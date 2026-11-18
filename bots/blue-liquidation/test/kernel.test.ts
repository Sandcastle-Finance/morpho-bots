import type { KernelConfig } from '@repo/kernel'

import { layoutOf } from '@repo/engine/testing'
import { createLogger } from '@repo/kit'
import { MethodNotFoundRpcError } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../src/config'
import { SettingsMismatchError } from '../src/errors'
import { LIQUIDATOR_GRAPH } from '../src/graph'
import { liquidatorAccount, liquidatorKernel, liquidatorKernelConfig } from '../src/kernel'
import { replayGraph } from '../src/replay'
import { liquidatorSettings } from '../src/settings'

/** A node answering only what signing reads, estimating `gas` for every transaction. */
const mockRpc = (chainId: number, gas: bigint) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string) as { id: number; method: string }
    const results: Record<string, unknown> = {
      eth_chainId: `0x${chainId.toString(16)}`,
      eth_estimateGas: `0x${gas.toString(16)}`,
      eth_getBlockByNumber: { baseFeePerGas: '0x7' }
    }
    return body.method in results
      ? Response.json({ jsonrpc: '2.0', id: body.id, result: results[body.method] })
      : Response.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: MethodNotFoundRpcError.code, message: `unmocked ${body.method}` }
        })
  })

const guard = { signal: new AbortController().signal, mayAct: () => true }
const logger = createLogger('error', { env: {} })

const configOn = (chainId: number) =>
  loadConfig({
    CHAIN_ID: String(chainId),
    [`FINALITY_${chainId}`]: 'safe',
    RPC_URL: 'http://localhost:8545',
    LIQUIDATOR_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
    MORPHO_API_KEY: 'morpho-key',
    KERNEL_STATE_DIR: '/nonexistent',
    KERNEL_ENROLLMENT: 'enrolled',
    JOURNAL_RUN_CAP_BYTES: '1073741824',
    BUILD_REVISION: '0d58dd8e5',
    BUILD_IMAGE_TAG: 'test',
    MAX_FEE_GWEI: '250',
    ZEROX_API_KEY: 'zx-key'
  })

const kernelOn = (chainId: number) => {
  const config = configOn(chainId)
  const account = liquidatorAccount(config)
  const settings = liquidatorSettings(config, { account: account.address, runId: 'run' })
  return { account, settings, ...liquidatorKernel(settings, { config, account, logger }) }
}

describe('liquidatorKernel', () => {
  afterEach(() => vi.restoreAllMocks())

  // Robinhood's estimate folds in L1 data cost, so a self-send there estimates above 21,000.
  it.each([
    { chainId: 8453, gas: 21_000n },
    { chainId: 4663, gas: 22_584n }
  ])('signs the kernel nonce fill for chain id $chainId', async ({ chainId, gas }) => {
    const { account, live } = kernelOn(chainId)
    mockRpc(chainId, gas)
    await expect(
      live.effects.signTx(
        { kind: 'tx' as const, to: account.address, data: '0x' as const, value: 0n },
        {
          nonce: 0,
          level: 1,
          kind: 'fill',
          fee: live.config.feeReserve,
          recoveryFee: live.config.feeReserve
        },
        guard
      )
    ).resolves.toMatchObject({ hash: expect.stringMatching(/^0x/) })
  })

  it('converts each block window from a time on each chain', () => {
    const windows = (chainId: number) => {
      const { settings, live } = kernelOn(chainId)
      const config = liquidatorKernelConfig(settings)
      const { reorgDepth } = live
      return {
        maxEvidenceAgeBlocks: config.maxEvidenceAgeBlocks,
        maxSimLagBlocks: config.maxSimLagBlocks,
        stuckBlocks: config.stuckBlocks,
        reorgDepth
      }
    }
    expect(windows(8453)).toEqual({
      maxEvidenceAgeBlocks: 340,
      maxSimLagBlocks: 30,
      stuckBlocks: 40,
      reorgDepth: 3_000
    })
    expect(windows(4663)).toEqual({
      maxEvidenceAgeBlocks: 680,
      maxSimLagBlocks: 60,
      stuckBlocks: 80,
      reorgDepth: 6_000
    })
  })

  it('builds from settings the config its live signer is bounded by', () => {
    const { settings, live } = kernelOn(8453)
    const data = ({ validators: _validators, feePolicy: _feePolicy, ...rest }: KernelConfig) => rest
    expect(data(liquidatorKernelConfig(settings))).toStrictEqual(data(live.config))
  })

  it('refuses an account or a chain its settings do not record', () => {
    const config = configOn(8453)
    const account = liquidatorAccount(config)
    const settings = liquidatorSettings(config, { account: account.address, runId: 'run' })
    const other = liquidatorAccount({ ...config, liquidatorPrivateKey: `0x${'2'.repeat(64)}` })
    expect(() => liquidatorKernel(settings, { config, account: other, logger })).toThrow(
      new SettingsMismatchError('account')
    )
    expect(() =>
      liquidatorKernel({ ...settings, chainId: 4663 }, { config, account, logger })
    ).toThrow(new SettingsMismatchError('chainId'))
  })
})

describe('replayGraph', () => {
  it("ticks the kernel's clock at the live run's interval", () => {
    const { settings, live } = kernelOn(8453)
    const replayed = replayGraph({ graph: LIQUIDATOR_GRAPH, run: settings.runId, settings })
    const tick = [...layoutOf(replayed).nodes.values()].find(node => node.id === 'kernel.tick')
    expect(tick?.clock?.everyMs).toBe(live.pollMs)
  })
})

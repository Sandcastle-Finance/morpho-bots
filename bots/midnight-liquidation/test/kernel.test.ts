import type { KernelConfig } from '@repo/kernel'

import { layoutOf } from '@repo/engine/testing'
import { blocksFor, createLogger, transactionKernelConfig } from '@repo/kit'
import {
  createPublicClient,
  http,
  MethodNotFoundRpcError,
  numberToHex,
  parseEther,
  parseGwei
} from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadConfig, STUCK_MS } from '../src/config'
import { SettingsMismatchError } from '../src/errors'
import { LIQUIDATOR_GRAPH } from '../src/graph'
import {
  chainFeeReads,
  liquidationFees,
  liquidatorAccount,
  liquidatorKernel,
  liquidatorKernelConfig,
  PREPARE_TIMEOUT_MS
} from '../src/kernel'
import { replayGraph } from '../src/replay'
import { liquidatorSettings } from '../src/settings'

/** A node answering only what signing reads, estimating `gas` for every transaction. */
const mockRpc = (chainId: number, gas: bigint, l1Fee?: bigint, baseFee = 7n) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(init?.body as string) as { id: number; method: string }
    const results: Record<string, unknown> = {
      eth_chainId: `0x${chainId.toString(16)}`,
      eth_estimateGas: `0x${gas.toString(16)}`,
      eth_getBlockByNumber: { baseFeePerGas: numberToHex(baseFee) },
      ...(l1Fee !== undefined && { eth_call: numberToHex(l1Fee, { size: 32 }) })
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
    KERNEL_STATE_DIR: '/nonexistent',
    KERNEL_ENROLLMENT: 'enrolled',
    JOURNAL_RUN_CAP_BYTES: '1073741824',
    BUILD_REVISION: '0d58dd8e5',
    BUILD_IMAGE_TAG: 'test',
    MAX_FEE_GWEI: '250',
    MAX_SPEND_ETH: '0.4',
    MAX_GAS_LIMIT: '12000000',
    ZEROX_API_KEY: 'zx-key',
    MORPHO_API_KEY: 'morpho-key'
  })

const kernelOn = (chainId: number) => {
  const config = configOn(chainId)
  const account = liquidatorAccount(config)
  const settings = liquidatorSettings(config, { account: account.address, runId: 'run' })
  return { account, settings, ...liquidatorKernel(settings, { config, account, logger }) }
}

const feesOn = (chainId: number) => {
  const config = configOn(chainId)
  const settings = liquidatorSettings(config, {
    account: liquidatorAccount(config).address,
    runId: 'run'
  })
  const client = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) })
  return liquidationFees(settings, chainFeeReads(client, config.chain))('0x')
}

describe('liquidatorKernel', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    { chainId: 8453, gas: 21_000n },
    { chainId: 1, gas: 21_000n }
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

  it('converts each block window from a time, with floors that bind on mainnet', () => {
    const windows = (chainId: number) => {
      const { settings, live } = kernelOn(chainId)
      const config = liquidatorKernelConfig(settings)
      const { reorgDepth } = live
      return {
        maxEvidenceAgeBlocks: config.maxEvidenceAgeBlocks,
        stuckBlocks: config.stuckBlocks,
        reorgDepth
      }
    }
    expect(windows(8453)).toEqual({ maxEvidenceAgeBlocks: 500, stuckBlocks: 40, reorgDepth: 3_000 })
    expect(windows(1)).toEqual({ maxEvidenceAgeBlocks: 64, stuckBlocks: 1, reorgDepth: 128 })
  })

  it.each([8453, 1])(
    'builds from settings the config the live kernel and its env config build, for chain id %i',
    chainId => {
      const { account, settings, live } = kernelOn(chainId)
      const config = configOn(chainId)
      const fromConfig = transactionKernelConfig(
        {
          chainId: config.chain.id,
          targets: [config.executooorAddress],
          maxSpendWei: config.kernel.maxSpendWei,
          stuckMs: STUCK_MS,
          maxEvidenceAgeBlocks: blocksFor(
            2 * (config.worldValidMs + PREPARE_TIMEOUT_MS),
            config.chain,
            64
          )
        },
        config.chain,
        account.address,
        live.config.validators[0]!
      )
      const data = ({ validators: _validators, feePolicy: _feePolicy, ...rest }: KernelConfig) =>
        rest
      const built = data(liquidatorKernelConfig(settings))
      expect(built).toStrictEqual(data(live.config))
      expect(built).toStrictEqual(data(fromConfig))
    }
  )

  it('refuses an account or a chain its settings do not record', () => {
    const config = configOn(8453)
    const account = liquidatorAccount(config)
    const settings = liquidatorSettings(config, { account: account.address, runId: 'run' })
    const other = liquidatorAccount({ ...config, liquidatorPrivateKey: `0x${'2'.repeat(64)}` })
    expect(() => liquidatorKernel(settings, { config, account: other, logger })).toThrow(
      new SettingsMismatchError('account')
    )
    expect(() =>
      liquidatorKernel({ ...settings, chainId: 1 }, { config, account, logger })
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

describe('liquidationFees', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    { chainId: 8453, l1Data: 5n },
    { chainId: 1, l1Data: 0n }
  ])(
    'prices the first bid the kernel signs, beside the L1 data fee only where one is charged: $chainId',
    async ({ chainId, l1Data }) => {
      mockRpc(chainId, 100_000n, 5n)
      const fees = await feesOn(chainId)
      expect(fees).toMatchObject({ l1Data, baseFee: 7n, gasLimit: 120_000n })
      expect(fees.firstBid(2_520_000n)).toStrictEqual({
        maxFeePerGas: 21n,
        maxPriorityFeePerGas: 7n,
        gas: 120_000n
      })
      expect(fees.firstBid(2_519_999n).gas).toBeLessThan(120_000n)
    }
  )

  const feesAt = async (gas: bigint, baseFee: bigint) => {
    mockRpc(1, gas, undefined, baseFee)
    return feesOn(1)
  }

  it('prices a first bid at the step cap, under a base fee between it and the policy cap', async () => {
    const fees = await feesAt(100_000n, parseGwei('230'))
    expect(fees.firstBid(parseEther('0.4')).maxFeePerGas).toBeLessThan(fees.baseFee)
  })

  it('funds a first bid with no more than MAX_SPEND_ETH, however large the profit', async () => {
    const fees = await feesAt(3_000_000n, parseGwei('100'))
    expect(fees.firstBid(parseEther('1')).gas).toBeLessThan(fees.gasLimit)
  })
})

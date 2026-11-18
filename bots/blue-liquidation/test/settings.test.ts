import type { Data } from '@repo/engine'

import { decode, encode } from '@repo/engine'
import { tryCatch } from '@repo/utils'
import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config'
import { InvalidSettingsError } from '../src/errors'
import { liquidatorAccount } from '../src/kernel'
import { liquidatorSettings, parseLiquidatorSettings } from '../src/settings'
import { testSettings } from './scenario/bot'

const config = loadConfig({
  CHAIN_ID: '8453',
  FINALITY_8453: '12',
  RPC_URL: 'http://localhost:8545',
  LIQUIDATOR_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
  MORPHO_API_KEY: 'morpho-key',
  EXECUTOOOR_ADDRESS: '0x1111111111111111111111111111111111111111',
  KERNEL_STATE_DIR: '/nonexistent',
  KERNEL_ENROLLMENT: 'enrolled',
  JOURNAL_RUN_CAP_BYTES: '1073741824',
  BUILD_REVISION: '0d58dd8e5',
  BUILD_IMAGE_TAG: 'test',
  MAX_FEE_GWEI: '250',
  HTTP_RPS: '7',
  BACKOFF_BASE_BLOCKS: '3',
  BACKOFF_MAX_BLOCKS: '96',
  ZEROX_API_KEY: 'zx-key'
})
const account = liquidatorAccount(config).address

describe('liquidatorSettings', () => {
  it('records what the live run builds its graph from, and survives the journal codec', () => {
    const settings = liquidatorSettings(config, { account, runId: 'lq7f-0a1b2c3d' })
    expect(settings).toStrictEqual({
      runId: 'lq7f-0a1b2c3d',
      chainId: 8453,
      account,
      executor: getAddress('0x1111111111111111111111111111111111111111'),
      morpho: config.morpho,
      kernel: {
        maxFeePerGasWei: 250n * 10n ** 9n,
        maxSpendWei: config.kernel.maxSpendWei,
        maxGasLimit: config.kernel.maxGasLimit,
        finality: { depth: 12 },
        enrollment: 'enrolled'
      },
      worldValidMs: 30_000,
      quotes: { validForMs: 30_000, retryMs: 10_000 },
      venue: { concurrency: 3, budget: { calls: 7, perMs: 1_000 } },
      simulations: 3,
      maxReservations: 3,
      backoff: { baseBlocks: 3, maxBlocks: 96 }
    })
    expect(parseLiquidatorSettings(decode(encode(settings as Data)))).toStrictEqual(settings)
  })
})

describe('parseLiquidatorSettings', () => {
  it('refuses unknown fields, at any depth, by name', () => {
    const settings = testSettings()
    expect(() =>
      parseLiquidatorSettings({
        ...settings,
        privateKey: 'secret',
        kernel: { ...settings.kernel, rpcUrl: 'secret' }
      })
    ).toThrow(new InvalidSettingsError(['kernel.rpcUrl', 'privateKey']))
  })

  it('refuses missing and malformed fields, naming each and echoing no value', () => {
    const { simulations: _, ...settings } = testSettings()
    const { error } = tryCatch(() =>
      parseLiquidatorSettings({
        ...settings,
        runId: 'has a secret-value in it',
        account: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb',
        kernel: { ...settings.kernel, maxSpendWei: 0n }
      })
    )
    expect(error).toStrictEqual(
      new InvalidSettingsError(['runId', 'account', 'kernel.maxSpendWei', 'simulations'])
    )
    expect(error?.message).not.toMatch(/secret|0x/)
  })
})

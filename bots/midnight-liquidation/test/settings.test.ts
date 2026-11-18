import type { Data } from '@repo/engine'

import { decode, encode } from '@repo/engine'
import { TRANSACTION_KERNEL_RESERVATIONS } from '@repo/kit'
import { tryCatch } from '@repo/utils'
import { getAddress, parseEther, parseGwei } from 'viem'
import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config'
import {
  LISTED_MARKETS_MAX_AGE_MS,
  TOKEN_PRICES_REFRESH_MS,
  TOKEN_PRICES_VALID_MS
} from '../src/constants'
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
  MAX_SPEND_ETH: '0.4',
  MAX_GAS_LIMIT: '12000000',
  HTTP_RPS: '7',
  MIN_SURPLUS_BPS: '15',
  SEIZE_CAP_MARGIN_BPS: '40',
  HEADROOM_FLOOR_BPS: '5',
  MARKETS_REFRESH_MS: '45000',
  BACKOFF_BASE_BLOCKS: '3',
  BACKOFF_MAX_BLOCKS: '96',
  ZEROX_API_KEY: 'zx-key',
  ONEINCH_API_KEY: '1inch-key'
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
      midnight: config.midnight,
      nativeToken: config.wrappedNative,
      kernel: {
        maxFeePerGasWei: parseGwei('250'),
        maxSpendWei: parseEther('0.4'),
        maxGasLimit: 12_000_000n,
        finality: { depth: 12 },
        enrollment: 'enrolled'
      },
      worldValidMs: config.worldValidMs,
      sendLifeMs: config.sendLifeMs,
      minSurplusBps: 15,
      sizing: { seizeCapMarginBps: 40, headroomFloorBps: 5 },
      markets: { refreshMs: 45_000, maxAgeMs: LISTED_MARKETS_MAX_AGE_MS },
      prices: { refreshMs: TOKEN_PRICES_REFRESH_MS, validForMs: TOKEN_PRICES_VALID_MS },
      venues: config.venues.enabled,
      venue: { concurrency: 4, budget: { calls: 7, perMs: 1_000 } },
      maxReservations: TRANSACTION_KERNEL_RESERVATIONS,
      backoff: { baseBlocks: 3, maxBlocks: 96 }
    })
    expect(settings.venues).toStrictEqual(expect.arrayContaining(['0x', '1inch']))
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
        kernel: { ...settings.kernel, rpcUrl: 'secret' },
        sizing: { ...settings.sizing, apiKey: 'secret' }
      })
    ).toThrow(new InvalidSettingsError(['kernel.rpcUrl', 'sizing.apiKey', 'privateKey']))
  })

  it('refuses missing and malformed fields, naming each and echoing no value', () => {
    const { sendLifeMs: _, ...settings } = testSettings()
    const { error } = tryCatch(() =>
      parseLiquidatorSettings({
        ...settings,
        runId: 'has a secret-value in it',
        account: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb',
        kernel: { ...settings.kernel, maxSpendWei: 0n },
        venues: ['0x', 'uniswap-v3'],
        minSurplusBps: 10_001,
        backoff: { baseBlocks: 1, maxBlocks: Number(2n ** 60n) }
      })
    )
    expect(error).toStrictEqual(
      new InvalidSettingsError([
        'runId',
        'account',
        'kernel.maxSpendWei',
        'sendLifeMs',
        'minSurplusBps',
        'venues.1',
        'backoff.maxBlocks'
      ])
    )
    expect(error?.message).not.toMatch(/secret|0x|uniswap/)
  })
})

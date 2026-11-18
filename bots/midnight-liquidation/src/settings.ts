import type { Venue } from '@repo/swaps'
import type { Address } from 'viem'

import { TRANSACTION_KERNEL_RESERVATIONS } from '@repo/kit'
import { getAddress, isAddress } from 'viem'
import { z } from 'zod'

import type { Config } from './config'

import {
  LISTED_MARKETS_MAX_AGE_MS,
  TOKEN_PRICES_REFRESH_MS,
  TOKEN_PRICES_VALID_MS
} from './constants'
import { InvalidSettingsError } from './errors'

/** How many positions quote and simulate at once. */
const PREPARE_CONCURRENCY = 4
const VENUE_BUDGET_WINDOW_MS = 1_000
const MAX_BPS = 10_000

const checksummed = z.custom<Address>(
  value => typeof value === 'string' && isAddress(value) && getAddress(value) === value
)
const count = z.int().positive()
const blocks = z.int().nonnegative()
const bps = z.int().min(0).max(MAX_BPS)
const wei = z.bigint().positive()
const venue = z.enum(['lifi', '0x', '1inch'] as const satisfies readonly Venue[])

const settingsSchema = z.strictObject({
  /** Names this run in its intent ids, so a restart's acts never collide with an earlier run's. */
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  chainId: count,
  /** The liquidating EOA's address, which also receives each liquidation's sweeps. */
  account: checksummed,
  executor: checksummed,
  midnight: checksummed,
  /** The chain's wrapped native token, whose USD price converts a liquidation's profit to wei. */
  nativeToken: checksummed,
  kernel: z.strictObject({
    maxFeePerGasWei: wei,
    maxSpendWei: wei,
    maxGasLimit: wei,
    finality: z.union([
      z.literal('safe'),
      z.literal('finalized'),
      z.strictObject({ depth: count })
    ]),
    enrollment: z.enum(['enrolling', 'enrolled'])
  }),
  /** How long a world read authorizes liquidations, from when it started. */
  worldValidMs: count,
  /** How long a prepared liquidation's quote authorizes its send. */
  sendLifeMs: count,
  /** Surplus over break-even a quoted route must clear, in bps of the repay. */
  minSurplusBps: bps,
  sizing: z.strictObject({ seizeCapMarginBps: bps, headroomFloorBps: bps }),
  /** How often the whitelist refreshes, and how long a source holds without one. */
  markets: z.strictObject({ refreshMs: count, maxAgeMs: count }),
  /** How often token prices refresh, and how long a fetched table orders work. */
  prices: z.strictObject({ refreshMs: count, validForMs: count }),
  /** The swap venues routes and curves price against, in preference order. */
  venues: z.array(venue),
  /** How many preparations run at once, and how many may start in a window. */
  venue: z.strictObject({
    concurrency: count,
    budget: z.strictObject({ calls: count, perMs: count }).optional()
  }),
  /** How many native reservations the task family may hold; none stops it acting. */
  maxReservations: z.int().nonnegative(),
  /** Spaces a position's failed preparations and refused acts alike. */
  backoff: z.strictObject({ baseBlocks: blocks, maxBlocks: blocks })
})

/**
 * Everything the liquidator builds its graph from, kernel config included: plain data, recorded in
 * its journal's header, so a replay builds the graph the run did. Never a key or a credential.
 */
export type LiquidatorSettings = z.infer<typeof settingsSchema>

const fieldsOf = (error: z.ZodError) =>
  error.issues.flatMap(issue => {
    const path = issue.path.join('.')
    return issue.code === 'unrecognized_keys'
      ? issue.keys.map(key => (path ? `${path}.${key}` : key))
      : [path || '(root)']
  })

/** @throws InvalidSettingsError - naming each missing, malformed or unknown field. */
export const parseLiquidatorSettings = (value: unknown): LiquidatorSettings => {
  const parsed = settingsSchema.safeParse(value)
  if (!parsed.success) throw new InvalidSettingsError(fieldsOf(parsed.error))
  return parsed.data
}

/** The settings a live run records, from its loaded config, its signing account and its run id. */
export const liquidatorSettings = (
  config: Config,
  run: Readonly<{ account: Address; runId: string }>
) => {
  const { maxFeePerGasWei, maxSpendWei, maxGasLimit, finality, enrollment } = config.kernel
  return parseLiquidatorSettings({
    runId: run.runId,
    chainId: config.chainId,
    account: run.account,
    executor: config.executooorAddress,
    midnight: config.midnight,
    nativeToken: config.wrappedNative,
    kernel: { maxFeePerGasWei, maxSpendWei, maxGasLimit, finality, enrollment },
    worldValidMs: config.worldValidMs,
    sendLifeMs: config.sendLifeMs,
    minSurplusBps: config.quoting.minSurplusBps,
    sizing: {
      seizeCapMarginBps: config.quoting.seizeCapMarginBps,
      headroomFloorBps: config.quoting.headroomFloorBps
    },
    markets: { refreshMs: config.markets.refreshMs, maxAgeMs: LISTED_MARKETS_MAX_AGE_MS },
    prices: { refreshMs: TOKEN_PRICES_REFRESH_MS, validForMs: TOKEN_PRICES_VALID_MS },
    venues: config.venues.enabled,
    venue: {
      concurrency: PREPARE_CONCURRENCY,
      budget: { calls: config.quoting.httpRps, perMs: VENUE_BUDGET_WINDOW_MS }
    },
    maxReservations: TRANSACTION_KERNEL_RESERVATIONS,
    backoff: {
      baseBlocks: Number(config.quoting.backoffBaseBlocks),
      maxBlocks: Number(config.quoting.backoffMaxBlocks)
    }
  })
}

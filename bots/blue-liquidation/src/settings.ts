import type { Address } from 'viem'

import { getAddress, isAddress } from 'viem'
import { z } from 'zod'

import type { Config } from './config'

import { InvalidSettingsError } from './errors'

/** How long a route authorizes liquidations before its position is quoted again. */
const QUOTE_VALID_MS = 30_000
/** How long a position whose quote failed, or found no path, waits to be quoted again. */
const QUOTE_RETRY_MS = 10_000
/** How many positions are worked at once, preparing or in flight; swap venues are rate limited. */
const POSITIONS_AT_ONCE = 3
const VENUE_BUDGET_WINDOW_MS = 1_000

const checksummed = z.custom<Address>(
  value => typeof value === 'string' && isAddress(value) && getAddress(value) === value
)
const count = z.int().positive()
const blocks = z.int().nonnegative()
const wei = z.bigint().positive()

const settingsSchema = z.strictObject({
  /** Names this run in its intent ids, so a restart's acts never collide with an earlier run's. */
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  chainId: count,
  /** The liquidating EOA's address, which also receives each liquidation's sweep. */
  account: checksummed,
  executor: checksummed,
  morpho: checksummed,
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
  /** How long a route authorizes liquidations, and how long a quote that found no path waits. */
  quotes: z.strictObject({ validForMs: count, retryMs: count }),
  /** How many quotes run at once, and how many may start in a window. */
  venue: z.strictObject({
    concurrency: count,
    budget: z.strictObject({ calls: count, perMs: count }).optional()
  }),
  simulations: count,
  /** How many native reservations the kernel's caps allow. */
  maxReservations: count,
  /** Spaces a position's failed preparations, refused acts and failed quotes alike. */
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
    morpho: config.morpho,
    kernel: { maxFeePerGasWei, maxSpendWei, maxGasLimit, finality, enrollment },
    worldValidMs: config.worldValidMs,
    quotes: { validForMs: QUOTE_VALID_MS, retryMs: QUOTE_RETRY_MS },
    venue: {
      concurrency: POSITIONS_AT_ONCE,
      budget: { calls: config.quoting.httpRps, perMs: VENUE_BUDGET_WINDOW_MS }
    },
    simulations: POSITIONS_AT_ONCE,
    maxReservations: POSITIONS_AT_ONCE,
    backoff: {
      baseBlocks: Number(config.quoting.backoffBaseBlocks),
      maxBlocks: Number(config.quoting.backoffMaxBlocks)
    }
  })
}

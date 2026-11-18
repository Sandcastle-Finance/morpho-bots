import type { BackoffPolicy } from '@repo/controller'
import type { Budget, RunnerOptions } from '@repo/engine'
import type { TxPayload } from '@repo/kernel'
import type { Logger } from '@repo/kit'
import type { SwapPlan } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { Executor, MorphoAbi } from '@repo/contracts'
import { createReplayer } from '@repo/engine/replay'
import { FakeChain, MemoryStore } from '@repo/kernel/testing'
import { createJournalFileSink, readJournalFile } from '@repo/kit'
import { lensKey } from '@repo/utils'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { decodeFunctionData, getAddress, isAddressEqual, pad } from 'viem'

import type { MarketParams } from '../../src/market'
import type { LiquidatorSettings } from '../../src/settings'
import type { LensOut } from '../../src/state/lens.sol'

import { describeFailure } from '../../src/failure'
import { LIQUIDATOR_GRAPH } from '../../src/graph'
import { marketId } from '../../src/market'
import { replayGraph } from '../../src/replay'
import { startLiquidator } from '../../src/run'
import { createTickStats } from '../../src/stats'

export const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')
const MORPHO = getAddress('0x2222222222222222222222222222222222222222')
const ACCOUNT = getAddress('0x4444444444444444444444444444444444444444')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const BLOCK_MS = 40
const JOURNAL_CAPACITY_BYTES = 10_000_000
const JOURNAL_RUN_CAP_BYTES = 2 ** 40

export const market: MarketParams = {
  loanToken: LOAN,
  collateralToken: COLLATERAL,
  oracle: ACCOUNT,
  irm: ACCOUNT,
  lltv: 86n * 10n ** 16n
}
export const MARKET_ID = marketId(market)

export const borrowerAt = (index: number) =>
  getAddress(pad(`0x${(index + 0x100).toString(16)}`, { size: 20 }))
export const positionKey = (borrower: Address) => lensKey(MARKET_ID, borrower)

/**
 * An unhealthy position whose debt accrues every block, so its lens reading always moves, and whose
 * collateral each of its `liquidations` seized from.
 */
const unhealthyAt = (block: bigint, liquidations: number, cut: bigint): LensOut => ({
  valid: true,
  hasDebt: true,
  healthy: false,
  blockTimestamp: block * 2n,
  borrowShares: 10n ** 24n,
  collateral: 10n ** 18n - BigInt(liquidations) * 10n ** 16n - cut,
  accruedTotalBorrowAssets: 10n ** 18n + block,
  totalBorrowShares: 10n ** 24n,
  collateralPrice: 10n ** 36n,
  lltv: market.lltv,
  params: market
})

const swap: SwapPlan = { steps: [], expectedAmountOut: 10n ** 18n, amountOutMinimum: 1n }

const borrowerOf = (payload: TxPayload, executor: Address): Address | undefined => {
  if (!isAddressEqual(payload.to as Address, executor)) return undefined
  const exec = decodeFunctionData({ abi: Executor.abi, data: payload.data as Hex })
  const [first] = (exec.args as readonly [readonly Hex[]])[0]
  const call = decodeFunctionData({ abi: Executor.abi, data: first! })
  const liquidate = decodeFunctionData({
    abi: MorphoAbi,
    data: (call.args as readonly unknown[])[3] as Hex
  })
  return (liquidate.args as readonly unknown[])[1] as Address
}

type Line = Readonly<{ event: string; fields: Record<string, unknown> }>

/** Records every line, and throws on the event `failsOn` names, as a broken log transport would. */
const recordingLogger = (
  lines: Line[],
  failure: () => Readonly<{ on: string | undefined; error: Error | undefined }>
): Logger => {
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    const { on, error } = failure()
    if (event === on) throw error ?? new Error(`the logger failed on ${event}`)
    lines.push({ event, fields })
  }
  return { debug: log, info: log, warn: log, error: log }
}

/** A Base liquidator's settings, as a live run would record them, for the fake chain's accounts. */
export const testSettings = (): LiquidatorSettings => ({
  runId: 'run',
  chainId: 8453,
  account: ACCOUNT,
  executor: EXECUTOR,
  morpho: MORPHO,
  kernel: {
    maxFeePerGasWei: 10n ** 9n,
    maxSpendWei: 10n ** 16n,
    maxGasLimit: 10n ** 7n,
    finality: 'safe',
    enrollment: 'enrolling'
  },
  worldValidMs: 60_000,
  quotes: { validForMs: 60_000, retryMs: 1_000 },
  venue: { concurrency: 4 },
  simulations: 4,
  maxReservations: 4,
  backoff: { baseBlocks: 1, maxBlocks: 4 }
})

export const until = async (done: () => boolean, what: string, ms = 20_000) => {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

/** Journals through the real file sink, under the run id and settings a live run would record. */
const fileJournal = async (settings: LiquidatorSettings) => {
  const directory = await mkdtemp(join(tmpdir(), 'blue-journal-'))
  const created = await createJournalFileSink({
    directory,
    graph: LIQUIDATOR_GRAPH,
    build: { revision: '0d58dd8e5', imageTag: 'test' },
    capacityBytes: JOURNAL_CAPACITY_BYTES,
    runCapBytes: JOURNAL_RUN_CAP_BYTES,
    runId: settings.runId,
    settings,
    describe: describeFailure
  })
  return { path: created.path, directory, journal: created.journal }
}

/** Rebuilds the graph from the file's header alone, and fails unless the file ended clean and every step replays exactly. */
export const replayFile = async (path: string) => {
  let replayer: ReturnType<typeof createReplayer> | undefined
  let steps = 0
  for await (const read of readJournalFile(path)) {
    if (read.kind === 'header') replayer = createReplayer(replayGraph(read.header))
    else if (read.kind === 'entry') {
      const replayed = replayer!.apply(read.entry)
      if (replayed.kind === 'diverged')
        throw new Error(`the journal diverged at line ${read.line}: ${replayed.reason}`)
      if (replayed.kind === 'step') steps += 1
    } else if (read.status !== 'clean' || !replayer)
      throw new Error(`the journal file is unreadable: ${read.status}`)
  }
  return steps
}

/**
 * The liquidator against a fake chain: `alive` are the positions the world reads as liquidatable,
 * and a mined liquidation clears its position unless `squeeze` says the shared route is spent or
 * `survives` says it stays liquidatable. It journals to a file unless given a `journal`, and its
 * `shutdown` replays that file.
 */
export const startBot = async (
  parameters: {
    chain?: FakeChain
    store?: MemoryStore
    alive?: Set<Address>
    /** Replaces {@link testSettings}, before the overrides below. */
    settings?: LiquidatorSettings
    chainId?: number
    enrollment?: 'enrolling' | 'enrolled'
    runId?: string
    /** Whether a liquidation mined at this index of its block reverts. */
    squeeze?: (indexInBlock: number) => boolean
    /** How many of its liquidations each position stays liquidatable after. */
    survives?: Map<Address, number>
    /** The clock the kernel and the runner share. */
    now?: () => number
    worldValidMs?: number
    backoff?: BackoffPolicy
    journal?: NonNullable<RunnerOptions['journal']>
    /** Firm quotes the venue starts per window, when it is rate limited. */
    venueBudget?: Budget
    /** How many blocks below the head the kernel keeps, when not the default few. */
    reorgDepth?: number
  } = {}
) => {
  const chain = parameters.chain ?? new FakeChain()
  const store = parameters.store ?? new MemoryStore()
  const alive = parameters.alive ?? new Set<Address>()
  const base = parameters.settings ?? testSettings()
  const settings: LiquidatorSettings = {
    ...base,
    ...(parameters.chainId !== undefined && { chainId: parameters.chainId }),
    ...(parameters.runId !== undefined && { runId: parameters.runId }),
    ...(parameters.worldValidMs !== undefined && { worldValidMs: parameters.worldValidMs }),
    ...(parameters.backoff && { backoff: parameters.backoff }),
    ...(parameters.venueBudget && {
      venue: { ...base.venue, budget: parameters.venueBudget }
    }),
    kernel: { ...base.kernel, enrollment: parameters.enrollment ?? base.kernel.enrollment }
  }
  const file = parameters.journal ? undefined : await fileJournal(settings)
  const lines: Line[] = []
  const world: {
    discoverFails: boolean
    quoteFails: boolean
    /** A quote in flight answers only once this settles. */
    quoteHeld?: Promise<void>
    /** A simulation answers only once this settles. */
    simulateHeld?: Promise<void>
    /** Collateral every position has lost besides its liquidations, which shrinks its seize. */
    collateralCut: bigint
    simulateThrows: boolean
    /** How many quotes the venue was asked for. */
    quotes: number
    logFailsOn?: string
    /** What the logger throws on `logFailsOn`. */
    logError?: Error
    /** How long a lens read takes to answer. */
    readDelayMs: number
  } = {
    discoverFails: false,
    quoteFails: false,
    collateralCut: 0n,
    simulateThrows: false,
    quotes: 0,
    readDelayMs: 0
  }
  const liquidated = new Map<Address, number>()
  const minedInBlock = new Map<number, number>()
  chain.onMined = (payload, block) => {
    const borrower = borrowerOf(payload, settings.executor)
    if (!borrower) return 'success'
    const index = minedInBlock.get(block) ?? 0
    minedInBlock.set(block, index + 1)
    if (!alive.has(borrower) || parameters.squeeze?.(index)) return 'reverted'
    liquidated.set(borrower, (liquidated.get(borrower) ?? 0) + 1)
    const survives = parameters.survives?.get(borrower) ?? 0
    if (survives > 0) parameters.survives!.set(borrower, survives - 1)
    else alive.delete(borrower)
    return 'success'
  }
  const bot = await startLiquidator(settings, {
    journal: parameters.journal ?? file!.journal,
    kernel: {
      store,
      chain,
      effects: chain.effects,
      pollMs: 5,
      effectTimeoutMs: 1_000,
      reorgDepth: parameters.reorgDepth ?? 16,
      onError: () => {}
    },
    world: {
      discover: async () => {
        if (world.discoverFails) throw new Error('the discovery API is down')
        return {
          candidates: [...alive].map(borrower => ({ marketParams: market, borrower })),
          complete: true
        }
      },
      readLens: async (pairs, at) => {
        if (chain.blockAt(at.number).hash !== at.hash) throw new Error('no block with that hash')
        if (world.readDelayMs > 0) await sleep(world.readDelayMs)
        return new Map(
          pairs
            .filter(pair => alive.has(pair.borrower))
            .map(
              pair =>
                [
                  positionKey(pair.borrower),
                  unhealthyAt(
                    BigInt(at.number),
                    liquidated.get(pair.borrower) ?? 0,
                    world.collateralCut
                  )
                ] as const
            )
        )
      }
    },
    quoteFor: async () => {
      world.quotes += 1
      await world.quoteHeld
      if (world.quoteFails) throw new Error('the venue is down')
      return { kind: 'swap', plan: swap }
    },
    simulate: async () => {
      await world.simulateHeld
      if (world.simulateThrows) throw new Error('the node is down')
      return { status: 'ok' }
    },
    stats: createTickStats(),
    logger: recordingLogger(lines, () => ({ on: world.logFailsOn, error: world.logError })),
    ...(parameters.now && { now: parameters.now })
  })
  const state = () => bot.runner.read(bot.nodes.kernel.nodes.state)!
  let miner: ReturnType<typeof setInterval> | undefined
  const mining = (on: boolean) => {
    clearInterval(miner)
    miner = on ? setInterval(() => chain.mine(), BLOCK_MS) : undefined
  }
  return {
    ...bot,
    chain,
    store,
    alive,
    lines,
    world,
    state,
    mining,
    settings,
    journalPath: file?.path,
    events: (event: string) => lines.filter(line => line.event === event),
    shutdown: async () => {
      mining(false)
      await bot.runner.abandon()
      if (!file) return undefined
      try {
        return await replayFile(file.path)
      } finally {
        await rm(file.directory, { recursive: true, force: true })
      }
    }
  }
}

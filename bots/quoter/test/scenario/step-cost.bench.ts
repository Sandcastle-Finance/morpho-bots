import type { Graph, JournalSink, RunnerMeter } from '@repo/engine'
import type {
  Block,
  KernelActivity,
  KernelChain,
  KernelState,
  LedgerStore,
  TxPayload
} from '@repo/kernel'
import type { Logger } from '@repo/kit'
import type { Address, Hex } from 'viem'

import { MarketUtils, MAX_OFFER_CAP, Payload, Tree, type IMarket } from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { encode } from '@repo/engine'
import { createLedgerStore } from '@repo/kernel'
import { blockTimeMs, createJournalFileSink } from '@repo/kit'
import { bigintMin } from '@repo/utils'
import { midnightCommitmentGroup } from '@repo/validators'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { Session } from 'node:inspector/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { keccak256, maxUint256, pad, size, toHex, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { parse } from 'yaml'

import type { QuoterHosting } from '../../src/graph'
import type { MakerOfferGroup } from '../../src/infrastructure/provider/offer-groups.utils'
import type { ReferenceRates } from '../../src/infrastructure/reference/reference-rates'

import { ConfigService } from '../../src/config/config.service'
import { journalSettings } from '../../src/config/journal-settings.utils'
import { alignedRateTick } from '../../src/domain/tick-window'
import { createProductionLadderAdapters } from '../../src/infrastructure/ladder/production-ladder'
import { createReadClients } from '../../src/infrastructure/provider/read-clients'
import { dryHosting, loadQuoterSigner, quoterReceiptLogs } from '../../src/kernel'
import { startQuoterEngine, type QuoterEngine } from '../../src/run'

/** Invariants not met yet; an entry here whose assertion passes fails the suite. */
const UNMET = new Set<Invariant>([])

type Invariant = 'flat-work' | 'work-budget' | 'step-ceiling'

/** Growth over the run, as a fraction of the fitted value at the first retirement. */
const FLAT_TOLERANCE = 0.1
const HEADROOM = 1.1

/**
 * Each deterministic work unit the engine meter counts per step, as a run mean and a worst ten-minute
 * window: measured values plus 10%, regression guards rather than a derived CPU budget. CPU time is
 * reported but not asserted, since it depends on the machine and its load.
 */
const UNITS = {
  stateBytes: { mean: HEADROOM * 236_700, window: HEADROOM * 273_600 },
  writesPerStep: { mean: HEADROOM * 7.24, window: HEADROOM * 7.26 },
  bytesPerStep: { mean: HEADROOM * 250_500, window: HEADROOM * 298_400 },
  reducedBytesPerStep: { mean: HEADROOM * 236_700, window: HEADROOM * 273_500 },
  operatorCallsPerStep: { mean: HEADROOM * 4.88, window: HEADROOM * 4.9 },
  roundTripBytesPerStep: { mean: HEADROOM * 261, window: HEADROOM * 290 },
  journalQueuedBytesPerStep: { mean: HEADROOM * 650, window: HEADROOM * 679 },
  journalAppendedBytesPerStep: { mean: HEADROOM * 607, window: HEADROOM * 635 },
  journalSinkBytesPerStep: { mean: HEADROOM * 633, window: HEADROOM * 661 }
} satisfies Record<string, { mean: number; window: number }>
type Unit = keyof typeof UNITS
/**
 * A replacement's single largest kernel state write (398 KB: plans and nonce candidates holding the
 * signed transactions) and its largest step (1.27 MB, three such writes), each plus 10%.
 */
const STATE_WRITE_CEILING = HEADROOM * 398_000
const STEP_BYTES_CEILING = HEADROOM * 1_274_000
/** `Tree.create` runs only while a replacement is prepared, so it is counted per replacement. */
const TREE_CREATES_PER_REPLACEMENT_BUDGET = HEADROOM * 36

const WINDOW_MINUTES = 10
/** Shape settings changed from their defaults, at which the budgets were not measured. */
const reshaped: string[] = []
const setting = (name: string, fallback: number, min: number) => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < min)
    throw new Error(`${name} must be an integer of at least ${min}, got ${process.env[name]}`)
  if (value !== fallback) reshaped.push(name)
  return value
}
const RUN_MINUTES = 60 * Number(process.env.QUOTER_STEP_COST_HOURS ?? 4)
if (!Number.isSafeInteger(RUN_MINUTES / WINDOW_MINUTES) || RUN_MINUTES <= 0)
  throw new Error(`QUOTER_STEP_COST_HOURS must be a positive multiple of ${WINDOW_MINUTES} minutes`)
const PERIOD_MINUTES = setting('QUOTER_STEP_COST_PERIOD_MINUTES', 60, 1)
const BLOCK_MS = setting('QUOTER_STEP_COST_BLOCK_MS', blockTimeMs(base.id), 1)
const SAFE_LAG_BLOCKS = setting('QUOTER_STEP_COST_SAFE_LAG_BLOCKS', 300, 0)
const BOOK_OFFERS_PER_SIDE = setting('QUOTER_STEP_COST_BOOK_OFFERS', 12, 1)
const PROFILE_MINUTES = 2
const INCLUSION_BLOCKS = 2
/** The quoter's own journal capacity, as `run.ts` opens its file. */
const JOURNAL_CAPACITY_BYTES = 16 * 1024 * 1024
const UNHEALTHY = /alarm|stopped|refused|failed|compensat|error|halt/
const bigints = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value
const DRIVEN_LIMIT_MS = 10 * 60_000
const STAGING_CONFIG = new URL('../../../../deploy/quoter/config-dev-8453.yaml', import.meta.url)

const START = Date.UTC(2026, 10, 10)
const GENESIS = 38_000_000
const makerKey: Hex = `0x${'11'.repeat(32)}`
const maker = privateKeyToAccount(makerKey).address
const usdc: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const cbBtc: Address = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'
const thirdParty: Address = '0x4444444444444444444444444444444444444444'
const STAGING_CASH = 106_630_000n

const marketAt = (maturity: number) => ({
  chainId: BigInt(base.id),
  midnight: getChainAddress(base.id, 'midnight'),
  loanToken: usdc,
  collateralParams: [
    {
      token: cbBtc,
      lltv: 860_000_000_000_000_000n,
      liquidationCursor: 250_000_000_000_000_000n,
      oracle: '0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9' as Address
    }
  ],
  maturity: BigInt(maturity / 1000),
  rcfThreshold: 0n,
  enterGate: zeroAddress,
  liquidatorGate: zeroAddress
})
const markets = [marketAt(Date.UTC(2026, 10, 27, 15)), marketAt(Date.UTC(2026, 11, 25, 15))].map(
  params => ({ id: MarketUtils.toId(params), params })
)
const TICK_SPACING = 4

/** The staging ladder, each market moved onto one of the benchmark's markets. */
const stagingLadder = () => {
  const values = parse(readFileSync(STAGING_CONFIG, 'utf8')) as {
    config: { ladder: Record<string, unknown>[] }
  }
  return values.config.ladder.map((item, index) => ({ ...item, marketId: markets[index]!.id }))
}

const environment = () => ({
  CHAIN_ID: String(base.id),
  RPC_URL: 'https://rpc.example',
  REFERENCE_RPC_URL: 'https://archive.example',
  MAKER_PRIVATE_KEY: makerKey,
  MAKER_ADDRESS: maker,
  MIDNIGHT_ADDRESS: getChainAddress(base.id, 'midnight'),
  LOAN_ASSET_ADDRESS: usdc,
  RATIFIER_ADDRESS: getChainAddress(base.id, 'ecrecoverRatifier'),
  MARKET_IDS: markets.map(market => market.id).join(','),
  REFERENCE_MARKET_ID: `0x${'77'.repeat(32)}`,
  NATIVE_RESERVE_WEI: '500000000000000',
  MAX_FEE_GWEI: '100',
  MAX_TRANSACTION_SPEND_WEI: '100000000000000000',
  MAX_CONTINUOUS_FEE_CAP: '0',
  KERNEL_ENROLLMENT: 'enrolling',
  MAX_PUBLICATION_GAS: '5000000',
  MAX_PUBLICATION_DATA_BYTES: '65536',
  MAX_CANCELLATION_GAS: '100000',
  MAX_BATCH_CANCELLATION_GAS: '1000000',
  MAX_BATCH_CANCELLATION_DATA_BYTES: '65536',
  MORPHO_API_BASE_URL: 'https://api.example',
  ROUTER_API_BASE_URL: 'https://router.example',
  LADDER_MARKETS: JSON.stringify(stagingLadder())
})

type Sent = { payload: TxPayload; nonce: number; sentAt: number }

/** Base as the kernel sees it: a block every {@link BLOCK_MS}, `safe` lagging, inclusion two blocks on. */
class BaseChain implements KernelChain {
  readonly sent = new Map<string, Sent>()
  readonly included = new Map<string, number>()
  readonly consumed = new Map<string, bigint>()
  readonly index = new Map<string, MakerOfferGroup>()
  private readonly winners = new Map<number, string>()
  private appliedThrough = GENESIS

  height = () => GENESIS + Math.floor((Date.now() - START) / BLOCK_MS)
  blockAt = (number: number): Block => ({
    number,
    hash: pad(toHex(number)),
    parentHash: pad(toHex(number - 1)),
    timestamp: BigInt(Math.floor((START + (number - GENESIS) * BLOCK_MS) / 1000))
  })
  latest = async () => {
    const head = this.height()
    const safe = this.blockAt(head - SAFE_LAG_BLOCKS)
    return {
      head: this.blockAt(head),
      finalized: { number: safe.number, timestamp: safe.timestamp }
    }
  }
  block = async (number: number) => {
    if (number > this.height()) throw new Error(`no block ${number}`)
    return this.blockAt(number)
  }
  safe = async () => this.blockAt(this.height() - SAFE_LAG_BLOCKS)
  nonceAt = async (at: Block) => {
    const latest = [...this.included.values()].filter(block => block <= at.number).length
    return { latest, pending: Math.max(latest, this.winners.size) }
  }
  accountCode = async () => '0x'
  private evidence = (hash: string) => {
    const block = this.included.get(hash)
    if (block === undefined || block > this.height()) return null
    return {
      block,
      blockHash: this.blockAt(block).hash,
      status: 'success' as const,
      logs: quoterReceiptLogs(maker)(this.sent.get(hash)!.payload)
    }
  }
  receipt = async (hash: string) => this.evidence(hash)
  nonceTx = async (nonce: number) => {
    const hash = this.winners.get(nonce)
    const found = hash === undefined ? null : this.evidence(hash)
    return hash === undefined || found === null ? null : { hash, ...found }
  }
  commitment = async (id: string) => {
    const consumed = this.consumedOf(midnightCommitmentGroup(id))
    return { consumed, neutralized: consumed >= MAX_OFFER_CAP }
  }
  capacity = () => Promise.reject(new Error('the quoter observes no resource'))

  consumedOf = (group: string) => this.consumed.get(group.toLowerCase()) ?? 0n

  private readonly hashes = new Map<string, string>()
  readonly groupMarket = new Map<string, Hex>()
  readonly publications: { marketId: Hex; at: number }[] = []

  sign = (payload: TxPayload, nonce: number, raw: Hex) => {
    const hash = keccak256(raw)
    this.sent.set(hash, { payload, nonce, sentAt: -1 })
    this.hashes.set(raw, hash)
    return hash
  }
  broadcast = (raw: string) => {
    const hash = this.hashes.get(raw)!
    const sent = this.sent.get(hash)!
    if (sent.sentAt < 0) sent.sentAt = this.height()
    if (!this.winners.has(sent.nonce)) {
      this.winners.set(sent.nonce, hash)
      this.included.set(hash, sent.sentAt + INCLUSION_BLOCKS)
    }
  }
  /** Applies what each transaction included since the last call does to Midnight and the API index. */
  advance = async () => {
    const head = this.height()
    for (const [hash, block] of this.included) {
      if (block <= this.appliedThrough || block > head) continue
      await this.apply(this.sent.get(hash)!.payload)
    }
    this.appliedThrough = head
  }
  private apply = async (payload: TxPayload) => {
    const data = payload.data as Hex
    if (payload.to.toLowerCase() === getChainAddress(base.id, 'midnightMempool').toLowerCase()) {
      const published = new Set<Hex>()
      for (const { offer } of await Payload.decode(data)) {
        const group = offer.group!.toLowerCase()
        const marketId = MarketUtils.toId(offer.market)
        this.groupMarket.set(group, marketId)
        published.add(marketId)
        const listed = {
          marketId,
          maker,
          buy: offer.buy,
          tick: BigInt(offer.tick),
          maturity: markets.find(market => market.id === marketId)!.params.maturity,
          continuousFeeCap: BigInt(offer.continuousFeeCap)
        }
        this.index.set(group, {
          id: offer.group!,
          consumed: 0n,
          cap: { kind: 'units', maximum: BigInt(offer.maxUnits) },
          marketId,
          tick: listed.tick,
          maturity: listed.maturity,
          continuousFeeCap: listed.continuousFeeCap,
          offers: [listed]
        })
      }
      for (const marketId of published) this.publications.push({ marketId, at: Date.now() })
      return
    }
    for (const log of quoterReceiptLogs(maker)(payload)) {
      const group = log.topics[2]?.toLowerCase()
      if (!group) continue
      this.consumed.set(group, BigInt(log.data))
      this.index.delete(group)
    }
  }
}

/** Third-party offers on both sides of the staging rates, clear of the ladder. */
const thirdPartyBook = (market: (typeof markets)[number]) => {
  const timeToMaturity = market.params.maturity - BigInt(START / 1000)
  const side = (buy: boolean) =>
    Array.from({ length: BOOK_OFFERS_PER_SIDE }, (_, index) => ({
      groupId: pad(toHex(market.params.maturity * 1000n + BigInt(index) * 2n + (buy ? 1n : 0n))),
      marketId: market.id,
      buy,
      maker: thirdParty,
      units: 25_000_000n * BigInt(index + 1),
      tick: alignedRateTick(
        BigInt(buy ? 700 + 15 * index : 420 - 20 * index),
        timeToMaturity,
        BigInt(TICK_SPACING)
      )
    }))
  return [...side(true), ...side(false)]
}

const worldReads = (chain: BaseChain) => {
  const books = new Map(markets.map(market => [market.id, thirdPartyBook(market)]))
  const params = new Map(markets.map(market => [market.id, market.params]))
  const own = (marketId: Hex) =>
    [...chain.index.values()]
      .filter(group => group.marketId === marketId)
      .map(group => ({
        groupId: group.id,
        marketId,
        buy: group.offers[0]!.buy,
        tick: group.tick!,
        maker,
        units: group.cap.maximum
      }))
  return {
    readLatestBlock: async () => {
      const block = chain.blockAt(chain.height())
      return { number: BigInt(block.number), hash: block.hash as Hex, timestamp: block.timestamp }
    },
    readMarket: async (marketId: Hex) =>
      ({
        params: params.get(marketId)!,
        tickSpacing: TICK_SPACING,
        continuousFee: 0
      }) as unknown as IMarket,
    readGroups: async () =>
      [...chain.index.values()].map(group => ({
        ...group,
        consumed: chain.consumedOf(group.id)
      })),
    readBook: async (marketId: Hex) => [...books.get(marketId)!, ...own(marketId)],
    readPositions: async (ids: readonly Hex[]) =>
      Promise.allSettled(
        ids.map(async marketId => ({
          marketId,
          credit: 0n,
          debt: 0n,
          lossFactor: 0n,
          maturity: params.get(marketId)!.maturity,
          tickSpacing: TICK_SPACING,
          continuousFee: 0,
          params: params.get(marketId)!,
          withdrawable: 0n,
          redeemableCredit: 0n
        }))
      ),
    readCash: async () => ({ cashBalance: STAGING_CASH, allowance: maxUint256 }),
    readConsumed: async (groupIds: readonly Hex[]) => groupIds.map(group => chain.consumedOf(group))
  }
}

/** The hardcoded target's observation, renewed every {@link PERIOD_MINUTES} as it is hourly in production. */
const references =
  (config: ConfigService): ReferenceRates =>
  async requested =>
    requested.map(({ marketId }) => {
      const target = config.ladder.find(item => item.marketId === marketId)!.targetRate
      const rateBps = target.strategy === 'hardcoded' ? target.hardcodedRateBps : 0n
      const period = Math.floor(Date.now() / (PERIOD_MINUTES * 60_000))
      return {
        ok: true,
        value: { mode: 'static', rateBps, observationId: `static:${rateBps}:hour:${period}` }
      }
    })

type Tally = { count: number; bytes: number; ms: number }
const tally = (): Tally => ({ count: 0, bytes: 0, ms: 0 })
const add = (map: Map<string, Tally>, key: string, bytes: number, ms: number) => {
  const found = map.get(key) ?? tally()
  map.set(key, { count: found.count + 1, bytes: found.bytes + bytes, ms: found.ms + ms })
}

/**
 * Per-step work units, from the engine's own cost meter: writes and their encoded bytes, operator
 * calls and time, round trips and journal bytes. It is teed beside the meter the quoter installs.
 */
const createStepMeter = () => {
  let steps = 0
  let headWrites = 0
  let operatorCalls = 0
  let nodes = new Map<string, Tally>()
  let operators = new Map<string, Tally>()
  let roundTrips = tally()
  let queued = tally()
  let appended = tally()
  let sink = tally()
  let kernel: KernelState | undefined
  let stepBytes = 0
  const peaks = {
    step: { bytes: 0, at: 0 },
    state: { bytes: 0, at: 0, fields: {} as Record<string, number> }
  }
  const retired: { id: string; at: number }[] = []
  const grow = (total: Tally, bytes: number, ms: number) => ({
    count: total.count + 1,
    bytes: total.bytes + bytes,
    ms: total.ms + ms
  })
  const meter: RunnerMeter = {
    step: () => {
      steps += 1
      if (stepBytes > peaks.step.bytes) peaks.step = { bytes: stepBytes, at: Date.now() }
      stepBytes = 0
    },
    write: (node, bytes, ms, value) => {
      stepBytes += bytes
      if (node === 'kernel.heads') headWrites += 1
      if (node === 'kernel.state' && value !== undefined) {
        kernel = value as KernelState
        if (bytes > peaks.state.bytes)
          peaks.state = {
            bytes,
            at: Date.now(),
            fields: Object.fromEntries(
              Object.entries(kernel).map(([field, part]) => [
                field,
                part === undefined ? 0 : encode(part).length
              ])
            )
          }
      }
      if (node === 'kernel.activity')
        for (const activity of value as readonly KernelActivity[])
          if (activity.type === 'entry' && activity.to === 'retired')
            retired.push({ id: activity.id, at: Date.now() })
      add(nodes, node, bytes, ms)
    },
    operator: (id, ms, inputs) => {
      operatorCalls += 1
      const found = operators.get(id) ?? tally()
      operators.set(id, { count: found.count + inputs, bytes: 0, ms: found.ms + ms })
    },
    roundTrip: (_node, bytes, ms) => void (roundTrips = grow(roundTrips, bytes, ms)),
    journal: (stage, bytes, ms) => {
      if (stage === 'queued') queued = grow(queued, bytes, ms)
      else appended = grow(appended, bytes, ms)
    },
    journalSink: cost => void (sink = grow(sink, cost.bytes, cost.encodeMs + cost.syncMs)),
    finish: () => undefined
  }
  return {
    tee: (inner?: RunnerMeter): RunnerMeter =>
      inner
        ? {
            step: ms => (meter.step(ms), inner.step(ms)),
            write: (...args) => (meter.write(...args), inner.write(...args)),
            operator: (...args) => (meter.operator(...args), inner.operator(...args)),
            roundTrip: (...args) => (meter.roundTrip(...args), inner.roundTrip(...args)),
            journal: (...args) => (meter.journal(...args), inner.journal(...args)),
            journalSink: cost => (meter.journalSink(cost), inner.journalSink(cost)),
            finish: () => inner.finish()
          }
        : meter,
    kernel: () => kernel,
    retired: () => retired,
    peaks: () => peaks,
    take: () => {
      const taken = {
        steps,
        headWrites,
        operatorCalls,
        nodes,
        operators,
        roundTrips,
        queued,
        appended,
        sink
      }
      steps = 0
      headWrites = 0
      operatorCalls = 0
      nodes = new Map()
      operators = new Map()
      roundTrips = tally()
      queued = tally()
      appended = tally()
      sink = tally()
      return taken
    }
  }
}

type StepMeter = ReturnType<typeof createStepMeter>
const metering = vi.hoisted(() => ({ meter: undefined as StepMeter | undefined }))

vi.mock('@repo/engine', async original => {
  const engine = await original<typeof import('@repo/engine')>()
  return {
    ...engine,
    createRunner: (graph: Graph, options: Parameters<typeof engine.createRunner>[1]) => {
      const meter = metering.meter
      if (!meter) return engine.createRunner(graph, options)
      return engine.createRunner(graph, { ...options, meter: meter.tee(options?.meter) })
    }
  }
})

type Row = {
  minute: number
  stepsPerSecond: number
  headStepShare: number
  cpuMsPerStep: number
  cpuMsPerSecond: number
  headsDelivered: number
  writesPerStep: number
  bytesPerStep: number
  reducedBytesPerStep: number
  operatorCallsPerStep: number
  reducesPerStep: number
  reduceMsPerStep: number
  stateBytes: number
  stateFieldBytes: Record<string, number>
  entries: Record<string, number>
  retiredInState: number
  /** Every transition to `retired` since the run began, whether or not the kernel still holds the entry. */
  retirements: number
  headers: number
  plans: number
  treeCreatesPerStep: number
  journalBytesPerStep: number
  roundTripBytesPerStep: number
  journalQueuedBytesPerStep: number
  journalAppendedBytesPerStep: number
  journalSinkBytesPerStep: number
  ledgerBytesPerStep: number
  liveBytesPerStep: number
}

const directoryBytes = (path: string): number => {
  let total = 0
  for (const name of readdirSync(path)) {
    const child = join(path, name)
    const stats = statSync(child)
    total += stats.isDirectory() ? directoryBytes(child) : stats.size
  }
  return total
}

/** Least squares of `y` on `x`. */
const fit = (points: readonly (readonly [number, number])[]) => {
  const n = points.length
  const mx = points.reduce((sum, [x]) => sum + x, 0) / n
  const my = points.reduce((sum, [, y]) => sum + y, 0) / n
  const sxx = points.reduce((sum, [x]) => sum + (x - mx) ** 2, 0)
  const sxy = points.reduce((sum, [x, y]) => sum + (x - mx) * (y - my), 0)
  const slope = sxx === 0 ? 0 : sxy / sxx
  return { slope, intercept: my - slope * mx }
}

const profileTop = async (session: Session, limit: number) => {
  const { profile } = await session.post('Profiler.stop')
  const total = profile.endTime - profile.startTime
  const deltas = new Map<number, number>()
  profile.samples?.forEach((id, index) =>
    deltas.set(id, (deltas.get(id) ?? 0) + (profile.timeDeltas?.[index] ?? 0))
  )
  const byFunction = new Map<string, number>()
  const byArea = new Map<string, number>()
  for (const node of profile.nodes) {
    const self = deltas.get(node.id) ?? 0
    if (self === 0) continue
    const { functionName, url, lineNumber } = node.callFrame
    const where = url ? `${basename(url)}:${lineNumber + 1}` : '(native)'
    const name = `${functionName || '(anonymous)'} ${where}`
    byFunction.set(name, (byFunction.get(name) ?? 0) + self)
    const area =
      /framework\/(\w+)|packages\/(\w+)|bots\/quoter\/src|node_modules\/(?:\.bun\/)?([^/]+)/.exec(
        url
      )
    const label = area ? (area[1] ?? area[2] ?? area[3] ?? 'quoter') : functionName || '(vm)'
    byArea.set(label, (byArea.get(label) ?? 0) + self)
  }
  const share = (map: Map<string, number>) =>
    [...map]
      .toSorted((left, right) => right[1] - left[1])
      .slice(0, limit)
      .map(([name, us]) => ({ name, percent: Math.round((1000 * us) / total) / 10 }))
  return { functions: share(byFunction), areas: share(byArea) }
}

/** Base's base fee and tip in quiet hours, so a signed bid carries realistic fee fields. */
const BASE_FEE_WEI = 5_000_000n
const TIP_WEI = 1_000_000n
/** Gas a publication spends per calldata byte above its fixed cost, and a cancellation per group. */
const PUBLICATION_GAS = 120_000n
const GAS_PER_DATA_BYTE = 16n
const CANCELLATION_GAS = 60_000n

const gasFor = (payload: TxPayload) =>
  payload.to.toLowerCase() === getChainAddress(base.id, 'midnightMempool').toLowerCase()
    ? PUBLICATION_GAS + GAS_PER_DATA_BYTE * BigInt(size(payload.data as Hex))
    : CANCELLATION_GAS * BigInt(Math.max(1, quoterReceiptLogs(maker)(payload).length))

const run = async () => {
  const meter = createStepMeter()
  metering.meter = meter
  const directory = mkdtempSync(join(tmpdir(), 'quoter-step-cost-'))
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    now: START
  })
  const realYield = () => new Promise<void>(resolve => setImmediate(resolve))
  const io = { inFlight: 0 }
  const tracked = <T>(work: Promise<T>) => {
    io.inFlight += 1
    return work.finally(() => (io.inFlight -= 1))
  }
  const settle = async () => {
    for (let turn = 0; turn < 4 || io.inFlight > 0; turn++) {
      await vi.advanceTimersByTimeAsync(0)
      await realYield()
    }
  }
  const chain = new BaseChain()
  const events = new Map<string, number>()
  const driven = async <T>(promise: Promise<T>, what: string) => {
    const began = Date.now()
    const outcome = { settled: false }
    void promise.then(
      () => (outcome.settled = true),
      () => (outcome.settled = true)
    )
    while (!outcome.settled) {
      if (Date.now() - began > DRIVEN_LIMIT_MS)
        throw new Error(`${what} did not end: ${JSON.stringify(Object.fromEntries(events))}`)
      await vi.advanceTimersByTimeAsync(BLOCK_MS)
      await chain.advance()
      await settle()
    }
    return promise
  }
  const handles: { engine?: QuoterEngine; session?: Session } = {}
  const releases: (() => Promise<unknown> | void)[] = []
  try {
    const config = ConfigService.from(environment())
    const reads = worldReads(chain)
    const ledger = createLedgerStore(join(directory, 'kernel.json'))
    const ledgerWrites = { bytes: 0 }
    const store: LedgerStore = {
      read: () => ledger.read(),
      write: async value => {
        ledgerWrites.bytes += encode(value).length
        return tracked(ledger.write(value))
      }
    }
    const signer = privateKeyToAccount(makerKey)
    const live = { bytes: 0 }
    const liveLogger: Logger = Object.fromEntries(
      (['debug', 'info', 'warn', 'error'] as const).map(level => [
        level,
        (event: string, fields?: Record<string, unknown>) => {
          live.bytes += JSON.stringify({ event, ...fields }, bigints).length
        }
      ])
    ) as Logger
    const create = Tree.create.bind(Tree)
    const treeCalls: number[] = []
    const treeCreates = vi.spyOn(Tree, 'create').mockImplementation((...args) => {
      treeCalls.push(Date.now())
      return create(...args)
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/mempool/validate')) return Response.json({ data: { issues: [] } })
      throw new Error('the benchmark makes no other request')
    })

    const settings = dryHosting(config)
    const kernel: QuoterHosting = {
      config: settings.config,
      pollMs: settings.pollMs,
      effectTimeoutMs: settings.effectTimeoutMs,
      reorgDepth: settings.reorgDepth,
      onError: settings.onError,
      enrollment: 'enrolling',
      store,
      chain,
      effects: {
        materialize: () => Promise.reject(new Error('the quoter materializes in its graph')),
        simulate: async () => true,
        signTx: async (payload, { nonce, fee }) => {
          const gas = gasFor(payload)
          const maxFeePerGas = bigintMin(fee / gas, BASE_FEE_WEI * 2n + TIP_WEI)
          const bid = { maxFeePerGas, maxPriorityFeePerGas: TIP_WEI, gas }
          const raw = await signer.signTransaction({
            type: 'eip1559',
            chainId: base.id,
            nonce,
            to: payload.to as Address,
            data: payload.data as Hex,
            value: payload.value,
            ...bid
          })
          return { hash: chain.sign(payload, nonce, raw), raw, bid }
        },
        signTyped: payload => signer.signTypedData(payload as never),
        broadcast: async raw => {
          chain.broadcast(raw)
          return 'accepted'
        },
        release: () => Promise.reject(new Error('the quoter releases nothing offchain'))
      }
    }
    const settingsOfJournal = journalSettings({})
    const file = await createJournalFileSink({
      directory: join(directory, 'journal'),
      graph: 'quoter',
      build: settingsOfJournal.build,
      capacityBytes: JOURNAL_CAPACITY_BYTES,
      runCapBytes: settingsOfJournal.runCapBytes
    })
    const journal = { finalized: false }
    const journalSink: JournalSink = {
      append: (entry, signal) => tracked(file.journal.sink.append(entry, signal)),
      finalize: (signal, result) => {
        journal.finalized = true
        return tracked(file.journal.sink.finalize(signal, result))
      }
    }
    releases.push(() =>
      journal.finalized
        ? undefined
        : journalSink.finalize(AbortSignal.timeout(DRIVEN_LIMIT_MS), { clean: false })
    )
    const identity = config.identity
    if (identity.readOnly) throw new Error('the benchmark signs as the maker')
    const startup = new AbortController()
    const starting = startQuoterEngine({
      config,
      signal: startup.signal,
      signer: await loadQuoterSigner(identity),
      clients: createReadClients(config),
      strategies: { ladder: true, bootstrap: false },
      journal: { ...file.journal, sink: journalSink },
      stateDirectory: directory,
      world: reads,
      references: references(config),
      adapters: { ladder: () => createProductionLadderAdapters(config, { reads }) },
      kernel,
      liveLogger,
      writeEvent: event => {
        const name =
          event.event === 'kernel.notice'
            ? `notice.${event.notice}`
            : event.event === 'kernel.error'
              ? `error.${event.source}`
              : event.event
        events.set(name, (events.get(name) ?? 0) + 1)
        if (UNHEALTHY.test(name))
          console.log(JSON.stringify({ minute: (Date.now() - START) / 60_000, ...event }, bigints))
      }
    })
    releases.push(async () => {
      startup.abort()
      await driven(starting, 'the cancelled startup')
    })
    const started = await driven(starting, 'the startup')
    handles.engine = started
    const stopped = { early: false }
    void started.stopped.then(() => (stopped.early = handles.engine !== undefined))

    const simulate = async (minutes: number) => {
      const end = Date.now() + minutes * 60_000
      while (Date.now() < end) {
        await vi.advanceTimersByTimeAsync(Math.min(BLOCK_MS, end - Date.now()))
        await chain.advance()
        await settle()
      }
    }

    meter.take()
    const rows: Row[] = []
    const windows = RUN_MINUTES / WINDOW_MINUTES
    let lastJournal = directoryBytes(join(directory, 'journal'))
    for (let window = 0; window < windows; window++) {
      const cpu = process.cpuUsage()
      const trees = treeCreates.mock.calls.length
      const ledgerBefore = ledgerWrites.bytes
      const liveBefore = live.bytes
      await simulate(WINDOW_MINUTES)
      const used = process.cpuUsage(cpu)
      const taken = meter.take()
      const journal = directoryBytes(join(directory, 'journal'))
      const state = meter.kernel()
      const entries: Record<string, number> = {}
      for (const entry of Object.values(state?.entries ?? {}))
        entries[entry.state] = (entries[entry.state] ?? 0) + 1
      const reduce = taken.operators.get('kernel.state') ?? tally()
      const steps = Math.max(taken.steps, 1)
      const cpuMs = (used.user + used.system) / 1000
      const writes = [...taken.nodes.values()].reduce((sum, node) => sum + node.count, 0)
      const bytes = [...taken.nodes.values()].reduce((sum, node) => sum + node.bytes, 0)
      const stateBytes = state ? encode(state).length : 0
      rows.push({
        minute: (window + 1) * WINDOW_MINUTES,
        stepsPerSecond: taken.steps / (WINDOW_MINUTES * 60),
        headStepShare: taken.headWrites / steps,
        cpuMsPerStep: cpuMs / steps,
        cpuMsPerSecond: cpuMs / (WINDOW_MINUTES * 60),
        headsDelivered: taken.headWrites,
        writesPerStep: writes / steps,
        bytesPerStep: bytes / steps,
        reducedBytesPerStep: (reduce.count / steps) * stateBytes,
        operatorCallsPerStep: taken.operatorCalls / steps,
        reducesPerStep: reduce.count / steps,
        reduceMsPerStep: reduce.ms / steps,
        stateBytes,
        stateFieldBytes: Object.fromEntries(
          Object.entries(state ?? {}).map(([field, value]) => [
            field,
            value === undefined ? 0 : encode(value).length
          ])
        ),
        entries,
        retiredInState: entries.retired ?? 0,
        retirements: meter.retired().length,
        headers: Object.keys(state?.headers ?? {}).length,
        plans: Object.keys(state?.plans ?? {}).length,
        treeCreatesPerStep: (treeCreates.mock.calls.length - trees) / steps,
        journalBytesPerStep: (journal - lastJournal) / steps,
        roundTripBytesPerStep: taken.roundTrips.bytes / steps,
        journalQueuedBytesPerStep: taken.queued.bytes / steps,
        journalAppendedBytesPerStep: taken.appended.bytes / steps,
        journalSinkBytesPerStep: taken.sink.bytes / steps,
        ledgerBytesPerStep: (ledgerWrites.bytes - ledgerBefore) / steps,
        liveBytesPerStep: (live.bytes - liveBefore) / steps
      })
      lastJournal = journal
      console.log(JSON.stringify(rows.at(-1)))
      if (window === windows - 1) {
        const top = (map: Map<string, Tally>, by: 'bytes' | 'ms') =>
          [...map]
            .toSorted((left, right) => right[1][by] - left[1][by])
            .slice(0, 12)
            .map(([name, t]) => ({
              name,
              perStep: Math.round((t[by] / steps) * 1000) / 1000,
              callsPerStep: Math.round((t.count / steps) * 100) / 100
            }))
        lastNodes = top(taken.nodes, 'bytes')
        lastOperators = top(taken.operators, 'ms')
      }
    }

    const minuteOf = (at: number) => (at - START) / 60_000
    const progress = Array.from({ length: Math.floor(RUN_MINUTES / PERIOD_MINUTES) }, (_, period) =>
      markets.map(market => {
        const inPeriod = (at: number) => Math.floor(minuteOf(at) / PERIOD_MINUTES) === period
        return {
          period,
          marketId: market.id,
          published: chain.publications.filter(
            publication => publication.marketId === market.id && inPeriod(publication.at)
          ).length,
          retired: meter
            .retired()
            .filter(
              ({ id, at }) =>
                inPeriod(at) &&
                chain.groupMarket.get(midnightCommitmentGroup(id).toLowerCase()) === market.id
            ).length
        }
      })
    ).flat()
    const treeCreatesByReplacement = Array.from(
      { length: Math.floor(RUN_MINUTES / PERIOD_MINUTES) - 1 },
      (_, index) =>
        treeCalls.filter(at => Math.round(minuteOf(at) / PERIOD_MINUTES) === index + 1).length
    )
    const { step, state } = meter.peaks()
    const peaks = {
      stepBytes: step.bytes,
      stepMinute: minuteOf(step.at),
      stateWriteBytes: state.bytes,
      stateMinute: minuteOf(state.at),
      stateFields: state.fields
    }

    const session = new Session()
    handles.session = session
    session.connect()
    await session.post('Profiler.enable')
    await session.post('Profiler.setSamplingInterval', { interval: 500 })
    await session.post('Profiler.start')
    await simulate(PROFILE_MINUTES)
    const profile = await profileTop(session, 20)
    const stoppedEarly = stopped.early
    return {
      rows,
      progress,
      treeCreatesByReplacement,
      peaks,
      stoppedEarly,
      profile,
      events: Object.fromEntries(events)
    }
  } finally {
    handles.session?.disconnect()
    const engine = handles.engine
    handles.engine = undefined
    if (engine) await driven(engine.abandon(), 'the abandon').catch(() => undefined)
    for (const release of releases.toReversed())
      await Promise.resolve()
        .then(release)
        .catch(() => undefined)
    vi.useRealTimers()
    vi.restoreAllMocks()
    metering.meter = undefined
    rmSync(directory, { recursive: true, force: true })
  }
}

let lastNodes: unknown
let lastOperators: unknown

type Report = Awaited<ReturnType<typeof run>> & {
  fitRetirements: number
  growth: Record<Unit, { slopePerRetirement: number; atFirstRetirement: number; growth: number }>
}

const SETTLED_FROM_MINUTE = 20
/** Replacements that start after the settle point and have a full period left to retire. */
const FITTED_REPLACEMENTS =
  Math.floor(RUN_MINUTES / PERIOD_MINUTES) - 1 - Math.floor(SETTLED_FROM_MINUTE / PERIOD_MINUTES)
const MIN_FITTED_REPLACEMENTS = 2
if (FITTED_REPLACEMENTS < MIN_FITTED_REPLACEMENTS)
  throw new Error(
    `the run holds ${FITTED_REPLACEMENTS} replacements after minute ${SETTLED_FROM_MINUTE}, and the fit needs ${MIN_FITTED_REPLACEMENTS}: lengthen QUOTER_STEP_COST_HOURS or shorten QUOTER_STEP_COST_PERIOD_MINUTES`
  )

/** Groups each market publishes per replacement: one per rung in the staging shared-rung ladder. */
const groupsPerMarket = () => ConfigService.from(environment()).ladder[0]!.rungCount
/** Each replacement in the fit retires the groups it replaces in both markets. */
const expectedRetirements = () => FITTED_REPLACEMENTS * markets.length * groupsPerMarket()

const analyze = (measured: Awaited<ReturnType<typeof run>>): Report => {
  const later = measured.rows.filter(row => row.minute >= SETTLED_FROM_MINUTE)
  const settled = later.length > 0 ? later : measured.rows
  const first = settled[0]!.retirements
  const last = settled.at(-1)!.retirements
  const growthOf = (unit: Unit) => {
    const { slope, intercept } = fit(settled.map(row => [row.retirements, row[unit]] as const))
    const atFirst = intercept + slope * first
    return {
      slopePerRetirement: slope,
      atFirstRetirement: atFirst,
      growth: atFirst === 0 ? 0 : (slope * (last - first)) / atFirst
    }
  }
  const units = Object.keys(UNITS) as Unit[]
  return {
    ...measured,
    fitRetirements: last - first,
    growth: Object.fromEntries(units.map(unit => [unit, growthOf(unit)])) as Report['growth']
  }
}

const printTable = (report: Report) => {
  const fixed = (value: number, digits = 1) => value.toFixed(digits)
  console.log(
    'min  steps/s heads%  cpu ms/step  cpu ms/s  writes/step  KB/step  reduces/step  reduce ms/step  state KB  live retired/total headers  trees/step  journal B/step  live B/step'
  )
  for (const row of report.rows)
    console.log(
      [
        String(row.minute).padStart(3),
        fixed(row.stepsPerSecond).padStart(7),
        fixed(100 * row.headStepShare, 0).padStart(6),
        fixed(row.cpuMsPerStep, 2).padStart(11),
        fixed(row.cpuMsPerSecond).padStart(9),
        fixed(row.writesPerStep).padStart(12),
        fixed(row.bytesPerStep / 1024).padStart(8),
        fixed(row.reducesPerStep, 2).padStart(13),
        fixed(row.reduceMsPerStep, 2).padStart(15),
        fixed(row.stateBytes / 1024).padStart(9),
        String((row.entries.live ?? 0) + (row.entries.exposed ?? 0)).padStart(5),
        `${row.retiredInState}/${row.retirements}`.padStart(13),
        String(row.headers).padStart(7),
        fixed(row.treeCreatesPerStep, 3).padStart(11),
        fixed(row.journalBytesPerStep, 0).padStart(15),
        fixed(row.liveBytesPerStep, 0).padStart(12)
      ].join(' ')
    )
  console.log(
    JSON.stringify(
      {
        growth: report.growth,
        peaks: report.peaks,
        progress: report.progress,
        events: report.events
      },
      null,
      1
    )
  )
  console.log(JSON.stringify({ nodes: lastNodes, operators: lastOperators }, null, 1))
  console.log(JSON.stringify(report.profile, null, 1))
}

describe('quoter step cost at production shape', () => {
  let report: Report

  beforeAll(async () => {
    report = analyze(await run())
    printTable(report)
    const output = process.env.QUOTER_STEP_COST_JSON
    if (output)
      writeFileSync(
        output,
        JSON.stringify({ ...report, nodes: lastNodes, operators: lastOperators }, null, 1)
      )
  }, 0)
  afterAll(() => vi.useRealTimers())

  const settled = () => report.rows.filter(row => row.minute >= SETTLED_FROM_MINUTE)

  test('runs at Base cadence without stopping, and every market replaces in every period', () => {
    expect(report.stoppedEarly).toBe(false)
    const heads = (WINDOW_MINUTES * 60_000) / BLOCK_MS
    for (const row of report.rows)
      expect(
        Math.abs(row.headsDelivered - heads),
        `heads by minute ${row.minute}`
      ).toBeLessThanOrEqual(heads / 100)
    for (const { period, marketId, published, retired } of report.progress) {
      expect(published, `publications of ${marketId} in period ${period}`).toBeGreaterThanOrEqual(1)
      if (period > 0)
        expect(retired, `retirements of ${marketId} in period ${period}`).toBeGreaterThanOrEqual(
          groupsPerMarket()
        )
    }
  })

  const invariant = (name: Invariant) => (UNMET.has(name) ? test.fails : test)
  const budgeted = (name: Invariant) => (reshaped.length === 0 ? invariant(name) : test.skip)

  invariant('flat-work')('no work unit grows as retirements accumulate', () => {
    expect(report.fitRetirements).toBeGreaterThanOrEqual(expectedRetirements())
    for (const unit of Object.keys(UNITS) as Unit[])
      expect(report.growth[unit].growth, unit).toBeLessThanOrEqual(FLAT_TOLERANCE)
  })

  budgeted('work-budget')(
    'every work unit stays in budget over the run and in every window',
    () => {
      for (const unit of Object.keys(UNITS) as Unit[]) {
        const values = settled().map(row => row[unit])
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length
        expect(mean, `${unit} mean`).toBeLessThanOrEqual(UNITS[unit].mean)
        expect(Math.max(...values), `${unit} window`).toBeLessThanOrEqual(UNITS[unit].window)
      }
    }
  )

  invariant('flat-work')('Tree.create calls per replacement stay flat and in budget', () => {
    const counts = report.treeCreatesByReplacement
    expect(counts.length).toBeGreaterThanOrEqual(2)
    expect(Math.max(...counts) / Math.min(...counts) - 1).toBeLessThanOrEqual(FLAT_TOLERANCE)
    expect(Math.max(...counts)).toBeLessThanOrEqual(TREE_CREATES_PER_REPLACEMENT_BUDGET)
  })

  budgeted('step-ceiling')('no single step or kernel state write exceeds its ceiling', () => {
    expect(report.peaks.stepBytes).toBeLessThanOrEqual(STEP_BYTES_CEILING)
    expect(report.peaks.stateWriteBytes).toBeLessThanOrEqual(STATE_WRITE_CEILING)
  })
})

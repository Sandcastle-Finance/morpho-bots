import type { FactNode, FactReading, KernelDomain } from '@repo/controller'
import type { Data, Emit, GraphBuilder, Keyed, KeyRecord, Node, Stream } from '@repo/engine'
import type { KernelActivity, KernelRequest, KernelState, Plan, PlanInput } from '@repo/kernel'
import type { Hex } from 'viem'

import {
  act as actPlan,
  declarePhase,
  factOf,
  intentIdOf,
  parseIntentId,
  withdrawal
} from '@repo/controller'
import { emitTo, every, keyRecord, latest, watch } from '@repo/engine'
import { midnightCommitmentId } from '@repo/validators'

import type { BootstrapActPayload } from '../../application/engine/bootstrap-decision'
import type { Act, Decision, Outcome } from '../../application/engine/decision'
import type { LadderActPayload } from '../../application/engine/ladder-decision'
import type { MarketReport } from '../../application/engine/market-report'
import type { Publication } from '../kernel/quoter-holdings'
import type { QuoterSigning } from './quoter-plans'

import { unavailableReport } from '../../application/engine/market-report'
import { operatorErrorName } from '../../application/monitoring/operator-error-name.utils'
import { liveViewOf } from '../kernel/quoter-holdings'
import { quoterSteps } from './quoter-plans'

/**
 * Every replacement and redemption writes this, so no two run at once and each market decides from a
 * read after the last one landed.
 */
const BOOK_CONFLICT = 'quoter:book'

/** One market's decision from one world read, and what its preparation would be asked for now. */
export type Decided = Readonly<{
  decision: Decision & Readonly<{ detail: MarketReport }>
  request?: Readonly<{ digest: string; params: Data }>
  /** Whether a bootstrap market reaches its initial target at this reading. */
  completes: boolean
}>

/** A preparation asked of a market, numbered so a redelivery is refused. */
type PrepareRequest = Readonly<{ key: string; seq: number; digest: string; params: Data }>

/**
 * `submitted`: an act went to the kernel; `ended`: an act the kernel took ended, with its outcome;
 * `steady`: every market rests and nothing is in flight.
 */
export type ActEvent =
  | Readonly<{ type: 'submitted'; key: string; intentId: string; act: Act }>
  | Readonly<{ type: 'ended'; key: string; outcome: Outcome }>
  | Readonly<{ type: 'steady' }>

/**
 * The name of the {@link Turn} the acting fold takes for a market. A waiting turn reads `in_flight`
 * while an act of the market is held, and a decided one `preparing` while its preparation is out,
 * or `unprepared` while it has none built from its current desire. Codes and numbers only.
 */
type QuoterPhase = Readonly<{
  phase:
    | 'gated'
    | 'unread'
    | 'submitted'
    | 'in_flight'
    | 'preparing'
    | 'rested'
    | 'waiting'
    | 'idle'
  detail?: 'predates_own_effect' | 'book_held' | 'resting' | 'unprepared' | 'redeeming'
  /** While `unread`: when its parked workflow's reading went unusable. */
  since?: number
}>

/** Every {@link QuoterPhase} field, so a field added there and not here fails to compile. */
const PHASE_FIELDS = Object.keys({
  phase: true,
  detail: true,
  since: true
} satisfies Record<keyof QuoterPhase, true>) as readonly (keyof QuoterPhase)[]

/**
 * An act sent to the kernel, with the plan it supersedes and, once the kernel admitted a plan
 * superseding it, that plan's intent id.
 */
type Sent = Readonly<{ key: string; act: Act; supersedes?: string; supersededBy?: string }>

/** The acting policy's state: the inputs it last saw, and every act the kernel may still hold. */
type Acting = Readonly<{
  kernel: KernelState | undefined
  decisions: Keyed<Decided> | undefined
  desires: Keyed<unknown> | undefined
  /** The digest of the world read last seen, and of the one last affirmed. */
  world: string | undefined
  affirmed: string | undefined
  gate: boolean
  /**
   * The world read last seen when the gate opened: a market asks for no preparation until a world
   * read lands after it, so none is asked from a read the gate's own read overtakes.
   */
  gatedWorld: string | undefined
  halted: boolean
  steady: boolean
  /** Per market, the digest of the preparation last asked for. */
  asked: Readonly<Record<string, string>>
  /** Per market, its desire as read when that preparation was asked for, which its act rests on. */
  askedFrom: Readonly<Record<string, FactReading<'quoter'>>>
  /** Per market, the sequence number of its one preparation not yet answered. */
  preparing: Readonly<Record<string, number>>
  /** Per market, the act sent and not yet answered. */
  pending: Readonly<Record<string, string>>
  /**
   * Per market whose last act ended, the `restMark` it ended under: the market acts again
   * only on a newer read, or once that read became unusable, so a decision never repeats an act
   * against the state that act already changed.
   */
  rested: Readonly<Record<string, string>>
  /** Per parked workflow, when its market's reading went unusable; a usable read clears it. */
  unreadSince: Readonly<Record<string, number>>
  /** Every act the kernel may still hold, by intent id, until it ends. */
  acts: Readonly<Record<string, Sent>>
  /** What each replacement publishes, kept while its plan runs or the kernel holds its groups. */
  publications: Readonly<Record<string, Publication>>
  n: number
}>

/** What a turn reads beside {@link Acting}: the tables as this settle has written them so far. */
type Written = Pick<Acting, 'pending' | 'acts' | 'asked' | 'askedFrom' | 'preparing'>

/** A preparation a market's turn asks for, and the desire it is built from. */
type Ask = Readonly<{
  request: NonNullable<Decided['request']>
  reading: FactReading<'quoter'> | undefined
}>

/**
 * The branch one market's turn takes. The acting fold acts on it and `phase` names it, so the
 * phase is the fold's own decision by construction.
 */
type Turn =
  | Readonly<{ branch: 'halt'; reason: string }>
  | Readonly<{ branch: 'submitted' }>
  | Readonly<{ branch: 'rested' }>
  | Readonly<{ branch: 'predates_own_effect' }>
  | Readonly<{
      branch: 'unread'
      /** A parked workflow's wait for a usable read, from `since`. */
      parked?: Readonly<{ intentId: string; since: number }>
      withdraw?: Readonly<{ ids: readonly string[]; supersedes?: string }>
    }>
  | Readonly<{
      branch: 'decided'
      ask?: Ask
      does:
        | Readonly<{ kind: 'idle' | 'book_held' | 'resting' | 'unprepared' }>
        | Readonly<{
            kind: 'send'
            act: Act
            supersedes?: string
            evidence?: FactReading<'quoter'>
          }>
    }>

type ActsOptions = Readonly<{
  runId: string
  keys: readonly string[]
  signing: QuoterSigning
  decisions: Node<Keyed<Decided>>
  domain: KernelDomain<'quoter'>
  /** Each market's desire, the fact its replacement rests on. */
  desires: FactNode<'quoter'>
  world: Node<Keyed<unknown>>
  kernel: Node<KernelState>
  activity: Stream<readonly KernelActivity[]>
  /** Opens once startup has withdrawn what an earlier run left and readiness passed. */
  gate: Stream<true>
  /** Each preparation's answer, which ends its market's outstanding preparation. */
  answers: Stream<Readonly<{ key: string; seq: number }>>
  requests: Stream<KernelRequest>
  /** Where the acts' events go, which this fold writes. */
  events: Stream<ActEvent>
  /** How long a withdrawal, which rests on no fact, may take before the kernel gives it up. */
  receiptTimeoutMs: number
  /** How long a parked workflow waits for a usable read before its book is withdrawn. */
  readValidityMs: number
}>

/** The phase of a decided turn that is neither in flight nor preparing. */
const DECIDED_PHASES = {
  idle: { phase: 'idle' },
  send: { phase: 'idle' },
  book_held: { phase: 'waiting', detail: 'book_held' },
  resting: { phase: 'waiting', detail: 'resting' },
  unprepared: { phase: 'waiting', detail: 'unprepared' }
} as const satisfies Record<string, QuoterPhase>

const ANSWERS = new Set(['admitted', 'refused', 'known'])
const ENDED = new Set(['refused', 'abandoned', 'settled', 'compensated', 'failed'])
/** How a plan ends once the kernel set it aside for its superseding plan; `failed` never is. */
const SET_ASIDE = new Set(['abandoned', 'compensated'])

/** Whether `act` rests on its market's desire and writes {@link BOOK_CONFLICT}: all but a cancellation. */
const writesBook = (act: Act | undefined) => act !== undefined && act.kind !== 'cancel'

/** What a replacement publishes, recovered from the payload its decision built. */
const publicationOf = (intentId: string, act: Act): Publication | undefined => {
  if (act.kind !== 'replace') return undefined
  const payload = act.payload as unknown as
    | Extract<LadderActPayload, { publication: unknown }>
    | Extract<BootstrapActPayload, { publication: unknown }>
  if ('offer' in payload) {
    const { groupId, tick, continuousFeeCap } = payload.publication
    return {
      workflow: 'bootstrap',
      intentId,
      groupId,
      offer: {
        ...payload.offer,
        ...(tick === undefined ? {} : { tick }),
        ...(continuousFeeCap === undefined ? {} : { continuousFeeCap })
      }
    }
  }
  const { quote, groups } = payload.publication
  return { workflow: 'ladder', intentId, marketId: quote.marketId, quote, groups }
}

const groupsOf = (publication: Publication): readonly Hex[] =>
  publication.workflow === 'ladder'
    ? publication.groups.map(group => group.groupId)
    : [publication.groupId]

/** The plan the kernel executes for a market now, if any: never one of its own recoveries. */
const executingFor = (state: KernelState | undefined, key: string): Plan | undefined =>
  Object.values(state?.plans ?? {}).find(
    plan =>
      plan.status === 'executing' &&
      plan.recovery === undefined &&
      parseIntentId(plan.intentId)?.key === key
  )

/**
 * A reading taken before one of our own replacements, or this market's own last stage, landed:
 * any act on it would be refused for its stale evidence, so the market waits for a newer read.
 */
const predatesOwnEffect = (
  state: KernelState | undefined,
  running: Plan | undefined,
  block: number
) => block < (state?.conflictMarks[BOOK_CONFLICT] ?? -1) || block < (running?.lastInclusion ?? -1)

/** Whether another market's act holds {@link BOOK_CONFLICT}, so the kernel would refuse one now. */
const bookHeldBesides = (
  { pending, acts }: Readonly<Pick<Acting, 'pending' | 'acts'>>,
  kernel: KernelState | undefined,
  key: string
) =>
  Object.entries(pending).some(
    ([other, intentId]) => other !== key && writesBook(acts[intentId]?.act)
  ) ||
  Object.values(kernel?.plans ?? {}).some(
    plan =>
      plan.status === 'executing' &&
      plan.conflicts?.writes?.includes(BOOK_CONFLICT) === true &&
      parseIntentId(plan.intentId)?.key !== key
  )

/** A market's world reading cannot be decided on: the read failed, or it outlived its validity. */
const unusable = (acting: Acting, key: string, now: number) => {
  const decisions = acting.decisions
  if (decisions === undefined || decisions.coverage.status !== 'complete') return true
  const fact = keyRecord(decisions, key)
  return fact.status !== 'present' || (fact.expiry !== undefined && fact.expiry <= now)
}

const FAIL_CLOSED = 'fail-closed'

/** Which world read an act ended under, and whether the act was that read's fail-closed withdrawal. */
const restMark = (world: string | undefined, unread: boolean) =>
  `${unread ? 'unread:' : ''}${world}`

/** The withdrawal of a market whose reading cannot be decided on, reporting it unavailable. */
const failClosed = (key: string, ids: readonly string[], reason: string): Act => {
  const [workflow, marketId] = key.split(':') as ['ladder' | 'bootstrap', Hex]
  return {
    kind: 'cancel',
    identity: `withdraw:${ids.join(',')}`,
    payload: { cancel: [...ids], report: unavailableReport(workflow, marketId, reason) },
    condition: FAIL_CLOSED
  }
}

/**
 * The quoter's acting policy over its markets' decisions and the kernel's plans. Each world read
 * affirms what every decision keeps; a market's act goes to the kernel when nothing of it executes,
 * or supersedes its parked workflow once the market's desire moved; a market whose reading failed
 * or lapsed withdraws its book. A replacement or a redemption rests on its market's desire and
 * writes `BOOK_CONFLICT`, and a redemption never supersedes a workflow in flight; a
 * cancellation is risk-reducing and rests on nothing. Every act's
 * publication is kept beside it, since the kernel's witness holds offers, never their quote.
 * @param g - Graph builder the acting nodes are declared on.
 * @param options - The run id, market keys, signing, upstream nodes, and the kernel horizon.
 * @returns The acting state node, the prepare-request node it emits to, and `phase`, each market's
 * {@link QuoterPhase} as a map over that state.
 */
export const declareActs = (g: GraphBuilder, options: ActsOptions) => {
  const prepare = g.node<PrepareRequest>('quoter.prepare')
  const { requests, events } = options

  type Draft = {
    acting: Acting
    emit: Emit[]
    asked: Record<string, string>
    askedFrom: Record<string, FactReading<'quoter'>>
    preparing: Record<string, number>
    pending: Record<string, string>
    acts: Record<string, Sent>
    publications: Record<string, Publication>
    unreadSince: Record<string, number>
    n: number
    halted: boolean
  }

  const desireVersion = (acting: Acting, key: string) =>
    factOf(options.desires, acting.desires, key)?.fact.version

  /** Whether the kernel runs an act of `key` that rests on the market's desire as it is now. */
  const restsOnDesire = (acting: Acting, key: string, running: Plan | undefined) => {
    const desired = running?.evidence?.[0]?.version
    return desired !== undefined && desired === desireVersion(acting, key)
  }

  /**
   * The desire a replacement rests on: the reading its preparation was built from, while the market
   * still desires the same thing.
   */
  const preparedFrom = (
    acting: Acting,
    askedFrom: Acting['askedFrom'],
    key: string
  ): FactReading<'quoter'> | undefined => {
    const built = askedFrom[key]
    return built !== undefined && built.fact.version === desireVersion(acting, key)
      ? built
      : undefined
  }

  /** Sends `act`, resting on `evidence` when it has some and on nothing, as a withdrawal, otherwise. */
  const submit = (
    draft: Draft,
    key: string,
    act: Act,
    now: number,
    evidence?: FactReading<'quoter'>,
    supersedes?: string
  ) => {
    const fact = draft.acting.decisions && keyRecord(draft.acting.decisions, key)
    const basis =
      evidence !== undefined && 'block' in evidence.fact.basis
        ? evidence.fact.basis
        : fact?.status === 'present'
          ? (fact.basis as { block?: number })
          : undefined
    const intentId = intentIdOf(key, options.runId, draft.n++)
    let steps: PlanInput['steps']
    try {
      steps = quoterSteps(options.signing, act)
    } catch (error) {
      const outcome: Outcome = {
        intentId,
        kind: act.kind,
        notice: 'refused',
        reason: operatorErrorName(error),
        payload: act.payload,
        transactions: []
      }
      draft.emit.push(emitTo(events, { type: 'ended', key, outcome }))
      return
    }
    const planned = {
      intentId,
      steps,
      ...(supersedes !== undefined && { supersedes }),
      decision: { key, kind: act.kind, identity: act.identity }
    }
    const block = basis?.block ?? 0
    const plan = evidence
      ? actPlan(options.domain, {
          ...planned,
          restsOn: [evidence],
          readAt: block,
          conflicts: { writes: [BOOK_CONFLICT] }
        })
      : withdrawal(options.domain, {
          ...planned,
          basisBlock: block,
          expiresAt: now + options.receiptTimeoutMs,
          conflicts: {}
        })
    draft.acts[intentId] = { key, act, ...(supersedes !== undefined && { supersedes }) }
    draft.pending[key] = intentId
    const publication = publicationOf(intentId, act)
    if (publication) draft.publications[intentId] = publication
    draft.emit.push(
      emitTo(requests, { type: 'Submit', plan }),
      emitTo(events, { type: 'submitted', key, intentId, act })
    )
  }

  /**
   * A market whose reading cannot be decided on withdraws its book once nothing of it runs. A
   * workflow parked between its stages gets one read's validity to see a usable read, as the one
   * its own inclusion asked for, before the withdrawal supersedes it.
   */
  const unreadTurn = (
    acting: Acting,
    key: string,
    now: number,
    running: Plan | undefined
  ): Turn => {
    const ids = liveViewOf(acting.kernel, key).live.map(entry => entry.id)
    if (ids.length === 0) return { branch: 'unread' }
    if (running === undefined) return { branch: 'unread', withdraw: { ids } }
    if (running.phase !== 'awaiting-advance') return { branch: 'unread' }
    const parked = {
      intentId: running.intentId,
      since: acting.unreadSince[running.intentId] ?? now
    }
    if (now - parked.since < options.readValidityMs) return { branch: 'unread', parked }
    return { branch: 'unread', parked, withdraw: { ids, supersedes: running.intentId } }
  }

  /** A usable market's decided turn: ask its preparation, then send, supersede, or wait. */
  const decidedTurn = (
    acting: Acting,
    written: Written,
    key: string,
    running: Plan | undefined,
    { decision, request }: Decided
  ): Turn => {
    const resting = restsOnDesire(acting, key, running)
    const ask =
      request !== undefined &&
      written.asked[key] !== request.digest &&
      !resting &&
      written.preparing[key] === undefined &&
      acting.world !== acting.gatedWorld
        ? { request, reading: factOf(options.desires, acting.desires, key) }
        : undefined
    const decided = (does: Extract<Turn, { branch: 'decided' }>['does']): Turn => ({
      branch: 'decided',
      ...(ask && { ask }),
      does
    })
    const { act } = decision
    if (act === undefined) return decided({ kind: 'idle' })
    if (writesBook(act) && bookHeldBesides(written, acting.kernel, key))
      return decided({ kind: 'book_held' })
    if (
      running !== undefined &&
      (act.kind === 'redeem' || !(running.phase === 'awaiting-advance' && !resting))
    )
      return decided({ kind: 'resting' })
    const supersedes = running?.intentId
    if (act.kind === 'cancel')
      return decided({ kind: 'send', act, ...(supersedes !== undefined && { supersedes }) })
    const evidence =
      act.kind === 'redeem'
        ? factOf(options.desires, acting.desires, key)
        : ask
          ? ask.reading
          : preparedFrom(acting, written.askedFrom, key)
    if (evidence === undefined) return decided({ kind: 'unprepared' })
    return decided({ kind: 'send', act, evidence, ...(supersedes !== undefined && { supersedes }) })
  }

  /** The branch a market's turn takes at `now`, over `acting` and the tables `written` so far. */
  const turnOf = (acting: Acting, written: Written, key: string, now: number): Turn => {
    const decided = acting.decisions && keyRecord(acting.decisions, key)
    if (decided?.status === 'present' && decided.value.decision.halt !== undefined)
      return { branch: 'halt', reason: decided.value.decision.halt }
    if (written.pending[key] !== undefined) return { branch: 'submitted' }
    const running = executingFor(acting.kernel, key)
    const unread = unusable(acting, key, now)
    if (acting.rested[key] === restMark(acting.world, unread)) return { branch: 'rested' }
    if (unread) return unreadTurn(acting, key, now, running)
    const fact = keyRecord(acting.decisions!, key) as Extract<
      KeyRecord<Decided>,
      { status: 'present' }
    >
    const { block } = fact.basis as { block: number }
    if (predatesOwnEffect(acting.kernel, running, block)) return { branch: 'predates_own_effect' }
    return decidedTurn(acting, written, key, running, fact.value)
  }

  /** One market's turn, acting on the branch {@link turnOf} names. */
  const turn = (draft: Draft, key: string, now: number) => {
    const next = turnOf(draft.acting, draft, key, now)
    if (next.branch === 'halt') {
      if (!draft.halted) draft.emit.push(emitTo(requests, { type: 'Halt', reason: next.reason }))
      draft.halted = true
    } else if (next.branch === 'unread') {
      if (next.parked) draft.unreadSince[next.parked.intentId] = next.parked.since
      if (next.withdraw) {
        const reason = draft.acting.decisions?.coverage.reason ?? 'QuoterReadingUnavailableError'
        const { ids, supersedes } = next.withdraw
        submit(draft, key, failClosed(key, ids, reason), now, undefined, supersedes)
      }
    } else if (next.branch === 'decided') {
      if (next.ask) {
        const seq = draft.n++
        draft.asked[key] = next.ask.request.digest
        if (next.ask.reading) draft.askedFrom[key] = next.ask.reading
        else delete draft.askedFrom[key]
        draft.preparing[key] = seq
        draft.emit.push(emitTo(prepare, { key, seq, ...next.ask.request }))
      }
      const { does } = next
      if (does.kind === 'unprepared') {
        delete draft.asked[key]
        delete draft.askedFrom[key]
      } else if (does.kind === 'send') {
        submit(draft, key, does.act, now, does.evidence, does.supersedes)
      }
    }
  }

  /** Drops publications whose plan ended and whose groups the kernel no longer holds. */
  const prune = (acting: Acting, publications: Record<string, Publication>) => {
    const entries = acting.kernel?.entries ?? {}
    const held = (groupId: Hex) => {
      const state = entries[midnightCommitmentId(groupId)]?.state
      return state !== undefined && state !== 'retired'
    }
    for (const [intentId, publication] of Object.entries(publications)) {
      const plan = acting.kernel?.plans[intentId]
      const running = plan?.status === 'executing' || plan?.status === 'compensating'
      if (!running && !(intentId in acting.acts) && !groupsOf(publication).some(held))
        delete publications[intentId]
    }
  }

  const steadyNow = (acting: Acting, draft: Draft) =>
    acting.decisions?.coverage.status === 'complete' &&
    Object.keys(draft.pending).length === 0 &&
    options.keys.every(key => {
      const fact = keyRecord(acting.decisions!, key)
      return (
        fact.status === 'present' &&
        fact.value.decision.steady &&
        executingFor(acting.kernel, key) === undefined
      )
    })

  const settle = (acting: Acting, now: number): { state: Acting; emit: Emit[] } => {
    const draft: Draft = {
      acting,
      emit: [],
      asked: { ...acting.asked },
      askedFrom: { ...acting.askedFrom },
      preparing: { ...acting.preparing },
      pending: { ...acting.pending },
      acts: { ...acting.acts },
      publications: { ...acting.publications },
      unreadSince: {},
      n: acting.n,
      halted: acting.halted
    }
    prune(acting, draft.publications)
    const kernel = acting.kernel
    const open = acting.gate && kernel?.lifecycle.kind === 'running'
    let affirmed = acting.affirmed
    if (
      open &&
      acting.world !== acting.affirmed &&
      acting.decisions?.coverage.status === 'complete'
    ) {
      affirmed = acting.world
      const keep = options.keys.flatMap(key => {
        const fact = keyRecord(acting.decisions!, key)
        return fact.status === 'present' ? fact.value.decision.keep : []
      })
      if (keep.length > 0) draft.emit.push(emitTo(requests, { type: 'Affirm', ids: keep }))
    }
    if (open) for (const key of options.keys) turn(draft, key, now)
    const steady = open && steadyNow(acting, draft)
    if (steady && !acting.steady) draft.emit.push(emitTo(events, { type: 'steady' }))
    const { asked, askedFrom, preparing, pending, acts, publications, unreadSince, n, halted } =
      draft
    return {
      state: {
        ...acting,
        affirmed,
        asked,
        askedFrom,
        preparing,
        pending,
        acts,
        publications,
        unreadSince,
        n,
        halted,
        steady
      },
      emit: draft.emit
    }
  }

  const answered = (acting: Acting, activity: readonly KernelActivity[]) => {
    const pending = { ...acting.pending }
    const acts = { ...acting.acts }
    const rested = { ...acting.rested }
    const emit: Emit[] = []
    for (const a of activity) {
      if (a.type !== 'notice' || a.notice !== 'admitted') continue
      const replaced = acts[a.intentId]?.supersedes
      if (replaced !== undefined && acts[replaced] !== undefined)
        acts[replaced] = { ...acts[replaced], supersededBy: a.intentId }
    }
    for (const a of activity) {
      if (a.type !== 'notice') continue
      const record = acts[a.intentId]
      if (record === undefined) continue
      if (ANSWERS.has(a.notice) && pending[record.key] === a.intentId) delete pending[record.key]
      if (!ENDED.has(a.notice)) continue
      delete acts[a.intentId]
      rested[record.key] = restMark(acting.world, record.act.condition === FAIL_CLOSED)
      const outcome: Outcome = {
        intentId: a.intentId,
        kind: record.act.kind,
        notice: a.notice as Outcome['notice'],
        ...(a.reason !== undefined && { reason: a.reason }),
        ...(record.supersededBy !== undefined &&
          SET_ASIDE.has(a.notice) && { supersededBy: record.supersededBy }),
        payload: record.act.payload,
        transactions: a.included ?? []
      }
      emit.push(emitTo(events, { type: 'ended', key: record.key, outcome }))
    }
    return { state: { ...acting, pending, acts, rested }, emit }
  }

  const initial: Acting = {
    kernel: undefined,
    decisions: undefined,
    desires: undefined,
    world: undefined,
    affirmed: undefined,
    gate: false,
    gatedWorld: undefined,
    halted: false,
    steady: false,
    asked: {},
    askedFrom: {},
    preparing: {},
    pending: {},
    rested: {},
    unreadSince: {},
    acts: {},
    publications: {},
    n: 0
  }
  const state = g.fold('quoter.acts', {
    reads: {
      decisions: watch(options.decisions),
      desires: watch(options.desires),
      world: watch(options.world),
      kernel: watch(options.kernel),
      activity: every(options.activity),
      gate: every(options.gate),
      answer: every(options.answers)
    },
    emits: [requests, prepare, events],
    initial,
    applyInput: (acting, input) => {
      if (input.from === 'activity') return answered(acting, input.value)
      if (input.from === 'gate')
        return {
          state: acting.gate ? acting : { ...acting, gate: true, gatedWorld: acting.world }
        }
      if (input.from === 'answer') {
        const { key, seq } = input.value
        if (acting.preparing[key] !== seq) return { state: acting }
        const { [key]: _, ...preparing } = acting.preparing
        return { state: { ...acting, preparing } }
      }
      if (input.from === 'world') return { state: { ...acting, world: input.value.digest } }
      if (input.from === 'kernel') return { state: { ...acting, kernel: input.value.value } }
      if (input.from === 'desires') return { state: { ...acting, desires: input.value.value } }
      return { state: { ...acting, decisions: input.value.value } }
    },
    afterInputs: (acting, stamp) => settle(acting, stamp.at)
  })

  /**
   * A market's phase: the {@link Turn} its next turn would take over the state `settle` left, at the
   * kernel's clock, so a rest that ends by expiry alone shows at the next tick the kernel processes.
   */
  const phaseOf = (acting: Acting, key: string): QuoterPhase => {
    const { kernel } = acting
    if (!acting.gate || kernel?.lifecycle.kind !== 'running') return { phase: 'gated' }
    const next = turnOf(acting, acting, key, kernel.now)
    if (next.branch === 'halt') return { phase: 'gated' }
    if (next.branch === 'submitted') return { phase: 'submitted' }
    if (next.branch === 'unread')
      return { phase: 'unread', ...(next.parked && { since: next.parked.since }) }
    const sent = Object.values(acting.acts).find(record => record.key === key)
    if (sent)
      return { phase: 'in_flight', ...(sent.act.kind === 'redeem' && { detail: 'redeeming' }) }
    if (next.branch === 'rested') return { phase: 'rested' }
    if (next.branch === 'predates_own_effect')
      return { phase: 'waiting', detail: 'predates_own_effect' }
    if (acting.preparing[key] !== undefined) return { phase: 'preparing' }
    return DECIDED_PHASES[next.ask ? 'unprepared' : next.does.kind]
  }

  const phase = g.scope('quoter.acts', s =>
    declarePhase(
      s,
      { acting: latest(state) },
      ({ acting }) => Object.fromEntries(options.keys.map(key => [key, phaseOf(acting, key)])),
      PHASE_FIELDS
    )
  )
  return { state, prepare, phase }
}

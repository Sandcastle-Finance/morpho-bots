import type {
  Emit,
  Every,
  Graph,
  GraphBuilder,
  Keyed,
  KeyRecord,
  Lane,
  Latest,
  MapInputs,
  Node
} from '@repo/engine'
import type { Conflicts, KernelActivity, KernelNodes, KernelRequest, StepSpec } from '@repo/kernel'

import {
  digestOf,
  emitTo,
  encode,
  every,
  GraphDefinitionError,
  keyRecord,
  NotDataError,
  reachable,
  sample,
  UNREAD,
  watch
} from '@repo/engine'
import { isChainFact } from '@repo/kernel'

import type { FactNode, FactReading } from './act'
import type { BackoffPolicy, Backoff, ExemptEnd } from './backoff'
import type { Bot, KernelHandle } from './bot'
import type { LogSink } from './log'
import type { ByTask } from './own'
import type { KernelView } from './view'

import { act, factOf } from './act'
import { backoffHolding, declareBackoff, isBackedOff, isStaleRefusal } from './backoff'
import { onBuild, secondFamily } from './bot'
import { TaskDefectError } from './errors'
import { intentIdOf, parseIntentId } from './intent'
import { entryOf, has, keptTaskEntries, ownRecord, taskEntryOf, withTaskEntry } from './own'
import { isBusy } from './view'

/**
 * `seq` rises with every request a run makes, so an effect can refuse a redelivered one. A
 * preparation builds only from `input`, the key's reading captured when its facts stood at `version`,
 * never from a later read, so the act it returns is what those facts describe.
 */
export type PrepareRequest<I = unknown> = Readonly<{
  id: string
  key: string
  /** The task the request prepares, which its answer backs off when it fails. */
  task: string
  seq: number
  version: string
  input: I
}>

/**
 * A preparation's answer: the steps of an act, or why there is none and whether that failure backs
 * the key's task off. The act holds while every fact it rests on does; `validUntil` only shortens
 * that, for a preparation that read something no fact carries. An act the kernel ends with a code in
 * `exemptFromBackoff` is held only to the next head, not backed off ({@link declareBackoff}).
 */
export type PrepareOutcome =
  | Readonly<{
      ok: true
      steps: readonly StepSpec[]
      validUntil?: number
      exemptFromBackoff?: readonly ExemptEnd[]
      /** The most the act's own transactions may spend on fees; it only lowers the kernel's ceiling. */
      maxSpendWei?: bigint
    }>
  | Readonly<{ ok: false; reason: string; backoff: boolean }>

/** What a preparation's handler receives beside its request. */
type PrepareContext = Readonly<{
  /** Aborts at the family's `prepare.timeoutMs` and on stop; the runtime stops waiting either way. */
  signal: AbortSignal
}>

/** Why the runtime answered a preparation itself: its handler threw, or did not answer in time. */
type PrepareFault = 'prepare_threw' | 'prepare_timed_out'

/** A fault as the runtime answers it: its reason alone, never anything read from a thrown error. */
type FaultOutcome = Readonly<{ ok: false; reason: PrepareFault; backoff: true; fault: true }>

/**
 * An outcome as the runtime stamps it with the request it answers: the act is submitted only while
 * its key's fact is still at `version`.
 */
export type PrepareResult = Readonly<{ id: string; key: string; task: string; version: string }> &
  (PrepareOutcome | FaultOutcome)

/**
 * A key's wish to act: the act named `name`, ranked by `priority` (highest first, equal ones in
 * turn), conflicting with `conflicts`. The runtime acts only on one {@link task} built.
 */
export type Task = Readonly<{
  kind: 'task'
  name: string
  priority: bigint
  conflicts: Conflicts
}>

/** A task's name, which its intent ids carry after a `.`, so it holds neither `.` nor `#`. */
const TASK_NAME = /^[^.#]+$/

const built = new WeakSet<object>()

/** A copy of an id list, `undefined` for none, or `null` for anything but a list of strings. */
const idsOf = (value: unknown) => {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return null
  const ids: string[] = []
  for (const id of value as readonly unknown[]) {
    if (typeof id !== 'string') return null
    ids.push(id)
  }
  return Object.freeze(ids)
}

/**
 * A frozen task, read once from `spec`.
 * @throws TaskDefectError - for a name, priority or conflict set the runtime cannot act on.
 */
export const task = (name: string, spec: Omit<Task, 'kind' | 'name'>): Task => {
  const { priority, conflicts } = spec as Readonly<Record<string, unknown>>
  const { reads: readIds, writes: writeIds } = (conflicts ?? {}) as Record<string, unknown>
  const [reads, writes] = [idsOf(readIds), idsOf(writeIds)]
  const valid =
    typeof name === 'string' &&
    TASK_NAME.test(name) &&
    typeof priority === 'bigint' &&
    typeof conflicts === 'object' &&
    conflicts !== null &&
    reads !== null &&
    writes !== null
  if (!valid) throw new TaskDefectError("a task's name, priority or conflicts are malformed")
  const read = Object.freeze({
    kind: 'task' as const,
    name,
    priority,
    conflicts: Object.freeze({ ...(reads && { reads }), ...(writes && { writes }) })
  })
  built.add(read)
  return read
}

/** Why a policy's return was refused for a key, which then acts on nothing until it returns one. */
type Rejection = 'policy_threw' | 'policy_invalid'

type Wanted = Task | Readonly<{ kind: 'rejected'; reason: Rejection }>

type DropReason =
  | 'preparation_expired'
  | 'not_candidate'
  | 'policy_rejected'
  | 'task_changed'
  | 'fact_unavailable'
  | 'fact_unbounded'
  | 'fact_expired'
  | 'fact_changed'

/** `submitted` rests on its key's fact read at `block`; `fact_unbounded` names the fact. */
export type TaskEvent =
  | Readonly<{
      type: 'submitted'
      key: string
      intentId: string
      priority: bigint
      block: number
      exemptFromBackoff?: readonly ExemptEnd[]
    }>
  | Readonly<{ type: 'dropped'; key: string; task: string; reason: DropReason; fact?: string }>
  | Readonly<{ type: 'rejected'; key: string; reason: Rejection }>
  | Readonly<{
      type: 'prepare_failed'
      key: string
      task: string
      ticket: string
      reason: PrepareFault
    }>

/** Where a key of a family stands, by the family's own rules (`framework/controller/SPEC.md` §5.9). */
export type TaskPhase =
  | 'submitted'
  | 'ready'
  | 'preparing'
  | 'in_flight'
  | 'rejected'
  | 'waiting'
  | 'declined'
  | 'stale'
  | 'backed_off'
  | 'eligible'

type PhaseDetail =
  | Rejection
  | 'void'
  | 'not_accepting'
  | 'lane_full'
  | 'reservations_full'
  | 'busy'
  | 'backed_off'
  | 'fact_unavailable'
  | 'fact_expired'
  | 'input_unavailable'
  | 'predates_own_effect'

/** Scalars and codes only, so a reader may log it whole. */
export type KeyPhase = Readonly<{
  phase: TaskPhase
  detail?: PhaseDetail
  task?: string
  priority?: bigint
  /** While `backed_off`: the first block it may be prepared again, after `failures` in a row. */
  until?: number
  failures?: number
}>

/** Why the family does not prepare a key now: the first of its admission rules that holds. */
type Hold = Omit<KeyPhase, 'task' | 'priority' | 'phase'> &
  Readonly<{ phase: Exclude<TaskPhase, 'eligible'> | 'not_candidate' }>

/** A voided preparation keeps its lane slot until it answers, but can never become ready. */
type Preparation = Readonly<{
  id: string
  readings: readonly FactReading<string>[]
  inputFingerprint: string
  task: string
  /** The conflicts its task declared when it was asked, which its act carries. */
  conflicts: Conflicts
  void?: true
}>

type Ready = Preparation & Readonly<{ answer: Extract<PrepareResult, { ok: true }> }>

/** An act sent to the kernel: the task it carries out and the reading of its key's fact it rests on. */
type Sent = Readonly<{ intentId: string; task: string; readings: readonly FactReading<string>[] }>

type Family = Readonly<{
  candidates?: Keyed<unknown>
  /** Each fact node's level, in the order the family names them. */
  facts: readonly (Keyed<unknown> | null)[]
  inputs?: Keyed<unknown>
  view?: KernelView
  backoff?: Backoff
  preparing: Readonly<Record<string, Preparation>>
  ready: Readonly<Record<string, Ready>>
  /**
   * Keys whose preparation declined without backing off, per task, with the inputs it declined on:
   * a task of a key is not prepared again until the key's candidate, fact or input changes.
   */
  declined: ByTask<string>
  /**
   * Per key and task, the reading of its fact the kernel refused an act on as stale: the task is not
   * prepared again until the fact is read again.
   */
  stale: ByTask<string>
  /** Keys whose policy return was refused, with why: each acts on nothing until it is valid again. */
  rejected: Readonly<Record<string, Rejection>>
  /** Acts sent to the kernel whose first notice has not come back yet. */
  submitted: Readonly<Record<string, Sent>>
  /** The key served last, so equal priorities take turns. */
  served: string
  /** How many intent ids and preparation tickets this run has issued, which numbers the next. */
  issued: number
}>

const sameIds = (left: readonly string[] = [], right: readonly string[] = []) => {
  const sorted = right.toSorted()
  return left.length === right.length && left.toSorted().every((id, i) => id === sorted[i])
}

const sameConflicts = (left: Conflicts, right: Conflicts) =>
  sameIds(left.reads, right.reads) && sameIds(left.writes, right.writes)

/** Why a ready act is discarded whenever the family decides, in the order it is checked. */
const heldDrop = (
  ready: Ready,
  wanted: Wanted | undefined,
  now: number
): DropReason | undefined => {
  const { validUntil } = ready.answer
  if (validUntil !== undefined && validUntil <= now) return 'preparation_expired'
  if (ready.readings.some(({ expiry }) => expiry !== undefined && expiry <= now))
    return 'fact_expired'
  if (wanted === undefined) return 'not_candidate'
  if (wanted.kind === 'rejected') return 'policy_rejected'
  if (wanted.name !== ready.task || !sameConflicts(wanted.conflicts, ready.conflicts))
    return 'task_changed'
  return undefined
}

/** Why a ready act is discarded as it is about to go to the kernel, in the order it is checked. */
const submitDrop = (
  { readings: captured }: Ready,
  readings: readonly FactReading<string>[] | undefined,
  now: number
): DropReason | undefined => {
  if (readings === undefined) return 'fact_unavailable'
  if (
    captured.every(({ expiry }) => expiry === undefined) ||
    captured.some(({ fact, expiry }) => !isChainFact(fact) && expiry === undefined)
  )
    return 'fact_unbounded'
  if (captured.some(({ expiry }) => expiry !== undefined && expiry <= now)) return 'fact_expired'
  if (readings.some((reading, i) => reading.fact.version !== captured[i]!.fact.version))
    return 'fact_changed'
  return undefined
}

/** A policy return that {@link task} did not build is refused; any failure rejects only its key. */
const normalizePolicy = <C>(policy: Policy<C>, candidate: C, key: string): Wanted => {
  try {
    const value: unknown = policy(candidate, key)
    if (typeof value === 'object' && value !== null && built.has(value)) return value as Task
    return { kind: 'rejected', reason: 'policy_invalid' }
  } catch (error) {
    return {
      kind: 'rejected',
      reason: error instanceof TaskDefectError ? 'policy_invalid' : 'policy_threw'
    }
  }
}

type Policy<C> = (candidate: C, key: string) => Task

type TaskFamilyOptions<C, I> = Readonly<{
  kernel: KernelHandle
  /** The keys that may act; the policy decides each present one. */
  candidates: Node<Keyed<C>>
  /**
   * The facts every key's act rests on, each read at the same key. Neither they nor anything they
   * read may be triggered by the kernel's transitions, which `defineBot` checks: read kernel nodes
   * beside them with `sample`.
   */
  facts: FactNode<string> | readonly FactNode<string>[]
  /** What a preparation builds from, captured into its request in the same step as the fact. */
  inputs: Node<Keyed<I>>
  /** Names the run in its intent ids. */
  runId: string
  /** How many native reservations the kernel's caps allow: no act is prepared beyond them. */
  maxReservations: number
  backoff: BackoffPolicy
  policy: Policy<C>
  prepare: PrepareOptions<I>
}>

type PrepareOptions<I> = Readonly<{
  /** Its concurrency bounds how many preparations are outstanding. */
  lane: Lane
  /**
   * How long a preparation may take before the runtime answers it as `prepare_timed_out`, aborts its
   * signal and frees its slot, whether or not the handler stops.
   */
  timeoutMs: number
  /** A throw is answered as `prepare_threw`, which backs the key off as a failure does. */
  handle: (request: PrepareRequest<I>, context: PrepareContext) => Promise<PrepareOutcome>
}>

/** The longest delay `setTimeout` honours: https://nodejs.org/api/timers.html#settimeoutcallback-delay-args */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * The handler's outcome, or the runtime's own when it throws or outlives `timeoutMs`; `undefined`
 * once `stop` aborts. Settles by then whether or not the handler heeds its signal.
 */
const prepareWithin = async <I>(
  prepare: PrepareOptions<I>,
  request: PrepareRequest<I>,
  stop: AbortSignal
): Promise<PrepareOutcome | FaultOutcome | undefined> => {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), prepare.timeoutMs)
  const signal = AbortSignal.any([stop, deadline.signal])
  let release = () => {}
  const gaveUp = new Promise<undefined>(resolve => {
    if (signal.aborted) return resolve(undefined)
    const onAbort = () => resolve(undefined)
    signal.addEventListener('abort', onAbort, { once: true })
    release = () => signal.removeEventListener('abort', onAbort)
  })
  const handled = (async () => ({ outcome: await prepare.handle(request, { signal }) }))().catch(
    () => ({ outcome: { ok: false, reason: 'prepare_threw', backoff: true, fault: true } as const })
  )
  try {
    const answer = await Promise.race([handled, gaveUp])
    if (answer) return answer.outcome
    if (stop.aborted) return undefined
    return { ok: false, reason: 'prepare_timed_out', backoff: true, fault: true }
  } finally {
    clearTimeout(timer)
    release()
  }
}

/** A fact the kernel's transitions can trigger lets an act's own admission withdraw it. */
const checkFactKernelFree = (graph: Graph, family: string, fact: string, kernel: KernelNodes) => {
  const via = reachable(graph, [kernel.state, kernel.activity, kernel.commands], {
    skipRecovery: true
  })
  if (!via.has(fact)) return
  const path = [fact]
  while (via.get(path[0]!) !== path[0]) path.unshift(via.get(path[0]!)!)
  throw new GraphDefinitionError(
    `${family} rests on ${fact}, which the kernel's transitions trigger through ${path.join(' -> ')}; read kernel nodes beside a fact with sample`
  )
}

const ranked = (
  served: string,
  wanted: Readonly<Record<string, Wanted>>,
  keys: readonly string[]
) => {
  const priorityOf = (key: string) => {
    const want = entryOf(wanted, key)
    return want?.kind === 'task' ? want.priority : 0n
  }
  const inTurn = keys.toSorted()
  const at = inTurn.findIndex(key => key > served)
  const turn = at < 0 ? inTurn : [...inTurn.slice(at), ...inTurn.slice(0, at)]
  return turn.toSorted((a, b) => {
    const [left, right] = [priorityOf(a), priorityOf(b)]
    return left === right ? 0 : left > right ? -1 : 1
  })
}

/** What a preparation of `key` would read: its candidate, its facts and its input, by digest. */
const inputFingerprintOf = (family: Family, key: string) => {
  const digest = (keyed: Keyed<unknown> | null | undefined) => {
    const fact = keyed && keyRecord(keyed, key)
    return fact?.status === 'present' ? fact.digest : 'none'
  }
  return `${digest(family.candidates)}/${family.facts.map(digest).join('+')}/${digest(family.inputs)}`
}

/** Which readings of its facts a preparation rests on: a new read differs even at the same version. */
const readingFingerprintOf = (readings: readonly FactReading<string>[] | undefined) =>
  readings === undefined
    ? 'none'
    : readings
        .map(({ fact, expiry }) => {
          const at = 'block' in fact.basis ? fact.basis.blockHash : fact.basis.observedAt
          return `${fact.version}@${at}<${expiry ?? ''}`
        })
        .join('+')

/** The version a preparation is asked at: every fact's, in the family's order. */
const versionOf = (readings: readonly FactReading<string>[]) =>
  readings.map(({ fact }) => fact.version).join('+')

/**
 * Whether a chain fact of `readings` was read before our own last inclusion or release on a conflict
 * id of `want`: the kernel refuses an act on it as predating our own effect, so it waits for a later
 * read.
 */
const predatesOwnEffect = (
  view: KernelView | undefined,
  want: Wanted | undefined,
  readingsOf: () => readonly FactReading<string>[] | undefined
) => {
  if (view === undefined || want?.kind !== 'task') return false
  const { reads = [], writes = [] } = want.conflicts
  const marks = [...reads, ...writes].flatMap(id => entryOf(view.conflictMarks, id) ?? [])
  if (marks.length === 0) return false
  const readings = readingsOf()
  if (readings === undefined) return false
  const block = Math.min(
    ...readings.flatMap(({ fact }) => (isChainFact(fact) ? [fact.basis.block] : []))
  )
  return marks.some(mark => block < mark)
}

const detailOf = (detail: PhaseDetail | undefined) => (detail === undefined ? {} : { detail })

/** Every {@link KeyPhase} field, so a field added there and not here fails to compile. */
const PHASE_FIELDS = Object.keys({
  phase: true,
  detail: true,
  task: true,
  priority: true,
  until: true,
  failures: true
} satisfies Record<keyof KeyPhase, true>) as readonly (keyof KeyPhase)[]

/** Why a projection gave no phases: a value or key that is not data, or a throw. */
type PhaseFailure = 'not_data' | 'projection_threw'

/** What one projection read: each key's phase, or the code of why it read none. */
type PhaseRead<P> =
  | Readonly<{ phases: Readonly<Record<string, P>> }>
  | Readonly<{ failed: PhaseFailure }>

/** Runs a projection so that neither a throw nor a result that is not data fails the graph. */
const readPhases = <P>(phases: () => Readonly<Record<string, P>>): PhaseRead<P> => {
  try {
    const read = phases()
    encode(read)
    return { phases: read }
  } catch (error) {
    return { failed: error instanceof NotDataError ? 'not_data' : 'projection_threw' }
  }
}

/**
 * A read as a complete keyed value, or none with coverage `failed` and its code. A key whose phase
 * equals its record in `previous` on every one of `fields` keeps that record, so it is not hashed
 * again.
 */
const keyedPhases = <P extends object>(
  read: PhaseRead<P>,
  previous: Keyed<P, null>,
  fields: readonly (keyof P)[]
): Keyed<P, null> => {
  if ('failed' in read) return { coverage: { status: 'failed', reason: read.failed }, keys: {} }
  const keys = ownRecord<KeyRecord<P, null>>()
  for (const [key, value] of Object.entries(read.phases)) {
    const before = entryOf(previous.keys, key)
    keys[key] =
      before?.status === 'present' && fields.every(field => before.value[field] === value[field])
        ? before
        : { status: 'present', value, digest: digestOf(value), basis: null }
  }
  return { coverage: { status: 'complete' }, absentBasis: null, keys }
}

/**
 * Declares `projection`, a map of `project` over `reads` through {@link readPhases}, and `phase`, a
 * fold of each projection over its own previous value through {@link keyedPhases}, so a key whose
 * phase is unchanged keeps its record and a failed projection never fails the graph.
 */
export const declarePhase = <
  R extends Record<string, Latest<unknown> | Every<unknown>>,
  P extends object
>(
  g: GraphBuilder,
  reads: R,
  project: (inputs: MapInputs<R>) => Readonly<Record<string, P>>,
  fields: readonly (keyof P)[]
) => {
  const projection = g.map('projection', {
    reads,
    compute: inputs => readPhases(() => project(inputs))
  })
  const unread: Keyed<P, null> = UNREAD
  return g.fold('phase', {
    reads: { projection: watch(projection) },
    initial: unread,
    applyInput: (previous, { value: { value: read } }) => ({
      state: read ? keyedPhases(read, previous, fields) : previous
    })
  })
}

const isFault = (result: PrepareResult): result is PrepareResult & FaultOutcome =>
  !result.ok && 'fault' in result

/** The event a preparation the runtime answered itself logs: none for a handler's own outcome. */
const faultOf = (result: PrepareResult): TaskEvent[] => {
  if (!isFault(result)) return []
  const { key, task, id: ticket, reason } = result
  return [{ type: 'prepare_failed', key, task, ticket, reason }]
}

/** Takes the answer to a key's outstanding ticket; any other answer, or a void ticket's, readies nothing. */
const answered = (family: Family, result: PrepareResult): Family => {
  const asked = entryOf(family.preparing, result.key)
  if (asked?.id !== result.id || versionOf(asked.readings) !== result.version) return family
  const { [result.key]: _, ...preparing } = family.preparing
  const declines = !result.ok && !result.backoff && !asked.void
  const declined = withTaskEntry(
    family.declined,
    result.key,
    asked.task,
    declines ? asked.inputFingerprint : undefined
  )
  if (asked.void) return { ...family, preparing, declined }
  return {
    ...family,
    preparing,
    declined,
    ready: result.ok
      ? { ...family.ready, [result.key]: { ...asked, answer: result } }
      : family.ready
  }
}

/**
 * Forgets each submitted act the kernel has answered, and holds the task of one it refused as stale
 * until its fact is read again.
 */
const noticed = (family: Family, activity: readonly KernelActivity[]): Family => {
  const notices = new Map(activity.flatMap(a => (a.type === 'notice' ? [[a.intentId, a]] : [])))
  let { stale } = family
  const submitted = Object.fromEntries(
    Object.entries(family.submitted).filter(([key, sent]) => {
      const notice = notices.get(sent.intentId)
      if (isStaleRefusal(notice))
        stale = withTaskEntry(stale, key, sent.task, readingFingerprintOf(sent.readings))
      return notice === undefined
    })
  )
  return { ...family, submitted, stale }
}

/** Each kernel's family, by the kernel's own `kernel.state` node, which no handle can stand in for. */
const familyOf = new WeakMap<Node<unknown>, Node<unknown>>()

/**
 * Prepares and submits the task each candidate's `policy` wants; the runtime alone admits, rests
 * each act on the family's fact, and fails a key closed whose policy return it refuses. The
 * contract is `framework/controller/SPEC.md` §5; its logs are {@link logTasks}'s.
 * @throws GraphDefinitionError - for a second family on one kernel ({@link secondFamily}).
 */
const each = <C, I>(b: Bot, id: string, options: TaskFamilyOptions<C, I>) => {
  const { requests, prepared } = b.raw(g =>
    g.scope(id, s => ({
      requests: s.node<KernelRequest>('requests'),
      prepared: s.node<PrepareResult>('prepared')
    }))
  )
  const first = familyOf.get(options.kernel.nodes.state)
  if (first) throw secondFamily(requests, first)
  familyOf.set(options.kernel.nodes.state, requests)
  options.kernel.requestsFrom(requests)
  const { domain, view, nodes: kernel } = options.kernel
  const { timeoutMs } = options.prepare
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS)
    throw new GraphDefinitionError(
      `${id} needs prepare.timeoutMs, a whole number of milliseconds from 1 to ${MAX_TIMER_MS}`
    )
  if (parseIntentId(intentIdOf('key', options.runId, 0, 'task'))?.runId !== options.runId)
    throw new GraphDefinitionError(`${id} needs a runId that holds neither '.' nor '#'`)
  const { maxReservations } = options
  if (!Number.isSafeInteger(maxReservations) || maxReservations < 0)
    throw new GraphDefinitionError(`${id} needs maxReservations, a whole number from 0`)
  const factNodes: readonly FactNode<string>[] = Array.isArray(options.facts)
    ? options.facts
    : [options.facts as FactNode<string>]
  if (factNodes.length === 0) throw new GraphDefinitionError(`${id} rests on no fact`)
  onBuild(b, graph => {
    for (const fact of factNodes) checkFactKernelFree(graph, id, fact.id, kernel)
  })
  /** The key's reading of every fact, or undefined while any is unknown or failed. */
  const readingsOf = (family: Family, key: string) => {
    const readings = factNodes.map((node, i) => factOf(node, family.facts[i] ?? undefined, key))
    return readings.every(reading => reading !== undefined) ? readings : undefined
  }
  /** Each fact's read in the family fold; the first keeps `facts`, so a one-fact graph is unchanged. */
  const factReads = factNodes.map((_, i) => (i === 0 ? 'facts' : `facts${i}`))
  return b.raw(g =>
    g.scope(id, s => {
      const events = s.node<TaskEvent>('events')
      const backoff = declareBackoff(s, 'backoff', {
        runId: options.runId,
        prepared,
        submitted: events,
        activity: kernel.activity,
        heads: kernel.heads,
        policy: options.backoff
      })
      const prepare = s.node<PrepareRequest<I>>('prepare')
      const wantedNode = s.node<Readonly<Record<string, Wanted>>>('wanted')

      /** A decision in progress: the family as it stands so far, and what it has emitted. */
      type Draft = { -readonly [F in keyof Family]: Family[F] } & {
        wanted: Record<string, Wanted>
        ready: Record<string, Ready>
        preparing: Record<string, Preparation>
        submitted: Record<string, Sent>
        rejected: Record<string, Rejection>
        emit: Emit[]
      }

      const busy = (family: Family, key: string) =>
        isBusy(family.view, key) || has(family.submitted, key)

      /** The view's reservations plus the family's own acts awaiting a notice. */
      const reservedOf = (family: Family) =>
        (family.view?.numReservations ?? 0) + Object.keys(family.submitted).length

      const submitHold = (family: Family, key: string, task: string): PhaseDetail | undefined => {
        if (family.view?.acceptingNewWork !== true) return 'not_accepting'
        if (reservedOf(family) >= maxReservations) return 'reservations_full'
        if (busy(family, key)) return 'busy'
        if (isBackedOff(family.backoff, key, task)) return 'backed_off'
        return undefined
      }

      const prepareHold = (family: Family): PhaseDetail | undefined => {
        const outstanding = Object.keys(family.preparing).length
        if (family.view?.acceptingNewWork !== true) return 'not_accepting'
        if (outstanding >= options.prepare.lane.concurrency) return 'lane_full'
        if (reservedOf(family) + outstanding + Object.keys(family.ready).length >= maxReservations)
          return 'reservations_full'
        return undefined
      }

      const holdOf = (
        family: Family,
        wanted: Readonly<Record<string, Wanted>>,
        key: string,
        now: number
      ): Hold | undefined => {
        const ready = entryOf(family.ready, key)
        const preparing = entryOf(family.preparing, key)
        if (has(family.submitted, key)) return { phase: 'submitted' }
        if (ready) return { phase: 'ready', ...detailOf(submitHold(family, key, ready.task)) }
        if (preparing) return { phase: 'preparing', ...(preparing.void && { detail: 'void' }) }
        if (isBusy(family.view, key)) return { phase: 'in_flight' }
        const want = entryOf(wanted, key)
        if (want === undefined) return { phase: 'not_candidate' }
        if (want.kind === 'rejected') return { phase: 'rejected', detail: want.reason }
        const facts = family.facts.map(keyed => keyed && keyRecord(keyed, key))
        if (facts.some(fact => fact?.status !== 'present'))
          return { phase: 'waiting', detail: 'fact_unavailable' }
        if (
          facts.some(
            fact => fact?.status === 'present' && fact.expiry !== undefined && fact.expiry <= now
          )
        )
          return { phase: 'waiting', detail: 'fact_expired' }
        if ((family.inputs && keyRecord(family.inputs, key))?.status !== 'present')
          return { phase: 'waiting', detail: 'input_unavailable' }
        const readings = () => readingsOf(family, key)
        if (predatesOwnEffect(family.view, want, readings))
          return { phase: 'waiting', detail: 'predates_own_effect' }
        const declined = taskEntryOf(family.declined, key, want.name)
        if (declined !== undefined && declined === inputFingerprintOf(family, key))
          return { phase: 'declined' }
        const stale = taskEntryOf(family.stale, key, want.name)
        if (stale !== undefined && stale === readingFingerprintOf(readings()))
          return { phase: 'stale' }
        const backoff = backoffHolding(family.backoff, key, want.name)
        if (backoff)
          return { phase: 'backed_off', until: backoff.until, failures: backoff.failures }
        return undefined
      }

      const drop = (draft: Draft, key: string, reason: DropReason) => {
        const { task, inputFingerprint, readings } = draft.ready[key]!
        delete draft.ready[key]
        if (reason === 'fact_unbounded')
          draft.declined = withTaskEntry(draft.declined, key, task, inputFingerprint)
        draft.emit.push(
          emitTo(events, {
            type: 'dropped',
            key,
            task,
            reason,
            ...(reason === 'fact_unbounded' && { fact: readings.map(r => r.fact.id).join('+') })
          })
        )
      }

      const submit = (draft: Draft, key: string, now: number) => {
        const ready = entryOf(draft.ready, key)!
        const reason = submitDrop(ready, readingsOf(draft, key), now)
        if (reason) return drop(draft, key, reason)
        const want = entryOf(draft.wanted, key) as Task
        const { exemptFromBackoff, maxSpendWei } = ready.answer
        const intentId = intentIdOf(key, options.runId, draft.issued++, ready.task)
        const plan = act(domain, {
          intentId,
          steps: ready.answer.steps,
          restsOn: ready.readings,
          ...(ready.answer.validUntil !== undefined && { validUntil: ready.answer.validUntil }),
          conflicts: ready.conflicts,
          decision: { key, priority: String(want.priority), prepared: ready.id },
          ...(maxSpendWei !== undefined && { maxSpendWei })
        })
        delete draft.ready[key]
        draft.submitted[key] = { intentId, task: ready.task, readings: ready.readings }
        draft.served = key
        draft.emit.push(
          emitTo(requests, { type: 'Submit', plan }),
          emitTo(events, {
            type: 'submitted',
            key,
            intentId,
            priority: want.priority,
            block: plan.basisBlock,
            ...(exemptFromBackoff !== undefined &&
              exemptFromBackoff.length > 0 && { exemptFromBackoff })
          })
        )
      }

      /** Reads each present candidate's policy: its one read this decision (§5.2). */
      const normalizePolicies = (draft: Draft, family: Family) => {
        for (const key of Object.keys(family.candidates?.keys ?? {})) {
          const candidate = keyRecord(family.candidates!, key)
          if (candidate.status !== 'present') continue
          const want = normalizePolicy(options.policy, candidate.value as C, key)
          draft.wanted[key] = want
          if (want.kind !== 'rejected') continue
          draft.rejected[key] = want.reason
          const ticket = entryOf(draft.preparing, key)
          if (ticket && !ticket.void) draft.preparing[key] = { ...ticket, void: true }
          if (entryOf(family.rejected, key) !== want.reason)
            draft.emit.push(emitTo(events, { type: 'rejected', key, reason: want.reason }))
        }
      }

      /** Asks for preparations in rank order, taking turns from `served` as the decision began. */
      const prepareNext = (draft: Draft, served: string, now: number) => {
        // Every task's reading is taken before any hold short-circuits, so a malformed basis fails
        // the decision whatever holds its key (§2.2).
        const keys = Object.keys(draft.wanted).filter(key => {
          if (draft.wanted[key]!.kind === 'task') readingsOf(draft, key)
          return !holdOf(draft, draft.wanted, key, now)
        })
        for (const key of ranked(served, draft.wanted, keys)) {
          if (prepareHold(draft)) break
          const seq = draft.issued++
          const ticket = `${options.runId}.p${seq}`
          const readings = readingsOf(draft, key)!
          const version = versionOf(readings)
          const input = keyRecord(draft.inputs!, key) as Extract<
            KeyRecord<I>,
            { status: 'present' }
          >
          const { name, conflicts } = entryOf(draft.wanted, key) as Task
          draft.preparing[key] = {
            id: ticket,
            readings,
            inputFingerprint: inputFingerprintOf(draft, key),
            task: name,
            conflicts
          }
          draft.served = key
          draft.emit.push(
            emitTo(prepare, { id: ticket, key, seq, version, input: input.value, task: name })
          )
        }
      }

      /** Ends with the policy's results on `${id}.wanted`, after every other emit. */
      const decide = (family: Family, now: number): { state: Family; emit: Emit[] } => {
        const draft: Draft = {
          ...family,
          wanted: ownRecord(),
          ready: ownRecord(family.ready),
          preparing: ownRecord(family.preparing),
          submitted: ownRecord(family.submitted),
          rejected: ownRecord(),
          emit: []
        }
        normalizePolicies(draft, family)
        for (const [key, ready] of Object.entries(draft.ready)) {
          const reason = heldDrop(ready, entryOf(draft.wanted, key), now)
          if (reason) drop(draft, key, reason)
        }
        if (draft.view?.acceptingNewWork === true) {
          for (const key of ranked(family.served, draft.wanted, Object.keys(draft.ready)))
            if (!submitHold(draft, key, draft.ready[key]!.task)) submit(draft, key, now)
          prepareNext(draft, family.served, now)
        }
        const { emit, wanted, ...decided } = draft
        return {
          state: {
            ...decided,
            declined: keptTaskEntries(
              draft.declined,
              (key, fingerprint) => fingerprint === inputFingerprintOf(family, key)
            ),
            stale: keptTaskEntries(
              family.stale,
              (key, fingerprint) => fingerprint === readingFingerprintOf(readingsOf(family, key))
            )
          },
          emit: [...emit, emitTo(wantedNode, wanted)]
        }
      }

      /** Each key the family knows of, in the phase its rules hold it in at `now` (§5.9). */
      const phasesOf = (
        family: Family,
        wanted: Readonly<Record<string, Wanted>>,
        now: number
      ): Readonly<Record<string, KeyPhase>> => {
        const phases = ownRecord<KeyPhase>()
        const keys = new Set([
          ...Object.keys(wanted),
          ...Object.keys(family.submitted),
          ...Object.keys(family.ready),
          ...Object.keys(family.preparing),
          ...(family.view?.busy ?? [])
        ])
        for (const key of keys) {
          const hold = holdOf(family, wanted, key, now) ?? {
            phase: 'eligible' as const,
            ...detailOf(prepareHold(family))
          }
          if (hold.phase === 'not_candidate') continue
          const want = entryOf(wanted, key)
          const working =
            entryOf(family.submitted, key) ??
            entryOf(family.ready, key) ??
            entryOf(family.preparing, key)
          const task = working?.task ?? (want?.kind === 'task' ? want.name : undefined)
          phases[key] = {
            ...hold,
            phase: hold.phase,
            ...(task !== undefined && { task }),
            ...(want?.kind === 'task' && { priority: want.priority })
          }
        }
        return phases
      }

      const initial: Family = {
        facts: factNodes.map(() => null),
        preparing: {},
        ready: {},
        declined: {},
        stale: {},
        rejected: {},
        submitted: {},
        served: '',
        issued: 0
      }
      const state = s.fold('', {
        reads: {
          candidates: watch(options.candidates),
          ...(Object.fromEntries(factNodes.map((node, i) => [factReads[i], watch(node)])) as {
            facts: ReturnType<typeof watch<Keyed<unknown>>>
          }),
          inputs: watch(options.inputs),
          view: watch(view),
          backoff: watch(backoff.state),
          prepared: every(prepared),
          activity: every(kernel.activity)
        },
        emits: [prepare, requests, events, wantedNode],
        initial,
        applyInput: (family, input) => {
          if (input.from === 'prepared') {
            const result = input.value
            return {
              state: answered(family, result),
              emit: faultOf(result).map(fault => emitTo(events, fault))
            }
          }
          if (input.from === 'activity') return { state: noticed(family, input.value) }
          const fact = factReads.indexOf(input.from)
          if (fact >= 0)
            return {
              state: {
                ...family,
                facts: family.facts.with(
                  fact,
                  (input.value.value as Keyed<unknown> | undefined) ?? null
                )
              }
            }
          return { state: { ...family, [input.from]: input.value.value } }
        },
        afterInputs: (family, stamp) => decide(family, stamp.at)
      })

      s.effect('preparation', {
        requests: { request: every(prepare) },
        results: prepared,
        lane: options.prepare.lane,
        identify: ({ value }) => value.id,
        sequence: ({ value }) => value.seq,
        handle: async ({ value: request }, context) => {
          const { id, key, task, version } = request
          const outcome = await prepareWithin(
            { ...options.prepare, timeoutMs },
            request,
            context.signal
          )
          if (outcome) context.write({ ...outcome, id, key, task, version })
        }
      })

      const phase = declarePhase(
        s,
        { family: sample(state), wanted: every(wantedNode) },
        ({ family, wanted }) => {
          const { value, stamp } = wanted.at(-1)!
          return phasesOf(family, value, stamp.at)
        },
        PHASE_FIELDS
      )

      return { state, events, backoff, requests, prepared, phase }
    })
  )
}

export const tasks = { each }

/**
 * Logs each event as `act.${type}` with its fields and its key as `id`: `rejected` and
 * `prepare_failed` warn.
 */
export const logTasks = (logger: LogSink, { type, key, ...fields }: TaskEvent) =>
  logger[type === 'rejected' || type === 'prepare_failed' ? 'warn' : 'info'](`act.${type}`, {
    id: key,
    ...fields
  })

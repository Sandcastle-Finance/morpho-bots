import type {
  Graph,
  GraphBuilder,
  Keyed,
  KeyRecord,
  Node,
  NodeRecord,
  Stamp,
  StepObserver,
  Stream
} from '@repo/engine'

import { describeGraph, every, GraphDefinitionError, isKeyed, lane } from '@repo/engine'

import type { Logger } from './logger'

/** The `live.*` protocol between kit and `tools/realtime-app`; a change to a line's shape bumps it. */
export const LIVE_PROTOCOL = 2
/** The largest `live.snapshot` or `live.graph` part, or `live.flow` line, in bytes of JSON. */
export const LIVE_PART_BYTES = 8 * 1024
/** The longest scalar a shown field may hold, and the longest field name: a 32-byte hex word. */
const FIELD_CHARS = 66
/** The most fields a shown value logs, so any one key or node fits in a snapshot part. */
const FIELD_LIMIT = 32
/** The longest key a line names; a node holding a longer one says it omits keys. */
const KEY_CHARS = 160
/** A keyed node once over this many keys logs its status and coverage only, for the rest of the run. */
const KEY_LIMIT = 4_096
const QUEUE_CAPACITY = 8_192
/** How long one tick's work runs before it yields to the next tick. */
const BUDGET_MS = 5
const SNAPSHOT_EVERY_MS = 30_000
/** What a line's envelope (`v`, `run`, `n`, and a part's ids and stamps or a flow's) may take. */
const ENVELOPE_BYTES = 512
const ROOM_BYTES = LIVE_PART_BYTES - ENVELOPE_BYTES

type Scalar = string | number | boolean | null

/** A shown keyed node, drawn as spans while its `label` field keeps its value. */
type ShownKeyed = Readonly<{ node: Node<Keyed<unknown>>; label: string }>
type Shown = Node<unknown> | ShownKeyed

/** A keyed node may be shown only with the field it is labelled by. */
type Showable<S> =
  S extends Node<infer T> ? (NonNullable<T> extends Keyed<unknown> ? ShownKeyed : S) : S

export type LiveLogOptions<S extends readonly Shown[]> = Readonly<{
  /** The clock whose ticks run the comparing and logging; the kernel's `nodes.tick`. */
  on: Stream<unknown>
  /** The nodes whose values are logged, each field shape-guarded; every other node logs statuses. */
  show: { readonly [I in keyof S]: Showable<S[I]> }
  run: string
  logger: Logger
  /**
   * How many written nodes may wait to be compared, and how many steps to be logged, before the
   * rest are dropped and repaired.
   */
  capacity?: number
}>

export type LiveLog = Readonly<{
  /** For `createRunner`'s `observe`; it never logs, except one `live.gap` when the graph degrades. */
  observe: StepObserver
  /** Once the run has ended, logs everything still queued and a last `live.flow`; once only. */
  flush: () => void
  /**
   * Logs `graph`'s topology as `live.graph` with every snapshot, and names nodes in `live.flow` by
   * their index in it; without it, flows name nodes by id and the live view draws no edges.
   * @throws GraphDefinitionError - for an operator or effect too wide for one part.
   */
  describe: (graph: Graph) => void
}>

type GapReason = 'overflow' | 'observer_failed' | 'handler_failed' | 'degraded'

/** Consecutive steps that wrote the same nodes, in the order written, with each step's own `at`. */
type Steps = { seq: number; ats: number[]; nodes: readonly string[] }

type FlowLine = { t0: number; steps: unknown[][]; last: Stamp }

type GraphPart = Readonly<{
  format: number
  nodes: object[]
  operators: object[]
  effects: object[]
}>

/** A graph's `live.graph` parts, and each node's index in their `nodes`. */
type Topology = Readonly<{ parts: readonly GraphPart[]; index: ReadonlyMap<string, number> }>

type Entry =
  | Readonly<{ kind: 'record'; node: string; stamp: Stamp; record: NodeRecord<unknown> }>
  | Readonly<{ kind: 'status'; node: string; stamp: Stamp; status: string; coverage?: string }>
  | Readonly<{ kind: 'snapshot'; through: Stamp }>

/** What a line may say a node, a key or a coverage is: never a value of a node's own choosing. */
const NODE_STATUSES: ReadonlySet<unknown> = new Set(['unwritten', 'present', 'unknown', 'failed'])
const KEY_STATUSES: ReadonlySet<unknown> = new Set(['present', 'absent', 'unknown', 'failed'])
const COVERAGES: ReadonlySet<unknown> = new Set(['complete', 'unknown', 'failed'])
const statusIn = (statuses: ReadonlySet<unknown>, status: unknown) =>
  statuses.has(status) ? (status as string) : 'invalid'

type Guarded = Readonly<{ value?: unknown; suppressed?: number; text: string }>
type KeyPicture = Readonly<{ status: string; shown?: Guarded }>
type Picture = {
  status: string
  coverage?: string
  overLimit?: true
  keys?: Map<string, KeyPicture>
  /** The `keys` record last compared, so an identical key record is skipped by identity. */
  source?: Keyed<unknown>['keys']
  shown?: Guarded
}

const isScalar = (value: unknown): value is Scalar | bigint =>
  value === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof value)

/** A record that holds any key as its own, `__proto__` included. */
const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>

/** Printable ASCII that JSON never escapes (no `"` or `\`), so a field's length is its bytes. */
const SHORT_TEXT = new RegExp(`^[\\x20\\x21\\x23-\\x5b\\x5d-\\x7e]{0,${FIELD_CHARS}}$`)

const guardScalar = (value: unknown): Scalar | undefined => {
  if (!isScalar(value)) return undefined
  const scalar = typeof value === 'bigint' ? value.toString() : value
  return typeof scalar === 'string' && !SHORT_TEXT.test(scalar) ? undefined : scalar
}

/**
 * Each of the first {@link FIELD_LIMIT} fields that is a scalar of at most {@link FIELD_CHARS}
 * printable ASCII characters, under such a name other than `reason`; the rest are counted as
 * suppressed. Any one guarded value so fits in a snapshot part.
 */
const guard = (value: unknown): Guarded => {
  if (value === undefined) return { text: '' }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    const scalar = guardScalar(value)
    return scalar === undefined
      ? { suppressed: 1, text: '!' }
      : { value: scalar, text: JSON.stringify(scalar) }
  }
  const fields = dictionary<Scalar>()
  let suppressed = 0
  let kept = 0
  for (const [name, field] of Object.entries(value)) {
    if (field === undefined) continue
    const scalar = guardScalar(field)
    const named = SHORT_TEXT.test(name) && name !== 'reason'
    if (scalar === undefined || !named || kept === FIELD_LIMIT) suppressed++
    else {
      fields[name] = scalar
      kept++
    }
  }
  return {
    value: fields,
    ...(suppressed > 0 && { suppressed }),
    text: JSON.stringify([fields, suppressed])
  }
}

const shownFields = (shown: Guarded | undefined) =>
  shown && {
    ...(shown.value !== undefined && { value: shown.value }),
    ...(shown.suppressed !== undefined && { suppressed: shown.suppressed })
  }

/** Whether `keys` holds more than `limit` keys, counting no further than that. */
const exceeds = (keys: object, limit: number) => {
  let count = 0
  for (const key in keys) if (Object.hasOwn(keys, key) && ++count > limit) return true
  return false
}

const isShownKeyed = (entry: Shown): entry is ShownKeyed =>
  typeof entry === 'object' && 'node' in entry && 'label' in entry

/** A stream records every write and holds no value to show; a level holds one, though it never coalesces. */
const refuseStream = (g: GraphBuilder, node: Node<unknown>) => {
  const level = (node as { source?: unknown }).source === 'level'
  if (!level && !g.coalesces(node))
    throw new GraphDefinitionError(`the live log cannot show ${node.id}, which is a stream`)
}

const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

const sameNodes = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((node, index) => node === right[index])

/** Ids, producers, shapes and edges only: never an alias, lane, policy or value. */
const topologyOf = (graph: Graph): Topology => {
  const { format, nodes, operators, effects } = describeGraph(graph)
  const lists = {
    nodes: nodes.map(({ id, producer, shape }) => ({ id, by: producer.by, shape })),
    operators: operators.map(op => ({
      id: op.id,
      reads: op.reads.map(({ node, mode }) => ({ node, mode })),
      ...(op.kind === 'fold' && op.emits.length > 0 && { emits: op.emits })
    })),
    effects: effects.map(({ id, requests, samples, results }) => ({
      id,
      requests: requests.map(({ node }) => node),
      samples: samples.map(({ node }) => node),
      ...(results !== undefined && { results })
    }))
  }
  const empty = () => ({ format, nodes: [], operators: [], effects: [] })
  const parts: GraphPart[] = [empty()]
  const emptySize = byteLength(empty())
  let size = emptySize
  for (const list of ['nodes', 'operators', 'effects'] as const)
    for (const item of lists[list]) {
      const bytes = byteLength(item) + 1
      if (emptySize + bytes > ROOM_BYTES)
        throw new GraphDefinitionError(`the live log cannot fit ${item.id} in a live.graph part`)
      if (size + bytes > ROOM_BYTES && size > emptySize) {
        parts.push(empty())
        size = emptySize
      }
      parts.at(-1)![list].push(item)
      size += bytes
    }
  return { parts, index: new Map(nodes.map(({ id }, index) => [id, index])) }
}

/**
 * `held` as the `t0` and `steps` of consecutive flow lines, each within {@link ROOM_BYTES}. A
 * line's first step is its `t0`; every later one is a delta from the step before it, and a step
 * whose delta would not add back to its `at` exactly opens a line of its own. `dropped` says a
 * step wrote too many nodes for any line.
 */
const flowLinesOf = (held: readonly Steps[], name: (node: string) => number | string) => {
  const lines: FlowLine[] = []
  let dropped = false
  let size = 0
  let previous = 0
  for (const { seq, ats, nodes } of held) {
    const names = nodes.map(name)
    const opening = (offset: number, delta: number) =>
      byteLength([seq + offset, [delta], ...names]) + 1
    if (opening(ats.length, 0) > ROOM_BYTES) {
      dropped = true
      continue
    }
    let deltas: number[] | undefined
    for (const [offset, at] of ats.entries()) {
      let delta = at - previous
      let bytes = deltas ? String(delta).length + 1 : opening(offset, delta)
      if (lines.length === 0 || size + bytes > ROOM_BYTES || previous + delta !== at) {
        lines.push({ t0: at, steps: [], last: { seq: seq + offset, at } })
        size = 0
        delta = 0
        deltas = undefined
        bytes = opening(offset, 0)
      }
      const line = lines.at(-1)!
      if (!deltas) {
        deltas = []
        line.steps.push([seq + offset, deltas, ...names])
      }
      deltas.push(delta)
      size += bytes
      previous = at
      line.last = { seq: seq + offset, at }
    }
  }
  return { lines, dropped }
}

/**
 * Logs what changed in a graph, step by step, as the `live.*` lines of the plan's live view: the
 * observer only queues each written node's record, and an effect on `on` compares and logs under a
 * {@link BUDGET_MS} budget per tick. No line ever holds a `reason` or a value of a node not shown.
 * @throws GraphDefinitionError - for a stream in `show`, a node shown twice, an empty label, or a
 * capacity that is not a positive safe integer.
 */
export const declareLiveLog = <const S extends readonly Shown[]>(
  g: GraphBuilder,
  options: LiveLogOptions<S>
): LiveLog => {
  const { logger, run } = options
  const capacity = options.capacity ?? QUEUE_CAPACITY
  if (!(Number.isSafeInteger(capacity) && capacity > 0))
    throw new GraphDefinitionError('the live log needs a positive safe-integer capacity')
  const labels = new Map<string, string | undefined>()
  for (const entry of options.show as readonly Shown[]) {
    const node = isShownKeyed(entry) ? entry.node : entry
    refuseStream(g, node)
    if (labels.has(node.id)) throw new GraphDefinitionError(`the live log shows ${node.id} twice`)
    if (isShownKeyed(entry) && !(typeof entry.label === 'string' && entry.label.length > 0))
      throw new GraphDefinitionError(`the live log shows ${node.id} with no label field`)
    labels.set(node.id, isShownKeyed(entry) ? entry.label : undefined)
  }

  const latest = new Map<string, NodeRecord<unknown>>()
  let queue: Entry[] = []
  let held: Steps[] = []
  let heldSteps = 0
  let topology: Topology | undefined
  let graphDue = false
  let head: Stamp = { seq: 0, at: 0 }
  let through: Stamp = head
  let overflowed = false
  let observerFailed = false
  let ended = false
  let repair: GapReason | 'first' | undefined = 'first'
  let lastSnapshotAt = -Infinity
  let n = 0
  let snapshots = 0
  let graphs = 0
  const pictures = new Map<string, Picture>()
  /**
   * Keyed nodes found over the key limit, which the step path queues as their status and coverage.
   * It only grows: counting a large node's keys costs as much as it is large.
   */
  const large = new Set<string>()
  /** Keyed nodes that held a key over {@link KEY_CHARS}, for the rest of the run. */
  const keysOmitted = new Set<string>()
  const omission = (node: string) => keysOmitted.has(node) && { keysOmitted: true }

  const line = (event: string, fields: Record<string, unknown>) =>
    logger.info(event, { v: LIVE_PROTOCOL, run, n: n++, ...fields })

  const entryOf = (node: string, record: NodeRecord<unknown>, stamp: Stamp): Entry => {
    const keyed = isKeyed(record.value)
    if (large.has(node) && keyed)
      return {
        kind: 'status',
        node,
        stamp,
        status: record.status,
        coverage: record.value.coverage.status
      }
    return labels.has(node) || keyed
      ? { kind: 'record', node, stamp, record }
      : { kind: 'status', node, stamp, status: record.status }
  }

  /** Holds a step for the next flow, folded into the steps before it when it wrote the same nodes. */
  const hold = ({ seq, at }: Stamp, nodes: readonly string[]) => {
    if (heldSteps >= capacity) {
      overflowed = true
      return
    }
    heldSteps++
    const last = held.at(-1)
    if (last && last.seq + last.ats.length === seq && sameNodes(last.nodes, nodes))
      last.ats.push(at)
    else held.push({ seq, ats: [at], nodes })
  }

  const observe: StepObserver = step => {
    if (ended) return
    try {
      if (step.degraded) {
        ended = true
        try {
          line('live.gap', { reason: 'degraded', through })
        } catch {
          return
        }
        return
      }
      head = step.stamp
      const nodes: string[] = []
      for (const { node, record } of step.recorded) {
        latest.set(node, record)
        nodes.push(node)
        if (queue.length < capacity) queue.push(entryOf(node, record, step.stamp))
        else overflowed = true
      }
      if (step.stamp.seq > 0) hold(step.stamp, nodes)
    } catch (error) {
      observerFailed = true
      throw error
    }
  }

  /** The key's line, when its status or shown value changed. */
  const compareKey = (
    node: string,
    stamp: Stamp,
    picture: Picture,
    key: string,
    record: KeyRecord<unknown> | undefined,
    gone: string,
    loud: boolean
  ) => {
    const status = record ? statusIn(KEY_STATUSES, record.status) : gone
    const shown =
      labels.get(node) !== undefined && record?.status === 'present'
        ? guard(record.value)
        : undefined
    const before = picture.keys!.get(key)
    if (record === undefined) picture.keys!.delete(key)
    if (before?.status === status && before.shown?.text === shown?.text) return
    if (record !== undefined) picture.keys!.set(key, { status, ...(shown && { shown }) })
    if (key.length > KEY_CHARS) {
      if (keysOmitted.has(node)) return
      keysOmitted.add(node)
      if (loud) logCoverage(node, stamp, picture)
      return
    }
    if (!loud) return
    line('live.record', {
      node,
      seq: stamp.seq,
      at: stamp.at,
      key: { id: key, status, ...shownFields(shown) }
    })
  }

  /** A node that holds no keyed value: its status, and its value when shown. */
  const compareValue = (
    node: string,
    stamp: Stamp,
    picture: Picture,
    status: string,
    value: unknown,
    loud: boolean
  ) => {
    const shown = labels.has(node) && status === 'present' ? guard(value) : undefined
    if (picture.status === status && picture.shown?.text === shown?.text) return
    pictures.set(node, { status, ...(shown && { shown }) })
    if (loud)
      line('live.record', { node, seq: stamp.seq, at: stamp.at, status, ...shownFields(shown) })
  }

  const logCoverage = (node: string, stamp: Stamp, picture: Picture) =>
    line('live.record', {
      node,
      seq: stamp.seq,
      at: stamp.at,
      status: picture.status,
      coverage: picture.coverage,
      ...(picture.overLimit && { overLimit: true }),
      ...omission(node)
    })

  /** A keyed node's own status, coverage, and whether it holds too many keys to compare. */
  const compareCoverage = (
    node: string,
    stamp: Stamp,
    picture: Picture,
    status: string,
    coverage: string,
    overLimit: boolean,
    loud: boolean
  ) => {
    const checked = statusIn(COVERAGES, coverage)
    if (
      picture.status === status &&
      picture.coverage === checked &&
      (picture.overLimit ?? false) === overLimit
    )
      return
    picture.status = status
    picture.coverage = checked
    if (overLimit) picture.overLimit = true
    else delete picture.overLimit
    if (loud) logCoverage(node, stamp, picture)
  }

  /** A keyed node in {@link large}: its keys are unknown from this step on. */
  const dropKeys = (
    node: string,
    stamp: Stamp,
    picture: Picture,
    status: string,
    coverage: string,
    loud: boolean
  ) => {
    compareCoverage(node, stamp, picture, status, coverage, true, loud)
    delete picture.keys
    delete picture.source
  }

  /**
   * Compares one queued entry with its node's picture, logging each change when `loud`. A keyed
   * node over the key limit joins {@link large} and drops its keys.
   */
  function* compare(entry: Exclude<Entry, { kind: 'snapshot' }>, loud: boolean) {
    const { node, stamp } = entry
    const picture = pictures.get(node) ?? { status: 'unwritten' }
    pictures.set(node, picture)
    const status = statusIn(
      NODE_STATUSES,
      entry.kind === 'record' ? entry.record.status : entry.status
    )
    if (entry.kind === 'status') {
      if (entry.coverage === undefined) compareValue(node, stamp, picture, status, undefined, loud)
      else dropKeys(node, stamp, picture, status, entry.coverage, loud)
      return
    }
    const value = entry.record.value
    if (!isKeyed(value)) {
      compareValue(node, stamp, picture, status, value, loud)
      return
    }
    if (large.has(node) || exceeds(value.keys, KEY_LIMIT)) {
      large.add(node)
      dropKeys(node, stamp, picture, status, value.coverage.status, loud)
      return
    }
    compareCoverage(node, stamp, picture, status, value.coverage.status, false, loud)
    const before = picture.source
    picture.keys ??= new Map()
    picture.source = value.keys
    const gone = value.absentBasis === undefined ? 'unknown' : 'absent'
    for (const key of Object.keys(value.keys)) {
      const now = value.keys[key]!
      if (before !== undefined && Object.hasOwn(before, key) && before[key] === now) continue
      compareKey(node, stamp, picture, key, now, gone, loud)
      yield
    }
    for (const key of picture.keys.keys()) {
      if (Object.hasOwn(value.keys, key)) continue
      compareKey(node, stamp, picture, key, undefined, gone, loud)
      yield
    }
  }

  const snapshotNode = (node: string, picture: Picture) => ({
    node,
    status: picture.status,
    ...(picture.coverage !== undefined && { coverage: picture.coverage }),
    ...(labels.get(node) !== undefined && { label: labels.get(node) }),
    ...(picture.overLimit && { overLimit: true }),
    ...omission(node),
    ...shownFields(picture.shown)
  })

  const keyEntry = ([key, picture]: [string, KeyPicture]) =>
    [key, { status: picture.status, ...shownFields(picture.shown) }] as const

  /** The whole picture at `at`, in parts of at most {@link LIVE_PART_BYTES}. */
  function* snapshot(at: Stamp) {
    const id = snapshots++
    const room = LIVE_PART_BYTES - ENVELOPE_BYTES
    let part = 0
    let nodes: object[] = []
    let size = 0
    const flush = (last: boolean) => {
      line('live.snapshot', {
        snapshot: id,
        part: part++,
        through: at,
        nodes,
        ...(last && { last })
      })
      nodes = []
      size = 0
    }
    const add = (entry: object) => {
      const bytes = byteLength(entry) + 1
      if (size + bytes > room && nodes.length > 0) flush(false)
      nodes.push(entry)
      size += bytes
    }
    for (const [node, picture] of pictures) {
      const head = snapshotNode(node, picture)
      if (!picture.keys) {
        add(head)
        yield
        continue
      }
      const empty = byteLength({ ...head, keys: {} })
      let keys = dictionary<unknown>()
      let keysSize = empty
      for (const pair of picture.keys) {
        if (pair[0].length > KEY_CHARS) continue
        const [key, value] = keyEntry(pair)
        const bytes = byteLength({ [key]: value })
        if (keysSize + bytes > room) {
          add({ ...head, keys })
          keys = dictionary()
          keysSize = empty
          yield
        }
        keys[key] = value
        keysSize += bytes
      }
      add({ ...head, keys })
      yield
    }
    flush(true)
  }

  function* work() {
    while (queue.length > 0) {
      const entry = queue.shift()!
      if (entry.kind === 'snapshot') {
        through = entry.through
        yield* snapshot(entry.through)
        continue
      }
      const next = queue[0]
      yield* compare(entry, true)
      if (next === undefined || next.kind === 'snapshot' || next.stamp.seq !== entry.stamp.seq)
        through = entry.stamp
      yield
    }
    through = head
  }

  let running: Generator | undefined

  const logGraph = () => {
    if (!topology) return
    const id = graphs++
    const { parts } = topology
    for (const [part, fields] of parts.entries())
      line('live.graph', {
        graph: id,
        part,
        ...(part === parts.length - 1 && { last: true }),
        ...fields
      })
  }

  /** Takes every held step as flow lines, before this tick's repair, which a dropped step needs. */
  const takeFlows = () => {
    const taken = held
    held = []
    heldSteps = 0
    const index = topology?.index
    const { lines, dropped } = flowLinesOf(taken, node => index?.get(node) ?? node)
    if (dropped) overflowed = true
    return lines
  }

  /** Lines that each end at their last step and never claim a later `through`. */
  const logFlows = (lines: readonly FlowLine[]) => {
    if (lines.length === 0) line('live.flow', { head, through, steps: [] })
    for (const [i, { t0, steps, last }] of lines.entries()) {
      const final = i === lines.length - 1
      line('live.flow', {
        head: final ? head : last,
        through: final || through.seq <= last.seq ? through : last,
        t0,
        steps
      })
    }
  }

  /** Starts over from the latest records, quietly, then a snapshot of them at `head`. */
  const rebuild = () => {
    pictures.clear()
    const at = head
    const rebuilt = [...latest].map(([node, record]) => entryOf(node, record, at))
    queue = []
    overflowed = false
    running = (function* () {
      for (const entry of rebuilt) {
        if (entry.kind !== 'snapshot') yield* compare(entry, false)
        yield
      }
      yield* snapshot(at)
      through = at
      yield* work()
    })()
  }

  const step = (now: number, budgetMs: number) => {
    const started = performance.now()
    if (observerFailed) {
      ended = true
      line('live.gap', { reason: 'observer_failed', through })
      return
    }
    const flows = takeFlows()
    if (overflowed) repair = 'overflow'
    if (repair !== undefined) {
      if (repair !== 'first') line('live.gap', { reason: repair, through })
      repair = undefined
      lastSnapshotAt = now
      graphDue = true
      rebuild()
    } else if (now - lastSnapshotAt >= SNAPSHOT_EVERY_MS) {
      lastSnapshotAt = now
      graphDue = true
      queue.push({ kind: 'snapshot', through: head })
    }
    if (graphDue) {
      graphDue = false
      logGraph()
    }
    running ??= work()
    while (performance.now() - started < budgetMs)
      if (running.next().done) {
        running = undefined
        break
      }
    logFlows(flows)
  }

  g.effect('live.log', {
    requests: { tick: every(options.on) },
    lane: lane('live.log', { concurrency: 1, queue: 1 }),
    latestOnly: true,
    handle: (_request, context) => {
      if (ended) return
      try {
        step(context.now(), BUDGET_MS)
      } catch {
        running = undefined
        repair = 'handler_failed'
      }
    }
  })

  return {
    observe,
    flush: () => {
      if (ended) return
      ended = true
      try {
        step(Date.now(), Number.POSITIVE_INFINITY)
      } catch {
        // A failed logger at shutdown loses only lines a later snapshot would have repaired.
      }
    },
    describe: graph => {
      topology = topologyOf(graph)
      graphDue = true
    }
  }
}

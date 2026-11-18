import type { DerivedWrite, NodeRecord } from './core'
import type { Graph, Stamp } from './graph'
import type { JournalEntry } from './journal'

import { createCore, layout } from './core'
import { encode } from './data'
import { expandJournalWrite } from './journal'

export type ReplayReport =
  | Readonly<{ ok: true; steps: number }>
  | Readonly<{ ok: false; step: number; reason: string }>

export type ReplayedWrite = Readonly<{
  node: string
  /** The operator, effect or clock that wrote the node; absent for a source. */
  producer?: string
  /** Whether an operator derived it, so the journal's digest covers it, or it was pushed. */
  derived: boolean
  record: NodeRecord<unknown>
}>

export type Divergence = Readonly<{
  kind: 'diverged'
  stamp: Stamp
  reason: string
  /** The node whose derived write first differs, the operator the step threw in, or a delta's node. */
  node?: string
  expected?: DerivedWrite
  actual?: DerivedWrite
  /** Unverified: the whole step's writes on a digest mismatch, or those made before it threw. */
  writes: readonly ReplayedWrite[]
}>

export type Replayed =
  | Readonly<{
      kind: 'step'
      stamp: Stamp
      wakes: readonly string[]
      writes: readonly ReplayedWrite[]
    }>
  | Divergence
  | Extract<JournalEntry, { kind: 'note' | 'failed' | 'recovery' }>

type StepEntry = Extract<JournalEntry, { kind: 'step' }>

type Difference = Pick<Divergence, 'node' | 'expected' | 'actual'>

const firstDifference = (
  actual: readonly DerivedWrite[],
  expected: readonly DerivedWrite[]
): Difference | undefined => {
  for (let index = 0; index < Math.max(actual.length, expected.length); index += 1) {
    const [replayed, journaled] = [actual[index], expected[index]]
    const differing = journaled ?? replayed
    if (differing && (!replayed || !journaled || encode(replayed) !== encode(journaled)))
      return {
        node: differing.node,
        ...(journaled && { expected: journaled }),
        ...(replayed && { actual: replayed })
      }
  }
  return undefined
}

/**
 * Replays a journal one entry at a time on a fresh copy of `graph`, running no effect. A step's
 * writes come back, in the order the step recorded them, only once its derived writes match the
 * journal's digests; `note`, `failed` and `recovery` entries come back as journaled. The first
 * divergence stops it: that call, and every later one, returns the {@link Divergence}.
 */
export const createReplayer = (graph: Graph) => {
  const pushedBy = new Map<string, string>()
  for (const effect of graph[layout].effects)
    if (effect.results !== undefined) pushedBy.set(effect.results, effect.id)
  for (const spec of graph[layout].nodes.values())
    if (spec.kind === 'clock') pushedBy.set(spec.id, spec.id)

  let recorded: ReplayedWrite[] = []
  const core = createCore(graph, (node, record, operator) => {
    const producer = operator ?? pushedBy.get(node)
    recorded.push({
      node,
      ...(producer !== undefined && { producer }),
      derived: operator !== undefined,
      record
    })
  })
  const previous: Parameters<typeof expandJournalWrite>[1] = new Map()
  const pendingOf = ({ node, value }: { node: string; value: unknown }) => {
    const kind = graph[layout].nodes.get(node)?.kind
    return kind === 'level' || kind === 'occurrence'
      ? core.accept(node, value)
      : core.produced(node, value)
  }
  let diverged: Divergence | undefined

  const step = (entry: StepEntry): Replayed => {
    recorded = []
    const diverge = (reason: string, at: Difference = {}) => {
      diverged = { kind: 'diverged', stamp: entry.stamp, reason, ...at, writes: recorded }
      return diverged
    }
    let derived: readonly DerivedWrite[]
    try {
      const writes = entry.writes.map(write => expandJournalWrite(write, previous))
      const unexpanded = entry.writes.find((_, index) => writes[index] === undefined)
      if (unexpanded)
        return diverge('a keyed delta has no earlier complete write', { node: unexpanded.node })
      derived = core.run(
        writes.map(write => pendingOf(write!)),
        entry.stamp,
        entry.wakes
      )
      for (const effect of graph[layout].effects)
        core.take(`effect:${effect.id}`, Object.keys(effect.reads))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const node = core.failedOperator()
      return diverge(`the step threw: ${reason}`, node === undefined ? undefined : { node })
    }
    const difference = firstDifference(derived, entry.derived)
    if (difference) return diverge('derived writes differ', difference)
    return { kind: 'step', stamp: entry.stamp, wakes: entry.wakes ?? [], writes: recorded }
  }

  return {
    apply: (entry: JournalEntry): Replayed => {
      if (diverged) return diverged
      if (entry.kind === 'recovery')
        core.keepOnly(new Set(graph[layout].recoveries.flatMap(r => r.members)))
      return entry.kind === 'step' ? step(entry) : entry
    }
  }
}

/** {@link createReplayer} over a whole journal, counting steps, or reporting the first that diverges. */
export const replay = (graph: Graph, entries: readonly JournalEntry[]): ReplayReport => {
  const replayer = createReplayer(graph)
  let steps = 0
  for (const entry of entries) {
    const replayed = replayer.apply(entry)
    if (replayed.kind === 'diverged') return { ok: false, step: steps + 1, reason: replayed.reason }
    if (replayed.kind === 'step') steps += 1
  }
  return { ok: true, steps }
}

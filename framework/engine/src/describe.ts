import type { EffectOperator, Graph, Lane, NodeSpec, OperatorSpec, Shape } from './graph'

import { layout } from './core'

/** Bumped whenever {@link GraphDescription} changes, so a reader can refuse one it cannot read. */
export const GRAPH_DESCRIPTION_FORMAT = 1

/** The edge constructor a read was declared with, which fixes when it schedules its reader. */
export type ReadMode = 'latest' | 'sample' | 'every' | 'watch'

export type ReadDescription = Readonly<{ alias: string; node: string; mode: ReadMode }>

export type NodeProducer =
  | Readonly<{ by: 'source' }>
  | Readonly<{ by: 'clock'; everyMs: number }>
  | Readonly<{ by: 'map' }>
  | Readonly<{ by: 'fold' }>
  | Readonly<{ by: 'emit'; fold: string }>
  | Readonly<{ by: 'result'; effect: string }>

export type NodeDescription = Readonly<{
  id: string
  kind: NodeSpec['kind']
  shape: Shape
  coalesces: boolean
  producer: NodeProducer
  /** Whether its producer declared `expiries`; a level's per-write expiry is not visible here. */
  expires: boolean
}>

export type OperatorDescription =
  | Readonly<{ id: string; kind: 'map'; reads: readonly ReadDescription[] }>
  | Readonly<{
      id: string
      kind: 'fold'
      reads: readonly ReadDescription[]
      emits: readonly string[]
      afterInputs: boolean
    }>

export type EffectPolicy =
  | 'identify'
  | 'sequence'
  | 'recovery'
  | 'ready'
  | 'latestOnly'
  | 'finishOnStop'

const POLICIES: readonly EffectPolicy[] = [
  'identify',
  'sequence',
  'recovery',
  'ready',
  'latestOnly',
  'finishOnStop'
]

export type EffectDescription = Readonly<{
  id: string
  requests: readonly Omit<ReadDescription, 'mode'>[]
  samples: readonly Omit<ReadDescription, 'mode'>[]
  results?: string
  /** The {@link LaneDescription.name} of its lane. */
  lane: string
  /** Each policy callback its spec defines, then `latestOnly` and `finishOnStop` when set. */
  policies: readonly EffectPolicy[]
}>

export type LaneDescription = Readonly<{
  /** Its own name, or when an earlier lane took it, the first free `name#2`, `name#3`… */
  name: string
  concurrency: number | 'unbounded'
  queue: number
  budget?: Readonly<{ calls: number; perMs: number }>
}>

/**
 * A built graph's shape as plain data. Nodes are by id; operators in evaluation order; effects and
 * lanes in dispatch order; reads and samples by node; emits and recovery members by id.
 */
export type GraphDescription = Readonly<{
  format: typeof GRAPH_DESCRIPTION_FORMAT
  id: string
  nodes: readonly NodeDescription[]
  operators: readonly OperatorDescription[]
  effects: readonly EffectDescription[]
  lanes: readonly LaneDescription[]
  recovery?: readonly string[]
}>

const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

/**
 * By node, then one node's `every` reads before its others, each in declaration order: the order a
 * fold takes their tied deliveries in.
 */
const byNode = (left: { node: string; mode?: string }, right: { node: string; mode?: string }) =>
  byText(left.node, right.node) || Number(left.mode !== 'every') - Number(right.mode !== 'every')

const readsOf = (reads: OperatorSpec['reads']): ReadDescription[] =>
  Object.entries(reads)
    .map(([alias, edge]) => ({
      alias,
      node: edge.node.id,
      mode: edge.mode === 'latest' && !edge.trigger ? ('sample' as const) : edge.mode
    }))
    .toSorted(byNode)

const namedOf = (entries: readonly (readonly [string, string])[]) =>
  entries.map(([alias, node]) => ({ alias, node })).toSorted(byNode)

const producersOf = (
  operators: readonly OperatorSpec[],
  effects: readonly EffectOperator[]
): ReadonlyMap<string, NodeProducer> =>
  new Map<string, NodeProducer>([
    ...operators.map(op => [op.output, { by: op.kind }] as const),
    ...operators.flatMap(op =>
      op.kind === 'fold' ? op.emits.map(node => [node, { by: 'emit', fold: op.id }] as const) : []
    ),
    ...effects.flatMap(effect =>
      effect.results === undefined
        ? []
        : [[effect.results, { by: 'result', effect: effect.id }] as const]
    )
  ])

/** Names each lane object once, in the order the runner serves them (SPEC §7.2). */
const laneNames = (effects: readonly EffectOperator[]) => {
  const names = new Map<Lane, string>()
  const used = new Set<string>()
  for (const { lane } of effects) {
    if (names.has(lane)) continue
    let name = lane.name
    for (let suffix = 2; used.has(name); suffix++) name = `${lane.name}#${suffix}`
    used.add(name)
    names.set(lane, name)
  }
  return names
}

/** The shape of `graph` as plain data, the same for every build of one declaration. */
export const describeGraph = (graph: Graph): GraphDescription => {
  const { nodes, initials, operators, effects, recoveries } = graph[layout]
  const producers = producersOf(operators, effects)
  const lanes = laneNames(effects)
  const shapeOf = (spec: NodeSpec): Shape =>
    initials.has(spec.id)
      ? 'state'
      : spec.kind === 'level' || (spec.kind === 'derived' && spec.coalesces)
        ? 'value'
        : 'stream'
  const producerOf = (spec: NodeSpec): NodeProducer =>
    spec.clock
      ? { by: 'clock', everyMs: spec.clock.everyMs }
      : (producers.get(spec.id) ?? { by: 'source' })
  return {
    format: GRAPH_DESCRIPTION_FORMAT,
    id: graph.id,
    nodes: [...nodes.values()]
      .map(spec => ({
        id: spec.id,
        kind: spec.kind,
        shape: shapeOf(spec),
        coalesces: spec.coalesces,
        producer: producerOf(spec),
        expires: spec.expiries !== undefined
      }))
      .toSorted((left, right) => byText(left.id, right.id)),
    operators: operators.map(op =>
      op.kind === 'map'
        ? { id: op.id, kind: op.kind, reads: readsOf(op.reads) }
        : {
            id: op.id,
            kind: op.kind,
            reads: readsOf(op.reads),
            emits: op.emits.toSorted(byText),
            afterInputs: op.afterInputs !== undefined
          }
    ),
    effects: effects.map(effect => ({
      id: effect.id,
      requests: namedOf(Object.entries(effect.reads).map(([alias, edge]) => [alias, edge.node.id])),
      samples: namedOf(Object.entries(effect.samples)),
      ...(effect.results !== undefined && { results: effect.results }),
      lane: lanes.get(effect.lane)!,
      policies: POLICIES.filter(
        policy => effect.spec[policy] !== undefined && effect.spec[policy] !== false
      )
    })),
    lanes: [...lanes].map(([lane, name]) => ({
      name,
      concurrency: lane.concurrency === Number.POSITIVE_INFINITY ? 'unbounded' : lane.concurrency,
      queue: lane.queue,
      ...(lane.budget && { budget: { calls: lane.budget.calls, perMs: lane.budget.perMs } })
    })),
    ...(recoveries.length > 0 && {
      recovery: recoveries.flatMap(recovery => recovery.members).toSorted(byText)
    })
  }
}

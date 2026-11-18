import type { JournalEntry, KeyedWrite, Runner, StepObserver } from '@repo/engine'

import {
  createGraph,
  createRunner,
  describeGraph,
  every,
  GraphDefinitionError,
  keyedLevel,
  keyedMap,
  latest,
  sourceWrite
} from '@repo/engine'
import { describe, expect, it } from 'vitest'

import type { Logger } from '../src'

import { declareLiveLog, LIVE_PART_BYTES } from '../src'
import { journaledSteps, liveGraph, liveSteps } from '../src/testing'

type Line = Readonly<{ event: string; fields: Record<string, unknown> }>

const SIGNED = `0x02f8${'5a'.repeat(120)}`
const CALLDATA = `0x2f8f9c2a${'00'.repeat(96)}`
const REVERT = 'execution reverted: 0xcanary-revert-text'

const recording = (lines: Line[], fails: () => boolean = () => false): Logger => {
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    if (fails()) throw new Error('the transport is down')
    lines.push({ event, fields: JSON.parse(JSON.stringify(fields)) as Record<string, unknown> })
  }
  return { debug: log, info: log, warn: log, error: log }
}

type Position = Readonly<{ debt: number; calldata: string }>

/**
 * A bot in miniature: a keyed level of positions, a shown keyed phase over it, a shown health over
 * a level, and a recovery scope that relays ticks as the kernel's clock does.
 */
const liveBot = (
  options: { capacity?: number; logFails?: () => boolean; describe?: boolean } = {}
) => {
  const lines: Line[] = []
  const g = createGraph('live')
  const writes = g.occurrences<KeyedWrite<Position>>('positions.writes')
  const positions = keyedLevel(g, 'positions', writes)
  const phase = keyedMap(g, 'positions.phase', positions, ({ debt, calldata }) => ({
    phase: debt > 5 ? 'big' : 'small',
    calldata
  }))
  const lifecycle = g.level<Readonly<Record<string, unknown>>>('kernel.lifecycle')
  const health = g.map('kernel.health', {
    reads: { lifecycle: latest(lifecycle) },
    compute: ({ lifecycle }) => lifecycle
  })
  const forged = g.level<unknown>('forged')
  const fails = g.occurrences<number>('bot.reads')
  g.fold('bot', {
    reads: { read: every(fails) },
    initial: 0,
    applyInput: (n, { value }) => {
      if (value < 0) throw new Error(REVERT)
      return { state: n + value }
    }
  })
  g.effect('bot.report', {
    requests: { read: every(fails) },
    samples: { health },
    handle: () => {}
  })
  const ticks = g.occurrences<number>('ticks')
  const tick = g.scope(
    'kernel',
    s => {
      const tick = s.node<number>('tick')
      s.fold('clock', {
        reads: { tick: every(ticks) },
        emits: [tick],
        initial: 0,
        applyInput: (n, { value }) => ({ state: n + 1, emit: [{ node: tick, value }] })
      })
      return tick
    },
    { recovery: () => () => undefined }
  )
  const live = declareLiveLog(g, {
    on: tick,
    show: [{ node: phase, label: 'phase' }, health],
    run: 'run-1',
    logger: recording(lines, options.logFails),
    ...(options.capacity !== undefined && { capacity: options.capacity })
  })
  const graph = g.build()
  if (options.describe !== false) live.describe(graph)
  const make = (observe: StepObserver = live.observe, now?: () => number) => {
    const runner = createRunner(graph, { observe, ...(now && { now }) })
    let at = 0
    return {
      runner,
      tick: async () => {
        runner.push(ticks, at++)
        await Promise.resolve()
      }
    }
  }
  return { lines, graph, live, make, writes, positions, phase, lifecycle, forged, fails, ticks }
}

const events = (lines: readonly Line[], event: string) =>
  lines.filter(line => line.event === event).map(line => line.fields)

const records = (lines: readonly Line[]) =>
  events(lines, 'live.record').map(({ node, key, status, coverage, value }) => ({
    node,
    ...(key !== undefined && { key }),
    ...(status !== undefined && { status }),
    ...(coverage !== undefined && { coverage }),
    ...(value !== undefined && { value })
  }))

/** Each node's status, coverage and key statuses, as the last complete snapshot holds them. */
const snapshotPicture = (lines: readonly Line[]) => {
  const parts = events(lines, 'live.snapshot')
  const last = parts.findLast(part => part.last === true)!
  const picture = new Map<string, Record<string, unknown>>()
  for (const part of parts.filter(part => part.snapshot === last.snapshot))
    for (const node of part.nodes as Record<string, unknown>[]) {
      const before = picture.get(node.node as string)
      const keys = { ...(before?.keys as object), ...(node.keys as object) }
      picture.set(node.node as string, { ...node, ...(node.keys !== undefined && { keys }) })
    }
  return picture
}

type KeyStatus = Readonly<{ status: string }>

describe('the live log', () => {
  it('logs one line per changed key or node, with values only of shown nodes', async () => {
    const bot = liveBot()
    const { runner, tick } = bot.make()
    runner.push(bot.writes, {
      coverage: 'complete',
      entries: { a: { debt: 1, calldata: CALLDATA } },
      basis: 1
    })
    await tick()
    expect(events(bot.lines, 'live.snapshot')).toHaveLength(1)
    const graph = liveGraph(bot.lines)
    bot.lines.length = 0
    runner.push(bot.writes, {
      coverage: 'carried',
      entries: { b: { debt: 9, calldata: CALLDATA } },
      basis: 2
    })
    runner.push(bot.writes, {
      coverage: 'carried',
      entries: { a: { debt: 2, calldata: CALLDATA } },
      basis: 3
    })
    runner.push(bot.lifecycle, { value: { lifecycle: 'running', signed: SIGNED }, basis: 1 })
    await tick()
    expect(records(bot.lines)).toStrictEqual([
      { node: 'positions', key: { id: 'b', status: 'present' } },
      {
        node: 'positions.phase',
        key: { id: 'b', status: 'present', value: { phase: 'big' }, suppressed: 1 }
      },
      { node: 'kernel.lifecycle', status: 'present' },
      { node: 'kernel.health', status: 'present', value: { lifecycle: 'running' } }
    ])
    const [flow] = events(bot.lines, 'live.flow')
    expect(flow).toMatchObject({ v: 2, run: 'run-1', head: { seq: 6 }, through: { seq: 6 } })
    expect(liveSteps(bot.lines, graph).flatMap(step => step.nodes)).toEqual(
      expect.arrayContaining(['positions', 'positions.phase', 'kernel.health'])
    )
    expect(bot.lines.map(line => line.fields.n)).toStrictEqual(
      bot.lines.map((_, index) => index + 3)
    )
    await runner.abandon()
  })

  it('logs coverage and every status, and never a reason, signed bytes or calldata', async () => {
    const bot = liveBot()
    const { runner, tick } = bot.make()
    await tick()
    runner.push(bot.writes, {
      coverage: 'complete',
      entries: { a: { debt: 1, calldata: CALLDATA }, b: { debt: 7, calldata: SIGNED } },
      basis: 1
    })
    runner.push(bot.writes, { coverage: 'failed', reason: REVERT })
    runner.push(bot.writes, { coverage: 'failed', keys: ['a'], reason: REVERT })
    runner.push(bot.lifecycle, { status: 'failed', reason: REVERT })
    runner.push(bot.lifecycle, {
      value: { lifecycle: 'running', signed: SIGNED, reason: 'short' },
      basis: 1
    })
    await tick()
    runner.push(bot.writes, { coverage: 'complete', entries: {}, basis: 2, empty: true })
    runner.push(bot.forged, {
      value: { coverage: { status: REVERT }, keys: { k: { status: { reason: REVERT, SIGNED } } } },
      basis: 1
    })
    await tick()
    const phase = (id: string, status: string, value?: string) => ({
      node: 'positions.phase',
      key: { id, status, ...(value && { value: { phase: value }, suppressed: 1 }) }
    })
    const position = (id: string, status: string) => ({ node: 'positions', key: { id, status } })
    expect(records(bot.lines)).toStrictEqual([
      { node: 'positions.writes', status: 'present' },
      { node: 'positions', status: 'present', coverage: 'complete' },
      position('a', 'present'),
      position('b', 'present'),
      { node: 'positions.phase', status: 'present', coverage: 'complete' },
      phase('a', 'present', 'small'),
      phase('b', 'present', 'big'),
      { node: 'positions', status: 'present', coverage: 'failed' },
      { node: 'positions.phase', status: 'present', coverage: 'failed' },
      position('a', 'failed'),
      phase('a', 'failed'),
      { node: 'kernel.lifecycle', status: 'failed' },
      { node: 'kernel.health', status: 'failed' },
      { node: 'kernel.lifecycle', status: 'present' },
      { node: 'kernel.health', status: 'present', value: { lifecycle: 'running' } },
      { node: 'positions', status: 'present', coverage: 'complete' },
      position('a', 'absent'),
      position('b', 'absent'),
      { node: 'positions.phase', status: 'present', coverage: 'complete' },
      phase('a', 'absent'),
      phase('b', 'absent'),
      { node: 'forged', status: 'present', coverage: 'invalid' },
      { node: 'forged', key: { id: 'k', status: 'invalid' } }
    ])
    expect(
      events(bot.lines, 'live.record').find(
        r => r.node === 'kernel.health' && r.status === 'present'
      )
    ).toMatchObject({ suppressed: 2 })
    const text = JSON.stringify(bot.lines)
    for (const secret of [SIGNED, CALLDATA, REVERT, 'reason', 'short'])
      expect(text).not.toContain(secret)
    await runner.abandon()
  })

  it('refuses to show a stream, a node twice, or a keyed node without its label', () => {
    const g = createGraph('refused')
    const writes = g.occurrences<KeyedWrite<number>>('writes')
    const level = keyedLevel(g, 'level', writes)
    const raw = g.level<number>('raw')
    const logger = recording([])
    const on = g.node<number>('tick')
    expect(() => declareLiveLog(g, { on, show: [writes], run: 'r', logger })).toThrow(
      GraphDefinitionError
    )
    expect(() => declareLiveLog(g, { on, show: [on], run: 'r', logger })).toThrow(
      'the live log cannot show tick, which is a stream'
    )
    expect(() => declareLiveLog(g, { on, show: [raw, raw], run: 'r', logger })).toThrow(
      'the live log shows raw twice'
    )
    expect(() =>
      declareLiveLog(g, { on, show: [{ node: level, label: '' }], run: 'r', logger })
    ).toThrow('the live log shows level with no label field')
    const unlabelled = () =>
      // @ts-expect-error a keyed node is shown only with its label field
      declareLiveLog(createGraph('typed'), { on, show: [level], run: 'r', logger })
    expect(unlabelled).toThrow()
  })

  it('drops what a full queue cannot hold, says so, and repairs the picture with a snapshot', async () => {
    const bot = liveBot({ capacity: 8 })
    const { runner, tick } = bot.make()
    await tick()
    bot.lines.length = 0
    for (let i = 0; i < 20; i++)
      runner.push(bot.writes, {
        coverage: 'carried',
        entries: { [`k${i}`]: { debt: i, calldata: CALLDATA } },
        basis: i
      })
    await tick()
    const [gap] = events(bot.lines, 'live.gap')
    expect(events(bot.lines, 'live.gap')).toHaveLength(1)
    expect(gap).toMatchObject({ reason: 'overflow', through: { seq: 1 } })
    expect(records(bot.lines)).toStrictEqual([])
    const picture = snapshotPicture(bot.lines)
    const state = runner.read(bot.positions)!
    const keys = picture.get('positions')!.keys as Record<string, KeyStatus>
    expect(
      Object.fromEntries(Object.entries(keys).map(([key, { status }]) => [key, status]))
    ).toStrictEqual(
      Object.fromEntries(Object.entries(state.keys).map(([key, record]) => [key, record.status]))
    )
    expect(picture.get('positions')).toMatchObject({ status: 'present', coverage: 'unknown' })
    bot.lines.length = 0
    runner.push(bot.writes, {
      coverage: 'carried',
      entries: { k0: { debt: 50, calldata: CALLDATA } },
      basis: 99
    })
    await tick()
    expect(records(bot.lines)).toStrictEqual([
      {
        node: 'positions.phase',
        key: { id: 'k0', status: 'present', value: { phase: 'big' }, suppressed: 1 }
      }
    ])
    await runner.abandon()
  })

  it('splits a snapshot into parts of at most 8 KiB that hold every key', async () => {
    const bot = liveBot()
    const { runner } = bot.make()
    const entries = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, i) => [
        `0x${i.toString(16).padStart(64, '0')}`,
        {
          debt: i,
          calldata: CALLDATA
        }
      ])
    )
    runner.push(bot.writes, { coverage: 'complete', entries, basis: 1 })
    const wide = Object.fromEntries(
      Array.from({ length: 180 }, (_, i) => [
        `f${i}`,
        ['x', '\u0000', '\\', '"'][i % 4]!.repeat(66)
      ])
    )
    runner.push(bot.lifecycle, { value: wide, basis: 1 })
    bot.live.flush()
    const parts = events(bot.lines, 'live.snapshot')
    expect(parts.length).toBeGreaterThan(10)
    for (const part of parts)
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThanOrEqual(LIVE_PART_BYTES)
    const picture = snapshotPicture(bot.lines)
    expect(Object.keys(picture.get('positions.phase')!.keys as object)).toHaveLength(2_000)
    expect(Object.keys(picture.get('positions')!.keys as object)).toHaveLength(2_000)
    expect(picture.get('kernel.health')).toMatchObject({ suppressed: 148 })
    expect(Object.values(picture.get('kernel.health')!.value as object)).toStrictEqual(
      Array.from({ length: 32 }, () => 'x'.repeat(66))
    )
    await runner.abandon()
  })

  it('never fails the run when its logger throws, and repairs once the logger works', async () => {
    let failing = true
    const bot = liveBot({ logFails: () => failing })
    const { runner, tick } = bot.make()
    for (let i = 0; i < 3; i++) {
      runner.push(bot.writes, {
        coverage: 'carried',
        entries: { [`k${i}`]: { debt: i, calldata: CALLDATA } },
        basis: i
      })
      await tick()
    }
    failing = false
    await tick()
    expect(bot.lines[0]).toMatchObject({ event: 'live.gap', fields: { reason: 'handler_failed' } })
    expect(events(bot.lines, 'live.snapshot').length).toBeGreaterThan(0)
    runner.push(bot.fails, 1)
    expect(runner.read(bot.positions)!.keys).toHaveProperty('k2')
    await runner.abandon()
  })

  it('logs one gap at the first recovery step once the graph degrades, then nothing', async () => {
    const bot = liveBot()
    const { runner, tick } = bot.make()
    await tick()
    bot.lines.length = 0
    const stopped = runner.stopped.catch((error: unknown) => error)
    runner.push(bot.fails, -1)
    await tick()
    await tick()
    bot.live.flush()
    expect(bot.lines).toStrictEqual([
      {
        event: 'live.gap',
        fields: {
          v: 2,
          run: 'run-1',
          n: expect.any(Number),
          reason: 'degraded',
          through: { seq: 1, at: expect.any(Number) }
        }
      }
    ])
    await runner.abandon()
    expect(await stopped).toBeInstanceOf(Error)
  })

  it('says the observer was dropped, and the bot carries on', async () => {
    const bot = liveBot()
    let broken = false
    const { runner, tick } = bot.make(step =>
      bot.live.observe(
        broken
          ? {
              ...step,
              get recorded(): never {
                throw new Error('torn')
              }
            }
          : step
      )
    )
    await tick()
    broken = true
    runner.push(bot.writes, {
      coverage: 'complete',
      entries: { a: { debt: 1, calldata: CALLDATA } },
      basis: 1
    })
    expect(runner.observerFailed).toBe(true)
    bot.lines.length = 0
    await tick()
    await tick()
    expect(bot.lines.map(line => line.event)).toStrictEqual(['live.gap'])
    expect(bot.lines[0]!.fields.reason).toBe('observer_failed')
    runner.push(bot.fails, 1)
    expect(runner.read(bot.positions)!.keys).toHaveProperty('a')
    await runner.abandon()
  })

  it('drains its queue through the head, once', async () => {
    const bot = liveBot()
    const { runner, tick } = bot.make()
    await tick()
    bot.lines.length = 0
    runner.push(bot.writes, {
      coverage: 'complete',
      entries: { a: { debt: 1, calldata: CALLDATA } },
      basis: 1
    })
    bot.live.flush()
    expect(records(bot.lines).length).toBeGreaterThan(0)
    const flows = events(bot.lines, 'live.flow')
    expect(flows.at(-1)!.through).toStrictEqual(flows.at(-1)!.head)
    expect(flows.at(-1)!.head).toMatchObject({ seq: 2 })
    bot.live.flush()
    expect(events(bot.lines, 'live.flow')).toHaveLength(1)
    await runner.abandon()
  })

  it('logs a node once over the key limit by its status and coverage only, for the rest of the run', async () => {
    const bot = liveBot()
    const { runner, tick } = bot.make()
    await tick()
    const many = Object.fromEntries(
      Array.from({ length: 4_097 }, (_, i) => [`k${i}`, { debt: 1, calldata: CALLDATA }])
    )
    runner.push(bot.writes, { coverage: 'complete', entries: many, basis: 1 })
    runner.push(bot.writes, {
      coverage: 'complete',
      entries: { a: { debt: 1, calldata: CALLDATA } },
      basis: 2
    })
    await tick()
    runner.push(bot.writes, { coverage: 'failed' })
    await tick()
    bot.live.flush()
    expect(records(bot.lines).filter(record => record.key !== undefined)).toStrictEqual([])
    expect(
      events(bot.lines, 'live.record')
        .filter(record => record.node === 'positions')
        .map(({ coverage, overLimit }) => ({ coverage, overLimit }))
    ).toStrictEqual([
      { coverage: 'complete', overLimit: true },
      { coverage: 'failed', overLimit: true }
    ])
    await runner.abandon()
  })

  it('keeps a key or a shown field named __proto__ in records and snapshots', async () => {
    const bot = liveBot()
    const { runner, tick } = bot.make()
    await tick()
    bot.lines.length = 0
    runner.push(bot.writes, {
      coverage: 'carried',
      entries: JSON.parse('{"__proto__": { "debt": 9, "calldata": "0x" }}') as Record<
        string,
        Position
      >,
      basis: 1
    })
    runner.push(bot.lifecycle, {
      value: JSON.parse('{"__proto__": "running"}') as object,
      basis: 1
    })
    bot.live.flush()
    expect(records(bot.lines)).toEqual(
      expect.arrayContaining([
        { node: 'positions', key: { id: '__proto__', status: 'present' } },
        { node: 'kernel.health', status: 'present', value: JSON.parse('{"__proto__": "running"}') }
      ])
    )
    await runner.abandon()
  })

  it('forgets a key its node stops listing, even one it last listed as absent', async () => {
    let now = 0
    const bot = liveBot()
    const { runner, tick } = bot.make(undefined, () => now)
    const listing = (keys: object, basis: number) =>
      runner.push(bot.forged, {
        value: { coverage: { status: 'complete' }, keys, absentBasis: basis },
        basis
      })
    await tick()
    listing({ k: { status: 'absent' } }, 1)
    await tick()
    listing({}, 2)
    await tick()
    now = 60_000
    await tick()
    expect(snapshotPicture(bot.lines).get('forged')!.keys).toStrictEqual({})
    await runner.abandon()
  })

  it('says once that a node omits a key too long to name, never logs it, and keeps saying so in snapshots', async () => {
    const LONG = 'k'.repeat(161)
    const early = liveBot()
    const first = early.make()
    first.runner.push(early.writes, {
      coverage: 'carried',
      entries: { [LONG]: { debt: 1, calldata: CALLDATA } },
      basis: 1
    })
    await first.tick()
    expect(snapshotPicture(early.lines).get('positions')).toMatchObject({ keysOmitted: true })
    await first.runner.abandon()

    let now = 0
    const bot = liveBot()
    const { runner, tick } = bot.make(undefined, () => now)
    await tick()
    bot.lines.length = 0
    runner.push(bot.writes, {
      coverage: 'carried',
      entries: { [LONG]: { debt: 1, calldata: CALLDATA }, a: { debt: 1, calldata: CALLDATA } },
      basis: 1
    })
    await tick()
    runner.push(bot.writes, {
      coverage: 'carried',
      entries: { [LONG]: { debt: 9, calldata: CALLDATA } },
      basis: 2
    })
    await tick()
    expect(JSON.stringify(bot.lines)).not.toContain(LONG)
    const omitted = events(bot.lines, 'live.record').filter(record => record.keysOmitted === true)
    expect(omitted.map(record => record.node)).toStrictEqual(['positions', 'positions.phase'])
    expect(records(bot.lines)).toContainEqual({
      node: 'positions',
      key: { id: 'a', status: 'present' }
    })
    runner.push(bot.writes, { coverage: 'complete', entries: {}, basis: 3, empty: true })
    now = 60_000
    await tick()
    const picture = snapshotPicture(bot.lines)
    expect(picture.get('positions')).toMatchObject({ keysOmitted: true, keys: {} })
    expect(picture.get('positions.phase')).toMatchObject({ keysOmitted: true })
    expect(picture.get('kernel.health')).not.toHaveProperty('keysOmitted')
    await runner.abandon()
  })

  it('logs the graph by ids, producers, shapes and edges at start and with every snapshot', async () => {
    let now = 0
    const bot = liveBot()
    const { runner, tick } = bot.make(undefined, () => now)
    await tick()
    now = 30_000
    await tick()
    expect(
      events(bot.lines, 'live.graph').map(({ graph, part, last }) => ({ graph, part, last }))
    ).toStrictEqual([
      { graph: 0, part: 0, last: true },
      { graph: 1, part: 0, last: true }
    ])
    expect(events(bot.lines, 'live.snapshot').filter(part => part.last === true)).toHaveLength(2)
    const described = describeGraph(bot.graph)
    const graph = liveGraph(bot.lines)!
    expect(graph).toStrictEqual({
      format: described.format,
      nodes: described.nodes.map(({ id, producer, shape }) => ({ id, by: producer.by, shape })),
      operators: described.operators.map(op => ({
        id: op.id,
        reads: op.reads.map(({ node, mode }) => ({ node, mode })),
        ...(op.kind === 'fold' && op.emits.length > 0 && { emits: op.emits })
      })),
      effects: described.effects.map(({ id, requests, samples, results }) => ({
        id,
        requests: requests.map(({ node }) => node),
        samples: samples.map(({ node }) => node),
        ...(results !== undefined && { results })
      }))
    })
    expect(graph.effects).toContainEqual({ id: 'live.log', requests: ['kernel.tick'], samples: [] })
    expect(graph.effects).toContainEqual({
      id: 'bot.report',
      requests: ['bot.reads'],
      samples: ['kernel.health']
    })
    expect(graph.operators).toContainEqual({
      id: 'kernel.clock',
      reads: [{ node: 'ticks', mode: 'every' }],
      emits: ['kernel.tick']
    })
    await runner.abandon()
  })

  it('splits a large graph into ordered parts of at most 8 KiB', async () => {
    const g = createGraph('wide')
    for (let i = 0; i < 300; i++) {
      const source = g.level<number>(`source.${'x'.repeat(40)}.${i}`)
      g.map(`map.${'y'.repeat(40)}.${i}`, { reads: { v: latest(source) }, compute: ({ v }) => v })
    }
    const ticks = g.occurrences<number>('ticks')
    const lines: Line[] = []
    const live = declareLiveLog(g, { on: ticks, show: [], run: 'r', logger: recording(lines) })
    const graph = g.build()
    live.describe(graph)
    const runner = createRunner(graph, { observe: live.observe })
    runner.push(ticks, 1)
    await Promise.resolve()
    const parts = events(lines, 'live.graph')
    expect(parts.length).toBeGreaterThan(2)
    expect(parts.map(part => part.part)).toStrictEqual(parts.map((_, index) => index))
    for (const part of parts)
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThanOrEqual(LIVE_PART_BYTES)
    const joined = liveGraph(lines)!
    expect(joined.nodes.map(node => node.id)).toStrictEqual(
      describeGraph(graph).nodes.map(node => node.id)
    )
    expect(joined.operators).toHaveLength(300)
    await runner.abandon()
  })

  it("rebuilds every step's stamp and written nodes, in the order written, as the journal holds them", async () => {
    let now = 1_000
    const bot = liveBot()
    const entries: JournalEntry[] = []
    const runner = createRunner(bot.graph, {
      now: () => now,
      observe: bot.live.observe,
      journal: {
        sink: { append: async entry => void entries.push(entry), finalize: async () => {} },
        capacityBytes: 1_000_000
      }
    })
    for (let i = 0; i < 60; i++) {
      now += [0, 1, 7, 250][i % 4]!
      if (i % 3 === 0)
        runner.push(bot.writes, {
          coverage: 'carried',
          entries: { [`k${i % 5}`]: { debt: i, calldata: CALLDATA } },
          basis: i
        })
      if (i % 7 === 0) runner.push(bot.lifecycle, { value: { lifecycle: `l${i}` }, basis: i })
      runner.push(bot.fails, i)
      if (i % 4 === 0) {
        runner.push(bot.ticks, i)
        await Promise.resolve()
      }
    }
    await runner.abandon()
    bot.live.flush()
    const journaled = journaledSteps(entries)
    expect(journaled.length).toBeGreaterThan(90)
    expect(events(bot.lines, 'live.flow').length).toBeGreaterThan(5)
    expect(liveSteps(bot.lines)).toStrictEqual(journaled)
  })

  it('folds consecutive steps that wrote the same nodes into one entry, keeping each step’s time', async () => {
    let now = 0
    const bot = liveBot()
    const { runner, tick } = bot.make(undefined, () => now)
    await tick()
    const graph = liveGraph(bot.lines)!
    bot.lines.length = 0
    const index = (id: string) => graph.nodes.findIndex(node => node.id === id)
    for (let i = 0; i < 50; i++) {
      now += i % 2 === 0 ? 1_000 : 3
      runner.push(bot.fails, i)
    }
    await tick()
    const [flow] = events(bot.lines, 'live.flow')
    const steps = flow!.steps as unknown[][]
    expect(flow!.t0).toBe(1_000)
    expect(steps).toHaveLength(2)
    expect(steps[0]).toStrictEqual([
      2,
      Array.from({ length: 50 }, (_, i) => (i === 0 ? 0 : i % 2 === 0 ? 1_000 : 3)),
      index('bot.reads'),
      index('bot')
    ])
    expect(steps[1]!.slice(0, 2)).toStrictEqual([52, [0]])
    await runner.abandon()
  })

  it('cuts an oversized flow into consecutive whole lines of at most 8 KiB', async () => {
    const STEP_MS = 123_457
    let now = 0
    const bot = liveBot()
    const { runner, tick } = bot.make(undefined, () => now)
    await tick()
    const graph = liveGraph(bot.lines)!
    bot.lines.length = 0
    for (let i = 1; i <= 3_000; i++) {
      now = i * STEP_MS
      if (i % 2 === 0) runner.push(bot.fails, i)
      else runner.push(bot.lifecycle, { value: { lifecycle: 'running' }, basis: i })
    }
    await tick()
    const flows = events(bot.lines, 'live.flow')
    expect(flows.length).toBeGreaterThan(3)
    const steps = liveSteps(bot.lines, graph)
    expect(steps.map(({ seq, at }) => ({ seq, at }))).toStrictEqual(
      Array.from({ length: 3_001 }, (_, i) => ({
        seq: i + 2,
        at: Math.min(i + 1, 3_000) * STEP_MS
      }))
    )
    for (const flow of flows) {
      expect(Buffer.byteLength(JSON.stringify(flow))).toBeLessThanOrEqual(LIVE_PART_BYTES)
      const [first] = flow.steps as [number, number[]][]
      expect(first![1][0]).toBe(0)
      const head = flow.head as { seq: number; at: number }
      const last = steps.findLast(step => step.seq <= head.seq)!
      expect(head).toStrictEqual({ seq: last.seq, at: last.at })
      expect((flow.through as { seq: number }).seq).toBeLessThanOrEqual(head.seq)
    }
    await runner.abandon()
  })

  it('names nodes by id, and logs no graph, in a run never described', async () => {
    const bot = liveBot({ describe: false })
    const { runner, tick } = bot.make()
    await tick()
    runner.push(bot.fails, 1)
    await tick()
    expect(events(bot.lines, 'live.graph')).toStrictEqual([])
    expect(liveSteps(bot.lines).at(-2)).toMatchObject({ seq: 2, nodes: ['bot.reads', 'bot'] })
    await runner.abandon()
  })

  it('drops steps past its capacity, says so, and logs the steps it held', async () => {
    const bot = liveBot({ capacity: 8 })
    const { runner, tick } = bot.make()
    await tick()
    const graph = liveGraph(bot.lines)!
    bot.lines.length = 0
    for (let i = 0; i < 20; i++) runner.push(bot.fails, i)
    await tick()
    expect(events(bot.lines, 'live.gap')).toMatchObject([{ reason: 'overflow' }])
    expect(liveSteps(bot.lines, graph).map(step => step.seq)).toStrictEqual([
      2, 3, 4, 5, 6, 7, 8, 9
    ])
    await runner.abandon()
  })

  it('rebuilds fractional step times exactly', async () => {
    const times = [0.2, 0.9, 1.3, 1.30000000001, 7.1]
    let now = 0
    const bot = liveBot()
    const entries: JournalEntry[] = []
    const runner = createRunner(bot.graph, {
      now: () => now,
      observe: bot.live.observe,
      journal: {
        sink: { append: async entry => void entries.push(entry), finalize: async () => {} },
        capacityBytes: 1_000_000
      }
    })
    for (const time of times) {
      now = time
      runner.push(bot.fails, 1)
    }
    await runner.abandon()
    bot.live.flush()
    expect(liveSteps(bot.lines).map(step => step.at)).toStrictEqual(times)
    expect(liveSteps(bot.lines)).toStrictEqual(journaledSteps(entries))
  })

  it('drops a step too wide for any flow line, says so, and keeps every line within 8 KiB', async () => {
    const g = createGraph('wide')
    const sources = Array.from({ length: 400 }, (_, i) =>
      g.level<number>(`source.${'x'.repeat(40)}.${i}`)
    )
    const ticks = g.occurrences<number>('ticks')
    const lines: Line[] = []
    const live = declareLiveLog(g, { on: ticks, show: [], run: 'r', logger: recording(lines) })
    const runner = createRunner(g.build(), { observe: live.observe })
    runner.push(ticks, 1)
    await Promise.resolve()
    runner.pushAll(sources.map((source, i) => sourceWrite(source, { value: i, basis: 1 })))
    await runner.abandon()
    live.flush()
    expect(events(lines, 'live.gap')).toMatchObject([{ reason: 'overflow', through: { seq: 1 } }])
    expect(events(lines, 'live.snapshot').at(-1)).toMatchObject({ through: { seq: 2 }, last: true })
    expect(liveSteps(lines).map(step => step.seq)).toStrictEqual([1])
    for (const line of lines)
      expect(Buffer.byteLength(JSON.stringify(line.fields))).toBeLessThanOrEqual(LIVE_PART_BYTES)
  })

  it('refuses a graph item too wide for one part, and a capacity that is not a positive integer', () => {
    const g = createGraph('wide')
    const reads = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`r${i}`, latest(g.level<number>(`source.${i}`))])
    )
    g.map('wide', { reads, compute: () => 1 })
    const on = g.occurrences<number>('ticks')
    const logger = recording([])
    const live = declareLiveLog(g, { on, show: [], run: 'r', logger })
    expect(() => live.describe(g.build())).toThrow(GraphDefinitionError)
    for (const capacity of [0, 1.5, Number.POSITIVE_INFINITY])
      expect(() =>
        declareLiveLog(createGraph('bad'), { on, show: [], run: 'r', logger, capacity })
      ).toThrow('the live log needs a positive safe-integer capacity')
  })

  it('leaves every journal entry as it is without one', async () => {
    const journaled = async (observed: boolean) => {
      const bot = liveBot()
      const entries: unknown[] = []
      const runner: Runner = createRunner(bot.graph, {
        now: () => 1,
        ...(observed && { observe: bot.live.observe }),
        journal: {
          sink: { append: async entry => void entries.push(entry), finalize: async () => {} },
          capacityBytes: 1_000_000
        }
      })
      for (let i = 0; i < 5; i++) {
        runner.pushAll([
          sourceWrite(bot.writes, {
            coverage: 'carried',
            entries: { [`k${i % 3}`]: { debt: i, calldata: CALLDATA } },
            basis: i
          }),
          sourceWrite(bot.ticks, i)
        ])
        await Promise.resolve()
      }
      runner.push(bot.fails, -1)
      await runner.stopped.catch(() => undefined)
      return { entries, lines: bot.lines }
    }
    const observed = await journaled(true)
    expect(observed.lines.length).toBeGreaterThan(0)
    expect((await journaled(false)).entries).toStrictEqual(observed.entries)
  })
})

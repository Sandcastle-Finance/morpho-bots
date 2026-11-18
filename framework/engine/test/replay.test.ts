import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'

import type { DerivedWrite, EffectContext, Graph, JournalEntry, RunnerOptions } from '../src'
import type { Divergence, Replayed, ReplayedWrite } from '../src/replay'

import {
  createGraph,
  createRunner,
  decode,
  digestOf,
  emitTo,
  encode,
  every,
  latest,
  sourceWrite,
  watch
} from '../src'
import { createReplayer, replay } from '../src/replay'
import { ledgerGraph } from './fixtures'

/** A journal that keeps each entry as a journal file reads it back. */
const decodedJournal = (entries: JournalEntry[]) => ({
  sink: {
    append: async (entry: JournalEntry) => void entries.push(decode(encode(entry)) as JournalEntry),
    finalize: async () => undefined
  },
  capacityBytes: 16_000
})

describe('replay', () => {
  it("holds a push and an effect's result as the journal reads them back, so a map over field order replays", async () => {
    const entries: JournalEntry[] = []
    const fieldOrder = () => {
      const g = createGraph('field-order')
      const positions = g.level<Record<string, number>>('positions')
      const asks = g.occurrences<number>('asks')
      const quotes = g.node<Record<string, number>>('quotes')
      g.effect('quote', {
        requests: { ask: every(asks) },
        results: quotes,
        handle: (_, context) => context.write({ y: 1, b: 2 })
      })
      const firstPosition = g.map('first-position', {
        reads: { positions: latest(positions) },
        compute: ({ positions }) => Object.keys(positions)[0]!
      })
      const firstQuote = g.map('first-quote', {
        reads: { quotes: latest(quotes) },
        compute: ({ quotes }) => Object.keys(quotes)[0]!
      })
      return { graph: g.build(), positions, asks, firstPosition, firstQuote }
    }
    const live = fieldOrder()
    const runner = createRunner(live.graph, { journal: decodedJournal(entries) })
    runner.push(live.positions, { value: { z: 1, a: 2 }, basis: 1 })
    runner.push(live.asks, 1)
    await sleep(0)
    expect([runner.read(live.firstPosition), runner.read(live.firstQuote)]).toStrictEqual([
      'a',
      'b'
    ])
    await runner.abandon()

    expect(replay(fieldOrder().graph, entries)).toStrictEqual({ ok: true, steps: 3 })
  })

  it('stamps each step with a frozen stamp whose fields are in the order the journal reads back', async () => {
    const entries: JournalEntry[] = []
    const stampShape = () => {
      const g = createGraph('stamp-shape')
      const asks = g.occurrences<number>('asks')
      const shape = g.map('shape', {
        reads: { asks: every(asks) },
        compute: ({ asks }) =>
          asks.map(({ stamp }) => ({ fields: Object.keys(stamp), frozen: Object.isFrozen(stamp) }))
      })
      return { graph: g.build(), asks, shape }
    }
    const live = stampShape()
    const runner = createRunner(live.graph, { journal: decodedJournal(entries) })
    runner.push(live.asks, 1)
    await sleep(0)
    expect(runner.read(live.shape)).toStrictEqual([{ fields: ['at', 'seq'], frozen: true }])
    await runner.abandon()

    expect(replay(stampShape().graph, entries)).toStrictEqual({ ok: true, steps: 1 })
  })

  it('replays a finite feedback graph at the fixed cycle bound', async () => {
    const entries: JournalEntry[] = []
    const feedbackGraph = () => {
      const g = createGraph('feedback')
      const kicks = g.occurrences<number>('kicks')
      const pong = g.node<number>('pong')
      const ping = g.node<number>('ping')
      g.fold('left', {
        reads: { kick: every(kicks), pong: every(pong) },
        emits: [ping],
        initial: 0,
        applyInput: (count, { value }) => ({
          state: count + 1,
          emit: [emitTo(ping, value + 1)]
        })
      })
      g.fold('right', {
        reads: { ping: every(ping) },
        emits: [pong],
        initial: 0,
        applyInput: (count, { value }) => ({
          state: count + 1,
          ...(value < 65 && { emit: [emitTo(pong, value)] })
        })
      })
      return { graph: g.build(), kicks }
    }
    const live = feedbackGraph()
    const runner = createRunner(live.graph, {
      journal: {
        sink: { append: async entry => void entries.push(entry), finalize: async () => undefined },
        capacityBytes: 1_000_000
      }
    })
    runner.push(live.kicks, 0)
    await sleep(0)
    await runner.abandon()

    expect(replay(feedbackGraph().graph, entries)).toStrictEqual({ ok: true, steps: 1 })
  })

  it("replays a journal's stamped steps without running an effect, and finds a step that differs", async () => {
    const entries: JournalEntry[] = []
    const { g, amounts, orders } = ledgerGraph()
    const live = vi.fn()
    g.effect('send', { requests: { order: every(orders) }, handle: live })
    const graph = g.build()
    const runner = createRunner(graph, {
      journal: {
        sink: { append: async e => void entries.push(e), finalize: async () => undefined },
        capacityBytes: 16_000
      }
    })
    for (const amount of [1, 2, 3]) runner.push(amounts, amount)
    await sleep(0)
    await runner.abandon()
    expect(live).toHaveBeenCalledTimes(3)

    const replayed = ledgerGraph()
    const forbidden = vi.fn(() => {
      throw new Error('an effect ran during replay')
    })
    replayed.g.effect('send', { requests: { order: every(replayed.orders) }, handle: forbidden })
    expect(replay(replayed.g.build(), entries)).toStrictEqual({ ok: true, steps: 3 })
    expect(forbidden).not.toHaveBeenCalled()

    const tampered = entries.map((entry, i) =>
      i === 1 ? { ...entry, writes: [{ node: 'amounts', value: 9 }] } : entry
    )
    expect(replay(ledgerGraph().g.build(), tampered)).toStrictEqual({
      ok: false,
      step: 2,
      reason: 'derived writes differ'
    })
  })

  it('replays a keyed delta whose entries contain an own __proto__ key', async () => {
    const entries: JournalEntry[] = []
    const g = createGraph('proto-key')
    const writes = g.occurrences('writes')
    const runner = createRunner(g.build(), {
      journal: {
        sink: { append: async entry => void entries.push(entry), finalize: async () => undefined },
        capacityBytes: 16_000
      }
    })
    const keyed = (debt: number) => ({
      coverage: 'complete',
      entries: Object.fromEntries([['__proto__', { debt }]])
    })
    runner.push(writes, keyed(1))
    runner.push(writes, keyed(2))
    await runner.abandon()

    const delta = entries
      .filter(entry => entry.kind === 'step')
      .flatMap(entry => entry.writes)
      .find(write => 'delta' in write)
    expect(delta && 'delta' in delta && Object.hasOwn(delta.delta.entries, '__proto__')).toBe(true)
    const replayed = createGraph('proto-key')
    replayed.occurrences('writes')
    expect(replay(replayed.build(), entries)).toStrictEqual({ ok: true, steps: 2 })
  })
})

type Recorded = { entries: JournalEntry[]; journal: NonNullable<RunnerOptions['journal']> }

const recording = (): Recorded => {
  const entries: JournalEntry[] = []
  return {
    entries,
    journal: {
      sink: { append: async entry => void entries.push(entry), finalize: async () => undefined },
      capacityBytes: 64_000
    }
  }
}

const replayAll = (graph: Graph, entries: readonly JournalEntry[]) => {
  const replayer = createReplayer(graph)
  return entries.map(entry => replayer.apply(entry))
}

const stepsOf = (replayed: readonly Replayed[]) => replayed.filter(entry => entry.kind === 'step')

const shown = ({ node, producer, derived, record }: ReplayedWrite) =>
  [node, producer, derived, record.status, record.value] as const

/** Each ask quotes twice; the effect fills a large quote, and its fill counts against the book. */
const quoting = (handle: (value: number, context: EffectContext<number>) => void) => {
  const g = createGraph('quoting')
  const asks = g.occurrences<number>('asks')
  const quotes = g.node<number>('quotes')
  const fills = g.node<number>('fills')
  g.fold('book', {
    reads: { ask: every(asks), fill: every(fills) },
    emits: [quotes],
    initial: 0,
    applyInput: (open, { from, value }) =>
      from === 'ask'
        ? { state: open + 1, emit: [emitTo(quotes, value), emitTo(quotes, value * 10)] }
        : { state: open - value }
  })
  g.effect('fill', {
    requests: { quote: every(quotes) },
    results: fills,
    handle: ({ value }, context) => handle(value, context)
  })
  return { graph: g.build(), asks }
}

const fillLarge = (value: number, context: EffectContext<number>) => {
  if (value < 10) return
  context.note({ filled: value })
  context.write(1)
}

const recordQuoting = async () => {
  const { entries, journal } = recording()
  const live = quoting(fillLarge)
  const runner = createRunner(live.graph, { journal })
  runner.push(live.asks, 2)
  await sleep(0)
  await runner.abandon()
  return entries
}

describe('a stepping replayer', () => {
  it("returns each step's writes in order, with values and producers, for several emissions to one node", async () => {
    const entries = await recordQuoting()
    const forbidden = vi.fn(() => {
      throw new Error('an effect ran during replay')
    })
    const replayed = replayAll(quoting(forbidden).graph, entries)

    expect(entries.flatMap(entry => (entry.kind === 'step' ? [entry.derived] : []))).toStrictEqual([
      [
        { node: 'book', digest: digestOf(1) },
        { node: 'quotes', digest: digestOf(2) },
        { node: 'quotes', digest: digestOf(20) }
      ],
      [{ node: 'book', digest: digestOf(0) }]
    ])
    expect(replayed.map(entry => entry.kind)).toStrictEqual(['step', 'note', 'step'])
    expect(replayed[1]).toBe(entries[1])
    expect(stepsOf(replayed).map(({ stamp, wakes }) => [stamp.seq, wakes])).toStrictEqual([
      [1, []],
      [2, []]
    ])
    expect(stepsOf(replayed).map(({ writes }) => writes.map(shown))).toStrictEqual([
      [
        ['asks', undefined, false, 'present', 2],
        ['book', 'book', true, 'present', 1],
        ['quotes', 'book', true, 'present', 2],
        ['quotes', 'book', true, 'present', 20]
      ],
      [
        ['fills', 'fill', false, 'present', 1],
        ['book', 'book', true, 'present', 0]
      ]
    ])
    expect(forbidden).not.toHaveBeenCalled()
  })

  it('returns a blocked write as its status, and no write where a node coalesced', async () => {
    const declare = () => {
      const g = createGraph('pricing')
      const prices = g.level<number>('prices')
      g.map('doubled', { reads: { price: latest(prices) }, compute: ({ price }) => price * 2 })
      return { graph: g.build(), prices }
    }
    const { entries, journal } = recording()
    const live = declare()
    const runner = createRunner(live.graph, { journal })
    runner.push(live.prices, { status: 'failed', reason: 'rpc' })
    runner.push(live.prices, { value: 2, basis: 1 })
    runner.push(live.prices, { value: 2, basis: 2 })
    await runner.abandon()

    expect(entries.flatMap(entry => (entry.kind === 'step' ? [entry.derived] : []))).toStrictEqual([
      [{ node: 'doubled', digest: 'failed' }],
      [{ node: 'doubled', digest: digestOf(4) }],
      []
    ])
    const steps = stepsOf(replayAll(declare().graph, entries))
    expect(steps.map(({ writes }) => writes.map(shown))).toStrictEqual([
      [
        ['prices', undefined, false, 'failed', undefined],
        ['doubled', 'doubled', true, 'failed', undefined]
      ],
      [
        ['prices', undefined, false, 'present', 2],
        ['doubled', 'doubled', true, 'present', 4]
      ],
      [['prices', undefined, false, 'present', 2]]
    ])
    expect(steps[0]!.writes[0]!.record.reason).toBe('rpc')
    expect(steps[2]!.writes[0]!.record.basis).toBe(2)
  })

  it("returns an expiry wake as a step of its own, with the watcher's writes", async () => {
    vi.useFakeTimers({ now: 0 })
    try {
      const declare = () => {
        const g = createGraph('expiring')
        const quotes = g.level<number>('quotes')
        g.fold('seen', {
          reads: { quote: watch(quotes) },
          initial: [] as number[],
          applyInput: (log, { stamp }) => ({ state: [...log, stamp.at] })
        })
        return { graph: g.build(), quotes }
      }
      const { entries, journal } = recording()
      const live = declare()
      const runner = createRunner(live.graph, { journal })
      runner.start()
      runner.push(live.quotes, { value: 1, basis: 1, expiry: 100 })
      await vi.advanceTimersByTimeAsync(100)
      await runner.abandon()

      const steps = stepsOf(replayAll(declare().graph, entries))
      expect(
        steps.map(({ stamp, wakes, writes }) => [stamp.at, wakes, writes.map(shown)])
      ).toStrictEqual([
        [
          0,
          [],
          [
            ['quotes', undefined, false, 'present', 1],
            ['seen', 'seen', true, 'present', [0]]
          ]
        ],
        [100, ['quotes'], [['seen', 'seen', true, 'present', [0, 100]]]]
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns failed and recovery entries as journaled, and replays the re-run step under the recovery', async () => {
    const declare = () => {
      const g = createGraph('degrading')
      const reads = g.occurrences<number>('reads')
      const halts = g.occurrences<string>('halts')
      g.fold('bot', {
        reads: { read: every(reads) },
        initial: 0,
        applyInput: (total, { value }) => {
          if (value < 0) throw new Error('bot failed')
          return { state: total + value }
        }
      })
      g.scope(
        'kernel',
        s =>
          s.fold('wound', {
            reads: { halt: every(halts) },
            initial: [] as string[],
            applyInput: (log, { value }) => ({ state: [...log, value] })
          }),
        { recovery: () => (_, origin) => [sourceWrite(halts, origin)] }
      )
      return { graph: g.build(), reads }
    }
    const { entries, journal } = recording()
    const live = declare()
    const runner = createRunner(live.graph, { journal })
    runner.push(live.reads, 1)
    runner.push(live.reads, -1)
    await runner.abandon()

    const replayed = replayAll(declare().graph, entries)
    expect(replayed.map(entry => entry.kind)).toStrictEqual([
      'step',
      'failed',
      'recovery',
      'step',
      'step'
    ])
    expect(replayed[1]).toBe(entries[1])
    expect(replayed[1]).toMatchObject({ origin: 'bot', step: { writes: [{ value: -1 }] } })
    expect(replayed[2]).toBe(entries[2])
    expect(stepsOf(replayed).map(({ writes }) => writes.map(shown))).toStrictEqual([
      [
        ['reads', undefined, false, 'present', 1],
        ['bot', 'bot', true, 'present', 1]
      ],
      [['reads', undefined, false, 'present', -1]],
      [
        ['halts', undefined, false, 'present', 'bot'],
        ['kernel.wound', 'kernel.wound', true, 'present', ['bot']]
      ]
    ])
  })

  it('returns a failed effect as journaled, without running it', async () => {
    const { entries, journal } = recording()
    const live = quoting(() => {
      throw new Error('venue down')
    })
    const runner = createRunner(live.graph, { journal })
    runner.push(live.asks, 2)
    await runner.stopped.catch(() => undefined)

    const forbidden = vi.fn()
    const replayed = replayAll(quoting(forbidden).graph, entries)
    expect(replayed.map(entry => entry.kind)).toStrictEqual(['step', 'failed'])
    expect(replayed[1]).toBe(entries[1])
    expect(replayed[1]).toMatchObject({ origin: 'fill' })
    expect(forbidden).not.toHaveBeenCalled()
  })

  it('names the first derived write that differs, and stops there', async () => {
    const entries = await recordQuoting()
    const first = entries[0] as Extract<JournalEntry, { kind: 'step' }>
    const forged = { node: 'quotes', digest: digestOf(30) }
    const tampered = [{ ...first, derived: first.derived.with(2, forged) }, ...entries.slice(1)]

    const replayer = createReplayer(quoting(fillLarge).graph)
    const diverged = replayer.apply(tampered[0]!)
    expect(diverged).toStrictEqual({
      kind: 'diverged',
      stamp: first.stamp,
      reason: 'derived writes differ',
      node: 'quotes',
      expected: forged,
      actual: { node: 'quotes', digest: digestOf(20) },
      writes: expect.any(Array)
    })
    expect((diverged as Divergence).writes.map(shown).at(-1)).toStrictEqual([
      'quotes',
      'book',
      true,
      'present',
      20
    ])
    expect(replayer.apply(tampered[1]!)).toBe(diverged)
    expect(replay(quoting(fillLarge).graph, tampered)).toStrictEqual({
      ok: false,
      step: 1,
      reason: 'derived writes differ'
    })

    const book = { node: 'book', digest: digestOf(1) }
    const quote = (value: number) => ({ node: 'quotes', digest: digestOf(value) })
    const named = (derived: readonly DerivedWrite[]) => {
      const replayer = createReplayer(quoting(fillLarge).graph)
      const { node, expected, actual } = replayer.apply({ ...first, derived }) as Divergence
      expect(replayer.apply(entries[1]!)).toMatchObject({ kind: 'diverged', node })
      return { node, expected, actual }
    }
    expect(named([book, quote(3), quote(20)])).toStrictEqual({
      node: 'quotes',
      expected: quote(3),
      actual: quote(2)
    })
    expect(named([book, quote(2)])).toStrictEqual({
      node: 'quotes',
      expected: undefined,
      actual: quote(20)
    })
    expect(named([book, quote(2), quote(20), quote(200)])).toStrictEqual({
      node: 'quotes',
      expected: quote(200),
      actual: undefined
    })
    expect(named([{ node: 'other', digest: book.digest }, quote(2), quote(20)])).toStrictEqual({
      node: 'other',
      expected: { node: 'other', digest: book.digest },
      actual: book
    })
  })

  it('names the node of a keyed delta with no earlier complete write', async () => {
    const { entries, journal } = recording()
    const declare = () => {
      const g = createGraph('keyed')
      const writes = g.occurrences('writes')
      return { graph: g.build(), writes }
    }
    const live = declare()
    const runner = createRunner(live.graph, { journal })
    runner.push(live.writes, { coverage: 'complete', entries: { a: 1 } })
    runner.push(live.writes, { coverage: 'complete', entries: { a: 2 } })
    await runner.abandon()

    expect(replayAll(declare().graph, entries.slice(1))[0]).toMatchObject({
      kind: 'diverged',
      reason: 'a keyed delta has no earlier complete write',
      node: 'writes'
    })
  })

  it('names the operator a replayed step throws in', async () => {
    const entries = await recordQuoting()
    const g = createGraph('quoting')
    const asks = g.occurrences<number>('asks')
    g.fold('book', {
      reads: { ask: every(asks) },
      initial: 0,
      applyInput: () => {
        throw new Error('book changed')
      }
    })
    const [diverged] = replayAll(g.build(), entries)
    expect(diverged).toMatchObject({
      kind: 'diverged',
      reason: 'the step threw: book changed',
      node: 'book'
    })
    expect((diverged as Divergence).writes.map(shown)).toStrictEqual([
      ['asks', undefined, false, 'present', 2]
    ])
  })

  it('names no node when a replayed write is refused before any operator runs', async () => {
    const entries = await recordQuoting()
    const g = createGraph('quoting')
    g.occurrences<number>('bids')
    const [diverged] = replayAll(g.build(), entries)
    expect(diverged).toMatchObject({ kind: 'diverged', writes: [] })
    expect((diverged as Divergence).reason).toMatch(/^the step threw: /)
    expect(diverged).not.toHaveProperty('node')
  })
})

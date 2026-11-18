import { describe, expect, it } from 'vitest'

import { createGraph, describeGraph, every, GRAPH_DESCRIPTION_FORMAT, lane, watch } from '../src'
import { shopGraph } from './fixtures'

describe('describeGraph', () => {
  it('names each node by id with its kind, shape and producer', () => {
    expect(describeGraph(shopGraph()).nodes).toStrictEqual([
      {
        id: 'doubled',
        kind: 'derived',
        shape: 'state',
        coalesces: true,
        producer: { by: 'map' },
        expires: false
      },
      {
        id: 'ledger.total',
        kind: 'derived',
        shape: 'state',
        coalesces: true,
        producer: { by: 'fold' },
        expires: false
      },
      {
        id: 'orders',
        kind: 'occurrence',
        shape: 'stream',
        coalesces: false,
        producer: { by: 'source' },
        expires: false
      },
      {
        id: 'price',
        kind: 'level',
        shape: 'value',
        coalesces: false,
        producer: { by: 'source' },
        expires: false
      },
      {
        id: 'priced',
        kind: 'derived',
        shape: 'value',
        coalesces: true,
        producer: { by: 'map' },
        expires: true
      },
      {
        id: 'receipts',
        kind: 'derived',
        shape: 'stream',
        coalesces: false,
        producer: { by: 'emit', fold: 'ledger.total' },
        expires: false
      },
      {
        id: 'shipped',
        kind: 'derived',
        shape: 'stream',
        coalesces: false,
        producer: { by: 'result', effect: 'chain.ship' },
        expires: false
      },
      {
        id: 'tick',
        kind: 'clock',
        shape: 'stream',
        coalesces: false,
        producer: { by: 'clock', everyMs: 1_000 },
        expires: false
      },
      {
        id: 'watcher',
        kind: 'derived',
        shape: 'state',
        coalesces: true,
        producer: { by: 'fold' },
        expires: false
      }
    ])
  })

  it('lists operators in evaluation order, each read by alias with the edge it was declared with', () => {
    expect(describeGraph(shopGraph()).operators).toStrictEqual([
      {
        id: 'ledger.total',
        kind: 'fold',
        reads: [
          { alias: 'order', node: 'orders', mode: 'every' },
          { alias: 'shipped', node: 'shipped', mode: 'every' },
          { alias: 'tick', node: 'tick', mode: 'every' }
        ],
        emits: ['receipts'],
        afterInputs: true
      },
      {
        id: 'priced',
        kind: 'map',
        reads: [
          { alias: 'total', node: 'ledger.total', mode: 'latest' },
          { alias: 'price', node: 'price', mode: 'sample' }
        ]
      },
      {
        id: 'doubled',
        kind: 'map',
        reads: [{ alias: 'total', node: 'ledger.total', mode: 'latest' }]
      },
      {
        id: 'watcher',
        kind: 'fold',
        reads: [{ alias: 'priced', node: 'priced', mode: 'watch' }],
        emits: [],
        afterInputs: false
      }
    ])
  })

  it('lists effects in dispatch order with their lane and the policies they declare', () => {
    const { effects, lanes } = describeGraph(shopGraph())
    expect(effects).toStrictEqual([
      {
        id: 'chain.ship',
        requests: [{ alias: 'receipt', node: 'receipts' }],
        samples: [{ alias: 'total', node: 'ledger.total' }],
        results: 'shipped',
        lane: 'venue',
        policies: ['sequence', 'ready']
      },
      {
        id: 'chain.audit',
        requests: [{ alias: 'receipt', node: 'receipts' }],
        samples: [],
        lane: 'venue',
        policies: []
      },
      {
        id: 'report',
        requests: [{ alias: 'receipt', node: 'receipts' }],
        samples: [],
        lane: 'venue#2',
        policies: ['latestOnly']
      },
      {
        id: 'log',
        requests: [{ alias: 'order', node: 'orders' }],
        samples: [],
        lane: 'default',
        policies: ['finishOnStop']
      }
    ])
    expect(lanes).toStrictEqual([
      { name: 'venue', concurrency: 2, queue: 8, budget: { calls: 5, perMs: 1_000 } },
      { name: 'venue#2', concurrency: 1, queue: 1 },
      { name: 'default', concurrency: 'unbounded', queue: 1_024 }
    ])
  })

  it('names the recovery scope by member id, and is versioned', () => {
    const description = describeGraph(shopGraph())
    expect(description.recovery).toStrictEqual(['chain.audit', 'chain.ship'])
    expect(description.format).toBe(GRAPH_DESCRIPTION_FORMAT)
    expect(description.id).toBe('shop')
    expect(describeGraph(createGraph('bare').build())).toStrictEqual({
      format: GRAPH_DESCRIPTION_FORMAT,
      id: 'bare',
      nodes: [],
      operators: [],
      effects: [],
      lanes: []
    })
  })

  it('is the same data whatever order a spec declared its reads in', () => {
    const description = describeGraph(shopGraph())
    expect(describeGraph(shopGraph({ reverseReads: true }))).toStrictEqual(description)
    expect(JSON.parse(JSON.stringify(description))).toStrictEqual(description)
  })

  it("keeps the declaration order of one node's aliases, which orders their deliveries", () => {
    const aliasesOf = (aliases: readonly string[]) => {
      const g = createGraph('aliases')
      const orders = g.occurrences<number>('orders')
      g.fold('counted', {
        reads: Object.fromEntries(aliases.map(alias => [alias, watch(orders)])),
        initial: 0,
        applyInput: (state: number) => ({ state })
      })
      return describeGraph(g.build()).operators[0]!.reads.map(read => read.alias)
    }
    expect(aliasesOf(['first', 'second'])).toStrictEqual(['first', 'second'])
    expect(aliasesOf(['second', 'first'])).toStrictEqual(['second', 'first'])
  })

  it("lists a node's every read before its watch read, as a fold takes them", () => {
    const readsOf = (watchFirst: boolean) => {
      const g = createGraph('modes')
      const orders = g.occurrences<number>('orders')
      const watched = { watched: watch(orders) }
      const taken = { taken: every(orders) }
      g.fold('counted', {
        reads: watchFirst ? { ...watched, ...taken } : { ...taken, ...watched },
        initial: 0,
        applyInput: (state: number) => ({ state })
      })
      return describeGraph(g.build()).operators[0]!.reads.map(read => read.alias)
    }
    expect(readsOf(true)).toStrictEqual(['taken', 'watched'])
    expect(readsOf(false)).toStrictEqual(['taken', 'watched'])
  })

  it('names a lane whose name another lane already took by the first free suffix', () => {
    const g = createGraph('lanes')
    const requests = g.occurrences<number>('requests')
    const lanes = [
      lane('venue', { concurrency: 1, queue: 1 }),
      lane('venue', { concurrency: 2, queue: 2 }),
      lane('venue#2', { concurrency: 3, queue: 3 })
    ]
    for (const [index, effectLane] of lanes.entries())
      g.effect(`e${index}`, {
        requests: { n: every(requests) },
        lane: effectLane,
        handle: () => {}
      })
    const { effects, lanes: described } = describeGraph(g.build())
    expect(effects.map(effect => effect.lane)).toStrictEqual(['venue', 'venue#2', 'venue#2#2'])
    expect(described.map(({ name, concurrency }) => [name, concurrency])).toStrictEqual([
      ['venue', 1],
      ['venue#2', 2],
      ['venue#2#2', 3]
    ])
  })
})

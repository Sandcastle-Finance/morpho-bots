import { createGraph, emitTo, every, lane, latest, sample, watch } from '../src'

/** A source of numbers, a running total over every write, the total's double, and its emitted orders. */
export const ledgerGraph = () => {
  const g = createGraph('ledger')
  const amounts = g.occurrences<number>('amounts')
  const orders = g.node<number>('orders')
  const total = g.fold('total', {
    reads: { amount: every(amounts) },
    emits: [orders],
    initial: 0,
    applyInput: (sum, { value }) => ({ state: sum + value, emit: [emitTo(orders, sum + value)] })
  })
  const doubled = g.map('doubled', {
    reads: { total: latest(total) },
    compute: ({ total }) => total * 2
  })
  return { g, amounts, orders, total, doubled }
}

/** A source, a clock, a fold that emits, two maps, and effects over shared and same-named lanes. */
export const shopGraph = (options: Readonly<{ reverseReads?: boolean }> = {}) => {
  const g = createGraph('shop')
  const orders = g.occurrences<number>('orders')
  const price = g.level<number>('price')
  const tick = g.clock('tick', { everyMs: 1_000, value: now => now })
  const shipped = g.node<number>('shipped')
  const receipts = g.node<number>('receipts')
  const total = g.fold('ledger.total', {
    reads: options.reverseReads
      ? { tick: every(tick), order: every(orders), shipped: every(shipped) }
      : { order: every(orders), shipped: every(shipped), tick: every(tick) },
    emits: [receipts],
    initial: 0,
    applyInput: (sum, { value }) => ({ state: sum + value, emit: [emitTo(receipts, sum)] }),
    afterInputs: state => ({ state })
  })
  const priced = g.map(
    'priced',
    { reads: { total: latest(total), price: sample(price) }, compute: ({ total }) => total },
    { expiries: () => [] }
  )
  g.map('doubled', { reads: { total: latest(total) }, compute: ({ total }) => total * 2 })
  g.fold('watcher', {
    reads: { priced: watch(priced) },
    initial: 0,
    applyInput: n => ({ state: n + 1 })
  })
  const venue = lane('venue', { concurrency: 2, queue: 8, budget: { calls: 5, perMs: 1_000 } })
  g.scope(
    'chain',
    s => {
      s.effect('ship', {
        requests: { receipt: every(receipts) },
        samples: { total },
        results: shipped,
        lane: venue,
        sequence: () => 0,
        ready: () => true,
        handle: () => {}
      })
      s.effect('audit', { requests: { receipt: every(receipts) }, lane: venue, handle: () => {} })
    },
    { recovery: () => () => undefined }
  )
  g.effect('report', {
    requests: { receipt: every(receipts) },
    lane: lane('venue', { concurrency: 1, queue: 1 }),
    latestOnly: true,
    handle: () => {}
  })
  g.effect('log', { requests: { order: every(orders) }, finishOnStop: true, handle: () => {} })
  return g.build()
}

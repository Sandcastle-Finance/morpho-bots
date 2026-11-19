import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { encodeLedger, toDurable } from '../src/durable'
import {
  cancel,
  ecrecoverPlan,
  makeConfig,
  offer,
  publish,
  setterPlan,
  T,
  transfer,
  tree,
  W
} from './fixtures'
import { Harness } from './harness'
import { midnightId } from './validators'

const G1 = midnightId('g1')

/** Publishes `t` under `intentId`, mines it, and fills it at a final block, which retires it. */
const filled = (h: Harness, intentId = 'q:M1', t = T) => {
  h.liveOffer(t, intentId)
  h.observe(G1, 300n)
  h.finalize(h.block)
  expect(h.entry(G1)).toMatchObject({ state: 'retired', retiredBy: 'filled' })
  return h
}

/** {@link Harness.liveOffer} on a decision read at the current head, after our own final effects. */
const republish = (h: Harness, intentId: string) => {
  h.send({ type: 'Submit', plan: ecrecoverPlan(intentId, T, { basisBlock: h.block }) })
  h.sign()
  h.materialize(signatures => publish(T, signatures[0]), T)
  h.drive()
  h.head()
  h.mine(h.candidates().find(c => c.intentId === intentId)!.hash)
}

const heads = (h: Harness, n: number) => {
  for (let i = 0; i < n; i++) h.head()
}

const retiredAt = (h: Harness) => h.entry(G1)!.retiredAt!

const entryActivity = (h: Harness) =>
  h.activity.flatMap(a => (a.type === 'entry' && a.id === G1 ? [`${a.from}>${a.to}`] : []))

/** Stops, so recovery cancels the offer, and leaves the cancel accepted but unmined. */
const cancelOnStop = (h: Harness) => {
  h.send({ type: 'Stop' })
  h.drive()
  return h.candidate('0xsetConsumed')
}

describe('a retired commitment is kept for its retention window', () => {
  it('stays retired through the window and is then dropped, reporting nothing for the drop', () => {
    const h = filled(new Harness().start())
    const window = h.config.retiredRetentionBlocks
    expect(entryActivity(h).at(-1)).toBe('live>retired')
    h.activity.length = 0
    while (h.block < retiredAt(h) + window - 1) h.head()
    expect(h.entry(G1)?.state).toBe('retired')
    h.head()
    expect(h.entry(G1)).toBeUndefined()
    expect(h.activity.filter(a => a.type === 'entry')).toEqual([])
  })

  it('is never dropped in the transition that retires it, even with a zero window', () => {
    const h = new Harness(makeConfig({ maxEvidenceAgeBlocks: 0 })).start()
    expect(h.config.retiredRetentionBlocks).toBe(0)
    filled(h)
    expect(retiredAt(h)).toBe(h.block)
    h.observe(G1, 300n)
    expect(h.entry(G1)?.state).toBe('retired')
    h.head()
    expect(h.entry(G1)).toBeUndefined()
  })

  it('refuses a retired id inside the window and admits it afresh once dropped, retiring it again on the same fill', () => {
    const h = filled(new Harness().start())
    h.send({ type: 'Submit', plan: ecrecoverPlan('q:M2', T) })
    expect(h.refusal('q:M2')?.code).toBeDefined()
    heads(h, h.config.retiredRetentionBlocks)
    expect(h.entry(G1)).toBeUndefined()
    republish(h, 'q:M3')
    expect(h.notices('q:M3')[0]).toBe('admitted')
    expect(h.entry(G1)?.state).toBe('live')
    expect(h.available(W.loan)).toBe(700n)
    h.observe(G1, 300n)
    h.finalize(h.block)
    expect(h.entry(G1)).toMatchObject({ state: 'retired', retiredBy: 'filled' })
    expect(h.available(W.loan)).toBe(1000n)
  })

  it('re-admits a dropped cash-capped buy group, reserving its loan cap until the chain retires it again', () => {
    const cashBuy = tree(offer('g1', 300n, { buy: true }))
    const h = new Harness().start().liveOffer(cashBuy)
    h.observe(G1, 0n, true)
    h.finalize(h.block)
    expect(h.entry(G1)).toMatchObject({ state: 'retired', retiredBy: 'neutralized' })
    expect(h.available(W.loan)).toBe(1000n)
    heads(h, h.config.retiredRetentionBlocks)
    expect(h.entry(G1)).toBeUndefined()
    h.send({ type: 'Submit', plan: ecrecoverPlan('q:M2', cashBuy, { basisBlock: h.block }) })
    h.sign()
    h.materialize(signatures => publish(cashBuy, signatures[0]), cashBuy)
    h.drive()
    h.head()
    h.mine(h.candidates().find(c => c.intentId === 'q:M2')!.hash)
    expect(h.entry(G1)).toMatchObject({ state: 'live', intentId: 'q:M2' })
    expect(h.available(W.loan)).toBe(700n)
    h.observe(G1, 0n, true)
    h.finalize(h.block)
    expect(h.entry(G1)).toMatchObject({ state: 'retired', retiredBy: 'neutralized' })
    expect(h.available(W.loan)).toBe(1000n)
  })

  it('admits a dropped id whose creator only failed, and it goes live on a creator that executes', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n, { ratifier: W.setter }))
    h.send({ type: 'Submit', plan: setterPlan('q', t) })
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetIsRootRatified').hash, { status: 'reverted' })
    h.finalize(h.block)
    expect(h.entry(G1)).toMatchObject({ state: 'retired', retiredBy: 'creator did not execute' })
    const recovery = Object.values(h.state.plans).find(p => p.recovery?.entry === G1)
    expect(recovery?.status).toBe('executing')
    heads(h, h.config.retiredRetentionBlocks + 5)
    expect(h.entry(G1)?.state).toBe('retired')
    h.drive()
    h.head()
    expect(h.state.plans[recovery!.intentId]?.status).not.toBe('executing')
    expect(h.entry(G1)).toBeUndefined()
    h.send({ type: 'Submit', plan: { ...setterPlan('q2', t), basisBlock: h.block } })
    h.drive()
    h.head()
    h.mine(h.candidates().find(c => c.intentId === 'q2')!.hash)
    expect(h.entry(G1)).toMatchObject({ state: 'live', intentId: 'q2' })
  })

  it('keeps a retired entry while its own plan still executes a later step', () => {
    const h = new Harness().start()
    const plan = ecrecoverPlan('q', T)
    h.send({
      type: 'Submit',
      plan: { ...plan, steps: [...plan.steps, { kind: 'tx', payload: transfer(10n) }] }
    })
    h.sign()
    h.materialize(signatures => publish(T, signatures[0]), T)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    expect(h.state.plans.q?.phase).toBe('awaiting-advance')
    h.observe(G1, 300n)
    h.finalize(h.block)
    expect(h.entry(G1)?.state).toBe('retired')
    expect(h.state.plans.q?.status).toBe('executing')
    heads(h, h.config.retiredRetentionBlocks + 5)
    expect(h.entry(G1)?.state).toBe('retired')
    h.advance('q')
    h.drive()
    h.head()
    h.mine(h.candidate('0xtransfer').hash)
    h.finalize(h.block)
    expect(h.state.plans.q?.status).not.toBe('executing')
    expect(h.entry(G1)).toBeUndefined()
  })

  it('keeps a retired entry while a recovery plan and its candidate name it', () => {
    const h = new Harness().start().liveOffer()
    h.finalize(h.block)
    const stored = cancelOnStop(h)
    h.observe(G1, 300n)
    h.finalize(h.block)
    expect(h.entry(G1)).toMatchObject({ state: 'retired', retiredBy: 'filled' })
    const recovery = Object.values(h.state.plans).find(p => p.recovery?.entry === G1)
    expect(recovery?.status).toBe('executing')
    heads(h, h.config.retiredRetentionBlocks + 5)
    expect(h.entry(G1)?.state).toBe('retired')
    h.mine(stored.hash, { status: 'reverted' })
    h.finalize(h.block)
    h.head()
    expect(h.state.nonces).toEqual({})
    expect(h.entry(G1)).toBeUndefined()
  })

  it('keeps a retired entry while a nonce candidate retires it, though its plan has ended', () => {
    const h = new Harness().start().liveOffer()
    h.finalize(h.block)
    h.send({
      type: 'Submit',
      plan: {
        intentId: 'c',
        steps: [{ kind: 'tx', payload: cancel('g1') }],
        notAfter: h.now + 1_000,
        basisBlock: h.block
      }
    })
    h.drive()
    const sent = h.candidate('0xsetConsumed')
    h.tick(2_000)
    expect(h.state.plans.c?.status).not.toBe('executing')
    h.observe(G1, 300n)
    h.finalize(h.block)
    expect(h.entry(G1)?.state).toBe('retired')
    heads(h, h.config.retiredRetentionBlocks + 5)
    expect(h.entry(G1)?.state).toBe('retired')
    h.mine(sent.hash, { status: 'reverted' })
    h.finalize(h.block)
    h.head()
    expect(h.state.nonces).toEqual({})
    expect(h.entry(G1)).toBeUndefined()
  })
})

describe('retention across a restart', () => {
  it('a restart after the lazy flush holds nothing retired and admits the id afresh', () => {
    const h = filled(new Harness().start())
    h.flush()
    expect(h.disk).not.toContain(G1)
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(1)
    expect(h.entry(G1)).toBeUndefined()
    republish(h, 'q:M2')
    expect(h.entry(G1)?.state).toBe('live')
  })

  it('a restart before the lazy flush re-learns the retirement, then drops it after the window', () => {
    const h = new Harness().start().liveOffer()
    h.finalize(h.block)
    h.flush()
    h.observe(G1, 300n)
    h.finalize(h.block)
    expect(h.entry(G1)?.state).toBe('retired')
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(1)
    h.observe(G1, 300n)
    h.finalize(h.block)
    expect(h.entry(G1)?.state).toBe('retired')
    heads(h, h.config.retiredRetentionBlocks)
    expect(h.entry(G1)).toBeUndefined()
  })
})

describe('the durable digest', () => {
  const digestOf = (h: Harness) => {
    const ledger = toDurable(h.state, h.config)
    const text = encodeLedger({ ...ledger, header: { ...ledger.header, seq: 0 } })
    return createHash('sha256').update(text).digest('hex')
  }

  it('tracks the sequence-free durable text after every event, so each change is flushed', () => {
    const h = new Harness().start()
    const digests = [digestOf(h)]
    const reduce = h.send.bind(h)
    h.send = event => {
      const before = digestOf(h)
      const commands = reduce(event)
      const after = digestOf(h)
      expect(h.state.lastDurable).toBe(after)
      if (after !== before) expect(commands.some(c => c.type === 'flush')).toBe(true)
      digests.push(after)
      return commands
    }
    filled(h)
    heads(h, h.config.retiredRetentionBlocks)
    expect(new Set(digests).size).toBeGreaterThan(2)
  })
})

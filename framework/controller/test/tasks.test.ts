import type { KeyedWrite } from '@repo/engine'
import type { KernelActivity, KernelHead, KernelNodes, KernelRequest } from '@repo/kernel'

import { createRunner, keyedLevel, keyedMap, lane } from '@repo/engine'
import { layoutOf } from '@repo/engine/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { KernelHandle, KernelHealth, KernelView } from '../src'
import type { PrepareOutcome, Task, TaskEvent } from '../src/tasks'

import { defineBot, EvidenceDefectError, intentIdOf, kernelDomain, tasks, task } from '../src'

const STEPS = [
  { kind: 'tx' as const, payload: { kind: 'tx' as const, to: '0xx', data: '0x', value: 0n } }
]

type Answer = 'ok' | 'decline' | PrepareOutcome | Error

/** Acts at each key's bid, writing only that key. */
const PER_KEY = (bid: bigint, key: string) =>
  task('act', { priority: bid, conflicts: { writes: [key] } })

/** A position as read: only `bid` reaches its candidate and fact, so `read` moves its input alone. */
type Position = { bid: bigint; read?: number }

/**
 * A task family on stand-in kernel nodes the test writes itself: `view` says whether the kernel
 * acts, and every preparation waits until the test answers it. `policy` decides each candidate.
 */
const family = (
  policy: (bid: bigint, key: string) => Task,
  factValue = (_bid: bigint): unknown => true,
  timeoutMs = 60_000,
  maxReservations = 4,
  runId = 'run',
  concurrency = 2,
  quoted = false
) => {
  const asked: {
    id: string
    key: string
    signal: AbortSignal
    answer: (answer: Answer) => void
  }[] = []
  const submits: KernelRequest[] = []
  const emitted: TaskEvent[] = []
  const { graph, ...nodes } = defineBot('tasks', b => {
    const raw = b.raw(g => {
      const writes = g.occurrences<KeyedWrite<Position>>('positions.writes')
      const positions = keyedLevel(g, 'positions', writes)
      const candidates = keyedMap(g, 'candidates', positions, ({ bid }) => ({ bid }))
      const domain = kernelDomain('tasks')
      const facts = domain.fact(keyedMap(g, 'facts', positions, ({ bid }) => factValue(bid)))
      const quoteWrites = g.occurrences<KeyedWrite<string>>('quotes.writes')
      const quotes = domain.fact(keyedLevel(g, 'quotes', quoteWrites))
      const activity = g.occurrences<readonly KernelActivity[]>('kernel.activity')
      const heads = g.occurrences<KernelHead>('kernel.heads')
      const stand = {
        requests: g.occurrences<KernelRequest>('kernel.requests'),
        state: g.level('kernel.state'),
        commands: g.occurrences('kernel.commands'),
        activity,
        heads
      } as unknown as KernelNodes
      const view = g.level<KernelView>('kernel.view')
      const kernel: KernelHandle = {
        domain,
        nodes: stand,
        view,
        health: g.level<KernelHealth>('kernel.health'),
        start: async () => {},
        requestsFrom: () => {}
      }
      return {
        writes,
        quoteWrites,
        positions,
        candidates,
        facts,
        quotes,
        kernel,
        view,
        activity,
        heads
      }
    })
    const acts = tasks.each(b, 'acts', {
      kernel: raw.kernel,
      candidates: raw.candidates,
      facts: quoted ? [raw.facts, raw.quotes] : raw.facts,
      inputs: raw.positions,
      runId,
      maxReservations,
      backoff: { baseBlocks: 1, maxBlocks: 4 },
      policy: ({ bid }, key) => policy(bid, key),
      prepare: {
        lane: lane('venue', { concurrency, queue: 8 }),
        timeoutMs,
        handle: (request, { signal }) =>
          new Promise((resolve, reject) =>
            asked.push({
              id: request.id,
              key: request.key,
              signal,
              answer: answer => {
                if (answer instanceof Error) return reject(answer)
                if (typeof answer === 'object') return resolve(answer)
                resolve(
                  answer === 'ok'
                    ? { ok: true, validUntil: 60_000, steps: STEPS }
                    : { ok: false, reason: 'no_route', backoff: false }
                )
              }
            })
          )
      }
    })
    b.sink('record.submits', {
      on: { request: acts.requests },
      handle: ({ value }) => void submits.push(value)
    })
    b.sink('record.events', {
      on: { event: acts.events },
      handle: ({ value }) => void emitted.push(value)
    })
    return { ...raw, acts }
  })(undefined)
  const clock = { now: 0 }
  const runner = createRunner(graph, { now: () => clock.now })
  const write = (entries: Record<string, Position>, expiry: number | null = 60_000, block = 0) =>
    runner.push(nodes.writes, {
      coverage: 'complete',
      entries,
      basis: { block, blockHash: `0x${block}` },
      ...(expiry !== null && { expiry }),
      ...(Object.keys(entries).length === 0 && { empty: true })
    })
  const quote = (entries: Record<string, string>, observedAt: number, expiry = 60_000) =>
    runner.push(nodes.quoteWrites, {
      coverage: 'carried',
      entries,
      basis: { observedAt },
      expiry
    })
  const fail = () => runner.push(nodes.writes, { coverage: 'failed', reason: 'read' })
  const acceptingNewWork = (on: boolean) =>
    runner.push(nodes.view, {
      value: {
        busy: [],
        numReservations: 0,
        acceptingNewWork: on,
        conflictMarks: {},
        oldestPendingMs: 0,
        pendingAtCeiling: 0
      },
      basis: 'test'
    })
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const answer = async (key: string, answered: Answer = 'ok') => {
    const at = asked.findIndex(entry => entry.key === key)
    asked.splice(at, 1)[0]!.answer(answered)
    await settle()
    await settle()
  }
  const preparedOf = () =>
    submits.flatMap(request => (request.type === 'Submit' ? [request.plan.decision?.prepared] : []))
  const events = (type: TaskEvent['type']) =>
    emitted
      .filter(event => event.type === type)
      .map(event => {
        const { type: _, ...fields } = event
        return fields
      })
  return {
    graph,
    runner,
    nodes,
    asked,
    submits,
    preparedOf,
    events,
    clock,
    write,
    quote,
    fail,
    acceptingNewWork,
    answer,
    settle
  }
}

describe('a task family', () => {
  it('prepares and submits by priority, resting each act on its key', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n }, b: { bid: 3n }, c: { bid: 2n } })
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['b', 'c'])
    await bot.answer('c')
    await bot.answer('b')
    expect(bot.events('submitted').map(fields => fields.key)).toStrictEqual(['c', 'b'])
    const [first] = bot.submits
    expect(first?.type === 'Submit' && first.plan.evidence?.[0]?.id).toBe('facts/c')
    await bot.answer('a')
    await bot.runner.abandon()
  })
})

describe('a declined preparation', () => {
  it('is prepared again when only its input changes, and not when nothing does', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n, read: 1 } })
    await bot.answer('a', 'decline')
    bot.write({ a: { bid: 1n, read: 1 } })
    expect(bot.asked).toStrictEqual([])
    bot.write({ a: { bid: 1n, read: 2 } })
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a'])
    await bot.answer('a')
    expect(bot.events('submitted').map(fields => fields.key)).toStrictEqual(['a'])
    await bot.runner.abandon()
  })
})

describe('an act the kernel refuses on stale evidence', () => {
  it('is prepared again on the next read of its fact, not before, and backs nothing off', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    await bot.answer('a')
    const [submitted] = bot.submits
    const intentId = submitted?.type === 'Submit' ? submitted.plan.intentId : ''
    bot.runner.push(bot.nodes.activity, [
      {
        type: 'notice',
        intentId,
        notice: 'refused',
        code: 'evidence_predates_own_effect',
        reason: 'evidence facts/a predates our own effect on a'
      }
    ])
    expect(bot.asked).toStrictEqual([])
    expect(bot.runner.read(bot.nodes.acts.backoff.state)!.keys).toStrictEqual({})
    bot.write({ a: { bid: 1n } }, 61_000)
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a'])
    await bot.answer('a')
    await bot.runner.abandon()
  })
})

describe('a key after our own effect on what it writes', () => {
  it('is not prepared until its fact is read at or after that effect', async () => {
    const bot = family(PER_KEY)
    bot.runner.push(bot.nodes.view, {
      value: {
        busy: [],
        numReservations: 0,
        acceptingNewWork: true,
        conflictMarks: { a: 5 },
        oldestPendingMs: 0,
        pendingAtCeiling: 0
      },
      basis: 'test'
    })
    bot.write({ a: { bid: 1n }, b: { bid: 1n } }, 60_000, 4)
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['b'])
    bot.write({ a: { bid: 1n }, b: { bid: 1n } }, 60_000, 5)
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['b', 'a'])
    await bot.answer('a')
    await bot.answer('b')
    await bot.runner.abandon()
  })
})

describe('an act on a chain fact and an offchain fact', () => {
  const quotedFamily = () => family(PER_KEY, undefined, 60_000, 4, 'run', 2, true)

  it('rests on both, based at the chain fact, and holds until the earlier expiry', async () => {
    const bot = quotedFamily()
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } }, 60_000, 3)
    expect(bot.asked).toStrictEqual([])
    bot.quote({ a: 'route1' }, 10, 30_000)
    await bot.answer('a', { ok: true, steps: STEPS })
    const [submitted] = bot.submits
    expect(submitted?.type).toBe('Submit')
    if (submitted?.type === 'Submit') {
      expect(submitted.plan.evidence?.map(fact => fact.basis)).toStrictEqual([
        { block: 3, blockHash: '0x3' },
        { observedAt: 10 }
      ])
      expect(submitted.plan.basisBlock).toBe(3)
      expect(submitted.plan.notAfter).toBe(30_000)
    }
    await bot.runner.abandon()
  })

  it('drops a prepared act once the offchain fact changes version', async () => {
    const bot = quotedFamily()
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    bot.quote({ a: 'route1' }, 10)
    bot.quote({ a: 'route2' }, 20)
    await bot.answer('a', { ok: true, steps: STEPS })
    expect(bot.submits).toStrictEqual([])
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a'])
    await bot.answer('a', { ok: true, steps: STEPS })
    expect(bot.events('submitted').map(fields => fields.key)).toStrictEqual(['a'])
    await bot.runner.abandon()
  })

  it('drops an act whose offchain fact has no expiry, naming the facts', async () => {
    const bot = quotedFamily()
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    bot.runner.push(bot.nodes.quoteWrites, {
      coverage: 'carried',
      entries: { a: 'route1' },
      basis: { observedAt: 10 }
    })
    await bot.answer('a', { ok: true, steps: STEPS })
    expect(bot.events('dropped')).toStrictEqual([
      { key: 'a', task: 'act', reason: 'fact_unbounded', fact: 'facts/a+quotes/a' }
    ])
    expect(bot.submits).toStrictEqual([])
    await bot.runner.abandon()
  })

  it('is held for its chain fact predating our own effect, never for its offchain one', async () => {
    const bot = quotedFamily()
    bot.runner.push(bot.nodes.view, {
      value: {
        busy: [],
        numReservations: 0,
        acceptingNewWork: true,
        conflictMarks: { a: 5 },
        oldestPendingMs: 0,
        pendingAtCeiling: 0
      },
      basis: 'test'
    })
    bot.quote({ a: 'route1' }, 0)
    bot.write({ a: { bid: 1n } }, 60_000, 4)
    expect(bot.asked).toStrictEqual([])
    bot.write({ a: { bid: 1n } }, 60_000, 5)
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a'])
    await bot.answer('a')
    await bot.runner.abandon()
  })
})

describe('a preparation without its own validity', () => {
  it('is submitted to hold until its fact expires', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } }, 45_000)
    await bot.answer('a', { ok: true, steps: STEPS })
    const [submitted] = bot.submits
    expect(submitted?.type === 'Submit' && submitted.plan.notAfter).toBe(45_000)
    await bot.runner.abandon()
  })
})

describe('a key that fails closed', () => {
  it('never submits what was prepared before, only a preparation asked after it reopens', async () => {
    let throws = false
    const bot = family((bid, key) => {
      if (throws) throw new Error('the policy broke')
      return PER_KEY(bid, key)
    })
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    const [voided] = bot.asked
    throws = true
    bot.acceptingNewWork(true)
    expect(bot.events('rejected')).toStrictEqual([{ key: 'a', reason: 'policy_threw' }])
    await bot.answer('a')
    throws = false
    bot.acceptingNewWork(true)
    expect(bot.submits).toStrictEqual([])
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a'])
    await bot.answer('a')
    expect(bot.preparedOf()).toHaveLength(1)
    expect(bot.preparedOf()).not.toContain(voided!.id)
    await bot.runner.abandon()
  })

  it('keeps a voided ticket in its lane after the policy recovers', async () => {
    let invalid = false
    const bot = family((bid, key) =>
      invalid && key === 'a' ? (undefined as unknown as Task) : PER_KEY(bid, key)
    )
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 3n }, b: { bid: 2n }, c: { bid: 1n } })
    const [voided] = bot.asked
    invalid = true
    bot.acceptingNewWork(true)
    invalid = false
    bot.acceptingNewWork(true)
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a', 'b'])
    await bot.answer('a')
    expect(bot.submits).toStrictEqual([])
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['b', 'a'])
    await bot.answer('a')
    expect(bot.preparedOf()).toHaveLength(1)
    expect(bot.preparedOf()).not.toContain(voided!.id)
    await bot.answer('b')
    await bot.answer('c')
    await bot.runner.abandon()
  })

  it("backoff is independent of whether the answer's ticket is still current", async () => {
    let invalid = false
    const bot = family(
      (bid, key) => (invalid && key === 'a' ? (undefined as unknown as Task) : PER_KEY(bid, key)),
      undefined,
      60_000,
      4,
      'run',
      1
    )
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 2n } })
    const [voided] = bot.asked
    invalid = true
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 2n }, b: { bid: 1n } })
    invalid = false
    bot.acceptingNewWork(true)
    expect(bot.runner.read(bot.nodes.acts.state)!.preparing.a).toMatchObject({
      id: voided!.id,
      void: true
    })

    await bot.answer('a', new Error('preparation failed'))
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['b'])
    expect(bot.events('prepare_failed')).toStrictEqual([
      { key: 'a', task: 'act', ticket: voided!.id, reason: 'prepare_threw' }
    ])
    expect(bot.runner.read(bot.nodes.acts.backoff.state)!.keys.a?.act?.failures).toBe(1)
    expect(bot.submits).toStrictEqual([])

    await bot.answer('b', 'decline')
    bot.runner.push(bot.nodes.heads, { number: 1, hash: '0x1' })
    const [fresh] = bot.asked
    expect(fresh?.key).toBe('a')
    expect(fresh?.id).not.toBe(voided?.id)
    await bot.answer('a')
    expect(bot.preparedOf()).toStrictEqual([fresh!.id])
    expect(bot.preparedOf()).not.toContain(voided!.id)
    await bot.runner.abandon()
  })

  it('drops a prepared act it was holding, and submits only a fresh one', async () => {
    let throws = false
    const bot = family((bid, key) => {
      if (throws) throw new Error('the policy broke')
      return PER_KEY(bid, key)
    })
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    const [held] = bot.asked
    bot.acceptingNewWork(false)
    await bot.answer('a')
    throws = true
    bot.acceptingNewWork(false)
    expect(bot.events('dropped')).toStrictEqual([
      { key: 'a', task: 'act', reason: 'policy_rejected' }
    ])
    throws = false
    bot.acceptingNewWork(true)
    expect(bot.submits).toStrictEqual([])
    await bot.answer('a')
    expect(bot.preparedOf()).toHaveLength(1)
    expect(bot.preparedOf()).not.toContain(held!.id)
    await bot.runner.abandon()
  })
})

describe('a policy return the runtime refuses', () => {
  it('fails only its key, with a named rejection, and the bot runs on', async () => {
    const malformed: Readonly<Record<string, () => Task>> = {
      handBuilt: () => ({ kind: 'task', name: 'act', priority: 1n, conflicts: {} }),
      number: () => task('act', { priority: 1 as unknown as bigint, conflicts: {} }),
      hole: () => task('act', { priority: 1n, conflicts: { writes: Array.from({ length: 1 }) } }),
      dotted: () => task('a.ct', { priority: 1n, conflicts: {} })
    }
    const bot = family((bid, key) => malformed[key]?.() ?? PER_KEY(bid, key))
    const entries = {
      good: { bid: 1n },
      ...Object.fromEntries(Object.keys(malformed).map(key => [key, { bid: 9n }]))
    }
    bot.acceptingNewWork(true)
    bot.write(entries)
    expect(bot.events('rejected')).toStrictEqual(
      Object.keys(malformed)
        .toSorted()
        .map(key => ({ key, reason: 'policy_invalid' }))
    )
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['good'])
    await bot.answer('good')
    expect(bot.events('submitted').map(fields => fields.key)).toStrictEqual(['good'])
    bot.acceptingNewWork(true)
    expect(bot.events('rejected')).toHaveLength(Object.keys(malformed).length)
    await bot.runner.abandon()
  })
})

describe('a task whose fields change after it was built', () => {
  it('acts on the task as it was read, never reading its spec again', async () => {
    const bot = family((bid, key) => {
      let reads = 0
      return task('act', {
        get priority() {
          reads++
          if (reads > 1) throw new Error('read twice')
          return bid
        },
        conflicts: { writes: [key] }
      })
    })
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    await bot.answer('a')
    expect(bot.events('rejected')).toStrictEqual([])
    expect(bot.events('submitted').map(fields => fields.key)).toStrictEqual(['a'])
    await bot.runner.abandon()
  })
})

describe('a policy whose task changes', () => {
  it('drops the old ready act and submits only a preparation of the new task', async () => {
    let name = 'one'
    const bot = family((bid, key) => task(name, { priority: bid, conflicts: { writes: [key] } }))
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    const [old] = bot.asked
    bot.acceptingNewWork(false)
    await bot.answer('a')
    name = 'two'
    bot.acceptingNewWork(true)
    expect(bot.events('dropped')).toStrictEqual([{ key: 'a', task: 'one', reason: 'task_changed' }])
    expect(bot.submits).toStrictEqual([])
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a'])
    const [fresh] = bot.asked
    await bot.answer('a')
    expect(bot.preparedOf()).toStrictEqual([fresh!.id])
    expect(bot.preparedOf()).not.toContain(old!.id)
    await bot.runner.abandon()
  })

  it('drops a ready act whose task keeps its name but changes its conflicts', async () => {
    let writes = ['A']
    const bot = family(bid => task('one', { priority: bid, conflicts: { writes } }))
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    bot.acceptingNewWork(false)
    await bot.answer('a')
    writes = ['B']
    bot.acceptingNewWork(true)
    expect(bot.events('dropped')).toStrictEqual([{ key: 'a', task: 'one', reason: 'task_changed' }])
    expect(bot.submits).toStrictEqual([])
    await bot.answer('a')
    const [submitted] = bot.submits
    expect(submitted?.type === 'Submit' && submitted.plan.conflicts).toStrictEqual({
      writes: ['B']
    })
    await bot.runner.abandon()
  })
})

describe('two tasks of one key', () => {
  it('keep independent backoff: a task backed off never holds the other', async () => {
    let name = 'swap'
    const bot = family((bid, key) => task(name, { priority: bid, conflicts: { writes: [key] } }))
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    await bot.answer('a', { ok: false, reason: 'no_route', backoff: true })
    expect(bot.asked).toStrictEqual([])

    name = 'writeoff'
    bot.write({ a: { bid: 2n } })
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a'])
    await bot.answer('a')
    const [submitted] = bot.submits
    expect(submitted?.type === 'Submit' && submitted.plan.intentId).toBe('a#run.2.writeoff')
    expect(Object.keys(bot.runner.read(bot.nodes.acts.backoff.state)!.keys.a!)).toStrictEqual([
      'swap'
    ])
    await bot.runner.abandon()
  })
})

describe('a prepared act whose key backs off after an act the bot wrote raw', () => {
  it('is held, not submitted, until the backoff ends, and then submitted as prepared', async () => {
    const bot = family(PER_KEY)
    const { activity, heads } = bot.nodes
    const raw = 'a#raw.0'
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    const [prepared] = bot.asked
    bot.runner.push(bot.nodes.view, {
      value: {
        busy: ['a'],
        numReservations: 1,
        acceptingNewWork: true,
        conflictMarks: {},
        oldestPendingMs: 0,
        pendingAtCeiling: 0
      },
      basis: 'test'
    })
    await bot.answer('a')
    expect(bot.submits).toStrictEqual([])
    const failed: readonly KernelActivity[] = [{ type: 'notice', intentId: raw, notice: 'failed' }]
    bot.runner.pushAll([
      {
        node: activity,
        value: failed
      },
      {
        node: bot.nodes.view,
        value: {
          value: {
            busy: [],
            numReservations: 0,
            acceptingNewWork: true,
            conflictMarks: {},
            oldestPendingMs: 0,
            pendingAtCeiling: 0
          },
          basis: 'test'
        }
      }
    ])
    expect(bot.submits).toStrictEqual([])
    bot.runner.push(heads, { number: 2, hash: '0x2' })
    expect(bot.preparedOf()).toStrictEqual([prepared!.id])
    await bot.runner.abandon()
  })
})

describe('an owned preparation', () => {
  it('ignores stale tickets, foreign keys and wrong versions without releasing the lane', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 2n }, b: { bid: 1n } })
    const state = bot.runner.read(bot.nodes.acts.state)!
    const asked = state.preparing.a!
    const answer = {
      id: asked.id,
      key: 'a',
      version: asked.readings[0]!.fact.version,
      ok: true,
      validUntil: 60_000,
      steps: STEPS
    }
    const fold = layoutOf(bot.graph).operators.find(op => op.kind === 'fold' && op.id === 'acts')!
    if (fold.kind !== 'fold') throw new Error('missing family fold')
    for (const foreign of [
      { ...answer, id: 'old-ticket' },
      { ...answer, key: 'b' },
      { ...answer, version: 'wrong-version' }
    ]) {
      expect(
        fold.applyInput(state, { from: 'prepared', value: foreign, stamp: { seq: 0, at: 0 } }).state
      ).toBe(state)
    }
    await bot.answer('a')
    await bot.answer('b')
    expect(bot.events('submitted').map(fields => fields.key)).toStrictEqual(['a', 'b'])
    await bot.runner.abandon()
  })

  it('stamps the adapter outcome itself and keeps evidence from its own captured reading', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    const captured = bot.runner.read(bot.nodes.acts.state)!.preparing.a!
    const forged = {
      id: 'foreign-ticket',
      key: 'foreign-key',
      task: 'foreign-task',
      version: 'foreign-version',
      evidence: { fact: { id: 'foreign-fact', version: 'foreign-version' } },
      block: 99,
      ok: true as const,
      validUntil: 60_000,
      steps: STEPS
    }
    await bot.answer('a', forged)
    expect(bot.runner.read(bot.nodes.acts.prepared)).toStrictEqual({
      ...forged,
      id: captured.id,
      key: 'a',
      task: 'act',
      version: captured.readings[0]!.fact.version
    })
    const [submitted] = bot.submits
    expect(submitted?.type).toBe('Submit')
    if (submitted?.type === 'Submit') {
      expect(submitted.plan.evidence).toStrictEqual([captured.readings[0]!.fact])
      expect(submitted.plan.basisBlock).toBe(0)
      expect(submitted.plan.decision).toStrictEqual({
        key: 'a',
        priority: '1',
        prepared: captured.id
      })
    }
    await bot.runner.abandon()
  })

  it("caps the submitted plan's fees at the spend its preparation allows", async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    await bot.answer('a', { ok: true, validUntil: 60_000, steps: STEPS, maxSpendWei: 7n })
    const [submitted] = bot.submits
    expect(submitted?.type === 'Submit' && submitted.plan.maxSpendWei).toBe(7n)
    await bot.runner.abandon()
  })

  it('drops an answer whose captured version no longer matches the current fact', async () => {
    const bot = family(PER_KEY, bid => bid)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    const [stale] = bot.asked
    bot.write({ a: { bid: 2n } })
    await bot.answer('a')
    expect(bot.events('dropped')).toStrictEqual([{ key: 'a', task: 'act', reason: 'fact_changed' }])
    expect(bot.submits).toStrictEqual([])
    const [fresh] = bot.asked
    await bot.answer('a')
    expect(bot.preparedOf()).toStrictEqual([fresh!.id])
    expect(bot.preparedOf()).not.toContain(stale!.id)
    await bot.runner.abandon()
  })
})

describe('keys named like the fields every object inherits', () => {
  it('are prepared and submitted like any other', async () => {
    const bot = family(PER_KEY)
    const keys = ['constructor', 'toString', '__proto__']
    bot.acceptingNewWork(true)
    expect(bot.asked).toStrictEqual([])
    bot.write(Object.fromEntries(keys.map((key, i) => [key, { bid: BigInt(i + 1) }])))
    expect(bot.asked.map(entry => entry.key)).toContain('__proto__')
    while (bot.asked.length > 0) await bot.answer(bot.asked[0]!.key)
    expect(bot.events('submitted').map(fields => fields.key)).toStrictEqual([
      '__proto__',
      'toString',
      'constructor'
    ])
    expect(bot.submits).toHaveLength(keys.length)
    await bot.runner.abandon()
  })
})

describe('a fact that bounds no act', () => {
  it('drops an act on a fact with no expiry, naming it, until its inputs change', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } }, null)
    await bot.answer('a')
    expect(bot.events('dropped')).toStrictEqual([
      { key: 'a', task: 'act', reason: 'fact_unbounded', fact: 'facts/a' }
    ])
    bot.acceptingNewWork(true)
    expect(bot.asked).toStrictEqual([])
    bot.write({ a: { bid: 2n } }, null)
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a'])
    await bot.answer('a')
    expect(bot.submits).toStrictEqual([])
    await bot.runner.abandon()
  })

  it('drops an act whose fact expired, and prepares none on it after a failed read', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } }, 100)
    bot.clock.now = 100
    bot.fail()
    await bot.answer('a')
    expect(bot.events('dropped')).toStrictEqual([{ key: 'a', task: 'act', reason: 'fact_expired' }])
    bot.acceptingNewWork(true)
    expect(bot.asked).toStrictEqual([])
    bot.write({ a: { bid: 1n } }, 200)
    await bot.answer('a')
    expect(bot.events('submitted').map(fields => fields.key)).toStrictEqual(['a'])
    await bot.runner.abandon()
  })
})

describe('a preparation the runtime answers itself', () => {
  afterEach(() => void vi.useRealTimers())

  it('times out a handler that ignores its signal, freeing its slot and backing its key off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const bot = family(PER_KEY, undefined, 20)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 3n }, b: { bid: 2n }, c: { bid: 1n } })
    const [a, b] = bot.asked
    expect([a?.key, b?.key]).toStrictEqual(['a', 'b'])
    vi.advanceTimersByTime(20)
    await bot.settle()
    await bot.settle()
    expect([a?.signal.aborted, b?.signal.aborted]).toStrictEqual([true, true])
    expect(bot.events('prepare_failed')).toStrictEqual([
      { key: 'a', task: 'act', ticket: a!.id, reason: 'prepare_timed_out' },
      { key: 'b', task: 'act', ticket: b!.id, reason: 'prepare_timed_out' }
    ])
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a', 'b', 'c'])
    await bot.answer('a')
    await bot.answer('b')
    expect(bot.submits).toStrictEqual([])
    bot.runner.push(bot.nodes.heads, { number: 1, hash: '0x1' })
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['c', 'a'])
    await bot.answer('a')
    await bot.answer('c')
    expect(bot.events('submitted').map(fields => fields.key)).toStrictEqual(['a', 'c'])
    await bot.runner.abandon()
  })

  it('backs off a key whose handler throws, logging only its reason, and runs on', async () => {
    const secret = 'https://rpc.example/secret'
    class rpc_example_secret extends Error {}
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 2n }, b: { bid: 1n } })
    const [a] = bot.asked
    await bot.answer(
      'a',
      Object.assign(new rpc_example_secret(secret), { name: secret, code: secret })
    )
    expect(bot.events('prepare_failed')).toMatchObject([
      { key: 'a', task: 'act', ticket: a!.id, reason: 'prepare_threw' }
    ])
    expect(bot.runner.read(bot.nodes.acts.backoff.state)!.keys.a?.act?.failures).toBe(1)
    const forged = Object.assign(
      Object.create(
        Object.assign(Object.create(Error.prototype), { constructor: { name: secret } })
      ),
      { name: secret, message: secret, cause: new Error(secret) }
    )
    bot.write({ a: { bid: 2n }, b: { bid: 1n }, c: { bid: 3n } })
    await bot.answer('c', forged)
    expect(bot.events('prepare_failed').at(-1)).toMatchObject({
      key: 'c',
      reason: 'prepare_threw'
    })
    expect(JSON.stringify(bot.events('prepare_failed'))).not.toContain('rpc')
    await bot.answer('b')
    expect(bot.events('submitted').map(fields => fields.key)).toStrictEqual(['b'])
    expect(bot.asked).toStrictEqual([])
    await bot.runner.abandon()
  })

  it('lets a clean stop settle with a hung preparation in flight', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    const [a] = bot.asked
    await bot.runner.abandon()
    expect(a?.signal.aborted).toBe(true)
    expect(bot.events('prepare_failed')).toStrictEqual([])
  })

  it('is refused at build without a timeout it can arm', () => {
    for (const timeoutMs of [0, 1.5, 2 ** 31, Number.NaN])
      expect(() => family(PER_KEY, undefined, timeoutMs)).toThrow(
        'acts needs prepare.timeoutMs, a whole number of milliseconds from 1 to 2147483647'
      )
  })

  it('is refused at build without a reservation cap it can reach', () => {
    for (const maxReservations of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])
      expect(() => family(PER_KEY, undefined, 60_000, maxReservations)).toThrow(
        'acts needs maxReservations, a whole number from 0'
      )
  })

  it('is refused at build with a runId its intent ids cannot be parsed back to', () => {
    for (const runId of ['v1.2', 'a#b'])
      expect(() => family(PER_KEY, undefined, 60_000, 4, runId)).toThrow(
        "acts needs a runId that holds neither '.' nor '#'"
      )
  })
})

describe('a key whose act an earlier run left behind', () => {
  it('backs off after a restart when that act fails, though nothing was carried over', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.runner.push(bot.nodes.heads, { number: 1, hash: '0x1' })
    bot.runner.push(bot.nodes.activity, [
      { type: 'notice', intentId: intentIdOf('a', 'earlier', 0, 'act'), notice: 'failed' },
      {
        type: 'notice',
        intentId: intentIdOf('b', 'earlier', 1, 'act'),
        notice: 'compensating',
        reason: 'restart withdraws b: policy now refuses: x'
      }
    ] as unknown as readonly KernelActivity[])
    bot.write({ a: { bid: 2n }, b: { bid: 1n } })
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['b'])
    bot.runner.push(bot.nodes.heads, { number: 2, hash: '0x2' })
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['b', 'a'])
    await bot.answer('a')
    await bot.answer('b')
    expect(bot.events('submitted').map(fields => fields.key)).toStrictEqual(['a', 'b'])
    await bot.runner.abandon()
  })
})

/** Each key's phase as the family's phase node holds it, or the key's status when not present. */
const phasesOf = (bot: ReturnType<typeof family>) => {
  const keyed = bot.runner.read(bot.nodes.acts.phase)!
  expect(keyed.coverage).toStrictEqual({ status: 'complete' })
  return Object.fromEntries(
    Object.entries(keyed.keys).map(([key, record]) => [
      key,
      record.status === 'present' ? record.value : record.status
    ])
  )
}

describe("a family's phase node", () => {
  afterEach(() => void vi.useRealTimers())

  it('holds each key in the phase its own rules hold it in, then acts as it said', async () => {
    const bot = family(
      (bid, key) => {
        if (key === 'r') throw new Error('the policy broke')
        return PER_KEY(bid, key)
      },
      undefined,
      60_000,
      10,
      'run',
      10
    )
    const view = (acceptingNewWork: boolean) =>
      bot.runner.push(bot.nodes.view, {
        value: {
          busy: ['f'],
          numReservations: 0,
          acceptingNewWork,
          conflictMarks: { w: 5 },
          oldestPendingMs: 0,
          pendingAtCeiling: 0
        },
        basis: 'test'
      })
    const positions = {
      s: { bid: 9n },
      t: { bid: 8n },
      y: { bid: 7n },
      p: { bid: 6n },
      b: { bid: 4n },
      d: { bid: 3n },
      w: { bid: 1n },
      r: { bid: 1n },
      f: { bid: 1n }
    }
    view(true)
    bot.write(positions, 60_000, 4)
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['s', 't', 'y', 'p', 'b', 'd'])
    await bot.answer('s')
    await bot.answer('t')
    const refused = bot.submits.find(
      request => request.type === 'Submit' && request.plan.decision?.key === 't'
    )
    bot.runner.push(bot.nodes.activity, [
      {
        type: 'notice',
        intentId: refused?.type === 'Submit' ? refused.plan.intentId : '',
        notice: 'refused',
        code: 'evidence_expired',
        reason: 'evidence facts/t expired'
      }
    ])
    await bot.answer('b', { ok: false, reason: 'no_route', backoff: true })
    await bot.answer('d', 'decline')
    view(false)
    await bot.answer('y')
    bot.write({ ...positions, e: { bid: 2n }, g: { bid: 5n } }, 60_000, 4)

    const act = { task: 'act' }
    expect(phasesOf(bot)).toStrictEqual({
      f: { ...act, phase: 'in_flight', priority: 1n },
      s: { ...act, phase: 'submitted', priority: 9n },
      y: { ...act, phase: 'ready', priority: 7n, detail: 'not_accepting' },
      p: { ...act, phase: 'preparing', priority: 6n },
      g: { ...act, phase: 'eligible', priority: 5n, detail: 'not_accepting' },
      e: { ...act, phase: 'eligible', priority: 2n, detail: 'not_accepting' },
      w: { ...act, phase: 'waiting', priority: 1n, detail: 'predates_own_effect' },
      b: { ...act, phase: 'backed_off', priority: 4n, until: 1, failures: 1 },
      d: { ...act, phase: 'declined', priority: 3n },
      t: { ...act, phase: 'stale', priority: 8n },
      r: { phase: 'rejected', detail: 'policy_threw' }
    })

    view(true)
    expect(bot.events('submitted').map(fields => fields.key)).toStrictEqual(['s', 't', 'y'])
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['p', 'g', 'e'])
    expect(phasesOf(bot)).toMatchObject({
      y: { phase: 'submitted' },
      g: { phase: 'preparing' },
      e: { phase: 'preparing' }
    })
    await bot.runner.abandon()
  })

  it('names the first slot rule an eligible key waits on', async () => {
    const bot = family(PER_KEY, undefined, 60_000, 2, 'run', 1)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 3n }, b: { bid: 2n }, c: { bid: 1n } })
    expect(phasesOf(bot)).toMatchObject({
      a: { phase: 'preparing' },
      b: { phase: 'eligible', detail: 'lane_full' }
    })
    await bot.answer('a')
    expect(phasesOf(bot)).toMatchObject({
      a: { phase: 'submitted' },
      b: { phase: 'preparing' },
      c: { phase: 'eligible', detail: 'lane_full' }
    })
    await bot.answer('b')
    expect(phasesOf(bot)).toMatchObject({
      b: { phase: 'submitted' },
      c: { phase: 'eligible', detail: 'reservations_full' }
    })
    await bot.runner.abandon()
  })

  it('moves a hold that ends by time alone at the next decision, as the family drops it', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } }, 1_000)
    bot.acceptingNewWork(false)
    await bot.answer('a', { ok: true, validUntil: 50, steps: STEPS })
    const a = { task: 'act', priority: 1n }
    expect(phasesOf(bot)).toStrictEqual({ a: { ...a, phase: 'ready', detail: 'not_accepting' } })

    bot.clock.now = 50
    expect(phasesOf(bot)).toStrictEqual({ a: { ...a, phase: 'ready', detail: 'not_accepting' } })
    bot.acceptingNewWork(false)
    expect(bot.events('dropped')).toStrictEqual([
      { key: 'a', task: 'act', reason: 'preparation_expired' }
    ])
    expect(phasesOf(bot)).toStrictEqual({ a: { ...a, phase: 'eligible', detail: 'not_accepting' } })
    await bot.runner.abandon()
  })

  it("moves to waiting at the step a fact expires, though the family's state is unchanged", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const bot = family(PER_KEY)
    bot.runner.start()
    bot.acceptingNewWork(false)
    bot.write({ a: { bid: 1n } }, 1_000)
    const a = { task: 'act', priority: 1n }
    expect(phasesOf(bot)).toStrictEqual({ a: { ...a, phase: 'eligible', detail: 'not_accepting' } })
    const state = bot.runner.record(bot.nodes.acts.state)

    bot.clock.now = 1_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(bot.runner.record(bot.nodes.acts.state)).toBe(state)
    expect(phasesOf(bot)).toStrictEqual({ a: { ...a, phase: 'waiting', detail: 'fact_expired' } })
    await bot.runner.abandon()
  })

  it('reads the policy once per decision, and shows the answer that decision read', async () => {
    const reads: string[] = []
    const bot = family((bid, key) => {
      reads.push(key)
      return PER_KEY(bid + BigInt(reads.length), key)
    })
    bot.acceptingNewWork(false)
    bot.write({ a: { bid: 0n }, b: { bid: 0n } })
    expect(reads).toStrictEqual(['a', 'b'])
    expect(phasesOf(bot)).toMatchObject({ a: { priority: 1n }, b: { priority: 2n } })

    bot.acceptingNewWork(false)
    expect(reads).toStrictEqual(['a', 'b', 'a', 'b'])
    expect(phasesOf(bot)).toMatchObject({ a: { priority: 3n }, b: { priority: 4n } })
    await bot.runner.abandon()
  })

  it('shows the last decision of a step in which the family decided twice', async () => {
    const reads: string[] = []
    const bot = family((bid, key) => {
      reads.push(key)
      return PER_KEY(bid + BigInt(reads.length), key)
    })
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 0n } })
    await bot.answer('a', {
      ok: true,
      validUntil: 60_000,
      steps: STEPS,
      exemptFromBackoff: ['reverted']
    })
    expect(bot.events('submitted').map(fields => fields.key)).toStrictEqual(['a'])
    expect(reads).toStrictEqual(['a', 'a', 'a'])
    expect(phasesOf(bot)).toStrictEqual({ a: { phase: 'submitted', task: 'act', priority: 3n } })
    await bot.runner.abandon()
  })

  it('fails the decision on a malformed reading of a key that a ticket holds', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a'])
    const stopped = bot.runner.stopped.then(
      () => undefined,
      (error: unknown) => error
    )
    try {
      bot.runner.push(bot.nodes.writes, {
        coverage: 'complete',
        entries: { a: { bid: 1n } },
        basis: 'bad-basis',
        expiry: 60_000
      })
    } catch {}
    expect(await stopped).toBeInstanceOf(EvidenceDefectError)
  })
})

describe('a projection the phase node cannot hold', () => {
  it('fails only its own coverage, coded, when the projection throws', async () => {
    const bot = family(PER_KEY)
    bot.runner.push(bot.nodes.view, {
      value: {
        busy: {} as unknown as readonly string[],
        numReservations: 0,
        acceptingNewWork: false,
        conflictMarks: {},
        oldestPendingMs: 0,
        pendingAtCeiling: 0
      },
      basis: 'test'
    })
    bot.write({ a: { bid: 1n } })
    expect(bot.runner.read(bot.nodes.acts.phase)).toStrictEqual({
      coverage: { status: 'failed', reason: 'projection_threw' },
      keys: {}
    })
    await bot.runner.abandon()
  })

  it('keeps the record of a key whose phase a decision leaves unchanged, and replaces a changed one', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(false)
    bot.write({ a: { bid: 1n }, b: { bid: 2n } })
    const first = bot.runner.read(bot.nodes.acts.phase)!
    bot.write({ a: { bid: 5n }, b: { bid: 2n } })
    const next = bot.runner.read(bot.nodes.acts.phase)!
    expect(next.keys.b).toBe(first.keys.b)
    expect(next.keys.a).not.toBe(first.keys.a)
    expect(next.keys.a).toMatchObject({ status: 'present', value: { priority: 5n } })
    await bot.runner.abandon()
  })

  it('fails only its own coverage, never the graph, on a busy key that is no data field', async () => {
    const bot = family(PER_KEY)
    bot.runner.push(bot.nodes.view, {
      value: {
        busy: ['$bigint'],
        numReservations: 0,
        acceptingNewWork: true,
        conflictMarks: {},
        oldestPendingMs: 0,
        pendingAtCeiling: 0
      },
      basis: 'test'
    })
    bot.write({ a: { bid: 1n } })
    expect(bot.runner.read(bot.nodes.acts.phase)).toStrictEqual({
      coverage: { status: 'failed', reason: 'not_data' },
      keys: {}
    })
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a'])
    await bot.runner.abandon()
  })
})

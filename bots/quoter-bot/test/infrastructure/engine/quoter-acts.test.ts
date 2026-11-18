import type { KeyedWrite } from '@repo/engine'
import type { KernelActivity, KernelRequest, KernelState, Plan } from '@repo/kernel'
import type { Hex } from 'viem'

import { Offer, Tree } from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { kernelDomain, parseIntentId } from '@repo/controller'
import { createGraph, createRunner, every, keyedLevel, keyedMap, keyRecord } from '@repo/engine'
import { midnightCommitmentId, midnightWitness } from '@repo/validators'
import { zeroAddress } from 'viem'
import { afterEach, describe, expect, test } from 'vitest'

import type { Act, Outcome } from '../../../src/application/engine/decision'
import type { ActEvent, Decided } from '../../../src/infrastructure/engine/quoter-acts'

import { declareActs } from '../../../src/infrastructure/engine/quoter-acts'
import { marketParams } from '../../application/engine/world.fixtures'

const START = Date.UTC(2026, 10, 1)
const READ_HOLDS_MS = 60_000
const marketA: Hex = `0x${'11'.repeat(32)}`
const marketB: Hex = `0x${'22'.repeat(32)}`
const A = `ladder:${marketA}`
const B = `ladder:${marketB}`

const replace = (marketId: Hex): Act => ({
  kind: 'replace',
  identity: `publish:${marketId}`,
  payload: { cancel: [], publication: { quote: { marketId }, groups: [] } },
  condition: 'recenter'
})

const withdraw: Act = {
  kind: 'cancel',
  identity: 'withdraw',
  payload: { cancel: [] },
  condition: 'withdraw'
}

const decided = (marketId: Hex, act: Act | undefined, generation: number): Decided => ({
  decision: {
    keep: [],
    desire: `book:${marketId}`,
    ...(act && { act }),
    steady: act === undefined,
    detail: { workflow: 'ladder', marketId, status: 'applied', action: 'publish' }
  },
  request: { digest: `${marketId}@${generation}`, params: {} },
  completes: false
})

type SubmittedPlan = Extract<KernelRequest, { type: 'Submit' }>['plan']

const kernelState = (
  plans: readonly Plan[],
  bookMark?: number,
  now = START,
  lifecycle: KernelState['lifecycle']['kind'] = 'running'
) =>
  ({
    lifecycle: { kind: lifecycle },
    now,
    entries: {},
    plans: Object.fromEntries(plans.map(plan => [plan.intentId, plan])),
    conflictMarks: bookMark === undefined ? {} : { 'quoter:book': bookMark }
  }) as unknown as KernelState

const harness = () => {
  const g = createGraph('quoter-acts')
  const worldWrites = g.occurrences<KeyedWrite<Decided>>('world.writes')
  const world = keyedLevel(g, 'world', worldWrites)
  const domain = kernelDomain('quoter')
  const desires = domain.fact(keyedMap(g, 'desires', world, value => value.decision.desire))
  const kernel = g.level<KernelState>('kernel')
  const activity = g.occurrences<readonly KernelActivity[]>('activity')
  const gate = g.occurrences<true>('gate')
  const answers = g.occurrences<Readonly<{ key: string; seq: number }>>('answers')
  const requests = g.node<KernelRequest>('requests')
  const events = g.node<ActEvent>('events')
  const { prepare, phase } = declareActs(g, {
    runId: 'run',
    keys: [A, B],
    signing: {
      chainId: 8453,
      maker: `0x${'aa'.repeat(20)}`,
      signer: `0x${'aa'.repeat(20)}`,
      ratifier: () => 'setter'
    },
    decisions: world,
    domain,
    desires,
    world,
    kernel,
    activity,
    gate,
    answers,
    requests,
    events,
    receiptTimeoutMs: READ_HOLDS_MS,
    readValidityMs: READ_HOLDS_MS
  })
  const submitted = g.fold('seen.submits', {
    reads: { request: every(requests) },
    initial: [] as SubmittedPlan[],
    applyInput: (seen, { value }) => ({
      state: value.type === 'Submit' ? [...seen, value.plan] : seen
    })
  })
  const outcomes = g.fold('seen.outcomes', {
    reads: { event: every(events) },
    initial: [] as Outcome[],
    applyInput: (seen, { value }) => ({
      state: value.type === 'ended' ? [...seen, value.outcome] : seen
    })
  })
  const prepared = g.fold('seen.prepares', {
    reads: { request: every(prepare) },
    initial: [] as Readonly<{ key: string; seq: number }>[],
    applyInput: (seen, { value }) => ({ state: [...seen, { key: value.key, seq: value.seq }] })
  })
  domain.facts()

  let block = 100
  let clock = START
  const runner = createRunner(g.build(), { now: () => clock })
  const read = (entries: Readonly<Record<string, Decided>>, at = block) => {
    block = at
    runner.push(worldWrites, {
      coverage: 'complete',
      entries,
      basis: { block: at, blockHash: `0x${at.toString(16).padStart(64, '0')}` },
      expiry: START + READ_HOLDS_MS
    })
  }
  const kernelReports = (state: KernelState, notices: readonly KernelActivity[] = []) =>
    runner.pushAll([
      { node: kernel, value: { value: state, basis: { block } } },
      ...(notices.length > 0 ? [{ node: activity, value: notices }] : [])
    ])
  const answer = (key: string) => {
    for (const request of runner.read(prepared)!.filter(request => request.key === key))
      runner.push(answers, request)
  }

  runner.push(kernel, { value: kernelState([]), basis: { block } })
  runner.push(gate, true)
  const phases = () => {
    const keyed = runner.read(phase)!
    return Object.fromEntries(
      [A, B].map(key => {
        const fact = keyRecord(keyed, key)
        return [key, fact.status === 'present' ? fact.value : fact.status]
      })
    )
  }
  const unreadable = () => runner.push(worldWrites, { coverage: 'failed', reason: 'read failed' })
  return {
    runner,
    read,
    kernelReports,
    answer,
    submits: () => runner.read(submitted)!,
    outcomes: () => runner.read(outcomes)!,
    advance: (ms: number) => void (clock += ms),
    phases,
    unreadable
  }
}

type Harness = ReturnType<typeof harness>
let running: Harness | undefined
afterEach(async () => {
  await running?.runner.abandon()
  running = undefined
})

const keyOf = (intentId: string) => parseIntentId(intentId)?.key

const executing = (plan: SubmittedPlan) =>
  ({ ...plan, status: 'executing', phase: 'include' }) as unknown as Plan

describe('two markets replacing on one read', () => {
  test('let a withdrawal through while another market replaces', () => {
    running = harness()
    const { read, submits } = running

    read({ [A]: decided(marketA, replace(marketA), 1), [B]: decided(marketB, withdraw, 1) })

    expect(submits().map(plan => [keyOf(plan.intentId), plan.conflicts])).toEqual([
      [A, { writes: ['quoter:book'] }],
      [B, undefined]
    ])
  })
})

/** A live entry of one offer that `intentId` created, as the kernel lists it. */
const liveEntry = (intentId: string) => {
  const maturity = BigInt(Date.UTC(2027, 0, 1, 15) / 1000)
  const params: Parameters<typeof Offer.create>[0] = {
    market: {
      chainId: 8453n,
      midnight: getChainAddress(8453, 'midnight'),
      loanToken: `0x${'33'.repeat(20)}`,
      collateralParams: [
        {
          token: `0x${'44'.repeat(20)}`,
          lltv: 770_000_000_000_000_000n,
          liquidationCursor: 250_000_000_000_000_000n,
          oracle: `0x${'55'.repeat(20)}`
        }
      ],
      maturity,
      rcfThreshold: 0n,
      enterGate: zeroAddress,
      liquidatorGate: zeroAddress
    },
    buy: true,
    maker: `0x${'aa'.repeat(20)}`,
    start: 1n,
    expiry: maturity,
    ratifier: getChainAddress(8453, 'ecrecoverRatifier'),
    tick: 6_000n,
    maxUnits: 1_000n,
    continuousFeeCap: 0n
  }
  const offer = Offer.create(params)
  const id = midnightCommitmentId(offer.group)
  const live = {
    spec: { id },
    state: 'live',
    intentId,
    origin: { witness: midnightWitness([{ offers: Tree.create([offer]).offers }]) }
  }
  return { id, live }
}

describe("each market's phase", () => {
  const admitted = (plan: SubmittedPlan) =>
    ({ type: 'notice', intentId: plan.intentId, notice: 'admitted' }) as KernelActivity
  const settled = (plan: SubmittedPlan, block: number) =>
    ({
      type: 'notice',
      intentId: plan.intentId,
      notice: 'settled',
      included: [{ step: 0, hash: `0x${'ab'.repeat(32)}`, block, success: true }]
    }) as KernelActivity

  test.each(['with the first', 'once the first settles'] as const)(
    'reads what the fold does at each step, by the rules it acts on, as it submits one replacement at a time, the second prepared %s',
    answered => {
      const early = answered === 'with the first'
      const second = early ? { phase: 'waiting', detail: 'book_held' } : { phase: 'preparing' }
      running = harness()
      const { read, kernelReports, answer, submits, phases } = running
      expect(phases()).toEqual({ [A]: { phase: 'unread' }, [B]: { phase: 'unread' } })

      read({
        [A]: decided(marketA, replace(marketA), 1),
        [B]: decided(marketB, replace(marketB), 1)
      })
      expect(submits().map(plan => keyOf(plan.intentId))).toEqual([A])
      expect(phases()).toEqual({ [A]: { phase: 'submitted' }, [B]: { phase: 'preparing' } })

      answer(A)
      if (early) answer(B)
      expect(submits()).toHaveLength(1)
      expect(phases()[B]).toEqual(second)

      const [first] = submits()
      kernelReports(kernelState([executing(first!)]), [admitted(first!)])
      expect(phases()).toEqual({ [A]: { phase: 'in_flight' }, [B]: second })

      kernelReports(kernelState([], 105), [settled(first!, 105)])
      if (!early) answer(B)
      expect(submits()).toHaveLength(1)
      expect(phases()).toEqual({
        [A]: { phase: 'rested' },
        [B]: { phase: 'waiting', detail: 'predates_own_effect' }
      })

      read({ [A]: decided(marketA, undefined, 2), [B]: decided(marketB, replace(marketB), 2) }, 106)
      expect(submits().map(plan => [keyOf(plan.intentId), plan.basisBlock])).toEqual([
        [A, 100],
        [B, 106]
      ])
      expect(phases()).toEqual({ [A]: { phase: 'preparing' }, [B]: { phase: 'submitted' } })
      answer(A)
      expect(phases()[A]).toEqual({ phase: 'idle' })
    }
  )

  test('waits unprepared while its replacement rests on no preparation of the desire it holds', () => {
    running = harness()
    const { read, kernelReports, answer, submits, phases } = running
    read({ [A]: decided(marketA, replace(marketA), 1), [B]: decided(marketB, undefined, 1) })
    const [first] = submits()
    answer(A)
    kernelReports(kernelState([executing(first!)]), [admitted(first!)])
    kernelReports(kernelState([], 105), [settled(first!, 105)])
    const moved = decided(marketA, replace(marketA), 1)
    read(
      {
        [A]: { ...moved, decision: { ...moved.decision, desire: `book:${marketA}:moved` } },
        [B]: decided(marketB, undefined, 2)
      },
      106
    )
    expect(submits()).toHaveLength(1)
    expect(phases()[A]).toEqual({ phase: 'waiting', detail: 'unprepared' })
    read(
      {
        [A]: { ...moved, decision: { ...moved.decision, desire: `book:${marketA}:moved` } },
        [B]: decided(marketB, undefined, 3)
      },
      107
    )
    expect(submits()).toHaveLength(2)
    expect(phases()[A]).toEqual({ phase: 'submitted' })
  })

  test('is gated while its decision halts the bot', () => {
    running = harness()
    const { read, phases } = running
    const halting = decided(marketA, replace(marketA), 1)
    read({
      [A]: { ...halting, decision: { ...halting.decision, halt: 'monitor' } },
      [B]: decided(marketB, undefined, 1)
    })
    expect(phases()).toEqual({ [A]: { phase: 'gated' }, [B]: { phase: 'preparing' } })
  })

  test('stays unread since its parked workflow first lost a usable read', () => {
    running = harness()
    const { read, kernelReports, answer, submits, phases, unreadable } = running
    read({ [A]: decided(marketA, replace(marketA), 1), [B]: decided(marketB, undefined, 1) })
    const [first] = submits()
    answer(A)
    const { id, live } = liveEntry(first!.intentId)
    const parkedPlan: Plan = { ...executing(first!), phase: 'awaiting-advance' }
    const parked = (now: number) =>
      ({
        ...kernelState([parkedPlan], undefined, now),
        entries: { [id]: live }
      }) as unknown as KernelState
    kernelReports(parked(START), [admitted(first!)])
    unreadable()
    expect(phases()[A]).toEqual({ phase: 'unread', since: START })
    kernelReports(parked(START + READ_HOLDS_MS / 2))
    expect(phases()[A]).toEqual({ phase: 'unread', since: START })
  })

  test('turns unread when its read expires on the kernel clock alone, and gated once the kernel stops', () => {
    running = harness()
    const { read, kernelReports, phases, unreadable } = running
    read({ [A]: decided(marketA, undefined, 1), [B]: decided(marketB, undefined, 1) })
    expect(phases()[A]).toEqual({ phase: 'preparing' })

    kernelReports(kernelState([], undefined, START + READ_HOLDS_MS))
    expect(phases()).toEqual({ [A]: { phase: 'unread' }, [B]: { phase: 'unread' } })

    kernelReports(kernelState([]))
    expect(phases()[A]).toEqual({ phase: 'preparing' })
    unreadable()
    expect(phases()).toEqual({ [A]: { phase: 'unread' }, [B]: { phase: 'unread' } })

    kernelReports(kernelState([], undefined, START, 'stopped'))
    expect(phases()).toEqual({ [A]: { phase: 'gated' }, [B]: { phase: 'gated' } })
  })

  test('stays submitted through a failed read, as the fold waits on the kernel before reading', () => {
    running = harness()
    const { read, submits, phases, unreadable } = running
    read({ [A]: decided(marketA, replace(marketA), 1), [B]: decided(marketB, undefined, 1) })
    expect(phases()[A]).toEqual({ phase: 'submitted' })
    unreadable()
    expect(submits()).toHaveLength(1)
    expect(phases()).toEqual({ [A]: { phase: 'submitted' }, [B]: { phase: 'unread' } })
  })

  test('rests once its fail-closed withdrawal ends on the same unusable read', () => {
    running = harness()
    const { read, kernelReports, submits, phases, unreadable } = running
    read({ [A]: decided(marketA, undefined, 1), [B]: decided(marketB, undefined, 1) })
    const { id, live } = liveEntry(`${A}#earlier.0`)
    kernelReports({ ...kernelState([]), entries: { [id]: live } } as unknown as KernelState)
    unreadable()
    const [withdrawal] = submits()
    expect(keyOf(withdrawal!.intentId)).toBe(A)
    kernelReports(kernelState([]), [admitted(withdrawal!), settled(withdrawal!, 101)])
    expect(submits()).toHaveLength(1)
    expect(phases()[A]).toEqual({ phase: 'rested' })
  })

  test('rests once its act ends, though it was preparing for a newer desire', () => {
    running = harness()
    const { read, kernelReports, answer, submits, phases } = running
    read({ [A]: decided(marketA, replace(marketA), 1), [B]: decided(marketB, undefined, 1) })
    const [first] = submits()
    answer(A)
    kernelReports(kernelState([executing(first!)]), [admitted(first!)])
    const moved = decided(marketA, replace(marketA), 2)
    read(
      {
        [A]: { ...moved, decision: { ...moved.decision, desire: `book:${marketA}:moved` } },
        [B]: decided(marketB, undefined, 2)
      },
      101
    )
    expect(phases()[A]).toEqual({ phase: 'in_flight' })
    kernelReports(kernelState([], 102), [settled(first!, 102)])
    expect(submits()).toHaveLength(1)
    expect(phases()[A]).toEqual({ phase: 'rested' })
  })

  test('stays in flight while its superseding replacement runs, though the plan it superseded ended', () => {
    running = harness()
    const { read, kernelReports, answer, submits, phases } = running
    read({ [A]: decided(marketA, replace(marketA), 1), [B]: decided(marketB, undefined, 1) })
    const [first] = submits()
    answer(A)
    const parked = { ...executing(first!), phase: 'awaiting-advance' } as Plan
    kernelReports(kernelState([parked]), [admitted(first!)])
    const moved = decided(marketA, replace(marketA), 2)
    read(
      {
        [A]: { ...moved, decision: { ...moved.decision, desire: `book:${marketA}:moved` } },
        [B]: decided(marketB, undefined, 2)
      },
      101
    )
    const [, replacement] = submits()
    expect(replacement).toMatchObject({ supersedes: first!.intentId })
    kernelReports(kernelState([executing(replacement!)]), [
      admitted(replacement!),
      { type: 'notice', intentId: first!.intentId, notice: 'failed' }
    ])
    expect(submits()).toHaveLength(2)
    expect(phases()[A]).toEqual({ phase: 'in_flight' })
  })

  test('never lets a redemption supersede its parked workflow, though its desire moved', () => {
    running = harness()
    const { read, kernelReports, answer, submits, phases } = running
    read({ [A]: decided(marketA, replace(marketA), 1), [B]: decided(marketB, undefined, 1) })
    const [first] = submits()
    answer(A)
    const parked = { ...executing(first!), phase: 'awaiting-advance' } as Plan
    kernelReports(kernelState([parked]), [admitted(first!)])
    const redemption: Act = {
      kind: 'redeem',
      identity: `redeem:${marketA}:40`,
      payload: { params: marketParams, units: 40n } as never,
      condition: 'redeem: 40 units'
    }
    const moved = decided(marketA, redemption, 2)
    read(
      {
        [A]: { ...moved, decision: { ...moved.decision, desire: `book:${marketA}:moved` } },
        [B]: decided(marketB, undefined, 2)
      },
      101
    )
    expect(submits()).toHaveLength(1)
    expect(phases()[A]).toEqual({ phase: 'in_flight' })
  })

  test('waits while a plan it did not send rests on the desire it still has', () => {
    running = harness()
    const { read, kernelReports, answer, submits, phases } = running
    read({ [A]: decided(marketA, replace(marketA), 1), [B]: decided(marketB, undefined, 1) })
    const [first] = submits()
    kernelReports(kernelState([]), [admitted(first!), settled(first!, 100)])
    const earlier = {
      ...first!,
      intentId: `${A}#earlier.0`,
      status: 'executing',
      phase: 'awaiting-advance'
    } as unknown as Plan
    kernelReports(kernelState([earlier]))
    read({ [A]: decided(marketA, replace(marketA), 2), [B]: decided(marketB, undefined, 2) }, 101)
    answer(A)
    expect(submits()).toHaveLength(1)
    expect(phases()[A]).toEqual({ phase: 'waiting', detail: 'resting' })
  })
})

describe('a replacement that supersedes its market’s parked plan', () => {
  const notice = (plan: SubmittedPlan, kind: string) =>
    ({ type: 'notice', intentId: plan.intentId, notice: kind }) as KernelActivity

  /** Market A's first replacement, parked between its stages, and the one superseding it. */
  const superseding = () => {
    running = harness()
    const { read, kernelReports, answer, submits } = running
    read({ [A]: decided(marketA, replace(marketA), 1), [B]: decided(marketB, undefined, 1) })
    const [first] = submits()
    answer(A)
    const parked = { ...executing(first!), phase: 'awaiting-advance' } as Plan
    kernelReports(kernelState([parked]), [notice(first!, 'admitted')])
    const moved = decided(marketA, replace(marketA), 2)
    read(
      {
        [A]: { ...moved, decision: { ...moved.decision, desire: `book:${marketA}:moved` } },
        [B]: decided(marketB, undefined, 2)
      },
      101
    )
    const [, replacement] = submits()
    expect(replacement).toMatchObject({ supersedes: first!.intentId })
    return { first: first!, replacement: replacement! }
  }

  test('ends superseded when the kernel abandons it in the batch that admits its successor', () => {
    const { first, replacement } = superseding()
    running!.kernelReports(kernelState([executing(replacement)]), [
      notice(first, 'abandoned'),
      notice(replacement, 'admitted')
    ])
    expect(running!.outcomes()).toEqual([
      expect.objectContaining({ intentId: first.intentId, supersededBy: replacement.intentId })
    ])
  })

  test('ends superseded when it is compensated after its successor settled', () => {
    const { first, replacement } = superseding()
    const { kernelReports, outcomes } = running!
    kernelReports(kernelState([executing(replacement)]), [notice(replacement, 'admitted')])
    kernelReports(kernelState([], 102), [notice(replacement, 'settled')])
    kernelReports(kernelState([], 102), [notice(first, 'compensated')])
    expect(outcomes()).toEqual([
      expect.not.objectContaining({ supersededBy: expect.anything() }),
      expect.objectContaining({ intentId: first.intentId, supersededBy: replacement.intentId })
    ])
  })

  test('ends as itself when its compensation fails after its successor was admitted', () => {
    const { first, replacement } = superseding()
    const { kernelReports, outcomes } = running!
    kernelReports(kernelState([executing(replacement)]), [notice(replacement, 'admitted')])
    kernelReports(kernelState([executing(replacement)]), [notice(first, 'failed')])
    expect(outcomes()).toEqual([expect.objectContaining({ intentId: first.intentId })])
    expect(outcomes()[0]).not.toHaveProperty('supersededBy')
  })

  test('ends superseded by the withdrawal of its market once its read stays unusable', () => {
    running = harness()
    const { read, kernelReports, answer, submits, outcomes, unreadable, advance } = running
    read({ [A]: decided(marketA, replace(marketA), 1), [B]: decided(marketB, undefined, 1) })
    const [first] = submits()
    answer(A)
    const { id, live } = liveEntry(first!.intentId)
    const parkedPlan: Plan = { ...executing(first!), phase: 'awaiting-advance' }
    const parked = (now: number) =>
      ({
        ...kernelState([parkedPlan], undefined, now),
        entries: { [id]: live }
      }) as unknown as KernelState
    kernelReports(parked(START), [notice(first!, 'admitted')])
    unreadable()
    advance(READ_HOLDS_MS)
    kernelReports(parked(START + READ_HOLDS_MS))
    const [, withdrawal] = submits()
    expect(withdrawal).toMatchObject({ supersedes: first!.intentId })
    kernelReports(kernelState([executing(withdrawal!)], undefined, START + READ_HOLDS_MS), [
      notice(first!, 'abandoned'),
      notice(withdrawal!, 'admitted')
    ])
    kernelReports(kernelState([], undefined, START + READ_HOLDS_MS), [
      notice(withdrawal!, 'settled')
    ])
    expect(outcomes()).toEqual([
      expect.objectContaining({ intentId: first!.intentId, supersededBy: withdrawal!.intentId }),
      expect.objectContaining({ intentId: withdrawal!.intentId })
    ])
    expect(outcomes()[1]).not.toHaveProperty('supersededBy')
  })

  test('ends as itself when the kernel refused its successor', () => {
    const { first, replacement } = superseding()
    const { kernelReports, outcomes } = running!
    const parkedPlan: Plan = { ...executing(first), phase: 'awaiting-advance' }
    kernelReports(kernelState([parkedPlan]), [notice(replacement, 'refused')])
    kernelReports(kernelState([]), [notice(first, 'failed')])
    for (const outcome of outcomes()) expect(outcome).not.toHaveProperty('supersededBy')
    expect(outcomes().map(outcome => outcome.intentId)).toEqual([
      replacement.intentId,
      first.intentId
    ])
  })
})

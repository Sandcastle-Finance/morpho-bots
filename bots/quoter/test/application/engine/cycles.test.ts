import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { Cycle, FailureBudget } from '../../../src/application/engine/cycles'

import { EMPTY_BUDGET, budgetVerdict, foldBudget } from '../../../src/application/engine/cycles'

const marketId: Hex = `0x${'11'.repeat(32)}`
const failed: Cycle = {
  counted: [{ workflow: 'ladder', marketId, status: 'failed', stage: 'decision' }],
  completed: [],
  tick: 1
}
const applied: Cycle = {
  counted: [{ workflow: 'ladder', marketId, status: 'applied', action: 'replace' }],
  completed: [],
  tick: 1
}
const at = (cycle: Cycle, tick: number): Cycle => ({ ...cycle, tick })
const fold = (cycles: readonly Cycle[], budget: FailureBudget = EMPTY_BUDGET) =>
  cycles.reduce(foldBudget, budget)

const verdictAfter = (budget: FailureBudget, cycle: Cycle) =>
  budgetVerdict(foldBudget(budget, cycle))

describe('budgetVerdict', () => {
  test('halts on the cycle that exhausts the budget, before the reducer has folded it', () => {
    let budget: FailureBudget = EMPTY_BUDGET
    for (let poll = 1; poll < 5; poll += 1) {
      expect(verdictAfter(budget, at(failed, poll))).toEqual({ ok: true })
      budget = foldBudget(budget, at(failed, poll))
    }
    expect(verdictAfter(budget, at(failed, 5))).toEqual({ ok: false, halt: 'ladder' })
  })

  test('never charges a redemption, decided, failed or settled, nor clears a quote failure', () => {
    const redeeming: Cycle = {
      counted: [
        { workflow: 'ladder', marketId, status: 'failed', stage: 'redeem' },
        { workflow: 'ladder', marketId, status: 'observed', action: 'queued', redeemedUnits: 40n },
        { workflow: 'ladder', marketId, status: 'applied', action: 'redeem', redeemedUnits: 40n }
      ],
      completed: [],
      tick: 1
    }
    let budget: FailureBudget = foldBudget(EMPTY_BUDGET, failed)
    for (let poll = 2; poll < 12; poll += 1) budget = foldBudget(budget, at(redeeming, poll))
    expect(budget.ladder.counts).toEqual({ [marketId]: { failures: 1, charged: 1 } })
    expect(budgetVerdict(budget)).toEqual({ ok: true })
  })

  test('charges a failed cancellation, as a rate-out-of-range withholding sends, to the budget instead of halting at once', () => {
    const cancelFailed: Cycle = {
      counted: [
        {
          workflow: 'bootstrap',
          marketId,
          status: 'failed',
          stage: 'act'
        }
      ],
      completed: [],
      tick: 1
    }
    let budget: FailureBudget = EMPTY_BUDGET
    for (let poll = 1; poll < 5; poll += 1) {
      expect(verdictAfter(budget, at(cancelFailed, poll))).toEqual({ ok: true })
      budget = foldBudget(budget, at(cancelFailed, poll))
    }
    expect(verdictAfter(budget, at(cancelFailed, 5))).toEqual({ ok: false, halt: 'bootstrap' })
  })

  test('never charges a below-minimum withholding, and clears the failure before it', () => {
    const withheld: Cycle = {
      counted: [
        {
          workflow: 'bootstrap',
          marketId,
          status: 'applied',
          action: 'publication-withheld'
        }
      ],
      completed: [],
      tick: 1
    }
    let budget: FailureBudget = foldBudget(EMPTY_BUDGET, {
      counted: [{ workflow: 'bootstrap', marketId, status: 'failed', stage: 'act' }],
      completed: [],
      tick: 1
    })
    expect(budget.bootstrap.unresolved).toEqual([marketId])
    for (let poll = 2; poll < 12; poll += 1) {
      expect(verdictAfter(budget, at(withheld, poll))).toEqual({ ok: true })
      budget = foldBudget(budget, at(withheld, poll))
    }
    expect(budget.bootstrap).toEqual({
      counts: { [marketId]: { failures: 0, charged: 1 } },
      unresolved: []
    })
  })
})

describe('foldBudget', () => {
  const unresolved: Cycle = {
    counted: [{ workflow: 'ladder', marketId, status: 'failed', stage: 'act' }],
    completed: [],
    tick: 1
  }
  const rest: Cycle = {
    counted: [{ workflow: 'ladder', marketId, status: 'observed', action: 'rest' }],
    completed: [],
    tick: 1
  }

  test('charges a market once for many failing reports within one poll tick', () => {
    const budget = fold(Array.from({ length: 10 }, () => at(failed, 1)))
    expect(budget.ladder.counts[marketId]?.failures).toBe(1)
    expect(budgetVerdict(budget)).toEqual({ ok: true })
  })

  test('charges an unresolved market once per poll tick however often it is re-read', () => {
    const budget = fold([unresolved, at(rest, 1), at(rest, 1), at(rest, 2), at(rest, 2)])
    expect(budget.ladder.counts[marketId]?.failures).toBe(2)
  })

  test('halts on the fifth charged poll tick', () => {
    const ticks = [1, 2, 3, 4, 5].flatMap(tick => [at(failed, tick), at(failed, tick)])
    expect(budgetVerdict(fold(ticks.slice(0, -2)))).toEqual({ ok: true })
    expect(budgetVerdict(fold(ticks))).toEqual({ ok: false, halt: 'ladder' })
  })

  test('charges a market absent from its tick’s poll by its next counted report in that interval', () => {
    const absent: Cycle = { counted: [], completed: [], tick: 2 }
    const budget = fold([at(failed, 1), absent, at(failed, 2)])
    expect(budget.ladder.counts[marketId]).toEqual({ failures: 2, charged: 2 })
  })

  test('charges a timeout and a deferred completion in one interval once', () => {
    const timedOut: Cycle = {
      counted: [{ workflow: 'ladder', marketId, status: 'failed', stage: 'prepare' }],
      completed: [],
      tick: 3
    }
    const deferred: Cycle = {
      counted: [{ workflow: 'ladder', marketId, status: 'failed', stage: 'reconcile' }],
      completed: [],
      tick: 3
    }
    const budget = fold([at(failed, 1), at(failed, 2), timedOut, deferred])
    expect(budget.ladder.counts[marketId]?.failures).toBe(3)
  })

  test('resets the count on a report that neither fails nor is unresolved, even within a tick', () => {
    const four = [1, 2, 3, 4].map(tick => at(failed, tick))
    const budget = fold([...four, at(applied, 4), at(failed, 5)])
    expect(budget.ladder.counts[marketId]?.failures).toBe(1)
    expect(budgetVerdict(budget)).toEqual({ ok: true })
  })
})

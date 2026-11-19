import { describe, expect, test } from 'vitest'

import type { MarketReport } from '../../../src/application/engine/market-report'
import type { Read } from '../../../src/application/engine/readings'
import type { WorldPosition } from '../../../src/application/engine/world'

import { redeeming, redemptionOf } from '../../../src/application/engine/redemption'
import { marketId, marketParams } from './world.fixtures'

const position = (redeemableCredit: bigint, withdrawable: bigint): Read<WorldPosition> => ({
  ok: true,
  value: {
    marketId,
    credit: redeemableCredit,
    debt: 0n,
    lossFactor: 0n,
    maturity: 2_000_000n,
    tickSpacing: 4,
    continuousFee: 0,
    params: marketParams,
    withdrawable,
    redeemableCredit
  }
})

const resting: MarketReport = { workflow: 'ladder', marketId, status: 'observed', action: 'rest' }
const idle = { keep: ['group'], steady: true, detail: resting }

describe('redemptionOf', () => {
  test.each([
    ['the credit when more is withdrawable', 40n, 100n, 40n],
    ['what is withdrawable when the credit exceeds it', 100n, 40n, 40n],
    ['all of it when both are equal', 40n, 40n, 40n]
  ])('redeems %s', (_, credit, withdrawable, units) => {
    expect(redemptionOf(position(credit, withdrawable))).toStrictEqual({
      params: marketParams,
      units
    })
  })

  test.each([
    ['no credit', 0n, 100n],
    ['nothing withdrawable', 40n, 0n]
  ])('redeems nothing with %s', (_, credit, withdrawable) => {
    expect(redemptionOf(position(credit, withdrawable))).toBeUndefined()
  })

  test('redeems nothing on a failed or missing position read', () => {
    expect(redemptionOf({ ok: false, errorName: 'TypeError' })).toBeUndefined()
    expect(redemptionOf(undefined)).toBeUndefined()
  })
})

describe('redeeming', () => {
  const redemption = { params: marketParams, units: 40n }

  test('redeems in place of a decision that would not act, keeping what it keeps', () => {
    const decision = redeeming(idle, redemption)
    expect(decision).toMatchObject({
      keep: ['group'],
      steady: false,
      act: {
        kind: 'redeem',
        identity: `redeem:${marketId}:40`,
        payload: { params: marketParams, units: 40n },
        condition: 'redeem: 40 units'
      },
      detail: {
        workflow: 'ladder',
        marketId,
        status: 'observed',
        action: 'queued',
        redeemedUnits: 40n
      }
    })
    expect(decision.desire).toBe(decision.act!.identity)
    expect(redeeming({ ...idle, desire: 'quote' }, redemption).desire).toBe('quote')
  })

  test('leaves a decision that acts or halts to go first', () => {
    const cancelling = {
      ...idle,
      act: { kind: 'cancel' as const, identity: 'cancel', payload: {}, condition: 'withdraw' }
    }
    const halting = { ...idle, halt: 'lens: broken' }
    expect(redeeming(cancelling, redemption)).toBe(cancelling)
    expect(redeeming(halting, redemption)).toBe(halting)
  })
})

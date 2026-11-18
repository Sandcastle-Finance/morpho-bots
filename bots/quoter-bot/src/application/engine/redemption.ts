import type { MarketParams } from '@morpho-org/midnight-sdk'

import { PositionUtils } from '@morpho-org/midnight-sdk'

import type { Decision } from './decision'
import type { Classification, MarketReport } from './market-report'
import type { Read } from './readings'
import type { WorldPosition } from './world'

import { decisionClassification } from './market-report'

/** All of the maker's credit a market lets it withdraw at par now. */
export type Redemption = Readonly<{ params: MarketParams; units: bigint }>

/** What a redemption act carries: the market and units it withdraws, and its report once settled. */
export type RedemptionActPayload = Redemption & Readonly<{ report: Classification }>

type Decided = Decision & Readonly<{ detail: MarketReport }>

/**
 * The redemption a market's position allows: never a partial one, so all of
 * `min(redeemableCredit, withdrawable)`.
 * @param position - The market's position from one world read; a failed read redeems nothing.
 * @returns The redemption, or `undefined` when the maker holds no credit or none is withdrawable.
 */
export const redemptionOf = (position: Read<WorldPosition> | undefined): Redemption | undefined => {
  if (!position?.ok) return undefined
  const { params, withdrawable, redeemableCredit } = position.value
  const units = PositionUtils.getWithdrawable({
    position: { credit: redeemableCredit },
    market: { withdrawable }
  })
  return units > 0n ? { params, units } : undefined
}

/**
 * A market's decision with its redemption ordered first: while the strategy would neither act nor
 * halt, the market keeps what the strategy keeps and redeems instead, and its strategy decides
 * again on the read after the redemption lands. A risk-reducing cancellation goes first. The
 * strategy's desire stands, so a workflow already in flight still rests on it and completes first.
 * @param decision - The strategy's decision from the same read.
 * @param redemption - The redemption that read allows.
 * @returns The redeeming decision, or `decision` unchanged when it acts or halts.
 */
export const redeeming = (decision: Decided, redemption: Redemption): Decided => {
  if (decision.act !== undefined || decision.halt !== undefined) return decision
  const { workflow, marketId, facts } = decision.detail
  const report: Classification = {
    status: 'applied',
    action: 'redeem',
    redeemedUnits: redemption.units
  }
  const identity = `redeem:${marketId.toLowerCase()}:${redemption.units}`
  const payload: RedemptionActPayload = { ...redemption, report }
  return {
    keep: decision.keep,
    desire: decision.desire ?? identity,
    act: {
      kind: 'redeem',
      identity,
      payload: payload as never,
      condition: `redeem: ${redemption.units} units`
    },
    steady: false,
    detail: {
      workflow,
      marketId,
      ...(facts ? { facts } : {}),
      ...decisionClassification(report, true)
    } as MarketReport
  }
}

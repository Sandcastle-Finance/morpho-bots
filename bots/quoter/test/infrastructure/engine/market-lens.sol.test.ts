import type { Address, Hex } from 'viem'

import { Market, MarketParams, MarketUtils } from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { zeroAddress } from 'viem'
import { describe, expect, test } from 'vitest'

import type { MarketLensOutput } from '../../../src/infrastructure/engine/market-lens.sol'

import { LadderAdapterError } from '../../../src/errors'
import { lensMarket, lensPosition } from '../../../src/infrastructure/engine/market-lens.sol'

const CHAIN_ID = 8453
const MIDNIGHT = getChainAddress(CHAIN_ID, 'midnight')
const WETH: Address = '0x4200000000000000000000000000000000000006'
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ORACLE: Address = '0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9'
const maker: Address = '0x7196FE66377C74Bf805F2373b7AEA2d0d6d3FD4b'
const T0 = 1_800_000_000n
const maturity = T0 + 1_000n

const slot = (token: Address, lltv: bigint) => ({
  token,
  lltv,
  liquidationCursor: 300_000_000_000_000_000n,
  oracle: ORACLE
})

/** Ascending by token, as Midnight requires, so the loan token's slot is index 1. */
const params = (
  collateralParams = [slot(WETH, 860_000_000_000_000_000n), slot(USDC, 900_000_000_000_000_000n)]
) => ({
  chainId: BigInt(CHAIN_ID),
  midnight: MIDNIGHT,
  loanToken: USDC,
  collateralParams,
  maturity,
  rcfThreshold: 3_000_000_000n,
  enterGate: zeroAddress,
  liquidatorGate: zeroAddress
})

const idOf = (market: ReturnType<typeof params>) => MarketUtils.toId(new MarketParams(market))

const baseOutput = () => ({
  market: params(),
  state: {
    totalUnits: 11n,
    lossFactor: 3n,
    withdrawable: 13n,
    continuousFeeCredit: 17n,
    settlementFeeCbp0: 1,
    settlementFeeCbp1: 2,
    settlementFeeCbp2: 3,
    settlementFeeCbp3: 4,
    settlementFeeCbp4: 5,
    settlementFeeCbp5: 6,
    settlementFeeCbp6: 7,
    continuousFee: 19,
    tickSpacing: 4
  },
  position: {
    credit: 1_000n,
    pendingFee: 100n,
    lastLossFactor: 3n,
    lastAccrual: T0,
    debt: 50n,
    collateralBitmap: 3n
  },
  collateral: [5n, 700n]
})

const output = (overrides: Partial<ReturnType<typeof baseOutput>> = {}): MarketLensOutput => ({
  ...baseOutput(),
  ...overrides
})

const marketId = idOf(params())
const otherMarketId: Hex = `0x${'55'.repeat(32)}`
const readAt = (id: Hex, lensOutput?: MarketLensOutput) =>
  new Map(lensOutput === undefined ? [] : [[id, lensOutput]])
const expected = { marketId, chainId: CHAIN_ID, midnight: MIDNIGHT }
const unavailable = expect.objectContaining({
  name: 'LadderAdapterError',
  operation: 'position-unavailable'
})

describe('lensMarket', () => {
  test('maps each marketState field to the SDK market field of the same name', () => {
    const market = lensMarket(readAt(marketId, output()), expected)

    expect(market).toStrictEqual(
      new Market({
        params: params(),
        totalUnits: 11n,
        lossFactor: 3n,
        withdrawable: 13n,
        continuousFeeCredit: 17n,
        settlementFeeCbps: [1, 2, 3, 4, 5, 6, 7],
        continuousFee: 19,
        tickSpacing: 4
      })
    )
    expect(market.id).toBe(marketId)
  })

  test.each<[string, ReadonlyMap<Hex, MarketLensOutput>, Partial<typeof expected>]>([
    ['a declined element', readAt(marketId), {}],
    ['another chain', readAt(marketId, output({ market: { ...params(), chainId: 1n } })), {}],
    [
      'another singleton',
      readAt(marketId, output({ market: { ...params(), midnight: ORACLE } })),
      {}
    ],
    ['another market', readAt(otherMarketId, output()), { marketId: otherMarketId }]
  ])('fails closed for %s', (_, read, override) => {
    expect(() => lensMarket(read, { ...expected, ...override })).toThrow(unavailable)
    expect(() => lensMarket(read, { ...expected, ...override })).toThrow(LadderAdapterError)
  })
})

describe('lensPosition', () => {
  const at = { ...expected, user: maker, timestamp: T0 + 250n, redeemBy: T0 + 250n }

  test('accrues the position to the read block and projects the loan-token collateral slot', () => {
    expect(lensPosition(readAt(marketId, output()), at)).toStrictEqual({
      marketId,
      loanCollateral: { assets: 700n, lltv: 900_000_000_000_000_000n },
      credit: 975n,
      debt: 50n,
      lossFactor: 3n,
      maturity,
      tickSpacing: 4,
      continuousFee: 19,
      params: params(),
      withdrawable: 13n,
      redeemableCredit: 975n
    })
  })

  test.each([
    ['a later time', T0 + 500n, 950n],
    ['past maturity, where the continuous fee stops', maturity + 1_000n, 900n]
  ])('accrues the redeemable credit to %s, below the credit read now', (_, redeemBy, credit) => {
    const position = lensPosition(readAt(marketId, output()), { ...at, redeemBy })
    expect(position.credit).toBe(975n)
    expect(position.redeemableCredit).toBe(credit)
  })

  test('leaves loan collateral out for a market that does not list the loan token', () => {
    const market = params([slot(WETH, 860_000_000_000_000_000n)])
    const position = lensPosition(readAt(idOf(market), output({ market, collateral: [5n] })), {
      ...at,
      marketId: idOf(market)
    })

    expect(position).not.toHaveProperty('loanCollateral')
    expect(position.credit).toBe(975n)
  })

  test('fails closed when the loan-token slot has no balance in the read', () => {
    expect(() => lensPosition(readAt(marketId, output({ collateral: [5n] })), at)).toThrow(
      unavailable
    )
  })

  test('fails closed for a declined element', () => {
    expect(() => lensPosition(readAt(marketId), at)).toThrow(unavailable)
  })
})

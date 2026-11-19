import type { BatchLensTransportType } from '@repo/utils'
import type { Address, Client, ContractFunctionReturnType, Hex, Transport } from 'viem'

import { AccrualPosition, Market } from '@morpho-org/midnight-sdk'
import { blockTagAt } from '@repo/kit'
import { readDeploylessBatchLens } from '@repo/utils'
import { sol, solFile } from 'soltag'
import { isAddressEqual } from 'viem'

import type { WorldPosition } from '../../application/engine/world'

import { LadderAdapterError } from '../../errors'

const compileLens = () => sol('QuoterMarketLens')`
// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

${solFile('@repo/contracts/solidity/interfaces/IMidnight.sol')}

struct PositionState {
  uint128 credit;
  uint128 pendingFee;
  uint128 lastLossFactor;
  uint128 lastAccrual;
  uint128 debt;
  uint128 collateralBitmap;
}

contract QuoterMarketLens {
  IMidnight public immutable MIDNIGHT;

  struct Input { bytes32 id; address user; }

  struct Output {
    Market market;
    MarketState state;
    PositionState position;
    uint128[] collateral;
  }

  constructor(IMidnight midnight) { MIDNIGHT = midnight; }

  // No try/catch: an unknown market, or any read that fails, reverts and declines the element.
  function read(Input calldata e) external view returns (Output memory o) {
    o.market = MIDNIGHT.toMarket(e.id);
    o.state = _marketState(e.id);
    PositionState memory p = o.position;
    (p.credit, p.pendingFee, p.lastLossFactor, p.lastAccrual, p.debt, p.collateralBitmap) =
      MIDNIGHT.position(e.id, e.user);
    o.collateral = new uint128[](o.market.collateralParams.length);
    for (uint256 i; i < o.collateral.length; ++i) {
      o.collateral[i] = MIDNIGHT.collateral(e.id, e.user, i);
    }
  }

  // marketState returns 13 values, too many to destructure on the stack; its static tuple shares
  // MarketState's ABI encoding, so it decodes into that struct whole.
  function _marketState(bytes32 id) private view returns (MarketState memory) {
    (bool ok, bytes memory data) =
      address(MIDNIGHT).staticcall(abi.encodeCall(IMidnight.marketState, (id)));
    require(ok, "marketState failed");
    return abi.decode(data, (MarketState));
  }
}
`

/** Built on first read, so an entrypoint run without the soltag transform loads until it reads. */
let lens: ReturnType<typeof compileLens> | undefined
const marketLens = () => (lens ??= compileLens())

/** One market's state and the user's position in it, as the lens reads them at one block. */
export type MarketLensOutput = ContractFunctionReturnType<
  ReturnType<typeof compileLens>['abi'],
  'view',
  'read'
>

/**
 * Reads every market's state and `user`'s position in it in one batched deployless `eth_call`,
 * pinned to `blockHash` (EIP-1898).
 * @param client - A client over kit's deployless transport.
 * @param parameters - The Midnight singleton, the position owner, the markets, and the block hash.
 * @returns Each market's lens output by market ID. A market is absent when its element was
 * declined: it reverted (an unknown market included) or the provider refused it.
 */
export const readMarketLens = (
  client: Client<Transport<BatchLensTransportType>>,
  parameters: Readonly<{
    midnight: Address
    user: Address
    marketIds: readonly Hex[]
    blockHash: Hex
  }>
) =>
  readDeploylessBatchLens({
    client,
    parameters: {
      ...marketLens().with(parameters.midnight),
      functionName: 'read',
      args: [...new Set(parameters.marketIds)].map(id => ({ id, user: parameters.user })),
      blockTag: blockTagAt(parameters.blockHash),
      declined: 'omit'
    },
    key: ({ id }) => id,
    value: (_input, output): MarketLensOutput => output
  })

/**
 * The SDK market the lens read for `expected.marketId`, checked to be that market.
 * @param outputs - A {@link readMarketLens} result.
 * @param expected - The market ID it was read for, and the chain and Midnight singleton it must name.
 * @returns The market, its collateral params normalized by the SDK.
 * @throws `LadderAdapterError('position-unavailable')` for a declined element or one naming another
 * market, chain, or singleton; the SDK's own error for params it rejects.
 */
export const lensMarket = (
  outputs: ReadonlyMap<Hex, MarketLensOutput>,
  expected: Readonly<{ marketId: Hex; chainId: number; midnight: Address }>
) => {
  const output = outputs.get(expected.marketId)
  if (output === undefined) throw new LadderAdapterError('position-unavailable')
  const { state } = output
  const market = new Market({
    params: output.market,
    totalUnits: state.totalUnits,
    lossFactor: state.lossFactor,
    withdrawable: state.withdrawable,
    continuousFeeCredit: state.continuousFeeCredit,
    settlementFeeCbps: [
      state.settlementFeeCbp0,
      state.settlementFeeCbp1,
      state.settlementFeeCbp2,
      state.settlementFeeCbp3,
      state.settlementFeeCbp4,
      state.settlementFeeCbp5,
      state.settlementFeeCbp6
    ],
    continuousFee: state.continuousFee,
    tickSpacing: state.tickSpacing
  })
  if (
    market.chainId !== BigInt(expected.chainId) ||
    !isAddressEqual(market.params.midnight, expected.midnight) ||
    market.id.toLowerCase() !== expected.marketId.toLowerCase()
  )
    throw new LadderAdapterError('position-unavailable')
  return market
}

/**
 * The maker's position the lens read for `expected.marketId`, accrued to `timestamp` by the SDK,
 * and its credit accrued again to `redeemBy`.
 * @param outputs - A {@link readMarketLens} result, read for `user`.
 * @param expected - What {@link lensMarket} checks, the position owner, the read block's
 * timestamp, and the latest timestamp a redemption decided on this read can land at.
 * @returns The world position with the market's params as the lens read them and its withdrawable
 * credit, its loan-token collateral present only when the market lists the loan token as collateral.
 * @throws What {@link lensMarket} throws, and the SDK's accrual error for a position state it
 * rejects.
 */
export const lensPosition = (
  outputs: ReadonlyMap<Hex, MarketLensOutput>,
  expected: Parameters<typeof lensMarket>[1] &
    Readonly<{ user: Address; timestamp: bigint; redeemBy: bigint }>
): WorldPosition => {
  const output = outputs.get(expected.marketId)
  if (output === undefined) throw new LadderAdapterError('position-unavailable')
  const market = lensMarket(outputs, expected)
  const read = new AccrualPosition(
    { user: expected.user, ...output.position, collateral: output.collateral },
    market
  )
  const position = read.accrueInterest(expected.timestamp)
  const { collateralParams, loanToken, maturity } = market.params
  const loanIndex = collateralParams.findIndex(slot => isAddressEqual(slot.token, loanToken))
  const loanSlot = collateralParams[loanIndex]
  const assets = loanSlot === undefined ? undefined : position.collateral[loanIndex]
  if (loanSlot !== undefined && assets === undefined)
    throw new LadderAdapterError('position-unavailable')
  return {
    marketId: expected.marketId,
    ...(loanSlot === undefined ? {} : { loanCollateral: { assets: assets!, lltv: loanSlot.lltv } }),
    credit: position.credit,
    debt: position.debt,
    lossFactor: market.lossFactor,
    maturity,
    tickSpacing: market.tickSpacing,
    continuousFee: market.continuousFee,
    params: output.market,
    withdrawable: market.withdrawable,
    redeemableCredit: read.accrueInterest(expected.redeemBy).credit
  }
}

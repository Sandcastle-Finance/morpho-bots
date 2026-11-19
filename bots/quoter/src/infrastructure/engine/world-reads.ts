import type { IMarket } from '@morpho-org/midnight-sdk'
import type { Hex } from 'viem'

import { midnightAbi } from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { blockTagAt } from '@repo/kit'
import { erc20Abi, getAbiItem } from 'viem'

import type { WorldPosition } from '../../application/engine/world'
import type { ConfigService } from '../../config/config.service'
import type { OwnedOverlapBookOffer } from '../../domain/intentional-overlap'
import type { MakerOfferGroup } from '../provider/offer-groups.utils'
import type { ReadClient } from '../provider/read-clients'

import { LadderAdapterError } from '../../errors'
import { readLadderBookOffers } from '../ladder/ladder-book.utils'
import { readMakerOfferGroups } from '../provider/offer-groups.utils'
import { lensMarket, lensPosition, readMarketLens } from './market-lens.sol'

/** One block, as every chain read of a poll is pinned to it by its hash. */
export type WorldBlock = Readonly<{ number: bigint; hash: Hex; timestamp: bigint }>

/**
 * The raw reads world polls and preparations make; production reads the chain and the API, tests
 * replace it.
 */
export type WorldReads = Readonly<{
  /** The latest block's number, hash and timestamp, read together. */
  readLatestBlock: () => Promise<WorldBlock>
  /** A market's state at `block`. */
  readMarket: (marketId: Hex, block: WorldBlock) => Promise<IMarket>
  /** The maker's offer groups as the API indexes them now; not pinned to a block. */
  readGroups: () => Promise<readonly MakerOfferGroup[]>
  /** A market's takeable book from the API now; not pinned to a block. */
  readBook: (marketId: Hex) => Promise<readonly OwnedOverlapBookOffer[]>
  /**
   * The maker's position in each market, accrued to `block` and its credit again to `redeemBy`,
   * read together, in `marketIds` order: one market's failure is its own entry; a failure of the
   * whole read rejects.
   */
  readPositions: (
    marketIds: readonly Hex[],
    block: WorldBlock,
    redeemBy: bigint
  ) => Promise<readonly PromiseSettledResult<WorldPosition>[]>
  /** The maker's loan-token balance and Midnight allowance at `block`. */
  readCash: (block: WorldBlock) => Promise<{ cashBalance: bigint; allowance: bigint }>
  /** Each group's consumption at `block`, in `groupIds` order. */
  readConsumed: (groupIds: readonly Hex[], block: WorldBlock) => Promise<readonly bigint[]>
}>

const consumedAbi = [getAbiItem({ abi: midnightAbi, name: 'consumed' })]

/**
 * The production world reads: the maker's offer groups and each ladder book from the Morpho API,
 * and every chain value pinned to the block it is asked at by hash (EIP-1898), so a read the node
 * cannot serve at that block fails rather than reading another fork's block of the same height.
 * Markets and positions come from one batched lens read per call ({@link readMarketLens}).
 * @param config - Validated runtime config: chain, API, timeouts, and the maker.
 * @param client - The process's shared chain read client.
 * @returns The production reads; no request is made until called.
 */
export const createWorldReads = (config: ConfigService, client: ReadClient): WorldReads => {
  const maker = config.identity.maker
  const expected = {
    chainId: config.chainId,
    midnight: getChainAddress(config.chainId, 'midnight')
  }
  const readLens = (marketIds: readonly Hex[], block: WorldBlock) =>
    readMarketLens(client, {
      midnight: expected.midnight,
      user: maker,
      marketIds,
      blockHash: block.hash
    })
  return {
    readLatestBlock: async () => {
      const { number, hash, timestamp } = await client.getBlock({ blockTag: 'latest' })
      return { number, hash, timestamp }
    },
    readMarket: async (marketId, block) =>
      lensMarket(await readLens([marketId], block), { ...expected, marketId }),
    readGroups: () =>
      readMakerOfferGroups({
        adapterError: LadderAdapterError,
        chainId: config.chainId,
        maker,
        morphoApiBaseUrl: config.morphoApiBaseUrl,
        requestTimeoutMs: config.requestTimeoutMs
      }),
    readBook: marketId =>
      readLadderBookOffers({
        baseUrl: config.morphoApiBaseUrl,
        marketIds: [marketId],
        timeoutMs: config.requestTimeoutMs
      }),
    readPositions: async (marketIds, block, redeemBy) => {
      const outputs = await readLens(marketIds, block)
      return Promise.allSettled(
        marketIds.map(async marketId =>
          lensPosition(outputs, {
            ...expected,
            marketId,
            user: maker,
            timestamp: block.timestamp,
            redeemBy
          })
        )
      )
    },
    readCash: async block => {
      const [cashBalance, allowance] = await Promise.all([
        client.readContract({
          address: config.setup.loanAsset,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [maker],
          blockTag: blockTagAt(block.hash)
        }),
        client.readContract({
          address: config.setup.loanAsset,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [maker, config.setup.midnight],
          blockTag: blockTagAt(block.hash)
        })
      ])
      return { cashBalance, allowance }
    },
    readConsumed: (groupIds, block) =>
      client.multicall({
        contracts: groupIds.map(
          groupId =>
            ({
              address: config.setup.midnight,
              abi: consumedAbi,
              functionName: 'consumed',
              args: [maker, groupId]
            }) as const
        ),
        allowFailure: false,
        blockTag: blockTagAt(block.hash)
      })
  }
}

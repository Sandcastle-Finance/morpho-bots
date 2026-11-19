import type { Address, Hex } from 'viem'

import { MarketParams, MarketUtils } from '@morpho-org/midnight-sdk'
import { morphoViemExtension } from '@morpho-org/morpho-sdk'
import { blockTagAt } from '@repo/kit'
import { createPublicClient, http, isAddressEqual } from 'viem'
import { base } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { ConfigService } from '../../src/config/config.service'
import type { WorldBlock } from '../../src/infrastructure/engine/world-reads'

import { createWorldReads } from '../../src/infrastructure/engine/world-reads'
import { createReadClients } from '../../src/infrastructure/provider/read-clients'
import { type AnvilHandle, startAnvil, stopAnvil } from './anvil'
import { MIDNIGHT, USDC } from './constants'

/** Every deployed quoter market exists here, and the production maker holds credit in each. */
const LENS_FORK_BLOCK = 57_600_000n
const LENS_ANVIL_PORT = 8553

/** The markets the deployed quoters accounted for at {@link LENS_FORK_BLOCK}. */
const MARKET_IDS: readonly Hex[] = [
  '0x6cb9f4a081803895ee5f8cb611c9a7ad7ccadd88d8a8343f478d9e5646efecac',
  '0x9593c3a6dba45b6106af8dc8b45ba8c505d90d3d68a3d33f7c278dd921b637da',
  '0xd0f00456f8d158dfd2f8fbbee55f78c8ce57b01be1e572ae0144506c39c8887f',
  '0x9489f29b589b92d28733ab15135ce6d9c4b5e64413db4326956447a3de1fc098'
]
const MAKERS: readonly Address[] = [
  '0x2b19FEDBe8f864254d65472D1d6A7Cf0bDce71dC',
  '0x7196FE66377C74Bf805F2373b7AEA2d0d6d3FD4b'
]

const configFor = (rpcUrl: string, maker: Address) =>
  ({
    chainId: base.id,
    rpcUrl,
    identity: { maker },
    setup: { loanAsset: USDC, midnight: MIDNIGHT }
  }) as unknown as ConfigService

/** The reference values: the SDK's deployless reads, mapped to the quoter's world types. */
const sdkReads = (rpcUrl: string, maker: Address) => {
  const midnight = createPublicClient({ chain: base, transport: http(rpcUrl) })
    .extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
    .morpho.midnight(base.id)
  return {
    market: (marketId: Hex, block: WorldBlock) =>
      midnight.getMarketData(marketId, { blockTag: blockTagAt(block.hash) }),
    position: async (marketId: Hex, block: WorldBlock, redeemBy: bigint) => {
      const data = await midnight.getPositionData({
        marketId,
        accountAddress: maker,
        parameters: { blockTag: blockTagAt(block.hash) }
      })
      const position = data.accrueInterest(block.timestamp)
      const loanIndex = data.market.params.collateralParams.findIndex(slot =>
        isAddressEqual(slot.token, data.market.params.loanToken)
      )
      const loanSlot = data.market.params.collateralParams[loanIndex]
      return {
        marketId,
        ...(loanSlot === undefined
          ? {}
          : { loanCollateral: { assets: position.collateral[loanIndex]!, lltv: loanSlot.lltv } }),
        credit: position.credit,
        debt: position.debt,
        lossFactor: data.market.lossFactor,
        maturity: data.market.params.maturity,
        tickSpacing: data.market.tickSpacing,
        continuousFee: data.market.continuousFee,
        withdrawable: data.market.withdrawable,
        redeemableCredit: data.accrueInterest(redeemBy).credit
      }
    }
  }
}

describe('the market lens on a pinned Base fork', () => {
  let anvil: AnvilHandle | undefined

  beforeAll(async () => {
    anvil = await startAnvil(LENS_ANVIL_PORT, LENS_FORK_BLOCK)
  }, 60_000)

  afterAll(async () => {
    await stopAnvil(anvil)
  })

  test.each(MAKERS)(
    'reads every market and position %s holds exactly as the SDK reads did',
    async maker => {
      const rpcUrl = anvil!.rpcUrl
      const config = configFor(rpcUrl, maker)
      const reads = createWorldReads(config, createReadClients(config).chain)
      const sdk = sdkReads(rpcUrl, maker)
      const block = await reads.readLatestBlock()
      expect(block.number).toBe(LENS_FORK_BLOCK)

      const redeemBy = block.timestamp + 180n
      const positions = await reads.readPositions(MARKET_IDS, block, redeemBy)
      for (const [index, marketId] of MARKET_IDS.entries()) {
        expect(await reads.readMarket(marketId, block)).toStrictEqual(
          await sdk.market(marketId, block)
        )
        const read = positions[index]
        if (read?.status !== 'fulfilled') throw new Error(`position ${marketId} was not read`)
        const { params, ...position } = read.value
        expect(position).toStrictEqual(await sdk.position(marketId, block, redeemBy))
        expect(MarketUtils.toId(new MarketParams(params))).toBe(marketId)
      }
    },
    300_000
  )
})

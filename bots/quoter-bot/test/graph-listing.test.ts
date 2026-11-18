import { MarketUtils } from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { createGraph, describeGraph } from '@repo/engine'
import { graphMarkdown } from '@repo/engine/testing'
import { describe, expect, it } from 'vitest'

import type { WorldReads } from '../src/infrastructure/engine/world-reads'

import { SETUP_CHECK_MONITOR_INTERVAL_MS } from '../src/application/setup/setup-check.service'
import { ConfigService } from '../src/config/config.service'
import { declareQuoter } from '../src/graph'
import {
  BOOTSTRAP_MONITOR_INTERVAL_MS,
  quoterPollMs
} from '../src/infrastructure/engine/quoter-cadence'
import { createReadClients } from '../src/infrastructure/provider/read-clients'
import { loadQuoterSigner, quoterKernelSpec } from '../src/kernel'

const unused = () => {
  throw new Error('declaring the graph runs nothing')
}

const CHAIN_ID = 8453
const ZERO = '0x0000000000000000000000000000000000000000'
const MAKER_PRIVATE_KEY = `0x${'11'.repeat(32)}`
const MAKER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const LOAN_ASSET = '0x3333333333333333333333333333333333333333'
const MARKET_ID = MarketUtils.toId({
  chainId: BigInt(CHAIN_ID),
  midnight: getChainAddress(CHAIN_ID, 'midnight'),
  loanToken: LOAN_ASSET,
  collateralParams: [
    {
      token: LOAN_ASSET,
      lltv: 1_000_000_000_000_000_000n,
      liquidationCursor: 250_000_000_000_000_000n,
      oracle: '0x0000000000000000000000000000000000008000'
    }
  ],
  maturity: BigInt(Date.UTC(2027, 0, 1, 15) / 1000),
  rcfThreshold: 0n,
  enterGate: ZERO,
  liquidatorGate: ZERO
})

/**
 * Base production's `start`: one market under both strategies on production's 60s ladder loop,
 * a signer's kernel, and readiness monitored. Placeholders stand in for its secrets and markets.
 */
const PRODUCTION_ENV = {
  CHAIN_ID: String(CHAIN_ID),
  RPC_URL: 'https://rpc.example',
  REFERENCE_RPC_URL: 'https://archive.example',
  MAKER_PRIVATE_KEY,
  MAKER_ADDRESS: MAKER,
  MIDNIGHT_ADDRESS: getChainAddress(CHAIN_ID, 'midnight'),
  LOAN_ASSET_ADDRESS: LOAN_ASSET,
  RATIFIER_ADDRESS: getChainAddress(CHAIN_ID, 'setterRatifier'),
  MARKET_IDS: MARKET_ID,
  REFERENCE_MARKET_ID: `0x${'77'.repeat(32)}`,
  NATIVE_RESERVE_WEI: '500000000000000',
  MAX_FEE_GWEI: '100',
  MAX_TRANSACTION_SPEND_WEI: '100000000000000000',
  MAX_CONTINUOUS_FEE_CAP: '0',
  KERNEL_ENROLLMENT: 'enrolled',
  MAX_PUBLICATION_GAS: '5000000',
  MAX_PUBLICATION_DATA_BYTES: '65536',
  MAX_CANCELLATION_GAS: '100000',
  MAX_BATCH_CANCELLATION_GAS: '1000000',
  MAX_BATCH_CANCELLATION_DATA_BYTES: '65536',
  MAX_RATIFICATION_GAS: '100000',
  MORPHO_API_BASE_URL: 'https://api.example',
  ROUTER_API_BASE_URL: 'https://router.example',
  TRANSACTION_RECEIPT_TIMEOUT_MS: '900000',
  BOOTSTRAP_MARKETS: JSON.stringify([
    {
      marketId: MARKET_ID,
      targetRate: { strategy: 'hardcoded', hardcodedRateBps: '518' },
      creditTarget: '1',
      acceptanceAssets: '1',
      offerSize: '72000000000',
      premiumBps: '0',
      maximumMarketExposure: '1',
      maximumTotalExposure: '332000000000',
      minimumRateBps: '200',
      maximumRateBps: '800',
      autoRefill: true
    }
  ]),
  LADDER_MARKETS: JSON.stringify([
    {
      marketId: MARKET_ID,
      targetRate: { strategy: 'hardcoded', hardcodedRateBps: '518' },
      quotePremiumBps: '0',
      spreadBps: '60',
      stepBps: '23',
      rungCount: '3',
      sizeSkewBps: '0',
      lowerRateBudgetAssets: '166000000000',
      higherRateBudgetAssets: '166000000000',
      targetMarketExposureAssets: '332000000000',
      maximumTotalExposureAssets: '332000000000',
      minimumOfferAssets: '1',
      groupMode: 'shared-rung',
      loopIntervalSeconds: '60',
      movementToleranceBps: '10',
      minimumRateBps: '200',
      maximumRateBps: '800'
    }
  ])
}

/** The graph `startQuoterEngine` builds for `start`, from the same config and constants. */
const declared = async () => {
  const config = ConfigService.from(PRODUCTION_ENV)
  if (config.identity.readOnly) throw new Error('production signs')
  const signer = await loadQuoterSigner(config.identity)
  const { hosting } = quoterKernelSpec({
    config,
    signer,
    client: createReadClients(config).chain,
    stateDirectory: '/nonexistent'
  })
  const g = createGraph('quoter')
  declareQuoter(g, {
    runId: 'run',
    ladder: config.ladder,
    bootstrap: config.bootstrap,
    accounting: {
      maker: config.setup.maker,
      marketIds: config.setup.marketIds,
      v0OfferGroupIds: config.v0OfferGroupIds
    },
    redeemWithdrawable: config.redeemWithdrawable,
    signing: {
      chainId: config.chainId,
      maker: config.setup.maker,
      signer: signer.address,
      ratifier: unused
    },
    kernel: hosting,
    dry: false,
    reads: new Proxy({}, { get: () => unused }) as WorldReads,
    rates: unused,
    prepare: unused,
    validate: unused,
    timing: {
      everyMs: quoterPollMs(config.ladder),
      bootstrapEveryMs: BOOTSTRAP_MONITOR_INTERVAL_MS,
      receiptTimeoutMs: config.transactionReceiptTimeoutMs
    },
    now: Date.now,
    readiness: { create: unused, intervalMs: SETUP_CHECK_MONITOR_INTERVAL_MS },
    onActivity: () => {},
    onReport: () => {},
    onAdvance: () => {},
    onSetup: () => {},
    onEvent: () => {}
  })
  return g.build()
}

describe('the quoter graph', () => {
  it('is the one GRAPH.md lists', async () => {
    await expect(
      graphMarkdown(describeGraph(await declared()), {
        declaration: './src/graph.ts',
        fixture: './test/graph-listing.test.ts',
        spec: '../../framework/engine/SPEC.md'
      })
    ).toMatchFileSnapshot('../GRAPH.md')
  })
})

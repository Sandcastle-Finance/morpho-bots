import type { KernelHead } from '@repo/kernel'
import type { Venue } from '@repo/swaps'
import type { Hex } from 'viem'

import { runIdAt } from '@repo/controller'
import {
  assertContractDeployed,
  createBalanceMonitor,
  createDeploylessClient,
  createHeartbeatMonitor,
  createJournalFileSink,
  createLogger,
  simulateLiquidationExec,
  withLogging
} from '@repo/kit'
import {
  createErc4626Unwrapper,
  createPendlePtUnwrapper,
  createRateLimitedClient,
  createVenueSelector,
  PENDLE_CHAIN_IDS,
  priceByVenue
} from '@repo/swaps'
import { tryCatch } from '@repo/utils'
import { join } from 'node:path'
import { erc20Abi } from 'viem'
import { getBalance, readContract } from 'viem/actions'

import type { LensInput } from './state/lens.sol'

import { loadConfig } from './config'
import { createApiCandidateSource, discoverBorrowers } from './discovery/borrowers'
import { createListedMarketFilter, createUnionListedMarketFilter } from './discovery/markets'
import { createTokenPriceSource } from './discovery/token-prices'
import { LIQUIDATOR_GRAPH } from './graph'
import { chainFeeReads, liquidatorAccount, liquidatorKernel } from './kernel'
import { composeQuoting } from './quotes'
import { revertReason } from './revert.utils'
import { startLiquidator } from './run'
import { createPlanSkipLog } from './runner/plan-skip-log'
import { liquidatorSettings } from './settings'
import { readMidnightLiquidationLens } from './state/lens.sol'
import { createTickStats } from './stats'
import { superviseKernelBot } from './supervise'

const JOURNAL_CAPACITY_BYTES = 16 * 1024 * 1024
async function main() {
  const config = loadConfig()
  const { build, runCapBytes } = config.kernel.journal
  const logger = createLogger(config.logLevel, {
    context: { bot: 'midnight-liquidation', chainId: config.chainId, ...build }
  })

  const account = liquidatorAccount(config)
  const eoa = account.address
  const settings = liquidatorSettings(config, { account: eoa, runId: runIdAt(Date.now()) })

  logger.info('startup', {
    chainId: config.chainId,
    liquidator: eoa,
    callback: config.executooorAddress,
    midnight: config.midnight
  })

  const client = createDeploylessClient(config)
  await assertContractDeployed(
    client,
    config.executooorAddress,
    'EXECUTOOOR_ADDRESS',
    'deploy it with `bun run --filter @repo/contracts deploy:executor`'
  )
  await assertContractDeployed(client, config.midnight, 'Midnight singleton')

  // Enabled venues are inferred from which venue API keys are present (loadConfig already enforced the
  // no-key → bad-debt-only opt-in). Keys are read HERE, at the point of use, and live only in this
  // closure — never on the (logged) Config object.
  const apiKeys: Partial<Record<Venue, string>> = {}
  if (process.env.ZEROX_API_KEY) apiKeys['0x'] = process.env.ZEROX_API_KEY
  if (process.env.ONEINCH_API_KEY) apiKeys['1inch'] = process.env.ONEINCH_API_KEY
  if (process.env.LIFI_API_KEY) apiKeys.lifi = process.env.LIFI_API_KEY
  const { venues } = settings
  if (venues.length === 0) {
    logger.warn('quoting.no_routes', {
      chainId: config.chainId,
      detail:
        'no venue API keys set — running bad-debt-only (positions discovered, bad debt realized, no swap-liquidations)'
    })
  } else {
    logger.info('quoting.startup', { chainId: config.chainId, venues })
  }
  const baseUrls: Partial<Record<Venue, string>> = {}
  if (config.venues.zeroxBaseUrl) baseUrls['0x'] = config.venues.zeroxBaseUrl
  if (config.venues.oneinchBaseUrl) baseUrls['1inch'] = config.venues.oneinchBaseUrl
  if (config.venues.lifiBaseUrl) baseUrls.lifi = config.venues.lifiBaseUrl

  // Two rate-limited HTTP clients, each with its own per-venue token buckets: one for time-sensitive
  // FIRM quotes, and a separate, slower one for BACKGROUND probes — so a probe burst can never queue
  // ahead of a live liquidation's firm quote on the same venue's bucket.
  const httpClient = createRateLimitedClient({
    apiKeys,
    rps: config.quoting.httpRps,
    burst: config.quoting.httpBurst,
    maxRetries: config.quoting.httpMaxRetries,
    timeoutMs: config.quoting.quoteTimeoutMs
  })
  const probeClient = createRateLimitedClient({
    apiKeys,
    rps: config.probe.httpRps,
    burst: config.probe.httpRps,
    maxRetries: config.quoting.httpMaxRetries,
    timeoutMs: config.quoting.quoteTimeoutMs
  })

  // Market whitelist: only listed markets are discovered, probed and liquidated. One filter per
  // configured markets source, unioned, with the max-age rule applied PER SOURCE so a source that goes
  // down or stale drops out instead of emptying the whitelist. The startup refresh is awaited but
  // non-fatal: a failed first fetch leaves the set empty, which is fail-closed.
  const listedMarkets = createUnionListedMarketFilter({
    filters: config.markets.apiUrls.map(apiUrl =>
      createListedMarketFilter({
        apiUrl,
        apiKey: config.morphoApiKey,
        chainId: config.chainId,
        logger
      })
    ),
    chainId: config.chainId,
    maxAgeMs: settings.markets.maxAgeMs,
    logger
  })
  await tryCatch(listedMarkets.refresh())

  // Token USD prices order positions and denominate the probe ladder, and fail open on both counts:
  // an unpriced token ranks last and its ladder falls back to whole collateral tokens. They share the
  // candidates endpoint's base URL, so pointing the bot at a staging host moves both.
  const tokenPrices = createTokenPriceSource({
    apiUrl: config.discovery.apiUrl,
    apiKey: config.morphoApiKey,
    chainId: config.chainId,
    logger
  })

  // Venue selector: caches each venue's rate curve per pair from log-scaled, USD-denominated
  // indicative probes. Decimals are read once per collateral, bounded by the listed markets.
  const venueSelector = createVenueSelector({
    venues,
    chainId: config.chainId,
    ladderSizes: config.probe.ladderSizes,
    getDecimals: token =>
      readContract(client, { address: token, abi: erc20Abi, functionName: 'decimals' }),
    usdPriceOf: async token => tokenPrices.usdPriceOf(token),
    indicativeQuote: (venue, params) => priceByVenue(probeClient, { venue, baseUrls, params }),
    staleMs: config.probe.staleMs,
    logger
  })

  // Pre-swap converters for exotic collateral (ERC-4626 shares, Pendle PTs → underlying), auto-detected
  // and memoized per process. Pendle is only constructed on chains it is deployed to — elsewhere a
  // cold-cache markets outage would fail plain-collateral quotes too.
  const pendle = PENDLE_CHAIN_IDS.has(config.chainId)
    ? createPendlePtUnwrapper({
        client: httpClient,
        chainId: config.chainId,
        slippageBps: config.quoting.pendleSlippageBps,
        logger
      })
    : null
  const unwrappers = [createErc4626Unwrapper({ client, logger }), ...(pendle ? [pendle] : [])]

  const { quoteFor, resolvePair } = composeQuoting({
    httpClient,
    selector: venueSelector,
    chainId: config.chainId,
    executor: config.executooorAddress,
    venues,
    baseUrls,
    maxRouteImpactBps: config.quoting.maxRouteImpactBps,
    unwrappers,
    excludeCollaterals: config.venues.excludeCollaterals,
    logger
  })

  // Borrower discovery: the markets liquidation-candidates endpoint, cursor-paginated and
  // over-inclusive. The lens re-reads every returned pair at the kernel's head, so this is a coverage
  // source, never the source of truth.
  const fetchPage = createApiCandidateSource({
    url: config.discovery.apiUrl,
    apiKey: config.morphoApiKey,
    chainId: config.chainId,
    healthFactorLte: config.discovery.healthFactorLte
  })
  const discover = () => discoverBorrowers(fetchPage, { logger })

  // Startup discovery self-check (non-fatal): a bad candidates-API URL, an auth failure, or an empty
  // whitelist is diagnosable from the boot logs rather than as a per-head `discover.error`.
  {
    const probe = await tryCatch(discover())
    if (probe.error) {
      logger.warn('discovery.startup_error', { detail: revertReason(probe.error) })
    } else {
      const listed = probe.data.candidates.filter(candidate =>
        listedMarkets.current().isListed(candidate.marketId)
      )
      logger.info('discovery.startup', {
        chainId: config.chainId,
        candidates: listed.length,
        sample: listed[0] ?? null
      })
    }
  }

  const balanceMonitor = createBalanceMonitor({
    address: eoa,
    read: () => getBalance(client, { address: eoa }),
    everyBlocks: config.tuning.balanceEveryBlocks,
    logger,
    chain: config.chain
  })
  using heartbeatMonitor = createHeartbeatMonitor({
    url: process.env.BETTERSTACK_HEARTBEAT_URL,
    logger
  })
  void heartbeatMonitor.start()

  // Scoped to the lens read: viem-dlc emits per outermost request inside the scope.
  const readLens = (pairs: readonly LensInput[], at: KernelHead) =>
    withLogging(() => readMidnightLiquidationLens(client, config.midnight, pairs, at.hash as Hex), {
      logger: logger.layer,
      lens: 'midnight-liquidation'
    })
  const kernel = liquidatorKernel(settings, { config, account, logger })
  const journal = await createJournalFileSink({
    directory: join(config.kernel.stateDirectory, 'journal'),
    graph: LIQUIDATOR_GRAPH,
    build,
    capacityBytes: JOURNAL_CAPACITY_BYTES,
    runCapBytes,
    runId: settings.runId,
    settings
  })
  logger.info('journal.pruned', journal.pruned)
  const running = await startLiquidator(settings, {
    journal: journal.journal,
    kernel: kernel.live,
    world: {
      discover,
      readLens,
      onHead: head => void balanceMonitor.maybeLog(BigInt(head.number))
    },
    markets: { initial: listedMarkets.sources() },
    refreshMarkets: async () => {
      await listedMarkets.refresh()
      if (venues.length === 0)
        logger.warn('quoting.no_routes', { detail: 'still no venue API keys — bad-debt-only' })
      return listedMarkets.sources()
    },
    refreshPrices: async () => {
      await tokenPrices.refresh()
      return { table: tokenPrices.table(), updatedAt: tokenPrices.snapshot().updatedAt }
    },
    routes: { resolvePair, sweep: venueSelector.refresh, curveOf: venueSelector.curveOf },
    quoteFor,
    simulate: data =>
      simulateLiquidationExec(client, { executooor: config.executooorAddress, eoa, data }),
    readFees: chainFeeReads(client, config.chain),
    stats: createTickStats(),
    planSkipLog: createPlanSkipLog(),
    logger
  })

  process.exitCode = await superviseKernelBot(running, journal.runCapReached, logger, () => ({
    venues: venueSelector.snapshot(),
    listedMarkets: listedMarkets.snapshot(),
    tokenPrices: tokenPrices.snapshot()
  }))
}

main().catch(error => {
  // Config/client never came up, so we cannot honor LOG_LEVEL — emit the failure directly, exit non-zero.
  console.error(
    JSON.stringify({ level: 'error', event: 'startup.error', error: revertReason(error) })
  )
  process.exitCode = 1
})

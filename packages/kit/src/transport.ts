import type { EIP1193RequestFn, PublicRpcSchema, Transport } from 'viem'

import { deployless, failover, rateLimiter } from '@morpho-org/viem-dlc/transports'
import { http } from 'viem'

import { ethCallGasCap } from './gas-limits'

/** Per-request timeout for every kit HTTP transport (the read client and the signer). */
const RPC_TIMEOUT_MS = 30_000

/** Per-endpoint read budget, matching prime-monorepo's server clients (`web3.config.server.ts`). */
const READ_RATE_LIMIT = {
  maxRequestsPerSecond: 100,
  maxBurstRequests: 300,
  maxConcurrentRequests: 100
}

/**
 * Robinhood Chain's public endpoint. Measured 2026-11-25: it serves 20 requests a second
 * sustained and answers HTTP 429 to about half of 80 a second, so it gets a budget under that.
 */
const ROBINHOOD_PUBLIC_RPC_HOST = 'rpc.mainnet.chain.robinhood.com'
const ROBINHOOD_PUBLIC_RATE_LIMIT = {
  maxRequestsPerSecond: 20,
  maxBurstRequests: 20,
  maxConcurrentRequests: 10
}

/** The read budget to hold this endpoint to. */
const readRateLimit = (url: string) =>
  url.includes(ROBINHOOD_PUBLIC_RPC_HOST) ? ROBINHOOD_PUBLIC_RATE_LIMIT : READ_RATE_LIMIT

/**
 * The endpoints named by a fallback setting: one URL, or several separated by commas, tried in
 * the order given.
 */
const fallbackUrls = (fallback: string | undefined): string[] =>
  (fallback ?? '')
    .split(',')
    .map(url => url.trim())
    .filter(url => url !== '')

/**
 * The base HTTP transport kit clients share: a viem-dlc `failover` over the primary and every
 * endpoint in `fallbackUrl` (see {@link fallbackUrls}) when it is set, else a single `http` endpoint — each with a {@link RPC_TIMEOUT_MS} per-request timeout.
 */
export function createHttpTransport(primaryUrl: string, fallbackUrl?: string) {
  // Only an endpoint with a measured budget is held to one here; the rest keep the plain transport.
  const rpc = (url: string) => {
    const endpoint = http(url, { timeout: RPC_TIMEOUT_MS })
    return url.includes(ROBINHOOD_PUBLIC_RPC_HOST)
      ? rateLimiter(endpoint, [ROBINHOOD_PUBLIC_RATE_LIMIT])
      : endpoint
  }
  const fallbacks = fallbackUrls(fallbackUrl)
  if (fallbacks.length === 0) return rpc(primaryUrl)
  return failover([rpc(primaryUrl), ...fallbacks.map(rpc)])
}

/**
 * The read transport: `deployless` **inside** each failover branch, not wrapped around the pair.
 *
 * `deployless`'s `gasLimit` states the provider's own `eth_call` cap, and a failover pair may point
 * at two providers whose caps differ — so each branch states its own, looked up from its URL. The
 * previous shape (`deployless(failover([...]))`) could only state one for both.
 *
 * `failover` types itself `viem-dlc-failover`, so the composed transport is re-labelled: every
 * branch underneath is a `deployless` and the RPC schema is identical, and callers are typed against
 * `Transport<'viem-dlc-deployless'>`.
 */
export function createDeploylessTransport(options: {
  chainId: number
  rpcUrl: string
  rpcUrlFallback?: string | undefined
  batchSize?: number | undefined
  timeoutMs?: number | undefined
}): Transport<'viem-dlc-deployless'> {
  const { chainId, rpcUrl, rpcUrlFallback, batchSize, timeoutMs = RPC_TIMEOUT_MS } = options
  const branch = (url: string) =>
    deployless(rateLimiter(http(url, { timeout: timeoutMs }), [readRateLimit(url)]), {
      gasLimit: ethCallGasCap(chainId, url),
      batchSize
    })

  const fallbacks = fallbackUrls(rpcUrlFallback)
  if (fallbacks.length === 0) return branch(rpcUrl)
  return asDeploylessTransport(failover([branch(rpcUrl), ...fallbacks.map(branch)]))
}

/**
 * Re-labels a transport as `viem-dlc-deployless`. PORTED from prime-monorepo
 * (`packages/web3/src/configs/rpcs.ts`), which composes the same failover-of-deployless shape.
 * Drops the deployless `value` typing (`{ gasLimit }`) — no consumer reads it through the client,
 * and with one cap per branch there is no single value to report anyway.
 */
function asDeploylessTransport(
  transport: Transport<string, unknown, EIP1193RequestFn<PublicRpcSchema>>
): Transport<'viem-dlc-deployless'> {
  return ((params: Parameters<typeof transport>[0]) => {
    const config = transport(params)
    return {
      ...config,
      config: {
        ...config.config,
        key: 'viem-dlc-deployless',
        name: '[viem-dlc] deployless',
        type: 'viem-dlc-deployless'
      }
    }
  }) as Transport<'viem-dlc-deployless'>
}

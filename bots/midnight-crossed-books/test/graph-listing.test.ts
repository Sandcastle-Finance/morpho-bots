import { describeGraph } from '@repo/engine'
import { graphMarkdown } from '@repo/engine/testing'
import { createLogger } from '@repo/kit'
import { describe, expect, it } from 'vitest'

import type { WriteConfig } from '../src/config'

import { loadConfig } from '../src/config'
import { declareResolver } from '../src/graph'
import { resolverAccount, resolverKernel } from '../src/kernel'

const unused = () => {
  throw new Error('declaring the graph runs nothing')
}

/** A writer's environment on Base, with placeholders for its secrets. */
const WRITER_ENV = {
  CHAIN_ID: '8453',
  FINALITY_8453: 'safe',
  KERNEL_ENROLLMENT: 'enrolled',
  MAX_FEE_GWEI: '0.5',
  MAX_SPEND_ETH: '0.0075',
  MAX_GAS_LIMIT: '15000000',
  RPC_URL: 'http://localhost:8545',
  RESOLVER_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
  KERNEL_STATE_DIR: '/nonexistent',
  JOURNAL_RUN_CAP_BYTES: '1073741824',
  BUILD_REVISION: '0d58dd8e5',
  BUILD_IMAGE_TAG: 'test'
}

/**
 * The graph `src/index.ts` starts in write mode, from the same config, with its reads and callbacks
 * stubbed; backoff and reservations are placeholders, since neither reaches the description.
 */
const declared = () => {
  const config = loadConfig(WRITER_ENV)
  const mode = config.mode as WriteConfig
  const logger = createLogger('error', { env: {} })
  const kernel = resolverKernel({ config, mode, account: resolverAccount(mode), logger })
  return declareResolver({
    kernel: kernel.live,
    scan: {
      listMarkets: unused,
      getBook: unused,
      simulate: unused,
      maxMatches: config.maxMatches,
      minimumProfit: config.minimumProfit
    },
    resolver: config.resolver,
    scanIntervalMs: config.scanIntervalMs,
    worldValidMs: config.worldValidMs,
    onHead: () => {},
    backoff: { baseBlocks: 1, maxBlocks: 1 },
    runId: 'run',
    maxReservations: 1,
    logger
  }).graph
}

describe('the resolver graph', () => {
  it('is the one GRAPH.md lists', async () => {
    await expect(
      graphMarkdown(describeGraph(declared()), {
        declaration: './src/graph.ts',
        fixture: './test/graph-listing.test.ts',
        spec: '../../framework/engine/SPEC.md'
      })
    ).toMatchFileSnapshot('../GRAPH.md')
  })
})

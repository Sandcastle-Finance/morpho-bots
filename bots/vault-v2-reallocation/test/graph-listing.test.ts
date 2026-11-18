import type { Address } from 'viem'

import { describeGraph } from '@repo/engine'
import { graphMarkdown } from '@repo/engine/testing'
import { createLogger, TRANSACTION_KERNEL_RESERVATIONS } from '@repo/kit'
import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config'
import { declareReallocator } from '../src/graph'
import { reallocatorAccount, reallocatorKernel } from '../src/kernel'
import { createStrategy } from '../src/strategies'

const unused = () => {
  throw new Error('declaring the graph runs nothing')
}

const ADAPTER: Address = '0x3333333333333333333333333333333333333333'

/** A sending reallocator's environment on Base, with placeholders for its secrets, vault and adapter. */
const WRITER_ENV = {
  CHAIN_ID: '8453',
  FINALITY_8453: 'safe',
  KERNEL_ENROLLMENT: 'enrolled',
  MAX_FEE_GWEI: '0.5',
  RPC_URL: 'http://localhost:8545',
  REALLOCATOR_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
  VAULT_WHITELIST: '0x1111111111111111111111111111111111111111',
  KERNEL_STATE_DIR: '/nonexistent',
  JOURNAL_RUN_CAP_BYTES: '1073741824',
  BUILD_REVISION: '0d58dd8e5',
  BUILD_IMAGE_TAG: 'test'
}

/**
 * The graph `src/index.ts` starts, from the same config, with its reads and callbacks stubbed;
 * backoff is a placeholder, since it never reaches the description.
 */
const declared = () => {
  const config = loadConfig(WRITER_ENV)
  const logger = createLogger('error', { env: {} })
  const account = reallocatorAccount(config)
  const adapters = { [config.vaultWhitelist[0]!]: ADAPTER }
  const kernel = reallocatorKernel({ config, account, adapters, logger })
  return declareReallocator({
    kernel: kernel.live,
    world: { vaults: config.vaultWhitelist, fetchVaults: unused },
    strategy: createStrategy(config),
    adapters,
    prepare: { encode: unused, simulate: unused, dryRun: config.dryRun },
    intervalMs: config.reallocationIntervalMs,
    backoff: { baseBlocks: 1, maxBlocks: 1 },
    runId: 'run',
    maxReservations: TRANSACTION_KERNEL_RESERVATIONS,
    onHead: () => {},
    logger
  }).graph
}

describe('the reallocator graph', () => {
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

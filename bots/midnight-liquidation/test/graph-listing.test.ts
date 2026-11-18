import { describeGraph } from '@repo/engine'
import { graphMarkdown } from '@repo/engine/testing'
import { createLogger } from '@repo/kit'
import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config'
import { declareLiquidator } from '../src/graph'
import { liquidatorAccount, liquidatorKernel } from '../src/kernel'
import { createPlanSkipLog } from '../src/runner/plan-skip-log'
import { liquidatorSettings } from '../src/settings'
import { createTickStats } from '../src/stats'

const unused = () => {
  throw new Error('declaring the graph runs nothing')
}

/** Base production's environment, with placeholders for its secrets and every venue enabled. */
const PRODUCTION_ENV = {
  CHAIN_ID: '8453',
  FINALITY_8453: 'safe',
  KERNEL_ENROLLMENT: 'enrolled',
  MAX_FEE_GWEI: '0.5',
  MAX_SPEND_ETH: '0.5',
  MAX_GAS_LIMIT: '15000000',
  RPC_URL: 'http://localhost:8545',
  LIQUIDATOR_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
  MORPHO_API_KEY: 'morpho-key',
  ZEROX_API_KEY: 'zx-key',
  ONEINCH_API_KEY: 'oneinch-key',
  LIFI_API_KEY: 'lifi-key',
  KERNEL_STATE_DIR: '/nonexistent',
  JOURNAL_RUN_CAP_BYTES: '1073741824',
  BUILD_REVISION: '0d58dd8e5',
  BUILD_IMAGE_TAG: 'test'
}

/**
 * The graph `src/index.ts` starts, from the settings it records for that environment, with its reads
 * and callbacks stubbed.
 */
const declared = () => {
  const config = loadConfig(PRODUCTION_ENV)
  const account = liquidatorAccount(config)
  const settings = liquidatorSettings(config, { account: account.address, runId: 'run' })
  const logger = createLogger('error', { env: {} })
  return declareLiquidator(settings, {
    kernel: liquidatorKernel(settings, { config, account, logger }).live,
    world: { discover: unused, readLens: unused },
    refreshMarkets: unused,
    refreshPrices: unused,
    routes: { resolvePair: unused, sweep: unused, curveOf: unused },
    quoteFor: unused,
    simulate: unused,
    readFees: unused,
    now: Date.now,
    stats: createTickStats(),
    planSkipLog: createPlanSkipLog(),
    logger
  }).graph
}

describe('the liquidator graph', () => {
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

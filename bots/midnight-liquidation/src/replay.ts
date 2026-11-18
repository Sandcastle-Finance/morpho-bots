import type { JournalHeader } from '@repo/kit'

import { reorgDepthFor, TRANSACTION_KERNEL_POLL_MS } from '@repo/kit'

import type { LiquidatorDeps } from './graph'
import type { LiquidatorSettings } from './settings'

import { NotReplayableError, ReplayEffectError } from './errors'
import { declareLiquidator, LIQUIDATOR_GRAPH } from './graph'
import { KERNEL_EFFECT_TIMEOUT_MS } from './kernel'
import { createPlanSkipLog } from './runner/plan-skip-log'
import { parseLiquidatorSettings } from './settings'
import { createTickStats } from './stats'

const refuse = (): never => {
  throw new ReplayEffectError()
}

/** An object every method of which refuses, standing in for a client a replay never calls. */
const inert = <T extends object>() => new Proxy({}, { get: () => refuse }) as T

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** Hosts the kernel with the live run's timings, so the rebuilt graph is the one it journaled. */
const replayDeps = (settings: LiquidatorSettings): LiquidatorDeps => ({
  kernel: {
    store: inert(),
    chain: inert(),
    effects: inert(),
    pollMs: TRANSACTION_KERNEL_POLL_MS,
    effectTimeoutMs: KERNEL_EFFECT_TIMEOUT_MS,
    reorgDepth: reorgDepthFor({ id: settings.chainId }),
    onError: () => {}
  },
  world: { discover: refuse, readLens: refuse },
  refreshMarkets: refuse,
  refreshPrices: refuse,
  routes: { resolvePair: refuse, sweep: refuse, curveOf: refuse },
  quoteFor: refuse,
  simulate: refuse,
  readFees: refuse,
  now: refuse,
  stats: createTickStats(),
  planSkipLog: createPlanSkipLog(),
  logger: silent
})

/**
 * The graph a journaled run built, rebuilt from its header alone: the settings it recorded, under
 * the run id it recorded.
 * @throws NotReplayableError - for another graph's journal, or a header with no settings or with
 * another run's; InvalidSettingsError for settings this build's schema refuses.
 */
export const replayGraph = (header: Pick<JournalHeader, 'graph' | 'run' | 'settings'>) => {
  if (header.graph !== LIQUIDATOR_GRAPH) throw new NotReplayableError('another graph wrote it')
  if (header.settings === undefined) throw new NotReplayableError('its header has no settings')
  const settings = parseLiquidatorSettings(header.settings)
  if (settings.runId !== header.run)
    throw new NotReplayableError("its settings name another run than its header's")
  return declareLiquidator(settings, replayDeps(settings)).graph
}

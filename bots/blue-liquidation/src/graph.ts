import type { Backoff } from '@repo/controller'
import type { Keyed, KeyedWrite } from '@repo/engine'
import type { KernelHostOptions } from '@repo/kernel'
import type { Logger } from '@repo/kit'

import { defineBot, isBackedOff, logBackoff, logTasks, tasks } from '@repo/controller'
import {
  emitTo,
  every,
  keyedLevel,
  keyRecord,
  lane,
  latest,
  sample,
  UNREAD,
  watch
} from '@repo/engine'
import { declareLiveLog } from '@repo/kit'

import type { PositionReading } from './liquidation'
import type { PrepareDeps } from './prepare'
import type { LiquidatorSettings } from './settings'
import type { PositionQuote, QuoteDeps, QuoteRequest, RouteQuote, WorldDeps } from './sources'
import type { TickStats } from './stats'

import { encodeLiquidationExec } from './execution/encode-call'
import { liquidatorKernelConfig } from './kernel'
import { liquidationTask, sizePosition, unhealthiness } from './liquidation'
import { createPositionPreparer } from './prepare'
import { createReporter } from './report'
import { parseLiquidatorSettings } from './settings'
import { covers, deferredQuote, quotesDue, quotesGone, readPositions, readQuote } from './sources'

/** World reads queued behind the one in flight; a read for a head the kernel has passed is skipped. */
const WORLD_QUEUE = 256
/** Preparations waiting for a simulation slot; the family never has more out than it runs. */
const PREPARE_QUEUE = 64
/** A simulation, with its retries. */
const PREPARE_TIMEOUT_MS = 10_000
/** A firm quote with its retries. */
const QUOTE_TIMEOUT_MS = 20_000
export const LIQUIDATOR_GRAPH = 'blue-liquidation'

/** What the liquidator reaches outside its graph; a replay runs none of it. */
export type LiquidatorDeps = Readonly<{
  /** The kernel's chain, ledger and effects; its config and enrollment come from the settings. */
  kernel: Omit<KernelHostOptions, 'config' | 'enrollment' | 'requests' | 'facts' | 'onActivity'>
  world: Omit<WorldDeps, 'logger'>
  quoteFor: QuoteDeps['quoteFor']
  simulate: PrepareDeps['simulate']
  stats: TickStats
  logger: Logger
}>

type Declared = Readonly<{ settings: LiquidatorSettings; deps: LiquidatorDeps }>

/**
 * The liquidator: each new head is a world read of every liquidatable position; each one with a
 * plan and no backoff is quoted, and quoted again only once its route expires or no longer covers its
 * seize, or its failed quote has waited out its own backoff. A
 * liquidation rests on two facts, that its position is still liquidatable and that its route is the
 * one quoted, so it holds exactly as long as both do. Shared liquidity between positions is neither
 * reserved nor a conflict: simulation and the Executor's onchain bounds stop a squeezed route, at
 * the cost of gas.
 */
const declare = defineBot(LIQUIDATOR_GRAPH, (b, { settings, deps }: Declared) => {
  const { logger, stats } = deps
  const reporter = createReporter({ stats, logger })
  const kernel = b.kernel({
    ...deps.kernel,
    config: liquidatorKernelConfig(settings),
    enrollment: settings.kernel.enrollment,
    onActivity: reporter.reportActivity
  })
  const world = b.source('world', {
    level: 'positions',
    at: 'head',
    queue: WORLD_QUEUE,
    validForMs: settings.worldValidMs,
    logger,
    read: readPositions({ ...deps.world, stats, logger })
  })
  const positions = world.level
  const { writes, quotes } = b.raw(g =>
    g.scope('quotes', s => {
      const writes = s.node<KeyedWrite<PositionQuote>>('reads')
      return { writes, quotes: keyedLevel(g, 'quotes', writes) }
    })
  )
  const routeOf = (key: string, routes: Keyed<PositionQuote>) => {
    const quote = keyRecord(routes, key)
    return quote.status === 'present' && quote.value.kind === 'route' ? quote : undefined
  }
  const routed = { with: { routes: latest(quotes) } }
  const liquidatable = b.fact('positions.liquidatable', positions, ({ marketId, borrower }) => ({
    marketId,
    borrower
  }))
  const route = b.fact('quotes.route', quotes, quote =>
    quote.kind === 'route' ? quote : undefined
  )
  const sizing = b.derive('positions.sizing', positions, r => sizePosition(r.out))
  const inputs = b.derive(
    'liquidations.inputs',
    positions,
    (reading, key, { routes }) => {
      const quoted = routeOf(key, routes)
      if (!quoted) return undefined
      const { plan } = sizePosition(reading.out)
      if (plan && !covers(quoted.value, plan.seizedAssets)) return undefined
      return { reading, quote: quoted.value as RouteQuote }
    },
    routed
  )
  const candidates = b.derive('liquidations.candidates', inputs, ({ reading }) => {
    const { plan } = sizePosition(reading.out)
    return plan ? { bid: unhealthiness(reading.out) } : undefined
  })
  const liquidations = tasks.each(b, 'liquidations', {
    kernel,
    candidates,
    facts: [liquidatable, route],
    inputs,
    runId: settings.runId,
    maxReservations: settings.maxReservations,
    backoff: settings.backoff,
    policy: liquidationTask,
    prepare: {
      lane: lane('simulation', { concurrency: settings.simulations, queue: PREPARE_QUEUE }),
      timeoutMs: PREPARE_TIMEOUT_MS,
      handle: createPositionPreparer({
        executor: settings.executor,
        encode: (market, borrower, seizedAssets, plan) =>
          encodeLiquidationExec({
            executor: settings.executor,
            morpho: settings.morpho,
            market,
            seizedAssets,
            borrower,
            plan,
            recipient: settings.account
          }),
        simulate: deps.simulate,
        stats,
        logger
      })
    }
  })
  const { backoff } = liquidations
  b.raw(g =>
    g.scope('quotes', s => {
      const requests = s.node<QuoteRequest>('requests')
      // A re-quote moves the route fact an in-flight act rests on, so busy keys are never quoted.
      // The view and backoff are sampled, as a fact the kernel triggers is refused (controller SPEC
      // §7), so quotes are scheduled only in a step that wrote positions or quotes, which re-reads both.
      const held = s.map('held', {
        reads: {
          positions: latest(positions),
          quotes: latest(quotes),
          view: sample(kernel.view),
          backoff: sample(backoff.state)
        },
        compute: ({ view, backoff }) => ({ busy: view.busy, backoff })
      })
      const unreadPositions: Keyed<PositionReading> = UNREAD
      const unreadQuotes: Keyed<PositionQuote> = UNREAD
      s.fold('schedule', {
        reads: {
          positions: watch(positions),
          held: watch(held),
          quotes: watch(quotes),
          written: every(writes)
        },
        emits: [requests],
        initial: {
          positions: unreadPositions,
          busy: [] as readonly string[],
          backoff: undefined as Backoff | undefined,
          quotes: unreadQuotes,
          quoting: [] as readonly string[],
          changed: false
        },
        applyInput: (state, input) => {
          if (input.from === 'held') {
            const { busy = [], backoff } = input.value.value ?? {}
            return { state: { ...state, busy, backoff } }
          }
          if (input.from === 'positions') {
            const read = input.value.value ?? UNREAD
            const changed = state.changed || read !== state.positions
            return { state: { ...state, positions: read, changed } }
          }
          if (input.from === 'quotes') {
            const read = input.value.value ?? UNREAD
            const changed = state.changed || read !== state.quotes
            return { state: { ...state, quotes: read, changed } }
          }
          const write = input.value
          const landed = write.coverage === 'carried' ? Object.keys(write.entries) : []
          return {
            state: { ...state, quoting: state.quoting.filter(key => !landed.includes(key)) }
          }
        },
        afterInputs: (state, stamp) => {
          if (!state.changed) return { state }
          const due = quotesDue(state.positions, state.quotes, {
            held: [...state.quoting, ...state.busy],
            ...(state.backoff && { backoff: state.backoff }),
            slots: settings.venue.concurrency - state.quoting.length,
            now: stamp.at
          })
          return {
            state: {
              ...state,
              quoting: [...state.quoting, ...due.map(({ key }) => key)],
              changed: false
            },
            emit: due.map(request => emitTo(requests, request))
          }
        }
      })
      s.effect('read', {
        requests: { request: every(requests) },
        samples: { positions, quotes, backoff: backoff.state },
        results: writes,
        lane: lane('venue', { ...settings.venue, queue: settings.venue.concurrency }),
        handle: async ({ value: request }, context) => {
          const startedAt = context.now()
          // A preparation may back the key off while its quote waits for the venue budget.
          const quote = isBackedOff(context.samples.backoff(), request.key)
            ? deferredQuote(request)
            : await readQuote(request, {
                quoteFor: deps.quoteFor,
                backoff: settings.backoff,
                timeoutMs: QUOTE_TIMEOUT_MS,
                stats,
                logger
              })
          // A route holds from when it was priced; a missing path waits its retry from when it ended.
          const expiry =
            quote.kind === 'route'
              ? startedAt + settings.quotes.validForMs
              : quote.kind === 'no_swap_path'
                ? context.now() + settings.quotes.retryMs
                : undefined
          const gone = quotesGone(context.samples.quotes(), context.samples.positions(), {
            block: request.reading.block,
            policy: settings.backoff
          }).filter(key => key !== request.key)
          context.write({
            coverage: 'carried',
            entries: { [request.key]: quote },
            absent: gone,
            basis: { observedAt: startedAt },
            ...(expiry !== undefined && { expiry })
          })
        }
      })
    })
  )
  b.sink('liquidations.log', {
    finishOnStop: true,
    on: { world: world.writes, acts: liquidations.events, backoff: backoff.events },
    samples: { sizing, view: kernel.view, backoff: backoff.state },
    handle: ({ from, value }, samples) => {
      if (from === 'world')
        return reporter.reportWorld({
          sizing: samples.sizing(),
          view: samples.view(),
          backoff: samples.backoff(),
          complete: value.coverage === 'complete' || value.coverage === 'carried'
        })
      if (from === 'acts') return logTasks(logger, value)
      logBackoff(logger, value)
    }
  })
  const live = b.raw(g =>
    declareLiveLog(g, {
      on: kernel.nodes.tick,
      show: [{ node: liquidations.phase, label: 'phase' }, kernel.health],
      run: settings.runId,
      logger
    })
  )
  return { kernel, positions, liquidatable, quotes, route, candidates, sizing, liquidations, live }
})

/**
 * Builds the liquidator from its settings, validated here, so a live run and a replay of its
 * journal build the same graph.
 * @throws InvalidSettingsError, or GraphDefinitionError for a graph the engine refuses.
 */
export const declareLiquidator = (settings: LiquidatorSettings, deps: LiquidatorDeps) =>
  declare({ settings: parseLiquidatorSettings(settings), deps })

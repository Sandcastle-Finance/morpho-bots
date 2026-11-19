import type { RunnerMeter } from '@repo/engine'
import type { KernelNodes, KernelState } from '@repo/kernel'
import type { EventLoopUtilization, IntervalHistogram } from 'node:perf_hooks'

import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks'

import type { Logger } from './logger'

import { createCpuProfiler } from './cpu-profile'

const HEALTH_INTERVAL_MS = 60_000
const TOP_NODES = 5
const NS_PER_MS = 1e6
const US_PER_MS = 1e3

/** What the process reports about itself; Node's own APIs unless a test replaces them. */
export type ProcessProbe = Readonly<{
  now: () => number
  cpu: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage
  elu: (previous?: EventLoopUtilization) => EventLoopUtilization
  heapUsed: () => number
  delay: Pick<IntervalHistogram, 'enable' | 'disable' | 'reset' | 'percentile' | 'max'>
  /** Calls `onGc` with each collection's duration in ms until the returned function is called. */
  watchGc: (onGc: (ms: number) => void) => () => void
}>

const nodeProbe = (): ProcessProbe => ({
  now: () => performance.now(),
  cpu: previous => process.cpuUsage(previous),
  elu: previous => performance.eventLoopUtilization(previous),
  heapUsed: () => process.memoryUsage().heapUsed,
  delay: monitorEventLoopDelay({ resolution: 20 }),
  watchGc: onGc => {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) onGc(entry.duration)
    })
    observer.observe({ entryTypes: ['gc'] })
    return () => observer.disconnect()
  }
})

/** A node's writes and their bytes, or an operator's runs and their inputs. */
type Cost = { count: number; size: number; ms: number }

const round = (ms: number) => Math.round(ms * 100) / 100

const add = (costs: Map<string, Cost>, key: string, size: number, ms: number) => {
  const cost = costs.get(key) ?? { count: 0, size: 0, ms: 0 }
  cost.count++
  cost.size += size
  cost.ms += ms
  costs.set(key, cost)
}

const topBy = (costs: Map<string, Cost>, field: 'ms' | 'size') =>
  [...costs].toSorted(([, left], [, right]) => right[field] - left[field]).slice(0, TOP_NODES)

const nodesBy = (costs: Map<string, Cost>, field: 'ms' | 'size') =>
  topBy(costs, field).map(([node, cost]) => ({
    node,
    writes: cost.count,
    bytes: cost.size,
    ms: round(cost.ms)
  }))

const sum = (costs: Map<string, Cost>, field: keyof Cost) =>
  [...costs.values()].reduce((total, cost) => total + cost[field], 0)

const countBy = <T>(items: Iterable<T>, key: (item: T) => string) => {
  const counts: Record<string, number> = {}
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1
  return counts
}

const census = (state: KernelState) => ({
  entries: countBy(Object.values(state.entries), entry => entry.state),
  plans: Object.keys(state.plans).length,
  headers: Object.keys(state.headers).length,
  nonces: Object.keys(state.nonces).length,
  submissions: Object.keys(state.submissions).length
})

/** What the meter counted since the last line; one is started per interval. */
const createCounters = () => ({
  steps: { count: 0, ms: 0, maxMs: 0 },
  writes: new Map<string, Cost>(),
  operators: new Map<string, Cost>(),
  roundTrips: { count: 0, bytes: 0, ms: 0 },
  journal: { encodeMs: 0, queuedBytes: 0, appended: 0, appendedBytes: 0, backlogMaxBytes: 0 },
  sink: { bytes: 0, encodeMs: 0, syncMs: 0 },
  kernelEvents: {} as Record<string, number>,
  gc: { count: 0, ms: 0 }
})

type Counters = ReturnType<typeof createCounters>

const typeOf = (event: unknown) => String((event as { type?: unknown } | undefined)?.type)

/** The kernel nodes whose writes the health line reads: its reducer's input and state. */
type KernelIds = Readonly<{ input: string; state: string }>

/** Counts into whichever counters are current, so a new interval needs only a new object. */
const countInto = (
  counters: () => Counters,
  kernel: KernelIds | undefined,
  onKernelState: (state: KernelState) => void
): Omit<RunnerMeter, 'step' | 'finish'> => ({
  write: (node, bytes, ms, value) => {
    const current = counters()
    add(current.writes, node, bytes, ms)
    if (node === kernel?.input) {
      const type = typeOf(value)
      current.kernelEvents[type] = (current.kernelEvents[type] ?? 0) + 1
    } else if (node === kernel?.state && value !== undefined) onKernelState(value as KernelState)
  },
  operator: (id, ms, inputs) => add(counters().operators, id, inputs, ms),
  roundTrip: (_node, bytes, ms) => {
    const { roundTrips } = counters()
    roundTrips.count++
    roundTrips.bytes += bytes
    roundTrips.ms += ms
  },
  journal: (stage, bytes, ms, backlogBytes) => {
    const { journal } = counters()
    journal.encodeMs += ms
    journal.backlogMaxBytes = Math.max(journal.backlogMaxBytes, backlogBytes)
    if (stage === 'queued') journal.queuedBytes += bytes
    else {
      journal.appended++
      journal.appendedBytes += bytes
    }
  },
  journalSink: cost => {
    const { sink } = counters()
    sink.bytes += cost.bytes
    sink.encodeMs += cost.encodeMs
    sink.syncMs += cost.syncMs
  }
})

const lineOf = (
  finished: Counters,
  spent: Readonly<{ intervalMs: number; cpu: NodeJS.CpuUsage; elu: number }>,
  probe: ProcessProbe,
  kernel: Readonly<{ ids?: KernelIds; state?: KernelState }>
) => {
  const reduced = kernel.ids && finished.operators.get(kernel.ids.state)
  return {
    intervalMs: Math.round(spent.intervalMs),
    cpuUserMs: Math.round(spent.cpu.user / US_PER_MS),
    cpuSystemMs: Math.round(spent.cpu.system / US_PER_MS),
    elu: round(spent.elu),
    delayP50Ms: round(probe.delay.percentile(50) / NS_PER_MS),
    delayP99Ms: round(probe.delay.percentile(99) / NS_PER_MS),
    delayMaxMs: round(probe.delay.max / NS_PER_MS),
    gcCount: finished.gc.count,
    gcMs: round(finished.gc.ms),
    heapUsedBytes: probe.heapUsed(),
    steps: finished.steps.count,
    stepMs: round(finished.steps.ms),
    stepMaxMs: round(finished.steps.maxMs),
    writes: sum(finished.writes, 'count'),
    writeBytes: sum(finished.writes, 'size'),
    writeMs: round(sum(finished.writes, 'ms')),
    nodesByMs: nodesBy(finished.writes, 'ms'),
    nodesByBytes: nodesBy(finished.writes, 'size'),
    operatorsByMs: topBy(finished.operators, 'ms').map(([operator, cost]) => ({
      operator,
      runs: cost.count,
      inputs: cost.size,
      ms: round(cost.ms)
    })),
    roundTrips: finished.roundTrips.count,
    roundTripBytes: finished.roundTrips.bytes,
    roundTripMs: round(finished.roundTrips.ms),
    journalEncodeMs: round(finished.journal.encodeMs),
    journalQueuedBytes: finished.journal.queuedBytes,
    journalAppended: finished.journal.appended,
    journalAppendedBytes: finished.journal.appendedBytes,
    journalBacklogMaxBytes: finished.journal.backlogMaxBytes,
    journalSinkBytes: finished.sink.bytes,
    journalSinkEncodeMs: round(finished.sink.encodeMs),
    journalSyncMs: round(finished.sink.syncMs),
    reduceMs: round(reduced?.ms ?? 0),
    reduceEvents: reduced?.size ?? 0,
    kernelEvents: finished.kernelEvents,
    ...(kernel.state && { kernel: census(kernel.state) })
  }
}

/**
 * A runner meter that logs `process.health` every {@link HEALTH_INTERVAL_MS} from the run's first
 * step until it finishes. `CPU_PROFILE=on` in `env` adds {@link createCpuProfiler}. Nothing here
 * throws into the bot.
 */
export const createHealthMeter = (deps: {
  logger: Logger
  kernel?: Pick<KernelNodes, 'input' | 'state'>
  env?: Record<string, string | undefined>
  probe?: ProcessProbe
  intervalMs?: number
}): RunnerMeter => {
  const { logger } = deps
  const probe = deps.probe ?? nodeProbe()
  const profiling = (deps.env ?? process.env).CPU_PROFILE?.trim()
  const profiler = profiling === 'on' ? createCpuProfiler({ logger }) : undefined
  const ids = deps.kernel && { input: deps.kernel.input.id, state: deps.kernel.state.id }
  let counters = createCounters()
  let kernelState: KernelState | undefined
  let lifecycle: 'idle' | 'running' | 'finished' = 'idle'
  let timer: ReturnType<typeof setInterval> | undefined
  let stopGc: (() => void) | undefined
  let since = { at: 0, cpu: { user: 0, system: 0 }, elu: probe.elu() }

  const report = () => {
    const finished = counters
    counters = createCounters()
    const at = probe.now()
    const cpu = probe.cpu(since.cpu)
    const elu = probe.elu(since.elu)
    const intervalMs = at - since.at
    since = { at, cpu: probe.cpu(), elu: probe.elu() }
    logger.info(
      'process.health',
      lineOf(finished, { intervalMs, cpu, elu: elu.utilization }, probe, {
        ...(ids && { ids }),
        ...(kernelState && { state: kernelState })
      })
    )
    probe.delay.reset()
  }
  const tick = () => {
    try {
      report()
    } catch {
      // A health line is best-effort and must never reach the bot.
    }
  }
  const start = () => {
    lifecycle = 'running'
    since = { at: probe.now(), cpu: probe.cpu(), elu: probe.elu() }
    probe.delay.enable()
    stopGc = probe.watchGc(ms => {
      counters.gc.count++
      counters.gc.ms += ms
    })
    timer = setInterval(tick, deps.intervalMs ?? HEALTH_INTERVAL_MS).unref()
    profiler?.start()
  }

  if (profiling && profiling !== 'on')
    logger.warn('health.misconfigured', { detail: 'CPU_PROFILE must be "on" or unset' })
  return {
    ...countInto(
      () => counters,
      ids,
      state => (kernelState = state)
    ),
    step: ms => {
      if (lifecycle === 'idle') start()
      const { steps } = counters
      steps.count++
      steps.ms += ms
      steps.maxMs = Math.max(steps.maxMs, ms)
    },
    finish: () => {
      const wasRunning = lifecycle === 'running'
      lifecycle = 'finished'
      if (!wasRunning) return
      clearInterval(timer)
      stopGc?.()
      probe.delay.disable()
      profiler?.stop()
    }
  }
}

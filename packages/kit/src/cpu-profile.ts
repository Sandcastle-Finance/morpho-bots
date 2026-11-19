import type { Profiler } from 'node:inspector'
import type { IntervalHistogram } from 'node:perf_hooks'

import { Session } from 'node:inspector/promises'
import { monitorEventLoopDelay } from 'node:perf_hooks'

import type { Logger } from './logger'

const PROFILE_WINDOW_MS = 10_000
const PROFILE_EVERY_MS = 15 * 60_000
const PROFILE_COOLDOWN_MS = 5 * 60_000
const DELAY_CHECK_MS = 5_000
const DELAY_THRESHOLD_MS = 200
const SAMPLING_INTERVAL_US = 1_000
const TOP_FRAMES = 15
const NS_PER_MS = 1e6

/** One function's self time in a profile: its name and script file, never arguments or data. */
type ProfileFrame = Readonly<{ fn: string; file: string; selfMs: number }>

/** What a frame from a `data:`, `blob:`, remote or other non-file script is logged as. */
const OTHER_SCRIPT = '(other)'

/** A script's file name, from a file or Node-internal URL only, so no query or inline source leaks. */
const fileOf = (url: string) => {
  const path = url.split(/[?#]/, 1)[0]!
  const scheme = /^([a-z][\w+.-]*):/i.exec(path)?.[1]?.toLowerCase()
  if (scheme !== undefined && scheme !== 'file' && scheme !== 'node') return OTHER_SCRIPT
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * The `top` functions by self time in a V8 CPU profile, each sample charged the time since the one
 * before it.
 */
export const summarizeProfile = (profile: Profiler.Profile, top = TOP_FRAMES) => {
  const byNode = new Map(profile.nodes.map(node => [node.id, node.callFrame]))
  const selfUs = new Map<string, { fn: string; file: string; us: number }>()
  const samples = profile.samples ?? []
  for (const [index, id] of samples.entries()) {
    const frame = byNode.get(id)
    if (!frame) continue
    const fn = frame.functionName || '(anonymous)'
    const file = fileOf(frame.url)
    const key = `${fn}\u0000${file}`
    const entry = selfUs.get(key) ?? { fn, file, us: 0 }
    entry.us += profile.timeDeltas?.[index] ?? 0
    selfUs.set(key, entry)
  }
  const frames: ProfileFrame[] = [...selfUs.values()]
    .toSorted((left, right) => right.us - left.us)
    .slice(0, top)
    .map(({ fn, file, us }) => ({ fn, file, selfMs: Math.round(us / 100) / 10 }))
  return {
    samples: samples.length,
    totalMs: Math.round((profile.endTime - profile.startTime) / 1_000),
    top: frames
  }
}

/** The inspector calls a profile makes: Node's own session unless a test replaces it. */
type ProfilerSession = Readonly<{
  connect: () => void
  post: (method: string, params?: object) => Promise<unknown>
  disconnect: () => void
}>

const inspectorSession = (): ProfilerSession => {
  const session = new Session()
  const post = session.post.bind(session) as (method: string, params?: object) => Promise<unknown>
  return { connect: () => session.connect(), post, disconnect: () => session.disconnect() }
}

/** Waits `ms`, or until `signal` aborts, leaving no listener on it either way. */
const waitWindow = (ms: number, signal: AbortSignal) =>
  new Promise<void>(resolve => {
    if (signal.aborted) return resolve()
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

/** Records one CPU profile of this isolate for `windowMs`, or until `signal` aborts. */
const recordProfile = async (session: ProfilerSession, windowMs: number, signal: AbortSignal) => {
  session.connect()
  try {
    await session.post('Profiler.enable')
    await session.post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US })
    await session.post('Profiler.start')
    await waitWindow(windowMs, signal)
    const { profile } = (await session.post('Profiler.stop')) as { profile: Profiler.Profile }
    return profile
  } finally {
    session.disconnect()
  }
}

type ProfileReason = 'schedule' | 'delay'

/**
 * A bounded CPU profiler: a fixed window every {@link PROFILE_EVERY_MS}, and one when the event
 * loop stalls past {@link DELAY_THRESHOLD_MS}, never closer than {@link PROFILE_COOLDOWN_MS} apart.
 * Each profile is logged as `process.profile`; any failure is logged by name and never thrown.
 */
export const createCpuProfiler = (deps: {
  logger: Logger
  session?: () => ProfilerSession
  delay?: Pick<IntervalHistogram, 'enable' | 'disable' | 'reset' | 'max'>
  now?: () => number
}) => {
  const session = deps.session ?? inspectorSession
  const now = deps.now ?? Date.now
  const delay = deps.delay ?? monitorEventLoopDelay({ resolution: 20 })
  const stopping = new AbortController()
  const timers: ReturnType<typeof setInterval>[] = []
  let running = false
  let lastAt = Number.NEGATIVE_INFINITY

  const profile = async (reason: ProfileReason) => {
    if (running || stopping.signal.aborted || now() - lastAt < PROFILE_COOLDOWN_MS) return
    running = true
    lastAt = now()
    try {
      const recorded = await recordProfile(session(), PROFILE_WINDOW_MS, stopping.signal)
      deps.logger.info('process.profile', { reason, ...summarizeProfile(recorded) })
    } catch (error) {
      try {
        deps.logger.warn('process.profile_failed', {
          reason,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      } catch {
        // A failing logger must not reach the bot.
      }
    } finally {
      running = false
    }
  }
  const checkDelay = () => {
    try {
      const stalled = delay.max / NS_PER_MS >= DELAY_THRESHOLD_MS
      delay.reset()
      if (stalled) void profile('delay')
    } catch {
      // Profiling is best-effort and must never reach the bot.
    }
  }

  return {
    start: () => {
      if (timers.length > 0 || stopping.signal.aborted) return
      delay.enable()
      timers.push(
        setInterval(() => void profile('schedule'), PROFILE_EVERY_MS).unref(),
        setInterval(checkDelay, DELAY_CHECK_MS).unref()
      )
    },
    stop: () => {
      stopping.abort()
      for (const timer of timers) clearInterval(timer)
      delay.disable()
    }
  }
}

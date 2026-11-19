import type { Profiler } from 'node:inspector'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Logger } from '../src/logger'

import { createCpuProfiler, summarizeProfile } from '../src/cpu-profile'
import { about, leaves, lists } from './log-values'

const frame = (functionName: string, url: string) => ({
  functionName,
  url,
  scriptId: '0',
  lineNumber: 0,
  columnNumber: 0
})

const profile: Profiler.Profile = {
  nodes: [
    { id: 1, callFrame: frame('(root)', '') },
    { id: 2, callFrame: frame('encodeAt', 'file:///app/dist/src/index.js') },
    { id: 3, callFrame: frame('', 'file:///app/dist/src/index.js') },
    { id: 4, callFrame: frame('(garbage collector)', '') },
    { id: 5, callFrame: frame('encodeAt', 'file:///app/other.js') },
    { id: 6, callFrame: frame('leak', 'file:///app/dist/src/index.js?token=SECRET#frag') },
    { id: 7, callFrame: frame('inline', 'data:text/javascript,run("SECRET")') },
    { id: 8, callFrame: frame('remote', 'https://example.com/a.js?key=SECRET') }
  ],
  startTime: 0,
  endTime: 10_000,
  samples: [2, 2, 3, 4, 2, 5, 6, 7, 8],
  timeDeltas: [1_000, 2_000, 500, 3_000, 1_500, 250, 100, 100, 100]
}

const lines = () => {
  const logged: Record<string, unknown>[] = []
  const log = (_event: string, fields: Record<string, unknown> = {}) => void logged.push(fields)
  const logger: Logger = { debug: log, info: log, warn: log, error: log }
  return { logger, logged }
}

const equalSets = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length && right.every(value => left.includes(value))

const stalledLoop = () => ({
  enable: () => true,
  disable: () => true,
  reset: vi.fn(),
  max: 500e6
})

describe('summarizeProfile', () => {
  it('names a script by its file alone, and any non-file script by a placeholder', () => {
    const summary = summarizeProfile(profile)
    expect(about(summary, 'leak')).toEqual([expect.arrayContaining(['index.js'])])
    expect(about(summary, 'inline')).toEqual([expect.arrayContaining(['(other)'])])
    expect(about(summary, 'remote')).toEqual([expect.arrayContaining(['(other)'])])
    expect(JSON.stringify(summary)).not.toContain('SECRET')
  })

  it('ranks functions by self time, by name and script file only', () => {
    const summary = summarizeProfile(profile, 3)
    const ranked = [
      ['encodeAt', 'index.js', 4.5],
      ['(garbage collector)', '', 3],
      ['(anonymous)', 'index.js', 0.5]
    ]
    expect(lists(summary).map(list => list.map(leaves))).toEqual([
      ranked.map(frame => expect.toSatisfy((values: unknown[]) => equalSets(values, frame)))
    ])
    expect(leaves(summary)).toEqual(expect.arrayContaining([9, 10]))
  })
})

/** An inspector session that answers every call, and `Profiler.stop` with `stop`. */
const fakeSession = (stop: () => Promise<unknown> = async () => ({ profile })) => {
  const posted: string[] = []
  const gates = new Map<string, Promise<void>>()
  const session = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    post: vi.fn(async (method: string) => {
      posted.push(method)
      await gates.get(method)
      return method === 'Profiler.stop' ? stop() : {}
    })
  }
  return { session, posted, gates }
}

/** Counts `abort` listeners added and removed on any signal. */
const abortListeners = () => {
  const add = vi.spyOn(EventTarget.prototype, 'addEventListener')
  const remove = vi.spyOn(EventTarget.prototype, 'removeEventListener')
  const count = (spy: typeof add) => spy.mock.calls.filter(([type]) => type === 'abort').length
  return () => count(add) - count(remove)
}

describe('createCpuProfiler', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('profiles a window when the loop stalls, then not again inside the cooldown', async () => {
    vi.useFakeTimers()
    const { logger, logged } = lines()
    const fake = fakeSession()
    const listening = abortListeners()
    const profiler = createCpuProfiler({
      logger,
      session: () => fake.session,
      delay: stalledLoop(),
      now: Date.now
    })
    profiler.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fake.posted).toStrictEqual([
      'Profiler.enable',
      'Profiler.setSamplingInterval',
      'Profiler.start'
    ])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.posted.at(-1)).toBe('Profiler.stop')
    expect(fake.session.disconnect).toHaveBeenCalledOnce()
    expect(listening()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    profiler.stop()
    expect(fake.session.connect).toHaveBeenCalledOnce()
    expect(logged).toHaveLength(1)
    expect(equalSets(leaves(logged[0]), ['delay', ...leaves(summarizeProfile(profile))])).toBe(true)
  })

  it('ends a recording at once when stopped while the inspector is still starting', async () => {
    vi.useFakeTimers()
    const { logger } = lines()
    const fake = fakeSession()
    let release = () => {}
    fake.gates.set('Profiler.start', new Promise<void>(resolve => (release = resolve)))
    const listening = abortListeners()
    const profiler = createCpuProfiler({
      logger,
      session: () => fake.session,
      delay: stalledLoop(),
      now: Date.now
    })
    profiler.start()
    await vi.advanceTimersByTimeAsync(5_000)
    profiler.stop()
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.posted.at(-1)).toBe('Profiler.stop')
    expect(fake.session.disconnect).toHaveBeenCalledOnce()
    expect(listening()).toBe(0)
  })

  it('swallows a profiling failure, logging only its name', async () => {
    vi.useFakeTimers()
    const { logger, logged } = lines()
    const fake = fakeSession(async () => {
      throw new TypeError('inspector unavailable at /secret/path')
    })
    const profiler = createCpuProfiler({
      logger,
      session: () => fake.session,
      delay: stalledLoop(),
      now: Date.now
    })
    profiler.start()
    await vi.advanceTimersByTimeAsync(15_000)
    profiler.stop()
    expect(fake.session.disconnect).toHaveBeenCalledOnce()
    expect(logged).toHaveLength(1)
    expect(equalSets(leaves(logged[0]), ['delay', 'TypeError'])).toBe(true)
  })
})

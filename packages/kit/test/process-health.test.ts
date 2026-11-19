import type { KernelNodes, KernelState, Validator } from '@repo/kernel'

import { createGraph, createRunner } from '@repo/engine'
import { declareKernel } from '@repo/kernel'
import { FakeChain, MemoryStore } from '@repo/kernel/testing'
import { isDeepStrictEqual } from 'node:util'
import { base } from 'viem/chains'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Logger } from '../src/logger'
import type { ProcessProbe } from '../src/process-health'

import { createHealthMeter } from '../src/process-health'
import { transactionKernelConfig } from '../src/transaction-kernel'
import { about, leaves, lists, objects } from './log-values'

const lines = (snapshot: () => unknown = () => undefined) => {
  const logged: { fields: Record<string, unknown>; at: unknown }[] = []
  const log = (_event: string, fields: Record<string, unknown> = {}) =>
    void logged.push({ fields, at: snapshot() })
  const logger: Logger = { debug: log, info: log, warn: log, error: log }
  return { logger, health: () => logged.map(({ fields }) => fields), logged }
}

/** A process whose clock, CPU, loop and collector move only when the test moves them. */
const fakeProcess = () => {
  const clock = { at: 0, cpuUs: 0, active: 0 }
  let onGc: (ms: number) => void = () => undefined
  const stopGc = vi.fn()
  const delay = {
    enable: vi.fn(() => true),
    disable: vi.fn(() => true),
    reset: vi.fn(),
    percentile: (p: number) => (p === 50 ? 2.37e6 : 9.41e6),
    max: 30.5e6
  }
  const probe: ProcessProbe = {
    now: () => clock.at,
    cpu: previous => ({
      user: clock.cpuUs - (previous?.user ?? 0),
      system: clock.cpuUs / 2 - (previous?.system ?? 0)
    }),
    elu: previous => {
      const active = clock.active - (previous?.active ?? 0)
      const idle = clock.at - clock.active - (previous?.idle ?? 0)
      return { active, idle, utilization: active / (active + idle) }
    },
    heapUsed: () => 64_123_456,
    delay,
    watchGc: listener => {
      onGc = listener
      return () => {
        stopGc()
        onGc = () => undefined
      }
    }
  }
  const pass = (ms: number, cpuMs: number) => {
    clock.at += ms
    clock.active += cpuMs
    clock.cpuUs += cpuMs * 1_000
  }
  return { probe, pass, gc: (ms: number) => onGc(ms), delay, stopGc }
}

const keyed = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [i, {}]))

const kernelState = {
  entries: {
    a: { state: 'live' },
    b: { state: 'retired' },
    c: { state: 'retired' }
  },
  plans: keyed(13),
  headers: keyed(11),
  nonces: keyed(17),
  submissions: keyed(19),
  lastDurable: 'ab'.repeat(32)
} as unknown as KernelState
const census = [13, 11, 17, 19]

/** Node handles as `declareKernel` returns them, under the ids a bot's own scope gave them. */
const kernelIds = { input: { id: 'bot.kernel.in' }, state: { id: 'bot.kernel.state' } } as Pick<
  KernelNodes,
  'input' | 'state'
>

const declareScopedKernel = (chain: FakeChain) => {
  const g = createGraph('health')
  const kernel = g.scope('bot', scope =>
    declareKernel(scope, {
      config: transactionKernelConfig(
        {
          chainId: base.id,
          targets: [],
          maxSpendWei: 1n,
          stuckMs: 60_000,
          maxEvidenceAgeBlocks: 10
        },
        base,
        '0x0000000000000000000000000000000000000001',
        { id: 'test-validator' } as unknown as Validator
      ),
      store: new MemoryStore(),
      chain,
      effects: chain.effects,
      enrollment: 'enrolling',
      pollMs: 5,
      effectTimeoutMs: 1_000,
      reorgDepth: 16,
      onError: () => undefined
    })
  )
  return { g, kernel }
}

describe('createHealthMeter', () => {
  afterEach(() => vi.useRealTimers())

  it('reports what the process and the run spent each minute, from a fresh count each time', () => {
    vi.useFakeTimers()
    const { logger, health: logged } = lines()
    const process = fakeProcess()
    const meter = createHealthMeter({ logger, probe: process.probe, env: {}, kernel: kernelIds })
    meter.step(3.25)
    meter.step(5.5)
    meter.write('bot.kernel.in', 10, 0.5, { type: 'Head' })
    meter.write('bot.kernel.in', 10, 0.5, { type: 'Head' })
    meter.write('bot.kernel.in', 8, 0.25, { type: 'Tick' })
    meter.write('bot.kernel.state', 900, 2, kernelState)
    meter.operator('bot.kernel.state', 4.5, 7)
    meter.roundTrip('bot.kernel.requests', 12, 1)
    meter.journal('queued', 50, 0.5, 50)
    meter.journal('appended', 40, 0.5, 90)
    meter.journalSink({ bytes: 41, encodeMs: 0.75, syncMs: 6 })
    process.gc(1.5)
    process.pass(60_000, 30_000)
    vi.advanceTimersByTime(60_000)

    const spent = [60_000, 30_000, 15_000, 0.5, 2.37, 9.41, 30.5, 1.5, 64_123_456]
    const counted = [8.75, 5.5, 928, 3.25, 12, 50, 40, 90, 41, 0.75, 6]
    expect(logged()).toHaveLength(1)
    const [first] = logged()
    expect(leaves(first)).toEqual(expect.arrayContaining([...spent, ...counted, ...census]))
    expect(about(first, 'bot.kernel.state')).toContainEqual(expect.arrayContaining([1, 900, 2]))
    expect(about(first, 'bot.kernel.in')).toContainEqual(expect.arrayContaining([3, 28, 1.25]))
    expect(about(first, 'bot.kernel.state')).toContainEqual(expect.arrayContaining([1, 7, 4.5]))
    expect(leaves(first).filter(value => value === 4.5 || value === 7)).toHaveLength(4)
    const nodeIds = new Set<unknown>(['bot.kernel.state', 'bot.kernel.in'])
    expect(
      lists(first).map(list => list.flatMap(leaves).filter(value => nodeIds.has(value)))
    ).toContainEqual(['bot.kernel.state', 'bot.kernel.in'])
    expect(objects(first)).toContainEqual({ Head: 2, Tick: 1 })
    expect(objects(first)).toContainEqual({ live: 1, retired: 2 })
    expect(process.delay.reset).toHaveBeenCalledOnce()

    process.pass(60_000, 6_000)
    vi.advanceTimersByTime(60_000)
    const second = logged()[1]
    expect(leaves(second)).toEqual(expect.arrayContaining([60_000, 6_000, 0.1, ...census]))
    for (const value of [...counted, 900, 28, 1.25, 4.5, 7, 1.5, 'bot.kernel.in'])
      expect(leaves(second)).not.toContain(value)
    expect(objects(second)).not.toContainEqual({ Head: 2, Tick: 1 })
    expect(objects(second)).toContainEqual({ live: 1, retired: 2 })
  })

  it('stays idle until the run steps, and leaves nothing running once it finishes', () => {
    vi.useFakeTimers()
    const { logger, health: logged } = lines()
    const process = fakeProcess()
    const meter = createHealthMeter({ logger, probe: process.probe, env: {} })
    vi.advanceTimersByTime(120_000)
    expect(vi.getTimerCount()).toBe(0)
    meter.step(1)
    expect(vi.getTimerCount()).toBe(1)
    meter.finish()
    vi.advanceTimersByTime(120_000)
    expect(logged()).toStrictEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(process.stopGc).toHaveBeenCalledOnce()
    expect(process.delay.disable).toHaveBeenCalledOnce()
  })

  it('counts the events and the census of a scoped kernel, and stops when the run is abandoned', async () => {
    let read: (() => KernelState | undefined) | undefined
    const { logger, health, logged } = lines(() => read?.())
    const process = fakeProcess()
    const chain = new FakeChain()
    const { g, kernel } = declareScopedKernel(chain)
    const measured = createHealthMeter({
      logger,
      probe: process.probe,
      env: {},
      kernel: kernel.nodes,
      intervalMs: 20
    })
    const reduced: number[] = []
    const meter: typeof measured = {
      ...measured,
      operator: (id, ms, inputs) => {
        if (id === kernel.nodes.state.id) reduced.push(inputs)
        measured.operator(id, ms, inputs)
      }
    }
    const runner = createRunner(g.build(), {
      meter,
      journal: {
        sink: { append: async () => undefined, finalize: async () => undefined },
        capacityBytes: 16_000_000
      }
    })
    read = () => runner.read(kernel.nodes.state)
    await kernel.start(runner)
    await vi.waitFor(() => {
      expect(health().flatMap(objects)).toContainEqual(expect.objectContaining({ Start: 1 }))
      const censused = logged.filter(({ at }) => at !== undefined)
      expect(censused.length).toBeGreaterThan(0)
      for (const { fields, at } of censused) {
        const state = at as KernelState
        const byState: Record<string, number> = {}
        for (const { state: kind } of Object.values(state.entries))
          byState[kind] = (byState[kind] ?? 0) + 1
        const counts = [state.plans, state.headers, state.nonces, state.submissions].map(
          record => Object.keys(record).length
        )
        const carriesCensus = (values: unknown[]) =>
          [byState, ...counts].every(expected =>
            values.some(value => isDeepStrictEqual(value, expected))
          )
        expect(objects(fields).map(Object.values).some(carriesCensus)).toBe(true)
      }
      expect(reduced.some(inputs => inputs > 0)).toBe(true)
    })
    expect(kernel.nodes.input.id).toBe('bot.kernel.in')
    await runner.abandon()
    const after = health().length
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(health()).toHaveLength(after)
    expect(process.stopGc).toHaveBeenCalledOnce()
    expect(process.delay.disable).toHaveBeenCalledOnce()
  })
})

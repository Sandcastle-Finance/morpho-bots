import type { KernelState } from '@repo/kernel'
import type { Hex } from 'viem'

import { midnightCommitmentId } from '@repo/validators'
import { describe, expect, it, vi } from 'vitest'

import type { MonitoringEvent } from '../../../src/application/monitoring/monitoring-event'

import {
  createRetiredIndexedLog,
  RETIRED_INDEXED_INTERVAL_MS
} from '../../../src/infrastructure/kernel/retired-indexed'

const BLOCK_TIME_MS = 2_000
const group = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`

type Held = Readonly<{ group: Hex; state: string; retiredBy?: string; retiredAt?: number }>

const stateAt = (head: number, entries: readonly Held[]) =>
  ({
    head: { number: head, hash: '0x', timestamp: 0n },
    entries: Object.fromEntries(
      entries.map(({ group: g, ...entry }) => [
        midnightCommitmentId(g),
        { spec: { id: midnightCommitmentId(g) }, ...entry }
      ])
    )
  }) as unknown as KernelState

/** What a line reports, whatever its field names. */
const reported = (events: readonly MonitoringEvent[]) => events.map(event => Object.values(event))

const harness = () => {
  let clock = 0
  const written: MonitoringEvent[] = []
  const observe = createRetiredIndexedLog({
    blockTimeMs: BLOCK_TIME_MS,
    now: () => clock,
    write: event => void written.push(event)
  })
  return {
    written,
    observe,
    advance: (ms: number) => (clock += ms)
  }
}

describe('createRetiredIndexedLog', () => {
  it('ages every retirement path from the head it retired at', () => {
    const { observe, written } = harness()
    const retirements = ['expired', 'filled', 'neutralized', 'creator did not execute']
    const state = stateAt(
      1_000,
      retirements.map((retiredBy, i) => ({
        group: group(i + 1),
        state: 'retired',
        retiredBy,
        retiredAt: 900 - i * 100
      }))
    )
    for (const [i] of retirements.entries()) {
      const { observe: one, written: alone } = harness()
      one(state, [group(i + 1)])
      const blocks = 100 + i * 100
      expect(reported(alone)).toEqual([
        expect.arrayContaining([1, blocks, (blocks * BLOCK_TIME_MS) / 1_000])
      ])
    }
    observe(
      state,
      [...retirements.keys()].map(i => group(i + 1).toUpperCase() as Hex)
    )
    expect(reported(written)).toEqual([expect.arrayContaining([4, 400, 800])])
  })

  it('logs at most once an interval, carrying the most and the oldest seen in it', () => {
    const { observe, written, advance } = harness()
    const state = stateAt(1_000, [
      { group: group(1), state: 'retired', retiredAt: 990 },
      { group: group(2), state: 'retired', retiredAt: 500 },
      { group: group(3), state: 'retired', retiredAt: 980 }
    ])
    observe(state, [group(1)])
    advance(RETIRED_INDEXED_INTERVAL_MS / 3)
    observe(state, [group(2)])
    advance(RETIRED_INDEXED_INTERVAL_MS / 3)
    observe(state, [group(1), group(3)])
    expect(written).toHaveLength(1)
    advance(RETIRED_INDEXED_INTERVAL_MS / 3)
    observe(state, [])
    expect(reported(written)).toEqual([
      expect.arrayContaining([1, 10, 20]),
      expect.arrayContaining([2, 500, 1_000])
    ])
    advance(RETIRED_INDEXED_INTERVAL_MS)
    observe(state, [])
    expect(written).toHaveLength(2)
  })

  it('logs nothing while the index lists no retired group', () => {
    const { observe, written, advance } = harness()
    const state = stateAt(1_000, [
      { group: group(1), state: 'retired', retiredAt: 900 },
      { group: group(2), state: 'live' }
    ])
    for (const listed of [[], [group(2)], [group(3)]]) {
      observe(state, listed)
      observe(undefined, [group(1)])
      advance(RETIRED_INDEXED_INTERVAL_MS)
    }
    expect(written).toStrictEqual([])
  })

  it('consumes a rejected asynchronous write without failing the read', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      let writes = 0
      const write = async () => {
        writes++
        throw new Error('sink rejected')
      }
      const observe = createRetiredIndexedLog({ blockTimeMs: BLOCK_TIME_MS, now: () => 0, write })
      const state = stateAt(1_000, [{ group: group(1), state: 'retired', retiredAt: 900 }])
      expect(observe(state, [group(1)])).toBeUndefined()
      for (let i = 0; i < 2; i++) await new Promise(resolve => setImmediate(resolve))
      expect(writes).toBe(1)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

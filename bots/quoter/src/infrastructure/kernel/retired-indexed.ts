import type { KernelState } from '@repo/kernel'
import type { Hex } from 'viem'

import { midnightCommitmentId } from '@repo/validators'

import type { MonitoringEvent } from '../../application/monitoring/monitoring-event'

export const RETIRED_INDEXED_INTERVAL_MS = 60_000

type RetiredIndexed = Extract<MonitoringEvent, { event: 'kernel.retired-indexed' }>
type Seen = Readonly<{ count: number; maxBlocks: number }>

const retiredAmong = (state: KernelState | undefined, indexedGroupIds: readonly Hex[]): Seen => {
  const head = state?.head?.number
  let count = 0
  let maxBlocks = 0
  if (!state || head === undefined) return { count, maxBlocks }
  for (const id of new Set(indexedGroupIds.map(midnightCommitmentId))) {
    const entry = state.entries[id]
    if (entry?.state !== 'retired') continue
    count++
    maxBlocks = Math.max(maxBlocks, head - (entry.retiredAt ?? head))
  }
  return { count, maxBlocks }
}

/**
 * Observes each read of the maker's indexed groups and logs, at most once per
 * {@link RETIRED_INDEXED_INTERVAL_MS}, the most groups one read listed that the kernel holds retired
 * and the oldest of their retirements over that interval; nothing when none was. Never throws.
 * @param options - The chain's block time, a clock, and the sink a line goes to; a rejected write
 * is consumed.
 * @returns An observer to call with the kernel's state and the group ids each index read listed.
 */
export const createRetiredIndexedLog = (options: {
  blockTimeMs: number
  now: () => number
  write: (event: RetiredIndexed) => void | Promise<void>
}) => {
  let loggedAt = -Infinity
  let seen: Seen | undefined
  return (state: KernelState | undefined, indexedGroupIds: readonly Hex[]) => {
    try {
      const read = retiredAmong(state, indexedGroupIds)
      if (read.count > 0)
        seen = {
          count: Math.max(read.count, seen?.count ?? 0),
          maxBlocks: Math.max(read.maxBlocks, seen?.maxBlocks ?? 0)
        }
      const at = options.now()
      if (seen === undefined || at - loggedAt < RETIRED_INDEXED_INTERVAL_MS) return
      const { count, maxBlocks } = seen
      seen = undefined
      loggedAt = at
      void Promise.resolve(
        options.write({
          event: 'kernel.retired-indexed',
          count,
          maxBlocksSinceRetired: maxBlocks,
          maxSecondsSinceRetired: (maxBlocks * options.blockTimeMs) / 1_000
        })
      ).catch(() => {})
    } catch {
      // Observing a read must never fail it.
    }
  }
}

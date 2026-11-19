/**
 * Consecutive charged poll intervals tolerated for one market before monitoring halts.
 * @remarks A handled failure is retried, but it can leave the previous offers live, so this bounds
 * how long stale quotes may stay up before shutdown cleanup cancels them: roughly five minutes at a
 * sixty-second poll. A market omitted from every report in an interval is not charged for it.
 */
export const MARKET_FAILURE_BUDGET_CYCLES = 5

/** Each market's consecutive charged poll intervals, and the poll tick it was last charged in. */
export type FailureCounts = Readonly<
  Record<string, Readonly<{ failures: number; charged?: number }>>
>

/**
 * Counts reports into each market's run of consecutive handled failures, charging a market at most
 * once per poll tick. Markets absent from the reports keep their running count; any other status
 * clears it, unless the market is listed as unresolved.
 * @param counts - Each market's consecutive failures before these reports.
 * @param results - Each reported market's status.
 * @returns The next counts.
 */
export const countFailures = (
  counts: FailureCounts,
  results: readonly { marketId: string; status: string }[],
  {
    tick,
    unresolved = new Set()
  }: {
    /** The ordinal of the poll tick the reports belong to. */
    tick: number
    /** Markets whose last failed act is still unresolved; they count as failing. */
    unresolved?: ReadonlySet<string>
  }
): FailureCounts => {
  const next = { ...counts }
  for (const { marketId, status } of results) {
    const last = next[marketId]
    if (status !== 'failed' && !unresolved.has(marketId)) next[marketId] = { ...last, failures: 0 }
    else if (last?.charged === undefined || tick > last.charged)
      next[marketId] = { failures: (last?.failures ?? 0) + 1, charged: tick }
  }
  return next
}

/**
 * Whether any market's run of failures reached `limit`.
 * @param counts - Each market's consecutive charged poll intervals.
 * @param limit - Charged intervals that exhaust the budget.
 * @returns `true` once any market's count is at least `limit`.
 */
export const exhausted = (counts: FailureCounts, limit: number) =>
  Object.values(counts).some(({ failures }) => failures >= limit)

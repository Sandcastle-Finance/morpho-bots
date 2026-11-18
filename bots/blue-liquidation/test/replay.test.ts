import { describe, expect, it } from 'vitest'

import { NotReplayableError } from '../src/errors'
import { LIQUIDATOR_GRAPH } from '../src/graph'
import { replayGraph } from '../src/replay'
import { testSettings } from './scenario/bot'

const settings = testSettings()
const header = { graph: LIQUIDATOR_GRAPH, run: settings.runId, settings }

describe('replayGraph', () => {
  it("rebuilds the liquidator's graph from a header alone", () => {
    expect(replayGraph(header).id).toBe(LIQUIDATOR_GRAPH)
  })

  it.each([
    [{ ...header, graph: 'midnight-liquidation' }, 'another graph wrote it'],
    [{ graph: LIQUIDATOR_GRAPH, run: settings.runId }, 'its header has no settings'],
    [{ ...header, run: 'another' }, "its settings name another run than its header's"]
  ])('refuses a header it cannot rebuild the run of: %#', (refused, reason) => {
    expect(() => replayGraph(refused)).toThrow(new NotReplayableError(reason))
  })
})

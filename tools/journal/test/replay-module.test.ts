import type { JournalHeader } from '@repo/kit'

import { JOURNAL_FORMAT } from '@repo/engine'
import { JOURNAL_FILE_FORMAT } from '@repo/kit'
import { tryCatch } from '@repo/utils'
import { access, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { JournalRefusedError } from '../src/errors'
import { loadReplayModule } from '../src/replay-module'

const BOTS = new URL('../../../bots/', import.meta.url)

const hasReplayModule = async (name: string) =>
  !(await tryCatch(access(new URL(`${name}/src/replay.ts`, BOTS)))).error

const bots = await readdir(BOTS, { withFileTypes: true })
const REPLAYABLE: string[] = []
for (const entry of bots)
  if (entry.isDirectory() && (await hasReplayModule(entry.name))) REPLAYABLE.push(entry.name)

const header = (graph: string): JournalHeader => ({
  type: 'header',
  fileFormat: JOURNAL_FILE_FORMAT,
  journalFormat: JOURNAL_FORMAT,
  graph,
  run: 'run',
  startedAt: 0,
  build: { revision: 'abc123', imageTag: 'test' }
})

const refusal = (replay: () => unknown) => {
  try {
    replay()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('the replay module rebuilt a graph from a header with no settings')
}

describe('loadReplayModule', () => {
  it('finds the existing replay modules', () => {
    expect(REPLAYABLE).toEqual(expect.arrayContaining(['blue-liquidation', 'midnight-liquidation']))
  })

  it.each(['../x', 'a/b', '', 'Blue', 'a--b', '-a'])('refuses the graph id %j', async graph => {
    await expect(loadReplayModule(graph)).rejects.toThrow(
      new JournalRefusedError(`graph ${JSON.stringify(graph)} is not a bot directory name`)
    )
  })

  it('refuses a graph with no bot directory', async () => {
    await expect(loadReplayModule('no-such-bot')).rejects.toThrow(
      new JournalRefusedError(
        'no replay module for graph no-such-bot at bots/no-such-bot/src/replay.ts'
      )
    )
  })

  it.each(REPLAYABLE)("accepts only its directory name as %s's graph id", async graph => {
    const { replayGraph } = await loadReplayModule(graph)
    const own = refusal(() => replayGraph(header(graph)))
    expect(own).not.toBe(refusal(() => replayGraph(header(`${graph}-other`))))
  })
})

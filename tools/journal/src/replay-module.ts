import type { Graph } from '@repo/engine'
import type { JournalHeader } from '@repo/kit'

import { tryCatch } from '@repo/utils'
import { access } from 'node:fs/promises'

import { JournalRefusedError } from './errors'

/**
 * What a bot exports so its journals replay: the graph the header's run declared, rebuilt from the
 * settings the header records. It throws for a header it cannot rebuild a graph from.
 */
export type ReplayModule = Readonly<{ replayGraph: (header: JournalHeader) => Graph }>

const BOT_DIRECTORY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const BOTS = new URL('../../../bots/', import.meta.url)

const isReplayModule = (value: unknown): value is ReplayModule =>
  typeof value === 'object' &&
  value !== null &&
  'replayGraph' in value &&
  typeof value.replayGraph === 'function'

const exists = async (url: URL) => !(await tryCatch(access(url))).error

/** Loads `bots/<graph>/src/replay.ts`, so a bot is replayable once its graph id is its directory name. */
export const loadReplayModule = async (graph: string) => {
  if (!BOT_DIRECTORY_NAME.test(graph))
    throw new JournalRefusedError(`graph ${JSON.stringify(graph)} is not a bot directory name`)
  const url = new URL(`${graph}/src/replay.ts`, BOTS)
  if (!(await exists(url)))
    throw new JournalRefusedError(
      `no replay module for graph ${graph} at bots/${graph}/src/replay.ts`
    )
  const loaded: unknown = await import(url.href)
  if (!isReplayModule(loaded))
    throw new JournalRefusedError(`the replay module for graph ${graph} exports no replayGraph`)
  return loaded
}

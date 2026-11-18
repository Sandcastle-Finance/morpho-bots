import type { Logger } from '@repo/kit'

import { createJournalFileSink, readJournalFile } from '@repo/kit'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { superviseKernelBot } from '../src/supervise'
import { startBot, until } from './scenario/bot'

const temporary: string[] = []
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('superviseKernelBot', () => {
  it('stops the bot cleanly once its journal reaches the run cap, and drains its live log', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'blue-cap-'))
    temporary.push(directory)
    const runCapBytes = 32 * 1024
    const journal = await createJournalFileSink({
      directory,
      graph: 'blue-liquidation',
      build: { revision: 'f0f0f0', imageTag: 'cap-test' },
      capacityBytes: 1_000_000,
      runCapBytes
    })
    const bot = await startBot({ journal: journal.journal })
    await until(() => bot.state().lifecycle.kind === 'running', 'the kernel running')
    const log = () => {}
    const logger: Logger = { debug: log, info: log, warn: log, error: log }
    const flush = vi.spyOn(bot.live, 'flush')
    bot.mining(true)

    const exitCode = await superviseKernelBot(bot, journal.runCapReached, logger, () => ({}))
    bot.mining(false)

    expect(exitCode).toBe(0)
    await expect(bot.stopped).resolves.toMatchObject({ outcome: 'clean' })
    expect((await stat(journal.path)).size).toBeGreaterThanOrEqual(runCapBytes)
    expect((await Array.fromAsync(readJournalFile(journal.path))).at(-1)).toMatchObject({
      status: 'clean'
    })
    expect(flush.mock.calls).toStrictEqual([[]])
  }, 30_000)

  it('drains its live log after a failed stop too', async () => {
    const flush = vi.fn()
    const log = () => {}
    const logger: Logger = { debug: log, info: log, warn: log, error: log }
    const running = { stop: () => {}, stopped: Promise.reject(new Error('boom')), live: { flush } }
    const exitCode = await superviseKernelBot(running, new Promise(() => {}), logger, () => ({}))
    expect(exitCode).toBe(1)
    expect(flush.mock.calls).toStrictEqual([[]])
  })
})

import { decode, encode } from '@repo/engine'
import { createJournalFileSink } from '@repo/kit'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { borrowerAt, positionKey, startBot, testSettings, until } from './bot'

const REPOSITORY = fileURLToPath(new URL('../../../..', import.meta.url))
const BIN = join(REPOSITORY, 'tools/journal/src/bin.mjs')

type Run = Readonly<{ code: number; stdout: string; stderr: string }>

/** The `journal` CLI as an operator runs it, loading blue's replay module by the header's graph id. */
const journal = async (...args: string[]): Promise<Run> => {
  try {
    const { stdout, stderr } = await promisify(execFile)('node', [BIN, ...args], {
      cwd: REPOSITORY
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const { code, stdout, stderr } = error as Run
    return { code, stdout, stderr }
  }
}

/** The commit the CLI checks a journal's build against; a checkout with none can replay nothing. */
const revision = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPOSITORY,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return undefined
  }
})()

describe.skipIf(revision === undefined)('the journal CLI on a blue scenario journal', () => {
  const [first, second] = [borrowerAt(1), borrowerAt(2)]
  let directory: string
  let path: string

  beforeAll(async () => {
    const settings = testSettings()
    directory = await mkdtemp(join(tmpdir(), 'blue-journal-'))
    const created = await createJournalFileSink({
      directory,
      graph: 'blue-liquidation',
      build: {
        revision: revision!,
        imageTag: 'scenario'
      },
      capacityBytes: 10_000_000,
      runCapBytes: 1_000_000_000,
      runId: settings.runId,
      settings
    })
    path = created.path
    const bot = await startBot({ journal: created.journal, settings })
    try {
      await until(() => bot.state().lifecycle.kind === 'running', 'the kernel running')
      bot.alive.add(first)
      bot.alive.add(second)
      bot.mining(true)
      await until(() => bot.events('tx.included').length === 2, 'both liquidations')
      bot.stop()
      await bot.stopped
    } finally {
      bot.mining(false)
    }
  }, 60_000)

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('verifies every step and reports a clean end', async () => {
    const run = await journal('verify', path)

    expect(run.stderr).toBe('')
    expect(run.code).toBe(0)
    expect(run.stdout).toMatch(/^graph {4}blue-liquidation$/m)
    expect(run.stdout).toMatch(/^verified [1-9]\d* steps, /m)
    expect(run.stdout).toMatch(/^ended {4}clean at /m)
  }, 30_000)

  it("lists every change to a position's records, input and derived alike", async () => {
    const run = await journal('history', path, '--key', positionKey(first))

    expect(run.code).toBe(0)
    const changes = run.stdout.split('\n').filter(line => line.startsWith('seq '))
    expect(changes.some(line => / recorded world\.reads <- world: \{.*"entry":/.test(line))).toBe(
      true
    )
    expect(
      changes.some(line => / verified positions <- positions: \{.*"status":"present"/.test(line))
    ).toBe(true)
    expect(
      changes.some(line => / verified positions <- positions: \{.*"status":"absent"/.test(line))
    ).toBe(true)
    expect(changes.every(line => !line.includes(positionKey(second)))).toBe(true)
    expect(run.stdout).toMatch(new RegExp(`^${changes.length} changes$`, 'm'))
  }, 30_000)

  it('stops a tampered journal at its first mismatch, naming the node', async () => {
    const lines = (await readFile(path, 'utf8')).split('\n')
    const index = lines.findIndex(line => line.includes('"derived":[{'))
    const frame = decode(lines[index]!) as {
      entry: { stamp: { seq: number }; derived: { node: string; digest: string }[] }
    }
    const [tampered] = frame.entry.derived
    tampered!.digest = '0'.repeat(64)
    lines[index] = encode(frame)
    const copy = join(directory, 'tampered.journal.jsonl')
    await writeFile(copy, lines.join('\n'))

    const run = await journal('verify', copy)

    expect(run.code).toBe(1)
    expect(run.stdout).toMatch(
      new RegExp(
        `^diverged at seq ${frame.entry.stamp.seq} at \\S+, line ${index + 1}: derived writes differ$`,
        'm'
      )
    )
    expect(run.stdout).toMatch(new RegExp(`^ {2}node {6}${tampered!.node}$`, 'm'))
    expect(run.stdout).not.toMatch(/^ended /m)
  }, 30_000)
})

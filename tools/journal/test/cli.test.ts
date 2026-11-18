import type { KeyedWrite } from '@repo/engine'

import {
  createGraph,
  createRunner,
  decode,
  encode,
  every,
  keyedLevel,
  keyedMap,
  latest,
  sourceWrite
} from '@repo/engine'
import { createJournalFileSink } from '@repo/kit'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { CliDependencies } from '../src/cli'

import { main } from '../src/cli'
import { loadReplayModule } from '../src/replay-module'

const STARTED_AT = Date.UTC(2026, 10, 11, 12)

/**
 * Positions read by key, and the ones above a floor derived from them; a tally that fails on a
 * failed read, which degrades the graph to its guard, the recovery scope that logs each failure.
 */
const declare = () => {
  const g = createGraph('toy')
  const reads = g.occurrences<KeyedWrite<{ debt: number }, number>>('reads')
  const halts = g.occurrences<string>('halts')
  const floor = g.level<number>('floor')
  const positions = keyedLevel(g, 'positions', reads)
  keyedMap(
    g,
    'risky',
    positions,
    ({ debt }, _key, inputs) => (debt > inputs.floor ? debt : undefined),
    { with: { floor: latest(floor) } }
  )
  g.fold('tally', {
    reads: { read: every(reads) },
    initial: 0,
    applyInput: (count, { value }) => {
      if (value.coverage === 'failed') throw new Error('the tally failed')
      return { state: count + 1 }
    }
  })
  g.scope(
    'guard',
    s =>
      s.fold('halts', {
        reads: { halt: every(halts) },
        initial: [] as string[],
        applyInput: (log, { value }) => ({ state: [...log, value] })
      }),
    { recovery: () => (_, origin) => [sourceWrite(halts, origin)] }
  )
  return { graph: g.build(), reads, floor }
}

let directory: string
let path: string

const record = async () => {
  const created = await createJournalFileSink({
    directory,
    graph: 'toy',
    build: { revision: 'abc123', imageTag: 'test' },
    capacityBytes: 1_000_000,
    runCapBytes: 1_000_000_000,
    runId: 'run',
    now: () => STARTED_AT
  })
  const live = declare()
  let at = STARTED_AT
  const runner = createRunner(live.graph, { journal: created.journal, now: () => (at += 1_000) })
  runner.push(live.floor, { value: 5, basis: 0 })
  runner.push(live.reads, {
    coverage: 'complete',
    entries: { a: { debt: 3 }, b: { debt: 7 } },
    basis: 1
  })
  runner.push(live.reads, { coverage: 'carried', entries: { a: { debt: 9 } }, basis: 2 })
  runner.push(live.reads, { coverage: 'complete', entries: { b: { debt: 8 } }, basis: 3 })
  runner.push(live.floor, { status: 'failed', reason: 'rpc down' })
  runner.push(live.reads, { coverage: 'failed', reason: 'rpc down' })
  await runner.abandon()
  return created.path
}

const dependencies: CliDependencies = {
  load: async () => ({ replayGraph: () => declare().graph }),
  checkout: () => ({ revision: 'abc123def4567890', dirty: false }),
  stdout: () => {},
  stderr: () => {}
}

const journal = async (argv: readonly string[], overrides: Partial<CliDependencies> = {}) => {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await main(argv, {
    ...dependencies,
    ...overrides,
    stdout: line => void stdout.push(line),
    stderr: line => void stderr.push(line)
  })
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

/** A copy of the journal with its lines changed by `edit`, at a path of its own. */
const copyWith = async (name: string, edit: (lines: string[]) => string[]) => {
  const copy = join(directory, name)
  await writeFile(copy, edit((await readFile(path, 'utf8')).split('\n')).join('\n'))
  return copy
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'journal-cli-'))
  path = await record()
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('journal verify', () => {
  it('replays every step and reports how the file ended', async () => {
    expect(await journal(['verify', path])).toMatchInlineSnapshot(`
      {
        "code": 0,
        "stderr": "",
        "stdout": "graph    toy
      run      run
      build    abc123 (test)
      started  2026-11-11T12:00:00.000Z

      verified 7 steps, 0 notes, 1 failed, 1 recovery
      ended    clean at 2026-11-11T12:00:00.000Z",
      }
    `)
  })

  it('stops a tampered journal at its first mismatch, naming the node', async () => {
    const tampered = await copyWith('tampered.journal.jsonl', lines =>
      lines.map((line, index) => {
        if (index !== 2) return line
        const frame = decode(line) as { entry: { derived: { digest: string }[] } }
        frame.entry.derived[0]!.digest = '0'.repeat(64)
        return encode(frame)
      })
    )
    expect(await journal(['verify', tampered])).toMatchInlineSnapshot(`
      {
        "code": 1,
        "stderr": "",
        "stdout": "graph    toy
      run      run
      build    abc123 (test)
      started  2026-11-11T12:00:00.000Z

      diverged at seq 2 at 2026-11-11T12:00:04.000Z, line 3: derived writes differ
        node      positions
        journaled positions 0000000000000000000000000000000000000000000000000000000000000000
        replayed  positions 641c61a299fe6b4e9c145cde87fe7ecfab5b8a2b94a81044cbb201f9d3a2d0fe
      verified 1 step before it",
      }
    `)
  })

  it('refuses a journal another build wrote', async () => {
    expect(
      await journal(['verify', path], {
        checkout: () => ({ revision: 'fedcba987654', dirty: false })
      })
    ).toMatchInlineSnapshot(`
      {
        "code": 2,
        "stderr": "the journal was written by build abc123 (test), not this checkout's fedcba987654; check out abc123 to replay it",
        "stdout": "graph    toy
      run      run
      build    abc123 (test)
      started  2026-11-11T12:00:00.000Z
      ",
      }
    `)
  })

  it("warns that a checkout whose tracked files changed replays code the build didn't hold", async () => {
    const run = await journal(['verify', path], {
      checkout: () => ({ revision: 'abc123def4567890', dirty: true })
    })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain(
      'warning  tracked files differ from that build, so this replay runs code it did not'
    )
  })

  it('refuses a graph with no replay module', async () => {
    expect(await journal(['verify', path], { load: loadReplayModule })).toMatchInlineSnapshot(`
      {
        "code": 2,
        "stderr": "no replay module for graph toy at bots/toy/src/replay.ts",
        "stdout": "graph    toy
      run      run
      build    abc123 (test)
      started  2026-11-11T12:00:00.000Z
      ",
      }
    `)
  })

  it('refuses rather than crashes when git cannot read the checkout', async () => {
    const run = await journal(['verify', path], {
      checkout: () => {
        throw Object.assign(new Error('spawnSync git ENOENT /secret/path'), { code: 'ENOENT' })
      }
    })
    expect(run).toMatchObject({
      code: 2,
      stderr:
        "cannot read this checkout's git revision; run it inside the repository with git installed (ENOENT)"
    })
  })

  it('refuses rather than crashes when the replay module fails to import', async () => {
    const run = await journal(['verify', path], {
      load: async () => {
        throw new SyntaxError("Unexpected token in '/secret/path/lens.ts'")
      }
    })
    expect(run).toMatchObject({
      code: 2,
      stderr:
        'cannot import the replay module for graph toy; install and build the workspace (SyntaxError)'
    })
  })

  it('refuses a header its replay module cannot rebuild a graph from', async () => {
    const replayGraph = () => {
      throw new Error('its header has no settings')
    }
    const run = await journal(['verify', path], { load: async () => ({ replayGraph }) })
    expect(run).toMatchObject({
      code: 2,
      stderr: "the replay module cannot rebuild this journal's graph: its header has no settings"
    })
  })
})

describe('journal show', () => {
  it('lists a step, labelling recorded inputs apart from verified writes', async () => {
    expect(await journal(['show', path, '--at', '3'])).toMatchInlineSnapshot(`
      {
        "code": 0,
        "stderr": "",
        "stdout": "graph    toy
      run      run
      build    abc123 (test)
      started  2026-11-11T12:00:00.000Z

      step seq 3 at 2026-11-11T12:00:07.000Z, line 4
        recorded reads: {"digest":"9e8317b460d9be8161a3af80dcf539f4de55def757f30f45bbce2fff7992a274","status":"present","value":{"basis":2,"coverage":"carried","entries":{"a":{"debt":9}}}}
        verified positions <- positions: {"digest":"8431a20c7596b7061e0675884008dabefdb6683b3adbdc8c9a676e7781c14588","status":"present","value":{"absentBasis":1,"coverage":{"status":"complete"},"keys":{"a":{"basis":2,"digest":"5053d82ba6e8bce2e5689e15410b72063f45e002e77c33c3ce74c63fb5edd8f1","status":"present","value":{"debt":9}},"b":{"basis":1,"digest":"fa39866887913caed06113258bea4d06d263365aa37c3c0264b744b27d4d85bd","status":"present","value":{"debt":7}}}}}
        verified risky <- risky: {"digest":"8b1933a539e85896d5cdec00c269bf47c2efc136ca8d116409eee96812711265","status":"present","value":{"absentBasis":1,"coverage":{"status":"complete"},"keys":{"a":{"basis":2,"digest":"19581e27de7ced00ff1ce50b2047e7a567c76b1cbaebabe5ef03f7c3017bb5b7","status":"present","value":9},"b":{"basis":1,"digest":"7902699be42c8a8e46fbbb4501726517e86b22c56a189f7625a6da49081b2451","status":"present","value":7}}}}
        verified tally <- tally: {"digest":"d4735e3a265e16eee03f59718b9b5d03019c07d8b6c51f90da3a666eec13ab35","status":"present","value":2}",
      }
    `)
  })

  it("shows one node's record as of a step", async () => {
    expect(await journal(['show', path, '--at', '4', '--node', 'risky'])).toMatchInlineSnapshot(`
      {
        "code": 0,
        "stderr": "",
        "stdout": "graph    toy
      run      run
      build    abc123 (test)
      started  2026-11-11T12:00:00.000Z

      node risky as of seq 4
      seq 4 verified risky <- risky: {"digest":"5150a57b06e27de2af99e49b0f5351b34febb59bf72ad94eea5aea83b5312818","status":"present","value":{"absentBasis":3,"coverage":{"status":"complete"},"keys":{"b":{"basis":3,"digest":"2c624232cdd221771294dfbb310aca000a0df6ac8b66b696d90ef06fdefb64a3","status":"present","value":8}}}}",
      }
    `)
  })

  it('shows what every node holds of one key as of a step', async () => {
    expect(await journal(['show', path, '--at', '5', '--key', 'a'])).toMatchInlineSnapshot(`
      {
        "code": 0,
        "stderr": "",
        "stdout": "graph    toy
      run      run
      build    abc123 (test)
      started  2026-11-11T12:00:00.000Z

      key a as of seq 5
      seq 4 verified positions <- positions: {"basis":3,"status":"absent"}
      seq 4 recorded reads: {"basis":3,"omitted":true}
      seq 5 verified risky <- risky: the node is failed",
      }
    `)
  })

  it('exits 1 on a file whose header is corrupt, as verify does', async () => {
    const corrupt = await copyWith('corrupt-header.journal.jsonl', lines => [
      'not-json',
      ...lines.slice(1)
    ])
    expect(await journal(['show', corrupt, '--at', '1'])).toStrictEqual({
      code: 1,
      stderr: '',
      stdout: 'no header: ended    corrupt at line 1: invalid encoding'
    })
  })

  it('says when no step has the seq', async () => {
    expect(await journal(['show', path, '--at', '99'])).toMatchInlineSnapshot(`
      {
        "code": 2,
        "stderr": "",
        "stdout": "graph    toy
      run      run
      build    abc123 (test)
      started  2026-11-11T12:00:00.000Z

      no step has seq 99
      ended    clean at 2026-11-11T12:00:00.000Z",
      }
    `)
  })
})

describe('journal history', () => {
  it("lists every step where a key's records changed", async () => {
    expect(await journal(['history', path, '--key', 'a'])).toMatchInlineSnapshot(`
      {
        "code": 0,
        "stderr": "",
        "stdout": "graph    toy
      run      run
      build    abc123 (test)
      started  2026-11-11T12:00:00.000Z

      history of key a
      seq 2 at 2026-11-11T12:00:04.000Z recorded reads: {"basis":1,"entry":{"debt":3}}
      seq 2 at 2026-11-11T12:00:04.000Z verified positions <- positions: {"basis":1,"digest":"dbb85340ff32b31e330fea0745834041bae0eb040525200e3c87fc0eb2b4197b","status":"present","value":{"debt":3}}
      seq 2 at 2026-11-11T12:00:04.000Z verified risky <- risky: {"basis":1,"status":"absent"}
      seq 3 at 2026-11-11T12:00:07.000Z recorded reads: {"basis":2,"entry":{"debt":9}}
      seq 3 at 2026-11-11T12:00:07.000Z verified positions <- positions: {"basis":2,"digest":"5053d82ba6e8bce2e5689e15410b72063f45e002e77c33c3ce74c63fb5edd8f1","status":"present","value":{"debt":9}}
      seq 3 at 2026-11-11T12:00:07.000Z verified risky <- risky: {"basis":2,"digest":"19581e27de7ced00ff1ce50b2047e7a567c76b1cbaebabe5ef03f7c3017bb5b7","status":"present","value":9}
      seq 4 at 2026-11-11T12:00:10.000Z recorded reads: {"basis":3,"omitted":true}
      seq 4 at 2026-11-11T12:00:10.000Z verified positions <- positions: {"basis":3,"status":"absent"}
      seq 4 at 2026-11-11T12:00:10.000Z verified risky <- risky: {"basis":3,"status":"absent"}
      seq 5 at 2026-11-11T12:00:13.000Z verified risky <- risky: the node is failed
      10 changes
      verified 7 steps, 0 notes, 1 failed, 1 recovery
      ended    clean at 2026-11-11T12:00:00.000Z",
      }
    `)
  })
})

describe('journal where', () => {
  it('reports the last step, the failure and recovery, and how the file ended', async () => {
    expect(await journal(['where', path])).toMatchInlineSnapshot(`
      {
        "code": 0,
        "stderr": "",
        "stdout": "graph    toy
      run      run
      build    abc123 (test)
      started  2026-11-11T12:00:00.000Z

      failed   at 2026-11-11T12:00:17.000Z, line 7, in tally, rolling back seq 6
      recovery at 2026-11-11T12:00:18.000Z, line 8, after a failure in tally
      last     step seq 8 at 2026-11-11T12:00:20.000Z, line 10
      read     7 steps, 0 notes, 1 failed, 1 recovery
      ended    clean at 2026-11-11T12:00:00.000Z",
      }
    `)
  })

  it('escapes control characters a crafted journal holds rather than printing them', async () => {
    const crafted = await copyWith('crafted.journal.jsonl', lines =>
      lines.map(line => {
        if (line === '') return line
        const read = decode(line) as { entry?: { kind: string; description?: string } }
        if (read.entry?.kind !== 'failed') return line
        read.entry.description = 'x\nended    clean\u001b[2J'
        return encode(read)
      })
    )
    const run = await journal(['where', crafted])
    expect(run.stdout).toContain(': x\\u{a}ended    clean\\u{1b}[2J\n')
    expect(run.stdout).not.toContain('\u001b')
  })

  it('reports a torn last line without replaying', async () => {
    const torn = await copyWith('torn.journal.jsonl', lines => [...lines.slice(0, 3), '{"entry"'])
    expect(await journal(['where', torn], { load: loadReplayModule })).toMatchInlineSnapshot(`
      {
        "code": 0,
        "stderr": "",
        "stdout": "graph    toy
      run      run
      build    abc123 (test)
      started  2026-11-11T12:00:00.000Z

      last     step seq 2 at 2026-11-11T12:00:04.000Z, line 3
      read     2 steps, 0 notes, 0 failed, 0 recoveries
      ended    without its end record, after a torn line of 8 bytes",
      }
    `)
  })
})

describe('journal arguments', () => {
  it.each([
    ['an unknown command', ['replay', 'file']],
    ['show without --at', ['show', 'file']],
    ['show with both --node and --key', ['show', 'file', '--at', '1', '--node', 'a', '--key', 'b']],
    ['history without --key', ['history', 'file']],
    ['an unknown option', ['verify', 'file', '--follow']]
  ])('refuses %s', async (_, argv) => {
    const run = await journal(argv.map(arg => (arg === 'file' ? path : arg)))
    expect(run.code).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toMatch(/^Usage:/)
  })

  it.skipIf(process.getuid?.() === 0)('refuses a file it cannot read', async () => {
    const locked = await copyWith('locked.journal.jsonl', lines => lines)
    await chmod(locked, 0o000)
    expect(await journal(['verify', locked])).toStrictEqual({
      code: 2,
      stdout: '',
      stderr: `cannot read ${locked}: EACCES`
    })
  })

  it('refuses a path with no file', async () => {
    expect(await journal(['where', join(directory, 'missing')])).toStrictEqual({
      code: 2,
      stdout: '',
      stderr: `no journal file at ${join(directory, 'missing')}`
    })
  })
})

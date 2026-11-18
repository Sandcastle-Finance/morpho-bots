import type { Graph } from '@repo/engine'
import type { Divergence, Replayed, ReplayedWrite } from '@repo/engine/replay'
import type { JournalHeader, JournalRead, JournalReadOutcome } from '@repo/kit'

import { encode } from '@repo/engine'
import { createReplayer } from '@repo/engine/replay'
import { readJournalFile } from '@repo/kit'
import { stat } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import type { ReplayModule } from './replay-module'

import { JournalRefusedError } from './errors'
import { keyViews, unreadKey } from './key'

const EXIT = { ok: 0, failed: 1, refused: 2 } as const

export type CliDependencies = Readonly<{
  load: (graph: string) => Promise<ReplayModule>
  /**
   * The commit this checkout is at, which must be the journal's build, and whether tracked files
   * differ from it, so the replay runs code that build did not.
   */
  checkout: () => Readonly<{ revision: string; dirty: boolean }>
  stdout: (line: string) => void
  stderr: (line: string) => void
}>

const USAGE = `Usage:
  journal verify <file>
  journal show <file> --at <seq> [--node <id> | --key <key>]
  journal history <file> --key <key>
  journal where <file>`

type Reads = AsyncGenerator<JournalRead>
type Step = Extract<Replayed, { kind: 'step' }>
type Counts = { steps: number; notes: number; failed: number; recoveries: number }
type Latest = Map<string, Readonly<{ seq: number; write: ReplayedWrite; view?: string }>>

/** Whether a replay should stop after this step, having found what it was asked for. */
type Visit = (step: Step, line: number) => boolean

type Replay =
  | Readonly<{ kind: 'stopped'; counts: Counts }>
  | Readonly<{ kind: 'diverged'; counts: Counts; divergence: Divergence; line: number }>
  | Readonly<{ kind: 'ended'; counts: Counts; outcome: JournalReadOutcome }>

const MAX_DATE_MS = 8.64e15

/** Control, format and line-separator characters, which a crafted journal could use to forge output. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

const printable = (line: string) =>
  line.replace(UNPRINTABLE, char => `\\u{${char.codePointAt(0)!.toString(16)}}`)

const isSystemError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && typeof (error as NodeJS.ErrnoException).syscall === 'string'

/** {@link readJournalFile}, refusing a file that cannot be opened or read instead of throwing. */
async function* readJournal(path: string): Reads {
  try {
    yield* readJournalFile(path)
  } catch (error) {
    if (!isSystemError(error)) throw error
    throw new JournalRefusedError(`cannot read ${path}: ${error.code ?? error.syscall}`)
  }
}

const time = (at: number) => (Math.abs(at) <= MAX_DATE_MS ? new Date(at).toISOString() : `${at}`)

const headerLines = (header: JournalHeader) => [
  `graph    ${header.graph}`,
  `run      ${header.run}`,
  `build    ${header.build.revision} (${header.build.imageTag})`,
  `started  ${time(header.startedAt)}`,
  ''
]

const endingLine = (outcome: JournalReadOutcome) => {
  if (outcome.status === 'clean') return `ended    clean at ${time(outcome.end.endedAt)}`
  if (outcome.status === 'corrupt')
    return `ended    corrupt at line ${outcome.line}: ${outcome.reason}`
  return outcome.truncatedBytes === 0
    ? 'ended    without its end record'
    : `ended    without its end record, after a torn line of ${outcome.truncatedBytes} bytes`
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const countsLine = (counts: Counts) =>
  [
    plural(counts.steps, 'step', 'steps'),
    plural(counts.notes, 'note', 'notes'),
    `${counts.failed} failed`,
    plural(counts.recoveries, 'recovery', 'recoveries')
  ].join(', ')

/** Recorded writes are the journal's inputs; verified ones an operator derived and replay matched by digest. */
const writeLine = (write: ReplayedWrite, shown = encode(write.record)) =>
  `${write.derived ? 'verified' : 'recorded'} ${write.node}${
    write.producer === undefined ? '' : ` <- ${write.producer}`
  }: ${shown}`

const stepLines = (step: Step, line: number) => [
  `step seq ${step.stamp.seq} at ${time(step.stamp.at)}, line ${line}`,
  ...(step.wakes.length === 0 ? [] : [`  wakes ${step.wakes.join(', ')}`]),
  ...step.writes.map(write => `  ${writeLine(write)}`)
]

const divergenceLines = ({ divergence, line, counts }: Extract<Replay, { kind: 'diverged' }>) => [
  `diverged at seq ${divergence.stamp.seq} at ${time(divergence.stamp.at)}, line ${line}: ${divergence.reason}`,
  ...(divergence.node === undefined ? [] : [`  node      ${divergence.node}`]),
  ...(divergence.expected
    ? [`  journaled ${divergence.expected.node} ${divergence.expected.digest}`]
    : []),
  ...(divergence.actual
    ? [`  replayed  ${divergence.actual.node} ${divergence.actual.digest}`]
    : []),
  `verified ${plural(counts.steps, 'step', 'steps')} before it`
]

const readable = async (path: string) => {
  const found = await stat(path).catch(() => undefined)
  if (!found?.isFile()) throw new JournalRefusedError(`no journal file at ${path}`)
}

const headerOf = async (reads: Reads, deps: CliDependencies) => {
  const first = (await reads.next()).value as JournalRead
  if (first.kind === 'header') {
    for (const line of headerLines(first.header)) deps.stdout(line)
    return first.header
  }
  if (first.kind === 'outcome') deps.stdout(`no header: ${endingLine(first)}`)
  return undefined
}

/** An error's code or class, which names what failed without its message's paths. */
const kindOf = (error: unknown) => {
  if (!(error instanceof Error)) return typeof error
  const { code } = error as NodeJS.ErrnoException
  return typeof code === 'string' ? code : error.name
}

/** Runs `step`, turning any failure but a refusal into a refusal with `reason`, never its own text. */
const refusing = async <T>(reason: string, step: () => T | Promise<T>) => {
  try {
    return await step()
  } catch (error) {
    if (error instanceof JournalRefusedError) throw error
    throw new JournalRefusedError(`${reason} (${kindOf(error)})`)
  }
}

const graphFor = async (header: JournalHeader, deps: CliDependencies) => {
  const journaled = header.build.revision.toLowerCase()
  const checkout = await refusing(
    "cannot read this checkout's git revision; run it inside the repository with git installed",
    deps.checkout
  )
  const revision = checkout.revision.toLowerCase()
  if (!revision.startsWith(journaled))
    throw new JournalRefusedError(
      `the journal was written by build ${header.build.revision} (${header.build.imageTag}), not this checkout's ${revision.slice(0, 12)}; check out ${header.build.revision} to replay it`
    )
  const module = await refusing(
    `cannot import the replay module for graph ${header.graph}; install and build the workspace`,
    () => deps.load(header.graph)
  )
  let graph: Graph
  try {
    graph = module.replayGraph(header)
  } catch (error) {
    throw new JournalRefusedError(
      `the replay module cannot rebuild this journal's graph: ${error instanceof Error ? error.message : 'it threw'}`
    )
  }
  if (graph.id !== header.graph)
    throw new JournalRefusedError(
      `the replay module built graph ${graph.id}, not the journal's ${header.graph}`
    )
  if (checkout.dirty)
    deps.stdout(
      'warning  tracked files differ from that build, so this replay runs code it did not'
    )
  return graph
}

const count = (counts: Counts, { kind }: Readonly<{ kind: string }>) => {
  if (kind === 'step') counts.steps += 1
  else if (kind === 'note') counts.notes += 1
  else if (kind === 'failed') counts.failed += 1
  else if (kind === 'recovery') counts.recoveries += 1
}

/** Replays a file entry by entry, until `visit` stops it, the first divergence, or the file's end. */
const replayFile = async (
  path: string,
  deps: CliDependencies,
  { title, visit }: Readonly<{ title?: string; visit: Visit }>
): Promise<Replay | undefined> => {
  const reads = readJournal(path)
  try {
    const header = await headerOf(reads, deps)
    if (!header) return undefined
    const replayer = createReplayer(await graphFor(header, deps))
    if (title !== undefined) deps.stdout(title)
    const counts: Counts = { steps: 0, notes: 0, failed: 0, recoveries: 0 }
    for await (const read of reads) {
      if (read.kind !== 'entry')
        return { kind: 'ended', counts, outcome: read as JournalReadOutcome }
      const replayed = replayer.apply(read.entry)
      if (replayed.kind === 'diverged')
        return { kind: 'diverged', counts, divergence: replayed, line: read.line }
      count(counts, replayed)
      if (replayed.kind === 'step' && visit(replayed, read.line)) return { kind: 'stopped', counts }
    }
    throw new JournalRefusedError('the journal reader ended without an outcome')
  } finally {
    await reads.return(undefined)
  }
}

/** Prints how a replay that ran to the file's end or diverged finished, and its exit code. */
const finish = (replay: Replay | undefined, deps: CliDependencies) => {
  if (replay === undefined) return EXIT.failed
  if (replay.kind === 'diverged') {
    for (const line of divergenceLines(replay)) deps.stdout(line)
    return EXIT.failed
  }
  if (replay.kind === 'stopped') return EXIT.ok
  deps.stdout(`verified ${countsLine(replay.counts)}`)
  deps.stdout(endingLine(replay.outcome))
  return replay.outcome.status === 'corrupt' ? EXIT.failed : EXIT.ok
}

const verify = async (path: string, deps: CliDependencies) =>
  finish(await replayFile(path, deps, { visit: () => false }), deps)

const showLines = (
  step: Step,
  line: number,
  { latest, node, key }: Readonly<{ latest: Latest; node?: string; key?: string }>
) => {
  const seq = step.stamp.seq
  if (node !== undefined) {
    const last = latest.get(node)
    return last === undefined
      ? [`no write to node ${node} at or before seq ${seq}`]
      : [`seq ${last.seq} ${writeLine(last.write)}`]
  }
  if (key !== undefined)
    return [...latest]
      .toSorted(([left], [right]) => (left < right ? -1 : 1))
      .map(([, last]) => `seq ${last.seq} ${writeLine(last.write, last.view)}`)
  return stepLines(step, line)
}

const show = async (
  path: string,
  deps: CliDependencies,
  options: { at: number; node?: string; key?: string }
) => {
  const latest: Latest = new Map()
  const views = options.key === undefined ? undefined : keyViews(options.key)
  let found = false
  const title =
    options.node !== undefined
      ? `node ${options.node} as of seq ${options.at}`
      : options.key !== undefined
        ? `key ${options.key} as of seq ${options.at}`
        : undefined
  const replay = await replayFile(path, deps, {
    ...(title !== undefined && { title }),
    visit: (step, line) => {
      for (const write of step.writes) {
        const view = views?.(write.node, write.record)
        if (!views || view !== undefined)
          latest.set(write.node, { seq: step.stamp.seq, write, view })
      }
      if (step.stamp.seq < options.at) return false
      found = step.stamp.seq === options.at
      if (found) for (const text of showLines(step, line, { latest, ...options })) deps.stdout(text)
      return true
    }
  })
  if (replay === undefined || replay.kind === 'diverged') return finish(replay, deps)
  if (found) return EXIT.ok
  deps.stdout(`no step has seq ${options.at}`)
  if (replay.kind !== 'ended') return EXIT.refused
  deps.stdout(endingLine(replay.outcome))
  return replay.outcome.status === 'corrupt' ? EXIT.failed : EXIT.refused
}

const history = async (path: string, deps: CliDependencies, key: string) => {
  const shown = new Map<string, string>()
  const views = keyViews(key)
  let changes = 0
  const replay = await replayFile(path, deps, {
    title: `history of key ${key}`,
    visit: step => {
      for (const write of step.writes) {
        const view = views(write.node, write.record)
        if (view === undefined || view === (shown.get(write.node) ?? unreadKey(key))) continue
        shown.set(write.node, view)
        changes += 1
        deps.stdout(`seq ${step.stamp.seq} at ${time(step.stamp.at)} ${writeLine(write, view)}`)
      }
      return false
    }
  })
  if (replay?.kind === 'ended') deps.stdout(plural(changes, 'change', 'changes'))
  return finish(replay, deps)
}

const whereIn = async (reads: Reads, deps: CliDependencies) => {
  if (!(await headerOf(reads, deps))) return EXIT.failed
  const counts: Counts = { steps: 0, notes: 0, failed: 0, recoveries: 0 }
  let last = 'no steps'
  for await (const read of reads) {
    if (read.kind !== 'entry') {
      deps.stdout(`last     ${last}`)
      deps.stdout(`read     ${countsLine(counts)}`)
      deps.stdout(endingLine(read as JournalReadOutcome))
      return read.kind === 'outcome' && read.status === 'corrupt' ? EXIT.failed : EXIT.ok
    }
    const { entry, line } = read
    count(counts, entry)
    if (entry.kind === 'step')
      last = `step seq ${entry.stamp.seq} at ${time(entry.stamp.at)}, line ${line}`
    if (entry.kind === 'failed')
      deps.stdout(
        `failed   at ${time(entry.at)}, line ${line}${entry.origin === undefined ? '' : `, in ${entry.origin}`}${
          entry.step === undefined ? '' : `, rolling back seq ${entry.step.stamp.seq}`
        }${entry.description === undefined ? '' : `: ${entry.description}`}`
      )
    if (entry.kind === 'recovery')
      deps.stdout(`recovery at ${time(entry.at)}, line ${line}, after a failure in ${entry.origin}`)
  }
  throw new JournalRefusedError('the journal reader ended without an outcome')
}

const where = async (path: string, deps: CliDependencies) => {
  const reads = readJournal(path)
  try {
    return await whereIn(reads, deps)
  } finally {
    await reads.return(undefined)
  }
}

const sequence = (value: string | undefined) => {
  const seq = value !== undefined && /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(seq)) throw new JournalRefusedError('--at takes a step seq')
  return seq
}

const parse = (argv: readonly string[]) => {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { at: { type: 'string' }, node: { type: 'string' }, key: { type: 'string' } }
    })
  } catch {
    throw new JournalRefusedError(USAGE)
  }
}

const run = async (argv: readonly string[], deps: CliDependencies) => {
  const { positionals, values } = parse(argv)
  const [command, path, ...rest] = positionals
  if (command === undefined || path === undefined || rest.length > 0)
    throw new JournalRefusedError(USAGE)
  const { at, node, key } = values
  const takes = (allowed: readonly string[]) => {
    const given = Object.entries(values).flatMap(([name, value]) =>
      value === undefined ? [] : [name]
    )
    if (given.some(name => !allowed.includes(name))) throw new JournalRefusedError(USAGE)
  }
  await readable(path)
  switch (command) {
    case 'verify':
      takes([])
      return verify(path, deps)
    case 'show':
      takes(['at', node === undefined ? 'key' : 'node'])
      if (at === undefined) throw new JournalRefusedError(USAGE)
      return show(path, deps, { at: sequence(at), node, key })
    case 'history':
      takes(['key'])
      if (key === undefined) throw new JournalRefusedError(USAGE)
      return history(path, deps, key)
    case 'where':
      takes([])
      return where(path, deps)
    default:
      throw new JournalRefusedError(USAGE)
  }
}

/** Runs one command, returning its exit code; a refusal prints its reason rather than throwing. */
export const main = async (argv: readonly string[], deps: CliDependencies) => {
  const out = {
    ...deps,
    stdout: (line: string) => deps.stdout(printable(line)),
    stderr: (line: string) => deps.stderr(printable(line))
  }
  try {
    return await run(argv, out)
  } catch (error) {
    if (!(error instanceof JournalRefusedError)) throw error
    for (const line of error.message === USAGE ? USAGE.split('\n') : [error.message])
      out.stderr(line)
    return EXIT.refused
  }
}

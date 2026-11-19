import type { Data, JournalEntry, JournalSink, JournalWrite, RunnerOptions } from '@repo/engine'
import type { FileHandle } from 'node:fs/promises'

import {
  decode,
  DEFAULT_JOURNAL_IO_TIMEOUT_MS,
  encode,
  expandJournalWrite,
  JOURNAL_FORMAT,
  JournalIoTimeoutError,
  validateJournalLimits
} from '@repo/engine'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fileSystem from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { InvalidJournalRunCapError, JournalFileError, MissingBuildIdentityError } from './errors'

export const JOURNAL_FILE_FORMAT = 1
export const JOURNAL_FILE_SUFFIX = '.journal.jsonl'
/** Earlier runs' files survive a new run's creation, newest first, while they total at most this many run caps. */
export const KEPT_JOURNAL_RUN_CAPS = 3
/**
 * A run file over this many run caps is deleted even among the newest runs, so a file written under
 * no cap or a larger one cannot pin the volume full; a capped run overshoots only by its stop's drain.
 */
export const KEPT_RUN_MAX_CAPS = 2
/** The smallest `JOURNAL_RUN_CAP_BYTES` a bot accepts, so a mistyped cap cannot restart it every few heads. */
export const MIN_JOURNAL_RUN_CAP_BYTES = 64 * 1024 * 1024
/** A `failed` entry's description is a short code, never a message or URL; a bot returns only fixed ones. */
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,31}$/
const UNDESCRIBED_FAILURE = 'undescribed'
/** Large enough that reading a 1 GiB file is not dominated by per-chunk overhead. */
const READ_CHUNK_BYTES = 256 * 1024
const JOURNAL_FILE_NAME = /^(\d+)-[A-Za-z0-9][A-Za-z0-9_-]*\.journal\.jsonl$/

export type JournalBuildIdentity = Readonly<{
  revision: string
  imageTag: string
}>

export type JournalHeader = Readonly<{
  type: 'header'
  fileFormat: typeof JOURNAL_FILE_FORMAT
  journalFormat: typeof JOURNAL_FORMAT
  graph: string
  run: string
  startedAt: number
  build: JournalBuildIdentity
  /** What the bot built its graph from, so a replay can build the same graph. */
  settings?: Readonly<Record<string, Data>>
}>

type JournalEnd = Readonly<{ type: 'end'; endedAt: number }>

/** How a journal file ended: its end record, a torn or missing tail, or the first invalid line. */
export type JournalReadOutcome =
  | Readonly<{ status: 'clean'; end: JournalEnd }>
  | Readonly<{ status: 'truncated'; truncatedBytes: number }>
  | Readonly<{ status: 'corrupt'; line: number; reason: string }>

export type JournalRead =
  | Readonly<{ kind: 'header'; header: JournalHeader }>
  | Readonly<{ kind: 'entry'; line: number; entry: JournalEntry }>
  | (Readonly<{ kind: 'outcome' }> & JournalReadOutcome)

export type JournalWritableFile = Pick<FileHandle, 'writeFile' | 'datasync' | 'sync' | 'close'>
export type JournalFileSystem = Readonly<{
  mkdir: (path: string, options: { recursive: true; mode: number }) => Promise<string | undefined>
  chmod: (path: string, mode: number) => Promise<void>
  open: (path: string, flags: string, mode?: number) => Promise<JournalWritableFile>
  writeFile?: (
    file: JournalWritableFile,
    data: Buffer,
    options: { signal?: AbortSignal }
  ) => Promise<void>
  readdir: (path: string) => Promise<string[]>
  lstat: (path: string) => Promise<Readonly<{ size: number; isFile: () => boolean }>>
  unlink: (path: string) => Promise<void>
}>

const defaultFileSystem: JournalFileSystem = {
  ...fileSystem,
  writeFile: (file, data, options) =>
    fileSystem.writeFile(file as FileHandle, data, { signal: options.signal })
}

const lineOf = (value: Data) => Buffer.from(`${encode(value)}\n`)

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

type CreationFiles = Readonly<{
  open: JournalFileSystem['open']
  close: (file: JournalWritableFile) => Promise<void>
}>

const syncDirectory = async (path: string, fs: JournalFileSystem) => {
  const directory = await fs.open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

const syncCreationDirectory = async (path: string, files: CreationFiles) => {
  const directory = await files.open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await files.close(directory)
  }
}

const createdDirectories = (firstCreated: string | undefined, target: string) => {
  if (!firstCreated) return []
  const first = resolve(firstCreated)
  const created: string[] = []
  for (let directory = resolve(target); ; directory = dirname(directory)) {
    created.push(directory)
    if (directory === first) break
    if (directory === dirname(directory))
      throw new JournalFileError('locate its created directory', undefined)
  }
  return created.toReversed()
}

const syncCreatedDirectories = async (created: readonly string[], files: CreationFiles) => {
  for (const directory of created) await syncCreationDirectory(dirname(directory), files)
}

export type JournalFileOptions = Readonly<{
  directory: string
  graph: string
  build: JournalBuildIdentity
  capacityBytes: number
  /** The size at which this run's file resolves `runCapReached`; appends still land past it. */
  runCapBytes: number
  runId?: string
  /** Recorded in the header; never a key or a credential. */
  settings?: Readonly<Record<string, Data>>
  now?: () => number
  ioTimeoutMs?: number
  /** Anything but a {@link FAILURE_CODE} is written as `undescribed`. */
  describe?: (error: unknown) => string
}>

const describedAsCode = (describe: (error: unknown) => string) => (error: unknown) => {
  const code: unknown = describe(error)
  return typeof code === 'string' && FAILURE_CODE.test(code) ? code : UNDESCRIBED_FAILURE
}

const imageTag = (value: unknown) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) &&
  !/(?:api[-_]?key|credential|password|private|rpc|secret|sk[-_]?live|token)/i.test(value) &&
  !/^(?:0x)?[0-9A-Fa-f]{64}$/.test(value)

const revision = (value: unknown) => typeof value === 'string' && /^[0-9A-Fa-f]{6,40}$/.test(value)

const buildIdentity = (value: unknown): value is JournalBuildIdentity =>
  record(value) &&
  Object.hasOwn(value, 'imageTag') &&
  Object.hasOwn(value, 'revision') &&
  Object.keys(value).every(field => field === 'imageTag' || field === 'revision') &&
  imageTag(value.imageTag) &&
  revision(value.revision)

/** The build the image says it is: `BUILD_REVISION` (a git commit) and `BUILD_IMAGE_TAG`, both required. */
export const buildIdentityFromEnv = (
  env: Readonly<Record<string, string | undefined>>
): JournalBuildIdentity => {
  const build = { revision: env.BUILD_REVISION?.trim(), imageTag: env.BUILD_IMAGE_TAG?.trim() }
  if (!buildIdentity(build)) throw new MissingBuildIdentityError()
  return build
}

/** `JOURNAL_RUN_CAP_BYTES`, required: a decimal byte count of at least {@link MIN_JOURNAL_RUN_CAP_BYTES}. */
export const parseJournalRunCapBytes = (value: string | undefined) => {
  const raw = value?.trim()
  const bytes = raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN
  if (!(Number.isSafeInteger(bytes) && bytes >= MIN_JOURNAL_RUN_CAP_BYTES))
    throw new InvalidJournalRunCapError(MIN_JOURNAL_RUN_CAP_BYTES)
  return bytes
}

type JournalPruned = Readonly<{ files: number; bytes: number; kept: number }>
export type JournalRunCap = Readonly<{ bytes: number; runCapBytes: number }>

const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined

const pruneOldRuns = async (
  directory: string,
  runCapBytes: number,
  fs: JournalFileSystem,
  files: CreationFiles,
  signal: AbortSignal
): Promise<JournalPruned> => {
  let names: string[]
  try {
    names = await fs.readdir(directory)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { files: 0, bytes: 0, kept: 0 }
    throw error
  }
  const runs: { path: string; name: string; startedAt: number; size: number }[] = []
  for (const name of names) {
    const match = JOURNAL_FILE_NAME.exec(name)
    if (!match) continue
    const path = join(directory, name)
    const info = await fs.lstat(path)
    signal.throwIfAborted()
    if (info.isFile()) runs.push({ path, name, startedAt: Number(match[1]), size: info.size })
  }
  runs.sort((a, b) => b.startedAt - a.startedAt || (a.name < b.name ? 1 : -1))
  const kept: typeof runs = []
  let budget = KEPT_JOURNAL_RUN_CAPS * runCapBytes
  for (const run of runs) {
    if (run.size > KEPT_RUN_MAX_CAPS * runCapBytes) continue
    if (run.size > budget) break
    kept.push(run)
    budget -= run.size
  }
  const pruned = { files: 0, bytes: 0, kept: kept.length }
  for (const run of runs.filter(run => !kept.includes(run))) {
    try {
      await fs.unlink(run.path)
      pruned.files += 1
      pruned.bytes += run.size
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    signal.throwIfAborted()
  }
  if (pruned.files > 0) await syncCreationDirectory(directory, files)
  return pruned
}

export const createJournalFileSink = async (
  options: JournalFileOptions,
  fs: JournalFileSystem = defaultFileSystem
): Promise<
  Readonly<{
    path: string
    header: JournalHeader
    journal: NonNullable<RunnerOptions['journal']>
    finalize: () => Promise<void>
    pruned: JournalPruned
    runCapReached: Promise<JournalRunCap>
  }>
> => {
  validateJournalLimits(options)
  const { runCapBytes } = options
  if (!(Number.isSafeInteger(runCapBytes) && runCapBytes > 0))
    throw new JournalFileError('use its run cap', undefined)
  if (!buildIdentity(options.build)) throw new JournalFileError('use its build identity', undefined)
  const now = options.now ?? Date.now
  const run = options.runId ?? randomUUID()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(run))
    throw new JournalFileError('use its run id', undefined)
  const startedAt = now()
  const header: JournalHeader = {
    type: 'header',
    fileFormat: JOURNAL_FILE_FORMAT,
    journalFormat: JOURNAL_FORMAT,
    graph: options.graph,
    run,
    startedAt,
    build: options.build,
    ...(options.settings && { settings: options.settings })
  }
  const path = join(options.directory, `${startedAt}-${run}${JOURNAL_FILE_SUFFIX}`)
  let encodedHeader: Buffer
  try {
    encodedHeader = lineOf(header)
  } catch (error) {
    throw new JournalFileError('encode its header', error)
  }
  const timeoutMs = options.ioTimeoutMs ?? DEFAULT_JOURNAL_IO_TIMEOUT_MS
  const controller = new AbortController()
  const opened = new Set<JournalWritableFile>()
  const close = async (file: JournalWritableFile) => {
    if (!opened.delete(file)) return
    await file.close()
  }
  const open: JournalFileSystem['open'] = async (...arguments_) => {
    const file = await fs.open(...arguments_)
    if (controller.signal.aborted) {
      try {
        await file.close()
      } catch {}
      controller.signal.throwIfAborted()
    }
    opened.add(file)
    return file
  }
  const files = { open, close }
  const creating = (async () => {
    let pruned: JournalPruned
    try {
      pruned = await pruneOldRuns(options.directory, runCapBytes, fs, files, controller.signal)
    } catch (error) {
      throw new JournalFileError('prune old runs', error)
    }
    let file: JournalWritableFile
    try {
      const firstCreated = await fs.mkdir(options.directory, { recursive: true, mode: 0o700 })
      controller.signal.throwIfAborted()
      const created = createdDirectories(firstCreated, options.directory)
      for (const directory of created) {
        await fs.chmod(directory, 0o700)
        controller.signal.throwIfAborted()
      }
      await syncCreatedDirectories(created, files)
      controller.signal.throwIfAborted()
      file = await open(path, 'wx', 0o600)
      controller.signal.throwIfAborted()
    } catch (error) {
      throw new JournalFileError('open durably', error)
    }
    try {
      await (fs.writeFile?.(file, encodedHeader, { signal: controller.signal }) ??
        file.writeFile(encodedHeader))
      controller.signal.throwIfAborted()
      await file.datasync()
      controller.signal.throwIfAborted()
      await syncCreationDirectory(options.directory, files)
      controller.signal.throwIfAborted()
    } catch (error) {
      try {
        await close(file)
      } catch {}
      throw new JournalFileError('write its header durably', error)
    }
    opened.delete(file)
    return { file, pruned }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new JournalIoTimeoutError('create', timeoutMs)
      controller.abort(error)
      for (const file of opened) {
        opened.delete(file)
        try {
          void file.close().catch(() => undefined)
        } catch {}
      }
      reject(error)
    }, timeoutMs)
  })
  let created: Awaited<typeof creating>
  try {
    created = await Promise.race([creating, timeout])
  } finally {
    clearTimeout(timer)
  }
  const { file, pruned } = created

  let written = encodedHeader.length
  const runCap = Promise.withResolvers<JournalRunCap>()
  if (written >= runCapBytes) runCap.resolve({ bytes: written, runCapBytes })
  let finalized = false
  const writeFrame = (frame: Buffer, signal?: AbortSignal) =>
    fs.writeFile?.(file, frame, { signal }) ?? file.writeFile(frame)
  const sink: JournalSink = {
    append: async (entry, signal) => {
      if (finalized) throw new JournalFileError('append after finalization', undefined)
      try {
        signal?.throwIfAborted()
        const encoding = performance.now()
        const frame = lineOf({ type: 'entry', entry })
        const encodeMs = performance.now() - encoding
        await writeFrame(frame, signal)
        signal?.throwIfAborted()
        const syncing = performance.now()
        await file.datasync()
        const syncMs = performance.now() - syncing
        signal?.throwIfAborted()
        written += frame.length
        if (written >= runCapBytes) runCap.resolve({ bytes: written, runCapBytes })
        return { bytes: frame.length, encodeMs, syncMs }
      } catch (error) {
        throw new JournalFileError('append durably', error)
      }
    },
    finalize: async (signal, result) => {
      if (finalized) return
      finalized = true
      let failure: JournalFileError | undefined
      if (result?.clean !== false) {
        try {
          signal?.throwIfAborted()
          await writeFrame(lineOf({ type: 'end', endedAt: now() }), signal)
          signal?.throwIfAborted()
          await file.datasync()
          signal?.throwIfAborted()
          await file.sync()
          signal?.throwIfAborted()
        } catch (error) {
          failure = new JournalFileError('finalize durably', error)
        }
      }
      try {
        await file.close()
        await syncDirectory(options.directory, fs)
      } catch (error) {
        failure ??= new JournalFileError('close durably', error)
      }
      if (failure) throw failure
    }
  }
  const finalize = async () => {
    const finalizeController = new AbortController()
    let finalizeTimer: ReturnType<typeof setTimeout> | undefined
    const finalizeTimeout = new Promise<never>((_, reject) => {
      finalizeTimer = setTimeout(() => {
        finalizeController.abort()
        reject(new JournalIoTimeoutError('finalize', timeoutMs))
      }, timeoutMs)
    })
    try {
      await Promise.race([sink.finalize(finalizeController.signal), finalizeTimeout])
    } finally {
      clearTimeout(finalizeTimer)
    }
  }
  const journal = {
    sink,
    capacityBytes: options.capacityBytes,
    ...(options.ioTimeoutMs !== undefined && { ioTimeoutMs: options.ioTimeoutMs }),
    ...(options.describe && { describe: describedAsCode(options.describe) })
  }
  return { path, header, journal, finalize, pruned, runCapReached: runCap.promise }
}

const exactFields = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
) => {
  const allowed = new Set([...required, ...optional])
  return (
    required.every(field => Object.hasOwn(value, field)) &&
    Object.keys(value).every(field => allowed.has(field))
  )
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const stamp = (value: unknown) =>
  record(value) &&
  exactFields(value, ['at', 'seq']) &&
  Number.isSafeInteger(value.seq) &&
  finite(value.at)

const stringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

const journalWrite = (value: unknown): value is JournalWrite => {
  if (!record(value) || typeof value.node !== 'string') return false
  if ('value' in value) return exactFields(value, ['node', 'value'])
  if (!record(value.delta) || value.delta.kind !== 'keyed-complete') return false
  return (
    exactFields(value, ['delta', 'node']) &&
    exactFields(value.delta, ['entries', 'fields', 'kind', 'removed']) &&
    record(value.delta.fields) &&
    record(value.delta.entries) &&
    stringArray(value.delta.removed)
  )
}

const journalStepFields = (value: Record<string, unknown>) =>
  stamp(value.stamp) &&
  Array.isArray(value.writes) &&
  value.writes.every(journalWrite) &&
  (value.wakes === undefined || stringArray(value.wakes))

const journalStep = (value: unknown) =>
  record(value) && exactFields(value, ['stamp', 'writes'], ['wakes']) && journalStepFields(value)

const journalEntry = (value: unknown): value is JournalEntry => {
  if (!record(value)) return false
  if (value.kind === 'note')
    return (
      exactFields(value, ['at', 'effect', 'kind', 'note']) &&
      typeof value.effect === 'string' &&
      finite(value.at)
    )
  if (value.kind === 'recovery')
    return (
      exactFields(value, ['at', 'kind', 'origin']) &&
      typeof value.origin === 'string' &&
      finite(value.at)
    )
  if (value.kind === 'failed')
    return (
      exactFields(value, ['at', 'kind'], ['description', 'origin', 'step']) &&
      finite(value.at) &&
      (value.origin === undefined || typeof value.origin === 'string') &&
      (value.description === undefined || typeof value.description === 'string') &&
      (value.step === undefined || journalStep(value.step))
    )
  return (
    value.kind === 'step' &&
    exactFields(value, ['derived', 'kind', 'stamp', 'writes'], ['wakes']) &&
    journalStepFields(value) &&
    Array.isArray(value.derived) &&
    value.derived.every(
      item =>
        record(item) &&
        exactFields(item, ['digest', 'node']) &&
        typeof item.node === 'string' &&
        typeof item.digest === 'string'
    )
  )
}

const journalHeader = (value: unknown): value is JournalHeader =>
  record(value) &&
  exactFields(
    value,
    ['build', 'fileFormat', 'graph', 'journalFormat', 'run', 'startedAt', 'type'],
    ['settings']
  ) &&
  (value.settings === undefined || record(value.settings)) &&
  value.type === 'header' &&
  value.fileFormat === JOURNAL_FILE_FORMAT &&
  value.journalFormat === JOURNAL_FORMAT &&
  typeof value.graph === 'string' &&
  typeof value.run === 'string' &&
  finite(value.startedAt) &&
  buildIdentity(value.build)

const journalEnd = (value: unknown): value is JournalEnd =>
  record(value) &&
  exactFields(value, ['endedAt', 'type']) &&
  value.type === 'end' &&
  finite(value.endedAt)

type ReadState = {
  header?: JournalHeader
  end?: JournalEnd
  deltas: Parameters<typeof expandJournalWrite>[1]
}

const invalidStepWrites = (entry: Extract<JournalEntry, { kind: 'step' }>, state: ReadState) => {
  for (const write of entry.writes) {
    if (expandJournalWrite(write, state.deltas) === undefined) return 'invalid keyed delta chain'
  }
  return undefined
}

const invalidEntryWrites = (entry: JournalEntry, state: ReadState) => {
  if (entry.kind === 'step') return invalidStepWrites(entry, state)
  if (entry.kind === 'failed' && entry.step?.writes.some(write => 'delta' in write))
    return 'a failed step contains a keyed delta'
  return undefined
}

const corrupt = (line: number, reason: string): JournalRead => ({
  kind: 'outcome',
  status: 'corrupt',
  line,
  reason
})

const readLine = (text: string, line: number, state: ReadState): JournalRead | undefined => {
  let frame: Data
  try {
    frame = decode(text)
    if (encode(frame) !== text) return corrupt(line, 'non-canonical encoding')
  } catch {
    return corrupt(line, 'invalid encoding')
  }
  if (line === 1) {
    if (!journalHeader(frame)) return corrupt(1, 'invalid header')
    state.header = frame
    return { kind: 'header', header: frame }
  }
  if (!record(frame)) return corrupt(line, 'invalid frame')
  if (
    frame.type === 'entry' &&
    exactFields(frame, ['entry', 'type']) &&
    journalEntry(frame.entry) &&
    !state.end
  ) {
    const reason = invalidEntryWrites(frame.entry, state)
    return reason ? corrupt(line, reason) : { kind: 'entry', line, entry: frame.entry }
  }
  if (journalEnd(frame) && !state.end) {
    state.end = frame
    return undefined
  }
  return corrupt(line, 'invalid frame order or shape')
}

/**
 * Reads a journal file one line at a time, holding only the line being read and each keyed node's
 * last complete write, so memory stays bounded by the longest line and the graph's state, not the
 * file. Its last item is always the outcome; a corrupt line ends it after the valid prefix.
 */
export async function* readJournalFile(path: string): AsyncGenerator<JournalRead> {
  const state: ReadState = { deltas: new Map() }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let tail: Buffer[] = []
  let line = 0
  for await (const chunk of createReadStream(path, {
    highWaterMark: READ_CHUNK_BYTES
  }) as AsyncIterable<Buffer>) {
    let start = 0
    for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, end)
      const bytes = tail.length === 0 ? piece : Buffer.concat([...tail, piece])
      tail = []
      start = end + 1
      line += 1
      let text: string
      try {
        text = decoder.decode(bytes)
      } catch {
        yield corrupt(line, 'invalid utf-8')
        return
      }
      const read = readLine(text, line, state)
      if (read) yield read
      if (read?.kind === 'outcome') return
    }
    if (start < chunk.length) tail.push(chunk.subarray(start))
  }
  const truncatedBytes = tail.reduce((total, piece) => total + piece.length, 0)
  yield truncatedBytes === 0 && state.header && state.end
    ? { kind: 'outcome', status: 'clean', end: state.end }
    : { kind: 'outcome', status: 'truncated', truncatedBytes }
}

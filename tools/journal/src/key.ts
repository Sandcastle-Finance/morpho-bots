import type { Keyed, KeyedWrite, NodeRecord } from '@repo/engine'

import { encode, keyRecord, UNREAD } from '@repo/engine'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const KEYED_WRITE_COVERAGES = new Set(['complete', 'carried', 'unknown', 'failed'])

const isKeyed = (value: unknown): value is Keyed<unknown> =>
  isRecord(value) && isRecord(value.coverage) && isRecord(value.keys)

const isKeyedWrite = (value: unknown): value is KeyedWrite<unknown> =>
  isRecord(value) && typeof value.coverage === 'string' && KEYED_WRITE_COVERAGES.has(value.coverage)

const names = (list: readonly string[] | undefined, key: string) => list?.includes(key) === true

/** What a keyed write said about one key, or `undefined` when it named the key nowhere. */
const writtenFor = (write: KeyedWrite<unknown>, key: string) => {
  if (!('entries' in write))
    return names(write.keys, key)
      ? { status: write.coverage, ...(write.reason !== undefined && { reason: write.reason }) }
      : undefined
  const { entries, basis, expiry } = write
  if (Object.hasOwn(entries, key)) return { entry: entries[key], basis, expiry }
  if (write.coverage === 'complete') return { omitted: true, basis, expiry }
  if (names(write.absent, key)) return { absent: true, basis, expiry }
  return names(write.failed, key) ? { status: 'failed' } : undefined
}

const viewOf = (record: NodeRecord<unknown>, key: string) => {
  if (isKeyed(record.value)) return encode(keyRecord(record.value, key))
  if (!isKeyedWrite(record.value)) return undefined
  const written = writtenFor(record.value, key)
  return written === undefined ? undefined : encode(written)
}

/** A key's record before any write names it. */
export const unreadKey = (key: string) => encode(keyRecord(UNREAD, key))

/**
 * What a node's record says about `key`, encoded: a keyed level's record of it, the part of a keyed
 * write that names it, or the node's status once a node that spoke for the key is blocked.
 * `undefined` when the record says nothing about it.
 */
export const keyViews = (key: string) => {
  const spoke = new Set<string>()
  return (node: string, record: NodeRecord<unknown>) => {
    const view =
      viewOf(record, key) ??
      (spoke.has(node) && record.status !== 'present' ? `the node is ${record.status}` : undefined)
    if (view !== undefined) spoke.add(node)
    return view
  }
}

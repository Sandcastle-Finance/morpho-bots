import type { JournalEntry, Stamp } from '@repo/engine'
import type { KernelActivity, Notice, Refusal } from '@repo/kernel'

import type { Logger } from './logger'

type Level = keyof Logger
type Line = Readonly<{ level: Level; event: string; fields: Record<string, unknown> }>

/** A logger that keeps every line, level included. Test-only, as `@repo/kit/testing`. */
export const recordLogs = () => {
  const lines: Line[] = []
  const at =
    (level: Level) =>
    (event: string, fields: Record<string, unknown> = {}) =>
      void lines.push({ level, event, fields })
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error')
  }
  return { lines, logger }
}

type LiveLine = Readonly<{ event: string; fields: Record<string, unknown> }>
type GraphNode = Readonly<{ id: string; by: string; shape: string }>
type LiveGraph = Readonly<{
  format: number
  nodes: GraphNode[]
  operators: Readonly<{ id: string; reads: { node: string; mode: string }[]; emits?: string[] }>[]
  effects: Readonly<{ id: string; requests: string[]; samples: string[]; results?: string }>[]
}>
/** A step as a reader rebuilds it: its stamp, and the nodes it wrote in the order written. */
export type WrittenStep = Stamp & Readonly<{ nodes: readonly string[] }>

/** The last whole `live.graph` in `lines`, its parts joined in order. */
export const liveGraph = (lines: readonly LiveLine[]) => {
  const parts = lines.filter(line => line.event === 'live.graph').map(line => line.fields)
  const last = parts.findLast(part => part.last === true)
  if (!last) return undefined
  const joined: LiveGraph = { format: last.format as number, nodes: [], operators: [], effects: [] }
  for (const part of parts.filter(part => part.graph === last.graph)) {
    joined.nodes.push(...(part.nodes as LiveGraph['nodes']))
    joined.operators.push(...(part.operators as LiveGraph['operators']))
    joined.effects.push(...(part.effects as LiveGraph['effects']))
  }
  return joined
}

/** Every step `live.flow` lines name, each node by the id `graph` gives its index. */
export const liveSteps = (lines: readonly LiveLine[], graph = liveGraph(lines)) =>
  lines
    .filter(line => line.event === 'live.flow')
    .flatMap(({ fields }) => {
      let at = fields.t0 as number
      return (fields.steps as [number, number[], ...(number | string)[]][]).flatMap(
        ([seq, deltas, ...nodes]) =>
          deltas.map((delta, offset): WrittenStep => {
            at += delta
            return {
              seq: seq + offset,
              at,
              nodes: nodes.map(node => (typeof node === 'number' ? graph!.nodes[node]!.id : node))
            }
          })
      )
    })

/** Every step a journal holds, with the nodes its writes and derived writes name, as observed. */
export const journaledSteps = (entries: readonly JournalEntry[]) =>
  entries.flatMap((entry): WrittenStep[] =>
    entry.kind === 'step'
      ? [
          {
            ...entry.stamp,
            nodes: [...new Set([...entry.writes, ...entry.derived].map(write => write.node))]
          }
        ]
      : []
  )

export const TX_KEY = '0xmarket:0xborrower'
const intent = (n: number) => `${TX_KEY}#run.${n}`
export const TX_FOREIGN_INTENT = 'fill-7'

/** The fees each scenario hash bids. */
const feesOf = (hash: string) => ({
  maxFeePerGas: hash.endsWith('2') ? 9n : 5n,
  maxPriorityFeePerGas: 1n
})

const sent = (
  n: number,
  hash: string,
  nonce: number,
  status: Extract<KernelActivity, { type: 'sent' }>['status'] = 'accepted',
  kind: Extract<KernelActivity, { type: 'sent' }>['kind'] = 'step'
): KernelActivity => ({
  type: 'sent',
  intentId: intent(n),
  step: 0,
  kind,
  nonce,
  hash,
  status,
  ...feesOf(hash)
})

const notice = (
  n: number,
  kind: Exclude<Notice, 'refused'>,
  included?: { hash: string; block: number; success?: boolean }[],
  reason?: string
): KernelActivity => ({
  type: 'notice',
  intentId: intent(n),
  notice: kind,
  ...(reason !== undefined && { reason }),
  ...(included && {
    included: included.map(inclusion => ({ step: 0, success: true, ...inclusion }))
  })
})

const cancelled = (n: number, reason: string): KernelActivity => ({
  type: 'notice',
  intentId: intent(n),
  notice: 'compensated',
  code: 'cancelled',
  reason,
  included: []
})

const refused = (n: number, refusal: Refusal): KernelActivity => ({
  type: 'notice',
  intentId: intent(n),
  notice: 'refused',
  ...refusal
})

/**
 * Kernel transitions that reach every `tx.*` event, `kernel.alarm`, and every branch of the reporter: each intent
 * `n` of {@link TX_KEY} ends in a different way, and one foreign intent id is not the library's.
 */
export const TX_SCENARIO: readonly (readonly KernelActivity[])[] = [
  [notice(0, 'admitted'), sent(0, '0xa1', 5)],
  [sent(0, '0xa1', 5)],
  [sent(0, '0xa2', 5), notice(0, 'compensating')],
  [notice(0, 'settled', [{ hash: '0xa2', block: 9 }])],
  [sent(1, '0xb1', 6, 'unknown'), sent(1, '0xb2', 6, 'accepted', 'neutralizer')],
  [notice(1, 'compensated', [{ hash: '0xb2', block: 10 }])],
  [sent(2, '0xc1', 7), sent(2, '0xc3', 11)],
  [notice(2, 'abandoned', [], 'deadline passed')],
  [sent(3, '0xd1', 8, 'withheld'), sent(3, '0xd2', 8, 'rejected', 'neutralizer')],
  [
    refused(3, {
      code: 'evidence_predates_own_effect',
      reason: 'evidence 0xmarket:0xborrower predates our own effect on 0xmarket'
    })
  ],
  [refused(4, { code: 'lifecycle', reason: 'stopped' })],
  [notice(7, 'abandoned', [], 'deadline passed')],
  [notice(5, 'settled', [{ hash: '0x99', block: 11 }])],
  [
    sent(6, '0xe1', 9),
    notice(6, 'failed', [{ hash: '0xe1', block: 12, success: false }], 'reverted')
  ],
  [sent(8, '0xg1', 12), cancelled(8, 'evidence expired')],
  [
    {
      type: 'sent',
      intentId: TX_FOREIGN_INTENT,
      step: 0,
      kind: 'fill',
      nonce: 10,
      hash: '0xf1',
      status: 'accepted',
      ...feesOf('0xf1')
    },
    { type: 'notice', intentId: TX_FOREIGN_INTENT, notice: 'settled', included: [] }
  ],
  [{ type: 'alarm', reason: 'malformed clock reading' }]
]

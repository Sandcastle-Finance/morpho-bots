import type { GraphBuilder, Node } from '@repo/engine'
import type { Id, KernelState } from '@repo/kernel'

import { latest } from '@repo/engine'
import { latched, occupiesNonce, waitsAtCeiling } from '@repo/kernel'

import { parseIntentId } from './intent'

/**
 * The account's complete risk. `busy` names every key the kernel holds risk for: a send whose nonce
 * record stands until it is pruned at finality, an executing plan, or an unretired entry, `revoking`
 * and adopted ones included. `numReservations`
 * counts what holds a native reservation: every nonce until its transaction resolves, and every
 * executing plan whose current transaction is not counted through a recorded one
 * ({@link occupiesNonce}).
 * `acceptingNewWork` is whether the kernel admits new risk at all: running, and not latched on an
 * unresolved send. `conflictMarks` is the kernel's: the block of our own last inclusion or release
 * on each conflict id.
 */
export type KernelView = Readonly<{
  busy: readonly string[]
  numReservations: number
  acceptingNewWork: boolean
  conflictMarks: Readonly<Record<string, number>>
  /** How long the oldest unresolved nonce has been held, in the kernel's clock; 0 with none. */
  oldestPendingMs: number
  /** Unresolved nonces waiting at the fee ceiling ({@link waitsAtCeiling}). */
  pendingAtCeiling: number
  /** The highest max fee per gas signed at the lowest such nonce: what the base fee must fall below. */
  waitingMaxFeePerGas?: bigint
}>

/** The `tick.end` fields that say whether the account's sends are landing. */
export const pendingFields = (view: KernelView | undefined) => ({
  oldestPendingMs: view?.oldestPendingMs ?? 0,
  pendingAtCeiling: view?.pendingAtCeiling ?? 0,
  waitingMaxFeePerGasWei: view?.waitingMaxFeePerGas ?? null
})

export const isBusy = (view: KernelView | undefined, key: string) =>
  view?.busy.includes(key) === true

/**
 * What the view and the health share: reservations, unresolved nonces and the fee ceiling's wait.
 * Every field but `executing` reaches {@link KernelHealth} as it is, so none may hold free text.
 */
const pendingOf = (state: KernelState) => {
  const unresolved = Object.values(state.nonces).filter(record => !record.resolution)
  const executing = Object.values(state.plans).filter(plan => plan.status === 'executing')
  const waiting = unresolved
    .filter(record => waitsAtCeiling(state, record))
    .toSorted((a, b) => a.nonce - b.nonce)
  const fees = (waiting[0]?.candidates ?? [])
    .filter(candidate => candidate.sent !== 'withheld')
    .map(candidate => candidate.maxFeePerGas)
  return {
    executing,
    unresolvedNonces: unresolved.length,
    numReservations:
      unresolved.length + executing.filter(plan => !occupiesNonce(state, plan)).length,
    acceptingNewWork: state.lifecycle.kind === 'running' && !latched(state),
    ...(unresolved.length > 0 && {
      oldestPendingSince: Math.min(...unresolved.map(record => record.openedAt))
    }),
    pendingAtCeiling: waiting.length,
    ...(fees.length > 0 && { waitingMaxFeePerGas: fees.reduce((a, b) => (a > b ? a : b)) })
  }
}

export const viewOf = (state: KernelState): KernelView => {
  const busy = new Set<string>()
  /** The kernel's own recovery intents name no key; they count only towards `numReservations`. */
  const hold = (intentId: Id) => {
    const key = parseIntentId(intentId)?.key
    if (key !== undefined) busy.add(key)
  }
  for (const record of Object.values(state.nonces))
    for (const candidate of record.candidates) hold(candidate.intentId)
  const pending = pendingOf(state)
  for (const plan of pending.executing) hold(plan.intentId)
  for (const entry of Object.values(state.entries))
    if (entry.state !== 'retired') hold(entry.intentId)
  const since = pending.oldestPendingSince
  return {
    busy: [...busy].toSorted(),
    numReservations: pending.numReservations,
    acceptingNewWork: pending.acceptingNewWork,
    conflictMarks: state.conflictMarks,
    oldestPendingMs: since === undefined ? 0 : Math.max(0, state.now - since),
    pendingAtCeiling: pending.pendingAtCeiling,
    ...(pending.waitingMaxFeePerGas !== undefined && {
      waitingMaxFeePerGas: pending.waitingMaxFeePerGas
    })
  }
}

/** The kernel view as a node, recomputed whenever the kernel's state changes. */
export const declareView = (g: GraphBuilder, id: string, state: Node<KernelState>) =>
  g.map(id, { reads: { state: latest(state) }, compute: ({ state }) => viewOf(state) })

/**
 * A kernel's health for operators. It holds instants, never ages, so it changes when health does
 * and not at every tick, and no lifecycle `reason`, which is free text.
 */
export type KernelHealth = Readonly<{
  chainId: number
  lifecycle: KernelState['lifecycle']['kind']
  stopOutcome?: Extract<KernelState['lifecycle'], { kind: 'stopped' }>['outcome']
  acceptingNewWork: boolean
  numReservations: number
  unresolvedNonces: number
  oldestPendingSince?: number
  pendingAtCeiling: number
  waitingMaxFeePerGas?: bigint
  chainNonce?: number
  nextNonce?: number
}>

export const healthOf = (state: KernelState, chainId: number): KernelHealth => {
  const { lifecycle, chainNonce, nextNonce } = state
  const { executing: _, ...pending } = pendingOf(state)
  return {
    chainId,
    lifecycle: lifecycle.kind,
    ...(lifecycle.kind === 'stopped' && { stopOutcome: lifecycle.outcome }),
    ...pending,
    ...(chainNonce !== undefined && { chainNonce }),
    ...(nextNonce !== undefined && { nextNonce })
  }
}

/** `id` as {@link KernelHealth}, apart from the view every task family watches. */
export const declareHealth = (
  g: GraphBuilder,
  id: string,
  state: Node<KernelState>,
  { chainId }: Readonly<{ chainId: number }>
) =>
  g.map(id, { reads: { state: latest(state) }, compute: ({ state }) => healthOf(state, chainId) })

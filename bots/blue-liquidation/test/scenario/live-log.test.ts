import type { JournalEntry } from '@repo/engine'
import type { KernelEffects } from '@repo/kernel'
import type { Hex } from 'viem'

import { describeGraph } from '@repo/engine'
import { replay } from '@repo/engine/replay'
import { FakeChain } from '@repo/kernel/testing'
import { LIVE_PART_BYTES } from '@repo/kit'
import { journaledSteps, liveGraph, liveSteps } from '@repo/kit/testing'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it } from 'vitest'

import { borrowerAt, startBot, until } from './bot'

type Bot = Awaited<ReturnType<typeof startBot>>

const bots: Bot[] = []
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.shutdown()
})

const KEY: Hex = `0x${'4c'.repeat(32)}`

/** A chain whose signer signs every transaction for real with {@link KEY}, as a live bot's does. */
const signingChain = () => {
  const chain = new FakeChain()
  const fake = chain.effects
  const account = privateKeyToAccount(KEY)
  const signed = new Map<string, string>()
  const calldata: string[] = []
  const effects: KernelEffects = {
    ...fake,
    signTx: async (payload, bid, guard) => {
      const tx = await fake.signTx(payload, bid, guard)
      if (tx === 'capped') return tx
      calldata.push(payload.data)
      const raw = await account.signTransaction({
        chainId: 8453,
        type: 'eip1559',
        to: payload.to as Hex,
        data: payload.data as Hex,
        value: payload.value,
        nonce: bid.nonce,
        gas: 1_000_000n,
        maxFeePerGas: tx.bid.maxFeePerGas,
        maxPriorityFeePerGas: tx.bid.maxPriorityFeePerGas
      })
      signed.set(raw, tx.raw)
      return { ...tx, raw }
    },
    broadcast: (raw, guard) => fake.broadcast(signed.get(raw) ?? raw, guard)
  }
  chain.effects = effects
  return { chain, signed, calldata }
}

const liveLines = (bot: Bot) => bot.lines.filter(line => line.event.startsWith('live.'))

describe("the blue liquidator's live log", () => {
  it('logs live lines that hold no signed bytes, calldata, key or failure text, drained after an abandon too, rebuild every journaled step, and replays its journal unchanged', async () => {
    const { chain, signed, calldata } = signingChain()
    const journal: JournalEntry[] = []
    const bot = await startBot({
      chain,
      journal: {
        sink: { append: async entry => void journal.push(entry), finalize: async () => {} },
        capacityBytes: 10_000_000
      }
    })
    bots.push(bot)
    await until(() => bot.state().lifecycle.kind === 'running', 'the kernel running')
    bot.world.quoteFails = true
    bot.alive.add(borrowerAt(1))
    bot.chain.mine(false)
    await until(() => bot.events('quote.error').length > 0, 'a failed quote')
    bot.world.quoteFails = false
    bot.world.discoverFails = true
    bot.chain.mine(false)
    await until(() => bot.events('discover.error').length > 0, 'a failed discovery')
    bot.world.discoverFails = false
    for (const index of [2, 3]) bot.alive.add(borrowerAt(index))
    bot.mining(true)
    await until(() => bot.alive.size === 0, 'every position liquidated')
    await until(() => liveLines(bot).some(line => line.event === 'live.flow'), 'a live flow')
    await bot.shutdown()
    const before = liveLines(bot).length
    bot.live.flush()
    expect(liveLines(bot).length).toBeGreaterThan(before)

    const lines = liveLines(bot)
    const text = JSON.stringify(lines)
    expect(signed.size).toBeGreaterThan(0)
    const secrets = [
      ...[...signed.keys()].map(raw => raw.slice(2)),
      ...calldata.map(data => data.slice(10, 74)),
      KEY.slice(2),
      'the venue is down',
      'the discovery API is down',
      'reason'
    ]
    for (const secret of secrets) expect(text).not.toContain(secret)

    const graph = liveGraph(lines)
    const described = describeGraph(bot.graph)
    expect(graph?.nodes.map(node => node.id)).toStrictEqual(described.nodes.map(node => node.id))
    expect(graph?.effects.map(({ id, samples }) => ({ id, samples }))).toStrictEqual(
      described.effects.map(({ id, samples }) => ({ id, samples: samples.map(({ node }) => node) }))
    )
    expect(graph?.effects.some(effect => effect.samples.includes('kernel.state'))).toBe(true)
    expect(liveSteps(lines, graph)).toStrictEqual(journaledSteps(journal))
    for (const flow of lines.filter(line => ['live.flow', 'live.graph'].includes(line.event)))
      expect(Buffer.byteLength(JSON.stringify(flow.fields))).toBeLessThanOrEqual(LIVE_PART_BYTES)

    const journaled = JSON.stringify(journal, (_, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value
    )
    for (const raw of signed.keys()) expect(journaled).toContain(raw.slice(2))

    const replayed = replay(bot.graph, journal)
    expect(replayed).toMatchObject({ ok: true })
    expect(replayed.ok && replayed.steps).toBeGreaterThan(20)
  }, 30_000)
})

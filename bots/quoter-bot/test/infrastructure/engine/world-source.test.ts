import type { Hex } from 'viem'

import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'vitest'

import type { WorldValue } from '../../../src/application/engine/world'
import type { WorldBlock, WorldReads } from '../../../src/infrastructure/engine/world-reads'

import { LadderAdapterError } from '../../../src/errors'
import { readWorld } from '../../../src/infrastructure/engine/quoter-sources'
import { marketParams } from '../../application/engine/world.fixtures'

const maker: Hex = '0x1111111111111111111111111111111111111111'
const marketId: Hex = `0x${'11'.repeat(32)}`
const otherMarketId: Hex = `0x${'12'.repeat(32)}`
const v0Group: Hex = `0x${'aa'.repeat(32)}`
const indexedGroup: Hex = `0x${'bb'.repeat(32)}`
const EVERY_MS = 1_000

const reads = (overrides: Partial<WorldReads> = {}): WorldReads => ({
  readLatestBlock: async () => ({ number: 7n, hash: `0x${'07'.repeat(32)}`, timestamp: 1_000n }),
  readMarket: async () => {
    throw new Error('world polls read no market')
  },
  readGroups: async () => [
    {
      id: indexedGroup,
      consumed: 0n,
      cap: { kind: 'units', maximum: 10n },
      offers: [{ marketId, maker, buy: true, tick: 4_400n }]
    }
  ],
  readBook: async () => [],
  readPositions: async (ids, block) =>
    Promise.allSettled(
      ids.map(async market => ({
        marketId: market,
        credit: block.number,
        debt: 0n,
        lossFactor: 0n,
        maturity: 10_000n,
        tickSpacing: 4,
        continuousFee: 0,
        params: marketParams,
        withdrawable: 0n,
        redeemableCredit: block.number
      }))
    ),
  readCash: async () => ({ cashBalance: 50n, allowance: 50n }),
  readConsumed: async groupIds =>
    groupIds.map(groupId => (groupId === v0Group ? MAX_OFFER_CAP : 0n)),
  ...overrides
})

/** One world read at the kernel head 7, for the ladder market and, unless off, the bootstrap one. */
const poll = async (
  parameters: { reads?: WorldReads; bootstrap?: boolean; readAt?: number } = {}
) => {
  const readAt = parameters.readAt ?? 5_000
  const write = await readWorld({
    at: { number: 7, hash: `0x${'07'.repeat(32)}`, timestamp: 1_000n },
    readAt,
    ownership: {
      ladderPublications: [],
      bootstrapGroupIds: [v0Group],
      bootstrapOffers: [],
      heldBuyGroups: [],
      retiredGroupIds: []
    },
    views: {},
    reads: parameters.reads ?? reads(),
    markets: [
      { strategy: 'ladder', marketId },
      ...(parameters.bootstrap === false ? [] : [{ strategy: 'bootstrap' as const, marketId }])
    ],
    accounting: { maker, marketIds: [marketId, otherMarketId], v0OfferGroupIds: [v0Group] },
    expiry: readAt + 3 * EVERY_MS
  })
  if (write.coverage !== 'complete') throw new TypeError('the world read failed')
  return write
}

const entry = (write: Awaited<ReturnType<typeof poll>>, key: string) =>
  (write.entries as Readonly<Record<string, WorldValue>>)[key]!

describe('readWorld', () => {
  test('vouches for every configured market at the kernel head it pinned every read to', async () => {
    const blocks: WorldBlock[] = []
    const write = await poll({
      reads: reads({
        readCash: async block => {
          blocks.push(block)
          return { cashBalance: 50n, allowance: 50n }
        },
        readConsumed: async (groupIds, block) => {
          blocks.push(block)
          return groupIds.map(() => 0n)
        }
      })
    })

    expect(Object.keys(write.entries)).toEqual([`ladder:${marketId}`, `bootstrap:${marketId}`])
    expect(write.basis).toEqual({
      block: 7,
      blockHash: `0x${'07'.repeat(32)}`,
      timestamp: 1_000n,
      readAt: 5_000
    })
    const world = entry(write, `ladder:${marketId}`)
    expect(world).not.toHaveProperty('timestamp')
    const pinned = { number: 7n, hash: `0x${'07'.repeat(32)}`, timestamp: 1_000n }
    expect(blocks).toEqual([pinned, pinned])
    expect(Object.keys(world.positions)).toEqual([marketId, otherMarketId])
    expect(world.positions[otherMarketId]).toMatchObject({ ok: true, value: { credit: 7n } })
    expect(world.book).toEqual({ ok: true, value: [] })
    expect(entry(write, `bootstrap:${marketId}`).book).toBeUndefined()
  })

  test('reads consumption for every indexed, owned, and intended group', async () => {
    const asked: (readonly Hex[])[] = []
    await poll({
      reads: reads({
        readConsumed: async groupIds => {
          asked.push(groupIds)
          return groupIds.map(() => 0n)
        }
      })
    })

    expect(asked).toEqual([[indexedGroup, v0Group]])
  })

  test.each([
    ['the head, when the wall clock trails it', 5_000, 1_003n],
    ['the wall clock, when the head trails it', 1_010_000, 1_013n]
  ])('accrues redeemable credit to the read expiry by %s', async (_, readAt, redeemBy) => {
    const asked: bigint[] = []
    await poll({
      readAt,
      reads: reads({
        readPositions: async (ids, block, until) => {
          asked.push(until)
          return reads().readPositions(ids, block, until)
        }
      })
    })
    expect(asked).toEqual([redeemBy])
  })

  test('stamps the write with the expiry its poll set', async () => {
    expect((await poll()).expiry).toBe(8_000)
  })

  test('keeps a failed read as a failed value of the keys that read it', async () => {
    const write = await poll({
      reads: reads({
        readGroups: async () => {
          throw new LadderAdapterError('offer-groups-timeout')
        },
        readBook: async () => {
          throw new LadderAdapterError('book-timeout')
        }
      })
    })

    const world = entry(write, `ladder:${marketId}`)
    expect(world.groups).toEqual({
      ok: false,
      errorName: 'LadderAdapterError',
      adapterOperation: 'offer-groups-timeout'
    })
    expect(world.book).toEqual({ ok: true, value: null })
    expect(world.cash).toEqual({ ok: true, value: { cashBalance: 50n, allowance: 50n } })
  })

  test('fails every chain value when the chain no longer holds the kernel head it is pinned to', async () => {
    const held = `0x${'08'.repeat(32)}`
    const atHeld = <T>(block: WorldBlock, value: T) => {
      if (block.hash !== held) throw new TypeError('header not found')
      return value
    }
    const write = await poll({
      reads: reads({
        readPositions: async (ids, block) =>
          atHeld(
            block,
            ids.map(market => ({
              status: 'fulfilled' as const,
              value: {
                marketId: market,
                credit: 0n,
                debt: 0n,
                lossFactor: 0n,
                maturity: 10_000n,
                tickSpacing: 4,
                continuousFee: 0,
                params: marketParams,
                withdrawable: 0n,
                redeemableCredit: 0n
              }
            }))
          ),
        readCash: async block => atHeld(block, { cashBalance: 50n, allowance: 50n }),
        readConsumed: async (groupIds, block) =>
          atHeld(
            block,
            groupIds.map(() => 0n)
          )
      })
    })

    const world = entry(write, `ladder:${marketId}`)
    const failed = { ok: false, errorName: 'TypeError' }
    expect(world.positions).toEqual({ [marketId]: failed, [otherMarketId]: failed })
    expect(world.cash).toEqual(failed)
    expect(world.consumed).toEqual(failed)
  })

  test('reads every position in one call, a market that failed in it failing only its own entry', async () => {
    const asked: (readonly Hex[])[] = []
    const write = await poll({
      reads: reads({
        readPositions: async (ids, block) => {
          asked.push(ids)
          return [
            { status: 'rejected', reason: new LadderAdapterError('position-unavailable') },
            ...(await reads().readPositions(ids.slice(1), block, block.timestamp))
          ]
        }
      })
    })

    expect(asked).toEqual([[marketId, otherMarketId]])
    expect(entry(write, `ladder:${marketId}`).positions).toEqual({
      [marketId]: {
        ok: false,
        errorName: 'LadderAdapterError',
        adapterOperation: 'position-unavailable'
      },
      [otherMarketId]: { ok: true, value: expect.objectContaining({ marketId: otherMarketId }) }
    })
  })

  test('a book provider failure is a failed book, not a missing observation', async () => {
    const write = await poll({
      reads: reads({
        readBook: async () => {
          throw new TypeError('fetch failed')
        }
      })
    })

    expect(entry(write, `ladder:${marketId}`).book).toEqual({ ok: false, errorName: 'TypeError' })
  })
})

import type { Entry, KernelState } from '@repo/kernel'
import type { Address, Hex } from 'viem'

import { Offer, Tree } from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { midnightCommitmentId, midnightTreeWitness, midnightWitness } from '@repo/validators'
import { zeroAddress } from 'viem'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { Publication } from '../../../src/infrastructure/kernel/quoter-holdings'
import type { GroupCache } from '../../../src/infrastructure/kernel/quoter-ownership'

import { exposureSnapshot } from '../../../src/application/engine/exposure'
import { LadderAdapterError } from '../../../src/errors'
import {
  createQuoterOwnership,
  holdingsOf,
  liveViewOf
} from '../../../src/infrastructure/kernel/quoter-holdings'
import { accounting, world } from '../../application/engine/world.fixtures'

const CHAIN = 8453
const maker: Address = '0x00000000000000000000000000000000000000aa'
const market = {
  chainId: BigInt(CHAIN),
  midnight: getChainAddress(CHAIN, 'midnight'),
  loanToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
  collateralParams: [
    {
      token: '0x4200000000000000000000000000000000000006' as Address,
      lltv: 770_000_000_000_000_000n,
      liquidationCursor: 250_000_000_000_000_000n,
      oracle: '0x0000000000000000000000000000000000008000' as Address
    }
  ],
  maturity: BigInt(Date.UTC(2027, 0, 1, 15) / 1000),
  rcfThreshold: 0n,
  enterGate: zeroAddress,
  liquidatorGate: zeroAddress
}
const marketId: Hex = `0x${'22'.repeat(32)}`
const LADDER = `ladder:${marketId}`
const BOOTSTRAP = `bootstrap:${marketId}`

/** A one-offer tree whose group is distinct per `start`. */
const treeOf = (
  start: bigint,
  buy = true,
  cap: { maxUnits: bigint } | { maxAssets: bigint } = { maxUnits: 10n }
) =>
  Tree.create([
    Offer.create({
      market,
      buy,
      maker,
      start,
      expiry: market.maturity,
      ratifier: getChainAddress(CHAIN, 'setterRatifier'),
      tick: 6_000n,
      ...cap,
      ...(buy ? {} : { reduceOnly: true, receiverIfMakerIsSeller: maker }),
      continuousFeeCap: 0n
    })
  ])

const groupOf = (tree: Tree) => tree.offers[0]!.group.toLowerCase() as Hex

const entryOf = (tree: Tree, state: Entry['state'], intentId: string, adopted = false): Entry => ({
  spec: {
    id: midnightCommitmentId(groupOf(tree)),
    exposure: 'inclusion',
    resources: {},
    expiry: market.maturity,
    cap: 10n,
    neutralizer: { kind: 'tx', to: zeroAddress, data: '0x', value: 0n }
  },
  state,
  intentId,
  validator: 'midnight-offers@2',
  creators: [],
  deadCreators: [],
  origin: {
    payload: { kind: 'tx', to: zeroAddress, data: '0x', value: 0n },
    witness: midnightTreeWitness(tree)
  },
  consumedFinal: 0n,
  recoveryAttempts: 0,
  stuck: false,
  compensate: false,
  affirmedAt: 0,
  ...(adopted ? { adopted: true as const } : {})
})

const stateOf = (entries: readonly Entry[], executing: readonly string[] = []): KernelState =>
  ({
    entries: Object.fromEntries(entries.map(entry => [entry.spec.id, entry])),
    plans: Object.fromEntries(executing.map(intentId => [intentId, { status: 'executing' }]))
  }) as unknown as KernelState

const lower = treeOf(1n, false)
const higher = treeOf(2n)
const ladderPublication: Publication = {
  workflow: 'ladder',
  intentId: `${LADDER}#run.0`,
  marketId,
  quote: {
    marketId,
    centerRateBps: 500n,
    groupMode: 'shared-rung',
    lower: [{ index: 0, rateBps: 450n, assets: 10n }],
    higher: [{ index: 0, rateBps: 550n, assets: 10n }]
  },
  groups: [
    { groupId: groupOf(lower), side: 'lower', rungIndexes: [0], ticks: [6_000n] },
    { groupId: groupOf(higher), side: 'higher', rungIndexes: [0], ticks: [6_000n] }
  ]
}

describe('the holdings a decision reads', () => {
  test('keep a publication reserved while its plan runs, then only while the kernel holds its groups', () => {
    const intentId = ladderPublication.intentId
    const groupsOf = (state: KernelState) =>
      holdingsOf(state, [ladderPublication], { v0GroupIds: [] }).ladderPublications.map(
        publication => [publication.status, publication.groups.map(group => group.groupId)]
      )

    expect(groupsOf(stateOf([], [intentId]))).toEqual([
      ['reserved', [groupOf(lower), groupOf(higher)]]
    ])
    const retiredLower = entryOf(lower, 'retired', intentId)
    expect(groupsOf(stateOf([retiredLower], [intentId]))).toEqual([['reserved', [groupOf(higher)]]])
    expect(groupsOf(stateOf([retiredLower, entryOf(higher, 'revoking', intentId)]))).toEqual([
      ['confirmed', [groupOf(higher)]]
    ])
    expect(groupsOf(stateOf([retiredLower, entryOf(higher, 'retired', intentId)]))).toEqual([])
    expect(groupsOf(stateOf([]))).toEqual([])
  })

  test('reserve cash for every unretired buy group, revoking and adopted ones included', () => {
    const adopted = treeOf(3n)
    const ownership = holdingsOf(
      stateOf([
        entryOf(higher, 'revoking', `${LADDER}#run.0`),
        entryOf(adopted, 'live', `${LADDER}#earlier.4`, true),
        entryOf(treeOf(4n), 'retired', `${LADDER}#run.1`),
        entryOf(lower, 'live', `${LADDER}#run.0`)
      ]),
      [],
      { v0GroupIds: [] }
    )

    expect(ownership.heldBuyGroups).toEqual([
      {
        groupId: groupOf(higher),
        marketIds: [expect.any(String)],
        cap: { kind: 'units', maximum: 10n }
      },
      {
        groupId: groupOf(adopted),
        marketIds: [expect.any(String)],
        cap: { kind: 'units', maximum: 10n }
      }
    ])
    expect(ownership.ladderPublications).toEqual([])
  })

  test('own configured, published, and kernel-held bootstrap groups, and forget retired intent', () => {
    const configured: Hex = `0x${'66'.repeat(32)}`
    const published = treeOf(5n)
    const held = treeOf(6n)
    const offer = { marketId, assets: 5n, rateBps: 500n, referenceObservationId: 'r' }
    const publication: Publication = {
      workflow: 'bootstrap',
      intentId: `${BOOTSTRAP}#run.0`,
      groupId: groupOf(published),
      offer
    }
    const ownership = (entries: readonly Entry[], executing: readonly string[] = []) =>
      holdingsOf(stateOf(entries, executing), [publication], { v0GroupIds: [configured] })
    const heldEntry = entryOf(held, 'live', `${BOOTSTRAP}#earlier.1`, true)

    expect(ownership([heldEntry], [publication.intentId]).bootstrapGroupIds).toEqual([
      configured,
      groupOf(published),
      groupOf(held)
    ])
    expect(ownership([heldEntry], [publication.intentId]).bootstrapOffers).toEqual([
      { groupId: groupOf(published), ...offer }
    ])
    const retired = ownership([heldEntry, entryOf(published, 'retired', publication.intentId)])
    expect(retired.bootstrapOffers).toEqual([])
    expect(retired.bootstrapGroupIds).toEqual([configured, groupOf(held), groupOf(published)])
  })

  test('name every retired group as retired, still owned and reserving nothing, whatever retired it', () => {
    const live = treeOf(12n)
    const reasons = ['neutralized', 'filled', 'expired', 'creator did not execute'] as const
    const retired = reasons.map((reason, i) => ({
      tree: treeOf(20n + BigInt(i)),
      reason
    }))
    const ownership = holdingsOf(
      stateOf([
        entryOf(live, 'live', `${BOOTSTRAP}#run.0`),
        ...retired.map(({ tree, reason }, i) => ({
          ...entryOf(tree, 'retired', `${BOOTSTRAP}#run.${i + 1}`),
          retiredBy: reason
        }))
      ]),
      [],
      { v0GroupIds: [] }
    )
    const retiredIds = retired.map(({ tree }) => groupOf(tree))

    expect(ownership.retiredGroupIds).toEqual(retiredIds)
    expect(ownership.bootstrapGroupIds).toEqual([groupOf(live), ...retiredIds])
    expect(ownership.heldBuyGroups.map(group => group.groupId)).toEqual([groupOf(live)])
  })

  test('never name a retired cash-capped buy retired, so exposure still fails closed on it', () => {
    const cashCapped = treeOf(30n, true, { maxAssets: 10n })
    const ownership = holdingsOf(
      stateOf([
        {
          ...entryOf(cashCapped, 'retired', `${BOOTSTRAP}#earlier.0`, true),
          retiredBy: 'filled'
        }
      ]),
      [],
      { v0GroupIds: [] }
    )

    expect(ownership.bootstrapGroupIds).toEqual([groupOf(cashCapped)])
    expect(ownership.retiredGroupIds).toEqual([])
    expect(() =>
      exposureSnapshot(
        world({ ownership, consumed: { [groupOf(cashCapped)]: 10n } }),
        accounting,
        LadderAdapterError
      )
    ).toThrow(expect.objectContaining({ operation: 'missing-owned-group-intent' }))
  })

  test('name every group the kernel holds or retired as owned, and the withdrawing ones as withdrawn', () => {
    const adopted = treeOf(7n)
    const state = stateOf([
      entryOf(adopted, 'live', `${LADDER}#earlier.0`, true),
      entryOf(lower, 'retired', `${LADDER}#run.0`),
      entryOf(higher, 'revoking', `${LADDER}#run.0`)
    ])
    const ownership = createQuoterOwnership(
      () => state,
      () => [],
      { v0GroupIds: [] }
    )

    expect(ownership.ownedGroupIds()).toEqual([groupOf(adopted), groupOf(lower), groupOf(higher)])
    expect(ownership.withdrawnGroupIds()).toEqual([groupOf(lower), groupOf(higher)])
  })

  test("count only a market's own exposed and live entries from this run as its live book", () => {
    const own = treeOf(8n)
    const state = stateOf([
      entryOf(own, 'live', `${LADDER}#run.0`),
      entryOf(treeOf(9n), 'live', `${LADDER}#earlier.0`, true),
      entryOf(treeOf(10n), 'revoking', `${LADDER}#run.1`),
      entryOf(treeOf(11n), 'live', `${BOOTSTRAP}#run.0`)
    ])

    expect(liveViewOf(state, LADDER)).toEqual({
      live: [
        { id: midnightCommitmentId(groupOf(own)), detail: { groupId: groupOf(own), buy: true } }
      ]
    })
  })
})

describe('decoded groups shared across reads', () => {
  afterEach(() => vi.restoreAllMocks())

  const configured: Hex = `0x${'66'.repeat(32)}`
  const units = treeOf(40n)
  const cash = treeOf(41n, true, { maxAssets: 10n })
  const sell = treeOf(42n, false)
  const bootstrapHeld = treeOf(43n)
  const handedBack = treeOf(44n)
  const intentId = ladderPublication.intentId
  const bootstrapPublication: Publication = {
    workflow: 'bootstrap',
    intentId: `${BOOTSTRAP}#run.0`,
    groupId: groupOf(bootstrapHeld),
    offer: { marketId, assets: 5n, rateBps: 500n, referenceObservationId: 'r' }
  }
  const publications = [ladderPublication, bootstrapPublication]
  const steps: KernelState[] = [
    stateOf([], [intentId]),
    stateOf(
      [
        entryOf(lower, 'exposed', intentId),
        entryOf(higher, 'exposed', intentId),
        entryOf(units, 'live', `${LADDER}#run.1`),
        entryOf(cash, 'live', `${BOOTSTRAP}#earlier.0`, true),
        entryOf(handedBack, 'live', `${LADDER}#run.2`)
      ],
      [intentId]
    ),
    stateOf([
      entryOf(lower, 'live', intentId),
      entryOf(higher, 'live', intentId),
      entryOf(units, 'retired', `${LADDER}#run.1`),
      { ...entryOf(cash, 'retired', `${BOOTSTRAP}#earlier.0`, true), retiredBy: 'filled' },
      entryOf(handedBack, 'revoking', `${LADDER}#run.2`),
      entryOf(bootstrapHeld, 'live', bootstrapPublication.intentId)
    ]),
    stateOf([
      entryOf(lower, 'retired', intentId),
      entryOf(higher, 'revoking', intentId),
      entryOf(sell, 'live', `${LADDER}#run.3`),
      entryOf(handedBack, 'live', `${LADDER}#run.2`),
      entryOf(bootstrapHeld, 'live', bootstrapPublication.intentId)
    ]),
    stateOf([entryOf(sell, 'retired', `${LADDER}#run.3`)])
  ]
  const readAll = (state: KernelState, cache?: GroupCache) => {
    const ownership = createQuoterOwnership(
      () => state,
      () => publications,
      { v0GroupIds: [configured], cache }
    )
    return {
      holdings: holdingsOf(state, publications, { v0GroupIds: [configured], cache }),
      current: ownership.current(),
      owned: ownership.ownedGroupIds(),
      withdrawn: ownership.withdrawnGroupIds(),
      ladder: liveViewOf(state, LADDER, cache),
      bootstrap: liveViewOf(state, BOOTSTRAP, cache)
    }
  }

  test('read exactly what an uncached read gives, over cloned states', () => {
    const cache: GroupCache = new Map()
    for (const state of [...steps, ...steps])
      expect(readAll(structuredClone(state), cache)).toEqual(readAll(state))
  })

  test('decode each commitment once across many reads of cloned states', () => {
    const create = vi.spyOn(Tree, 'create')
    const cache: GroupCache = new Map()
    const state = steps[2]!
    for (let i = 0; i < 20; i++) readAll(structuredClone(state), cache)

    expect(create).toHaveBeenCalledTimes(Object.keys(state.entries).length)
  })

  test('hold only the entries the latest state holds', () => {
    const cache: GroupCache = new Map()
    for (const state of steps) {
      readAll(structuredClone(state), cache)
      expect([...cache.keys()].toSorted()).toEqual(Object.keys(state.entries).toSorted())
    }
    holdingsOf(stateOf([]), [], { v0GroupIds: [], cache })
    expect(cache.size).toBe(0)
  })

  test('decode a commitment again when its id returns with another witness', () => {
    const later = { ...market, maturity: market.maturity + 86_400n }
    const offers = [market, later].map(on =>
      Offer.create({
        market: on,
        buy: true,
        maker,
        start: 46n,
        expiry: on.maturity,
        ratifier: getChainAddress(CHAIN, 'setterRatifier'),
        tick: 6_000n,
        maxUnits: 10n,
        continuousFeeCap: 0n
      })
    )
    const forward = Tree.create(midnightWitness([{ offers }]))
    const reversed = Tree.create(midnightWitness([{ offers: offers.toReversed() }]))
    expect(groupOf(reversed)).toBe(groupOf(forward))
    const cache: GroupCache = new Map()
    const marketIdsOf = (tree: Tree, through: readonly KernelState[] = []) => {
      for (const state of through) holdingsOf(state, [], { v0GroupIds: [], cache })
      const state = stateOf([entryOf(tree, 'live', `${LADDER}#run.4`)])
      return holdingsOf(structuredClone(state), [], { v0GroupIds: [], cache }).heldBuyGroups[0]
        ?.marketIds
    }
    const uncached = (tree: Tree) =>
      holdingsOf(stateOf([entryOf(tree, 'live', `${LADDER}#run.4`)]), [], { v0GroupIds: [] })
        .heldBuyGroups[0]?.marketIds

    expect(uncached(reversed)).not.toEqual(uncached(forward))
    expect(marketIdsOf(forward)).toEqual(uncached(forward))
    expect(marketIdsOf(reversed)).toEqual(uncached(reversed))
    expect(marketIdsOf(forward, [stateOf([])])).toEqual(uncached(forward))
  })
})

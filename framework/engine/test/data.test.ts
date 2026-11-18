import { describe, expect, it } from 'vitest'

import type { JournalEntry } from '../src/index'

import {
  createGraph,
  createRunner,
  decode,
  encode,
  every,
  latest,
  NotDataError
} from '../src/index'

describe('encode', () => {
  it('encodes equal data identically whatever the field order', () => {
    expect(encode({ b: 1, a: [true, null, 'x'] })).toBe(encode({ a: [true, null, 'x'], b: 1 }))
  })

  it('drops undefined fields', () => {
    expect(encode({ a: 1, b: undefined })).toBe(encode({ a: 1 }))
  })

  it('round-trips bigints', () => {
    const value = { amount: 12345678901234567890123n, nested: [-1n] }
    expect(decode(encode(value))).toStrictEqual(value)
  })

  it('tells a bigint from the same digits as a number or string', () => {
    expect(encode(5n)).not.toBe(encode(5))
    expect(encode(5n)).not.toBe(encode('5'))
  })

  it.each([
    ['a Map', new Map()],
    ['a Date', new Date(0)],
    ['NaN', Number.NaN],
    ['a function', () => 1],
    ['undefined in a list', [1, undefined]],
    ['the reserved bigint field', { $bigint: '1' }]
  ])('refuses %s', (_, value) => {
    expect(() => encode(value)).toThrow(NotDataError)
  })
})

class Position {
  constructor(readonly debt: number) {}
}

describe('fold state', () => {
  it.each([
    ['a Map', new Map([['a', 1]])],
    ['a Set', new Set([1])],
    ['a class instance', new Position(1)]
  ])('refuses %s, stopping the runner and keeping the state it had', async (_, held) => {
    const g = createGraph('fold-state')
    const ticks = g.occurrences<number>('ticks')
    const initial: Readonly<{ held?: unknown }> = {}
    const state = g.fold('state', {
      reads: { tick: every(ticks) },
      initial,
      applyInput: () => ({ state: { held } })
    })
    const runner = createRunner(g.build())
    runner.push(ticks, 1)
    await expect(runner.stopped).rejects.toBeInstanceOf(NotDataError)
    expect(runner.read(state)).toStrictEqual({})
  })
})

describe('a derived value', () => {
  it('refuses undefined, stopping the runner without recording it', async () => {
    const g = createGraph('derived-undefined')
    const price = g.level<number>('price')
    const derived = g.map('derived', {
      reads: { price: latest(price) },
      compute: () => undefined as unknown as number
    })
    const runner = createRunner(g.build())
    runner.push(price, { value: 1, basis: { block: 1 } })
    await expect(runner.stopped).rejects.toBeInstanceOf(NotDataError)
    expect(runner.read(derived)).toBeUndefined()
  })
})

describe('an accessor', () => {
  let calls = 0
  const counted = () => {
    calls += 1
    return 1
  }

  it.each([
    [
      'a getter',
      () => ({
        get a() {
          return counted()
        }
      })
    ],
    [
      'a setter alone',
      () => ({
        set a(_: number) {
          counted()
        }
      })
    ],
    [
      'a nested getter',
      () => ({
        outer: [
          {
            get a() {
              return counted()
            }
          }
        ]
      })
    ],
    [
      'an array index getter',
      () => Object.defineProperty([0], 0, { get: counted, enumerable: true })
    ],
    [
      'a non-enumerable array index getter',
      () => Object.defineProperty([0], 0, { get: counted, enumerable: false })
    ],
    [
      "a getter beside an array's items",
      () =>
        Object.assign([1], {
          extra: {
            get x() {
              return counted()
            }
          }
        })
    ]
  ])('refuses %s as not data without running it', (_, make) => {
    calls = 0
    expect(() => encode(make())).toThrow(NotDataError)
    expect(calls).toBe(0)
  })

  const withAmount = (amount: (self: object, reads: number) => unknown) => {
    let reads = 0
    return {
      get amount() {
        reads += 1
        return amount(this, reads)
      }
    }
  }

  it.each([
    ['2 once frozen, else 1', (self: object) => (Object.isFrozen(self) ? 2 : 1)],
    ['a Map once frozen, else 1', (self: object) => (Object.isFrozen(self) ? new Map() : 1)],
    ['1 once frozen, else a Map', (self: object) => (Object.isFrozen(self) ? 1 : new Map())],
    ['2 from its third read, else 1', (_: object, reads: number) => (reads >= 3 ? 2 : 1)]
  ])(
    'refuses a derived value whose getter returns %s, keeping the one before',
    async (_, amount) => {
      const g = createGraph('derived-getter')
      const price = g.level<number>('price')
      const derived = g.map('derived', {
        reads: { price: latest(price) },
        compute: ({ price }) =>
          (price === 1 ? { amount: 1 } : withAmount(amount)) as { amount: number }
      })
      const runner = createRunner(g.build())
      runner.push(price, { value: 1, basis: { block: 1 } })
      runner.push(price, { value: 2, basis: { block: 2 } })
      await expect(runner.stopped).rejects.toBeInstanceOf(NotDataError)
      expect(runner.read(derived)).toStrictEqual({ amount: 1 })
    }
  )
})

describe('refusing a derived value', () => {
  it.each([
    ['a non-enumerable item', () => Object.defineProperty([{ x: 1 }], 0, { enumerable: false })],
    ['a hole', () => Object.assign(Array(3), { 0: 1, 2: 3 })],
    ['a field besides its items', () => Object.assign([1], { extra: 1 })],
    ['a symbol-keyed field', () => Object.assign([1], { [Symbol('tag')]: 1 })],
    ['a subclass prototype', () => new (class extends Array<number> {})()]
  ])('refuses a list with %s as not data', (_, make) => {
    expect(() => encode(make())).toThrow(NotDataError)
  })

  it('checks it is data before its expiries', async () => {
    const g = createGraph('data-before-expiry')
    const price = g.level<number>('price')
    let expiries = 0
    g.map(
      'derived',
      { reads: { price: latest(price) }, compute: () => ({ held: new Map() }) as never },
      {
        expiries: () => {
          expiries += 1
          return [Number.NaN]
        }
      }
    )
    const runner = createRunner(g.build())
    runner.push(price, { value: 1, basis: { block: 1 } })
    await expect(runner.stopped).rejects.toBeInstanceOf(NotDataError)
    expect(expiries).toBe(0)
  })

  it('overflows on a cycle rather than refusing it as not data', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() => encode(cyclic)).toThrow(RangeError)
  })
})

describe('a plain derived value', () => {
  it('digests, coalesces and journals as it did before accessors were refused', async () => {
    const g = createGraph('plain-derived')
    const price = g.level<number>('price')
    const plain = g.map('plain', {
      reads: { price: latest(price) },
      compute: () => ({ b: [1, -0], a: { x: 1n }, c: undefined })
    })
    let evaluations = 0
    g.map('after', {
      reads: { plain: latest(plain) },
      compute: () => (evaluations += 1)
    })
    const entries: JournalEntry[] = []
    const runner = createRunner(g.build(), {
      now: () => 1_000,
      journal: {
        sink: { append: async entry => void entries.push(entry), finalize: async () => undefined },
        capacityBytes: 64_000
      }
    })
    runner.push(price, { value: 1, basis: { block: 1 } })
    runner.push(price, { value: 2, basis: { block: 2 } })
    expect(evaluations).toBe(1)
    expect(runner.record(plain)?.digest).toMatchInlineSnapshot(
      `"7892fb86b34d64497333128ebc60c550f8e71d2891f0ccf427590f1ee1380513"`
    )
    await runner.abandon()
    expect(entries).toMatchInlineSnapshot(`
      [
        {
          "derived": [
            {
              "digest": "7892fb86b34d64497333128ebc60c550f8e71d2891f0ccf427590f1ee1380513",
              "node": "plain",
            },
            {
              "digest": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
              "node": "after",
            },
          ],
          "kind": "step",
          "stamp": {
            "at": 1000,
            "seq": 1,
          },
          "writes": [
            {
              "node": "price",
              "value": {
                "basis": {
                  "block": 1,
                },
                "value": 1,
              },
            },
          ],
        },
        {
          "derived": [],
          "kind": "step",
          "stamp": {
            "at": 1000,
            "seq": 2,
          },
          "writes": [
            {
              "node": "price",
              "value": {
                "basis": {
                  "block": 2,
                },
                "value": 2,
              },
            },
          ],
        },
      ]
    `)
  })
})

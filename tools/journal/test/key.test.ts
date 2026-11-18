import { describe, expect, it } from 'vitest'

import { keyViews } from '../src/key'

const present = (value: unknown) => ({ status: 'present', value }) as const

describe('keyViews', () => {
  it('reads a keyed level, and the part of a keyed write that names the key', () => {
    const views = keyViews('a')
    expect(
      views('level', present({ coverage: { status: 'complete' }, absentBasis: 1, keys: {} }))
    ).toBe('{"basis":1,"status":"absent"}')
    expect(
      views('reads', present({ coverage: 'carried', entries: { a: 1 }, absent: ['b'], basis: 2 }))
    ).toBe('{"basis":2,"entry":1}')
    expect(views('reads', present({ coverage: 'failed', keys: ['a'] }))).toBe('{"status":"failed"}')
    expect(views('reads', present({ coverage: 'unknown', keys: ['a'], reason: 'rpc down' }))).toBe(
      '{"reason":"rpc down","status":"unknown"}'
    )
  })

  it("keeps a complete write's expiry for a key it omits", () => {
    const views = keyViews('a')
    const omitted = (expiry: number) =>
      views('reads', present({ coverage: 'complete', entries: { b: 1 }, basis: 2, expiry }))
    expect(omitted(100)).toBe('{"basis":2,"expiry":100,"omitted":true}')
    expect(omitted(200)).not.toBe(omitted(100))
  })

  it('says nothing for a write that never names the key', () => {
    const views = keyViews('a')
    expect(views('reads', present({ coverage: 'carried', entries: { b: 1 }, basis: 2 }))).toBe(
      undefined
    )
    expect(views('reads', { status: 'failed' })).toBe(undefined)
    expect(views('other', present({ a: 1 }))).toBe(undefined)
  })

  it('reports a node blocked after it spoke for the key, keyed level or keyed write alike', () => {
    const views = keyViews('a')
    views('level', present({ coverage: { status: 'unknown' }, keys: {} }))
    views('writes', present({ coverage: 'complete', entries: { a: 1 }, basis: 1 }))

    expect(views('level', { status: 'unknown' })).toBe('the node is unknown')
    expect(views('writes', { status: 'failed' })).toBe('the node is failed')
    expect(views('writes', present({ coverage: 'carried', entries: {}, basis: 2 }))).toBe(undefined)
  })
})

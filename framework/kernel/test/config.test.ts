import { createGraph } from '@repo/engine'
import { describe, expect, it } from 'vitest'

import type { KernelChain, KernelEffects, KernelHostOptions } from '../src'

import { declareKernel } from '../src'
import { KernelConfigError } from '../src/errors'
import { makeConfig } from './fixtures'

const MAX_BLOCKS = 2 ** 32
const MAX_INTEGER = Number.MAX_SAFE_INTEGER
const MAX_TIMER_MS = 2 ** 31 - 1
const DEGENERATE = [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1.5, '3', 3n]

const refuse = () => {
  throw new Error('construction ran an effect')
}

const hostOptions = (overrides: Partial<KernelHostOptions> = {}): KernelHostOptions => ({
  config: makeConfig(),
  store: { read: refuse, write: refuse },
  chain: new Proxy({} as KernelChain, { get: () => refuse }),
  effects: new Proxy({} as KernelEffects, { get: () => refuse }),
  enrollment: 'enrolling',
  pollMs: 5,
  effectTimeoutMs: 1_000,
  reorgDepth: 16,
  onError: refuse,
  ...overrides
})

const declare = (overrides: Partial<KernelHostOptions>) => () =>
  declareKernel(createGraph('kernel'), hostOptions(overrides))

describe('a kernel host refuses its configuration', () => {
  it.each([
    ['maxSimLagBlocks', 0, MAX_BLOCKS],
    ['maxEvidenceAgeBlocks', 0, MAX_BLOCKS],
    ['stuckBlocks', 1, MAX_BLOCKS],
    ['latchBoundBlocks', 0, MAX_BLOCKS],
    ['recoveryBoundMs', 1, MAX_INTEGER],
    ['revokeAfterStaleMs', 1, MAX_INTEGER],
    ['maxRecoveryAttempts', 1, MAX_INTEGER],
    ['maxDispatchLagMs', 1, MAX_INTEGER]
  ] as const)('refuses a %s that is not an integer in [%d, %d], naming both', (name, min, max) => {
    const build = (value: unknown) => declare({ config: makeConfig({ [name]: value }) })
    for (const value of [...DEGENERATE, min - 1, max + 1])
      expect(build(value)).toThrow(
        new KernelConfigError(`${name} must be an integer in [${min}, ${max}]`)
      )
    expect(build(min)).not.toThrow()
    expect(build(max)).not.toThrow()
  })

  it('refuses a fee reserve that is not a positive bigint', () => {
    for (const feeReserve of [undefined, 0n, -1n, 1, Number.NaN])
      expect(declare({ config: makeConfig({ feeReserve: feeReserve as bigint }) })).toThrow(
        new KernelConfigError('feeReserve must be a positive bigint')
      )
    expect(declare({ config: makeConfig({ feeReserve: 1n }) })).not.toThrow()
  })
})

describe('kernel host options', () => {
  it.each([
    ['pollMs', 1, MAX_TIMER_MS],
    ['effectTimeoutMs', 1, MAX_TIMER_MS],
    ['reorgDepth', 1, MAX_BLOCKS]
  ] as const)('refuses a %s that is not an integer in [%d, %d], naming both', (name, min, max) => {
    for (const value of [...DEGENERATE, min - 1, max + 1])
      expect(declare({ [name]: value })).toThrow(
        new KernelConfigError(`${name} must be an integer in [${min}, ${max}]`)
      )
    expect(declare({ [name]: min })).not.toThrow()
    expect(declare({ [name]: max })).not.toThrow()
  })
})

import { EvidenceDefectError } from '@repo/controller'
import {
  CycleBoundError,
  LaneOverflowError,
  NotDataError,
  PolicyReentryError,
  ReentrantPushError,
  RequestRefusedError,
  WriteRefusedError
} from '@repo/engine'
import { describe, expect, it } from 'vitest'

import { QuoteTimeoutError } from '../src/errors'
import { describeFailure } from '../src/failure'

const LEAK = 'https://rpc.example/v2/sk_live_secret 0xabcdef'

describe('describing a journaled failure', () => {
  it.each([
    ['cycle_bound', new CycleBoundError(100, 'node')],
    ['lane_overflow', new LaneOverflowError('lane', 4)],
    ['not_data', new NotDataError('value', LEAK)],
    ['policy_reentry', new PolicyReentryError('effect')],
    ['reentrant_push', new ReentrantPushError('node')],
    ['request_refused', new RequestRefusedError('effect', LEAK)],
    ['write_refused', new WriteRefusedError('node', LEAK)],
    ['evidence_defect', new EvidenceDefectError(LEAK)]
  ])('describes %s by its class alone', (code, error) => {
    expect(describeFailure(error)).toBe(code)
  })

  it('names anything else unknown, whatever its message, name or constructor carries', () => {
    const leaky = Object.assign(new Error(LEAK), {
      name: LEAK,
      constructor: { name: 'sk_live_secret' }
    })
    expect(describeFailure(leaky)).toBe('unknown')
    expect(describeFailure(Object.assign(new QuoteTimeoutError(), { message: LEAK }))).toBe(
      'unknown'
    )
    expect(describeFailure(LEAK)).toBe('unknown')
    expect(describeFailure(undefined)).toBe('unknown')
  })
})

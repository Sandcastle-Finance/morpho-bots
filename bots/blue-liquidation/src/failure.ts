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

/** The classes that can stop the running graph; blue's own errors and signing failures are caught first. */
const FAILURE_CODES = [
  [CycleBoundError, 'cycle_bound'],
  [LaneOverflowError, 'lane_overflow'],
  [NotDataError, 'not_data'],
  [PolicyReentryError, 'policy_reentry'],
  [ReentrantPushError, 'reentrant_push'],
  [RequestRefusedError, 'request_refused'],
  [WriteRefusedError, 'write_refused'],
  [EvidenceDefectError, 'evidence_defect']
] as const

type FailureCode = (typeof FAILURE_CODES)[number][1] | 'unknown'

/** A journaled failure's cause, by its error's class alone, so no error text reaches the journal. */
export const describeFailure = (error: unknown): FailureCode =>
  FAILURE_CODES.find(([type]) => error instanceof type)?.[1] ?? 'unknown'

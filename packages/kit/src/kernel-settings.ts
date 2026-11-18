import type { Chain } from 'viem'

import { parseEther, parseGwei } from 'viem'

import type { JournalBuildIdentity } from './journal-file'
import type { Finality } from './kernel-chain'

import { InvalidKernelSettingError } from './errors'
import { feeCeiling, stepCap } from './fee-policy'
import { buildIdentityFromEnv, parseJournalRunCapBytes } from './journal-file'
import { parseFinality } from './kernel-chain'
import { DEFAULT_MAX_GAS_LIMIT } from './policy'
import { assertFinalityInWindow } from './transaction-kernel'

type Env = Readonly<Record<string, string | undefined>>

/** Below the intrinsic cost of any transaction, the signer policy would refuse every send. */
const MIN_GAS_LIMIT = 21_000n
/** Whole wei only: digits past a unit's decimals may only be trailing zeros. */
const GWEI_AMOUNT = /^\d+(\.\d{1,9}0*)?$/
const ETHER_AMOUNT = /^\d+(\.\d{1,18}0*)?$/
const WHOLE_NUMBER = /^\d+$/

/** What a transaction kernel bot runs under, read once at startup by {@link parseKernelSettings}. */
export type KernelSettings = Readonly<{
  maxFeePerGasWei: bigint
  /** What one transaction may spend on fees, and so what the kernel reserves per unresolved nonce. */
  maxSpendWei: bigint
  maxGasLimit: bigint
  finality: Finality
  /** Holds the kernel's ledger and the journal, and must survive a restart. */
  stateDirectory: string
  /** `enrolling` for the first start of a fresh account, `enrolled` for every later one. */
  enrollment: 'enrolling' | 'enrolled'
  journal: Readonly<{ build: JournalBuildIdentity; runCapBytes: number }>
}>

/**
 * Where the spend bounds come from: `configured` requires `MAX_SPEND_ETH` and `MAX_GAS_LIMIT`, and
 * `fee-cap` prices the policy's default gas ceiling at `MAX_FEE_GWEI`.
 */
type SpendBounds = 'configured' | 'fee-cap'

/** Whether a step can bid one bump below the nonce fill these bounds fund; see {@link stepCap}. */
export const fundsStepBid = (maxFeePerGasWei: bigint, maxSpendWei: bigint) =>
  stepCap(feeCeiling(maxFeePerGasWei, maxSpendWei)) > 0n

const required = (env: Env, name: string) => {
  const value = env[name]?.trim()
  if (!value) throw new InvalidKernelSettingError(name, 'must be set')
  return value
}

const spendBounds = (env: Env, source: SpendBounds, maxFeePerGasWei: bigint) => {
  if (source === 'fee-cap')
    return {
      maxSpendWei: maxFeePerGasWei * DEFAULT_MAX_GAS_LIMIT,
      maxGasLimit: DEFAULT_MAX_GAS_LIMIT
    }
  const spend = required(env, 'MAX_SPEND_ETH')
  const maxSpendWei = ETHER_AMOUNT.test(spend) ? parseEther(spend) : 0n
  if (maxSpendWei === 0n)
    throw new InvalidKernelSettingError(
      'MAX_SPEND_ETH',
      'must be an ether amount of at least one wei, with no fraction of a wei'
    )
  const gas = required(env, 'MAX_GAS_LIMIT')
  if (!WHOLE_NUMBER.test(gas) || BigInt(gas) < MIN_GAS_LIMIT)
    throw new InvalidKernelSettingError(
      'MAX_GAS_LIMIT',
      `must be a whole number, at least ${MIN_GAS_LIMIT}`
    )
  return { maxSpendWei, maxGasLimit: BigInt(gas) }
}

/**
 * Reads a transaction kernel bot's settings from `env` for `chain`, all required, and refuses
 * bounds the kernel could not run under: fees that fund no step bid, or a finality depth outside
 * the reorg window.
 * @throws InvalidKernelSettingError, FinalityBeyondWindowError, MissingBuildIdentityError or
 * InvalidJournalRunCapError, each naming the setting; only the finality error echoes a value.
 */
export const parseKernelSettings = (
  env: Env,
  chain: Pick<Chain, 'id'>,
  options: Readonly<{ spendBounds: SpendBounds }>
): KernelSettings => {
  const maxFee = required(env, 'MAX_FEE_GWEI')
  const maxFeePerGasWei = GWEI_AMOUNT.test(maxFee) ? parseGwei(maxFee) : 0n
  if (maxFeePerGasWei === 0n)
    throw new InvalidKernelSettingError(
      'MAX_FEE_GWEI',
      'must be a gwei amount of at least one wei, with no fraction of a wei'
    )
  const { maxSpendWei, maxGasLimit } = spendBounds(env, options.spendBounds, maxFeePerGasWei)
  if (!fundsStepBid(maxFeePerGasWei, maxSpendWei))
    throw new InvalidKernelSettingError(
      options.spendBounds === 'configured' ? 'MAX_FEE_GWEI with MAX_SPEND_ETH' : 'MAX_FEE_GWEI',
      'cannot fund a nonce fill and a step bid below it'
    )
  const finalityName = `FINALITY_${chain.id}`
  const finality = parseFinality(required(env, finalityName))
  if (finality === undefined)
    throw new InvalidKernelSettingError(
      finalityName,
      'must be safe, finalized, or a positive block depth'
    )
  assertFinalityInWindow(chain, finality)
  const enrollment = required(env, 'KERNEL_ENROLLMENT')
  if (enrollment !== 'enrolling' && enrollment !== 'enrolled')
    throw new InvalidKernelSettingError('KERNEL_ENROLLMENT', 'must be enrolling or enrolled')
  return {
    maxFeePerGasWei,
    maxSpendWei,
    maxGasLimit,
    finality,
    stateDirectory: required(env, 'KERNEL_STATE_DIR'),
    enrollment,
    journal: {
      build: buildIdentityFromEnv(env),
      runCapBytes: parseJournalRunCapBytes(env.JOURNAL_RUN_CAP_BYTES)
    }
  }
}

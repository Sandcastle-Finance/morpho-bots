import type { Chain } from 'viem'

import { parseEther, parseGwei } from 'viem'
import { base, mainnet } from 'viem/chains'
import { describe, expect, it } from 'vitest'

import {
  FinalityBeyondWindowError,
  InvalidJournalRunCapError,
  InvalidKernelSettingError,
  MissingBuildIdentityError
} from '../src/errors'
import { parseKernelSettings } from '../src/kernel-settings'
import { DEFAULT_MAX_GAS_LIMIT } from '../src/policy'

const ENV = {
  MAX_FEE_GWEI: '0.5',
  MAX_SPEND_ETH: '0.0075',
  MAX_GAS_LIMIT: '15000000',
  FINALITY_8453: 'safe',
  KERNEL_STATE_DIR: '/state',
  KERNEL_ENROLLMENT: 'enrolled',
  JOURNAL_RUN_CAP_BYTES: '1073741824',
  BUILD_REVISION: '0d58dd8e5',
  BUILD_IMAGE_TAG: 'bot-test'
}

const configured = (
  overrides: Record<string, string | undefined> = {},
  chain: Pick<Chain, 'id'> = base
) => parseKernelSettings({ ...ENV, ...overrides }, chain, { spendBounds: 'configured' })
const feeCapped = (overrides: Record<string, string | undefined> = {}) =>
  parseKernelSettings({ ...ENV, ...overrides }, base, { spendBounds: 'fee-cap' })

const refusal = (parse: () => unknown) => {
  try {
    parse()
  } catch (error) {
    return error
  }
  throw new Error('parsed')
}

describe('parseKernelSettings', () => {
  it('reads every setting a transaction kernel bot runs under', () => {
    expect(configured({ MAX_FEE_GWEI: ' 0.5 ', KERNEL_STATE_DIR: ' /state ' })).toStrictEqual({
      maxFeePerGasWei: parseGwei('0.5'),
      maxSpendWei: parseEther('0.0075'),
      maxGasLimit: 15_000_000n,
      finality: 'safe',
      stateDirectory: '/state',
      enrollment: 'enrolled',
      journal: {
        build: { revision: '0d58dd8e5', imageTag: 'bot-test' },
        runCapBytes: 1_073_741_824
      }
    })
  })

  it('reads amounts with trailing zeros past their whole wei', () => {
    const settings = configured({
      MAX_FEE_GWEI: '0.5000000000',
      MAX_SPEND_ETH: '0.0075000000000000000'
    })
    expect(settings.maxFeePerGasWei).toBe(parseGwei('0.5'))
    expect(settings.maxSpendWei).toBe(parseEther('0.0075'))
  })

  it('prices the default gas ceiling at the fee cap when the bot configures no spend bounds', () => {
    const settings = feeCapped({ MAX_SPEND_ETH: undefined, MAX_GAS_LIMIT: undefined })
    expect(settings.maxGasLimit).toBe(DEFAULT_MAX_GAS_LIMIT)
    expect(settings.maxSpendWei).toBe(parseGwei('0.5') * DEFAULT_MAX_GAS_LIMIT)
  })

  it.each([
    'MAX_FEE_GWEI',
    'MAX_SPEND_ETH',
    'MAX_GAS_LIMIT',
    'FINALITY_8453',
    'KERNEL_STATE_DIR',
    'KERNEL_ENROLLMENT'
  ])('refuses a missing or blank %s, naming it', name => {
    for (const value of [undefined, '  ']) {
      const error = refusal(() => configured({ [name]: value }))
      expect(error).toBeInstanceOf(InvalidKernelSettingError)
      expect(error).toMatchObject({ setting: name, message: `${name} must be set` })
    }
  })

  it.each([
    ['MAX_FEE_GWEI', ['0', '0.0000000004', '1.0000000001', '-1', '1e3', '0x10', '.5']],
    ['MAX_SPEND_ETH', ['0', '0.0000000000000000001', '-1', '1e-3', 'abc']],
    ['MAX_GAS_LIMIT', ['20999', '1.5', '-21000', '0x5208']],
    ['FINALITY_8453', ['latest', '0', '-1', '1.5', '1000000']],
    ['KERNEL_ENROLLMENT', ['Enrolled', 'yes']]
  ] as const)('refuses an out-of-range %s without echoing it', (name, values) => {
    for (const value of values) {
      const error = refusal(() => configured({ [name]: value }))
      expect(error).toBeInstanceOf(InvalidKernelSettingError)
      expect(error).toMatchObject({ setting: name })
      expect((error as Error).message).not.toContain(value)
    }
  })

  it('refuses fee bounds that fund no step bid below a nonce fill', () => {
    expect(
      refusal(() => configured({ MAX_FEE_GWEI: '0.5', MAX_SPEND_ETH: '0.0000000000001' }))
    ).toMatchObject({
      setting: 'MAX_FEE_GWEI with MAX_SPEND_ETH',
      message: 'MAX_FEE_GWEI with MAX_SPEND_ETH cannot fund a nonce fill and a step bid below it'
    })
    expect(refusal(() => feeCapped({ MAX_FEE_GWEI: '0.000000001' }))).toMatchObject({
      setting: 'MAX_FEE_GWEI'
    })
    expect(feeCapped({ MAX_FEE_GWEI: '0.000000002' }).maxFeePerGasWei).toBe(2n)
  })

  it('refuses a finality depth outside the reorg window it would run under', () => {
    expect(refusal(() => configured({ FINALITY_8453: '3000' }))).toBeInstanceOf(
      FinalityBeyondWindowError
    )
    expect(configured({ FINALITY_8453: '2999' }).finality).toStrictEqual({ depth: 2_999 })
    expect(refusal(() => configured({ FINALITY_1: '128' }, mainnet))).toBeInstanceOf(
      FinalityBeyondWindowError
    )
  })

  it("reads finality for the chain it is given, not another chain's", () => {
    const error = refusal(() => configured({}, mainnet))
    expect(error).toMatchObject({ setting: 'FINALITY_1', message: 'FINALITY_1 must be set' })
  })

  it("refuses a journal without the build it names or a cap it can stop at, as the journal's own errors", () => {
    expect(refusal(() => configured({ BUILD_REVISION: undefined }))).toBeInstanceOf(
      MissingBuildIdentityError
    )
    expect(refusal(() => configured({ JOURNAL_RUN_CAP_BYTES: '1024' }))).toBeInstanceOf(
      InvalidJournalRunCapError
    )
  })
})

import type { BotLogger } from '@repo/kit'
import type { LocalAccount } from 'viem'

import {
  blocksFor,
  createHttpTransport,
  EXECUTOR_SELECTOR,
  transactionKernelConfig,
  transactionKernelSpec
} from '@repo/kit'
import { executorLiquidationValidator } from '@repo/validators'
import { createPublicClient, isAddressEqual } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { Config } from './config'
import type { LiquidatorSettings } from './settings'

import { SettingsMismatchError } from './errors'

export const KERNEL_EFFECT_TIMEOUT_MS = 10_000
/** How long a sent transaction may wait for inclusion before the kernel replaces it at a higher fee. */
const STUCK_MS = 8_000
/** Deliberately twice what one act rests on: a 30s world read plus a 4s preparation, 2 × 34s. */
const MAX_EVIDENCE_AGE_MS = 68_000
const MIN_EVIDENCE_AGE_BLOCKS = 256

/**
 * The EOA that liquidates and receives the end-of-exec sweeps. Only the kernel signs with it,
 * through the kit signer's default-deny policy.
 */
export const liquidatorAccount = (config: Config) =>
  privateKeyToAccount(config.liquidatorPrivateKey)

const limitsOf = (settings: LiquidatorSettings) => ({
  chainId: settings.chainId,
  targets: [settings.executor],
  maxSpendWei: settings.kernel.maxSpendWei,
  stuckMs: STUCK_MS,
  maxEvidenceAgeBlocks: blocksFor(
    MAX_EVIDENCE_AGE_MS,
    { id: settings.chainId },
    MIN_EVIDENCE_AGE_BLOCKS
  )
})

const validatorOf = (settings: LiquidatorSettings) =>
  executorLiquidationValidator({
    executor: settings.executor,
    protocol: { kind: 'blue', morpho: settings.morpho }
  })

/** The kernel's configuration: Executor calls only, each checked as a liquidation. */
export const liquidatorKernelConfig = (settings: LiquidatorSettings) =>
  transactionKernelConfig(
    limitsOf(settings),
    { id: settings.chainId },
    settings.account,
    validatorOf(settings)
  )

/**
 * The live kernel's chain, ledger and effects for the liquidator's account, its signer bounded by
 * the same settings {@link liquidatorKernelConfig} builds from.
 * @throws SettingsMismatchError - when `account` or `config`'s chain is not the one `settings` record.
 */
export const liquidatorKernel = (
  settings: LiquidatorSettings,
  options: Readonly<{ config: Config; account: LocalAccount; logger: BotLogger }>
) => {
  const { config, account, logger } = options
  if (config.chain.id !== settings.chainId) throw new SettingsMismatchError('chainId')
  if (!isAddressEqual(account.address, settings.account)) throw new SettingsMismatchError('account')
  return transactionKernelSpec({
    settings: { ...settings.kernel, stateDirectory: config.kernel.stateDirectory },
    limits: { ...limitsOf(settings), selector: EXECUTOR_SELECTOR },
    validator: validatorOf(settings),
    account,
    chain: config.chain,
    client: createPublicClient({
      chain: config.chain,
      transport: createHttpTransport(config.rpcUrl, config.rpcUrlFallback)
    }),
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback,
    effectTimeoutMs: KERNEL_EFFECT_TIMEOUT_MS,
    logger
  })
}

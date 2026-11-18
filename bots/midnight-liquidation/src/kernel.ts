import type { BotLogger } from '@repo/kit'
import type { Address, Chain, Client, Hex, LocalAccount } from 'viem'

import {
  blocksFor,
  createHttpTransport,
  EXECUTOR_SELECTOR,
  feeCeiling,
  firstBid,
  gasLimitFor,
  stepCap,
  transactionKernelConfig,
  transactionKernelSpec
} from '@repo/kit'
import { bigintMin } from '@repo/utils'
import { executorLiquidationValidator } from '@repo/validators'
import { createPublicClient, isAddressEqual } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { estimateGas, getBlock } from 'viem/actions'
import { estimateL1Fee } from 'viem/op-stack'

import type { Config } from './config'
import type { PrepareDeps } from './prepare'
import type { LiquidatorSettings } from './settings'

import { STUCK_MS } from './config'
import { MissingBaseFeeError, SettingsMismatchError } from './errors'

/** A firm quote with its retries and a simulation, well inside the world's validity. */
export const PREPARE_TIMEOUT_MS = 20_000
export const KERNEL_EFFECT_TIMEOUT_MS = 10_000
/** The evidence age's floor in blocks. */
const MIN_EVIDENCE_AGE_BLOCKS = 64

/**
 * The EOA that liquidates and receives the end-of-exec sweeps. Only the kernel signs with it,
 * through the kit signer's default-deny policy.
 */
export const liquidatorAccount = (config: Config) =>
  privateKeyToAccount(config.liquidatorPrivateKey)

/** Deliberately twice what one act rests on: a world read's validity plus its preparation. */
const maxEvidenceAgeBlocks = (settings: LiquidatorSettings) =>
  blocksFor(
    2 * (settings.worldValidMs + PREPARE_TIMEOUT_MS),
    { id: settings.chainId },
    MIN_EVIDENCE_AGE_BLOCKS
  )

const limitsOf = (settings: LiquidatorSettings) => ({
  chainId: settings.chainId,
  targets: [settings.executor],
  maxSpendWei: settings.kernel.maxSpendWei,
  stuckMs: STUCK_MS,
  maxEvidenceAgeBlocks: maxEvidenceAgeBlocks(settings)
})

const validatorOf = (settings: LiquidatorSettings) =>
  executorLiquidationValidator({
    executor: settings.executor,
    protocol: { kind: 'midnight', midnight: settings.midnight }
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

/** What sending one call costs on the chain now: its gas, the base fee, and any L1 data fee. */
export type FeeReads = (
  call: Readonly<{ account: Address; to: Address; data: Hex }>
) => Promise<Readonly<{ estimatedGas: bigint; baseFeePerGas: bigint | null; l1Data: bigint }>>

/** {@link FeeReads} from `client`, with an L1 data fee only on a chain that charges one. */
export const chainFeeReads =
  (client: Client, chain: Chain): FeeReads =>
  async call => {
    const [estimatedGas, { baseFeePerGas }, l1Data] = await Promise.all([
      estimateGas(client, call),
      getBlock(client, { blockTag: 'latest' }),
      chain.contracts?.gasPriceOracle ? estimateL1Fee(client, { ...call, chain }) : 0n
    ])
    return { estimatedGas, baseFeePerGas, l1Data }
  }

/** {@link PrepareDeps.feesFor} for an Executor call from the settings' account, as the kernel signs it. */
export const liquidationFees =
  (settings: LiquidatorSettings, reads: FeeReads): PrepareDeps['feesFor'] =>
  async data => {
    const { maxFeePerGasWei, maxGasLimit, maxSpendWei } = settings.kernel
    const { estimatedGas, baseFeePerGas, l1Data } = await reads({
      account: settings.account,
      to: settings.executor,
      data
    })
    if (baseFeePerGas === null) throw new MissingBaseFeeError(settings.chainId)
    const gasLimit = gasLimitFor(estimatedGas, maxGasLimit)
    const maxFeePerGas = stepCap(feeCeiling(maxFeePerGasWei, maxSpendWei))
    return {
      l1Data,
      baseFee: baseFeePerGas,
      gasLimit,
      firstBid: fee =>
        firstBid({
          fee: bigintMin(fee, maxSpendWei),
          estimatedGas,
          baseFee: baseFeePerGas,
          maxFeePerGas,
          gasLimit
        })
    }
  }

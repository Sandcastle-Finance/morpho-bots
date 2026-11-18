import type { BotLogger } from '@repo/kit'
import type { LocalAccount } from 'viem'

import { metaMorphoAbi } from '@morpho-org/blue-sdk-viem'
import { blocksFor, createHttpTransport, transactionKernelSpec } from '@repo/kit'
import { vaultV1ReallocationValidator } from '@repo/validators'
import { createPublicClient, getAbiItem, toFunctionSelector } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { Config } from './config'

import { readValidMs } from './config'

const KERNEL_EFFECT_TIMEOUT_MS = 10_000
/** How long a sent transaction may wait for inclusion before the kernel replaces it at a higher fee. */
const STUCK_MS = 8_000
const REALLOCATE_SELECTOR = toFunctionSelector(
  getAbiItem({ abi: metaMorphoAbi, name: 'reallocate' })
)

/** Twice the blocks a vault read holds, which also covers its preparation. */
const evidenceAgeBlocks = (config: Config) =>
  blocksFor(2 * readValidMs(config.reallocationIntervalMs), config.chain)

/** The reallocator's EOA. Only the kernel signs with it */
export const reallocatorAccount = (config: Config) =>
  privateKeyToAccount(config.reallocatorPrivateKey)

/** The live kernel for the reallocator's account: `reallocate` on the whitelisted vaults only. */
export const reallocatorKernel = (options: {
  config: Config
  account: LocalAccount
  logger: BotLogger
}) => {
  const { config, account, logger } = options
  return transactionKernelSpec({
    settings: config.kernel,
    limits: {
      targets: config.vaultWhitelist,
      selector: REALLOCATE_SELECTOR,
      stuckMs: STUCK_MS,
      maxEvidenceAgeBlocks: evidenceAgeBlocks(config)
    },
    validator: vaultV1ReallocationValidator({ vaults: config.vaultWhitelist }),
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

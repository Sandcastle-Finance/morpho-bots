import { createDeploylessClient } from '@repo/kit'
import { publicActions } from 'viem'

import type { ConfigService } from '../../config/config.service'

import { type SupportedChainId, supportedChain } from '../../config/supported-chains.utils'

const createReadClient = (chainId: SupportedChainId, rpcUrl: string, timeoutMs: number) =>
  createDeploylessClient({ chain: supportedChain(chainId), rpcUrl, timeoutMs }).extend(
    publicActions
  )

/** A read client over kit's deployless transport, with viem's public actions. */
export type ReadClient = ReturnType<typeof createReadClient>

/**
 * The read clients one process shares: every chain read, the kernel's included, goes through
 * `chain`, and the Blue reference reads through `reference`, the same client unless
 * `REFERENCE_RPC_URL` names another endpoint.
 */
export type ReadClients = Readonly<{ chain: ReadClient; reference: ReadClient }>

/**
 * Builds the process's read clients from validated config.
 * @param config - The chain, RPC URLs, and the per-request timeout.
 * @returns The shared clients; no request is made until one is used.
 */
export const createReadClients = (
  config: Pick<ConfigService, 'chainId' | 'rpcUrl' | 'referenceRpcUrl' | 'requestTimeoutMs'>
): ReadClients => {
  const read = (url: string) => createReadClient(config.chainId, url, config.requestTimeoutMs)
  const chain = read(config.rpcUrl)
  const { referenceRpcUrl } = config
  return {
    chain,
    reference:
      referenceRpcUrl === undefined || referenceRpcUrl === config.rpcUrl
        ? chain
        : read(referenceRpcUrl)
  }
}

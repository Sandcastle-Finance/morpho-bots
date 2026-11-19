import type { ReadClient } from '../provider/read-clients'
import type { ChainReader } from './viem-setup-state.service'

/**
 * Creates the narrow viem-backed chain reader consumed by setup-state checks.
 * @param client - One of the process's shared read clients.
 * @returns A `ChainReader` bound to that client.
 * @remarks Read-only; performs no writes. Missing block numbers read the latest block. The chain
 * is only a client-side definition: setup checks still assert the connected chain matches.
 */
export const createChainReader = (client: ReadClient): ChainReader => ({
  getChainId: () => client.getChainId(),
  getCode: parameters => client.getCode(parameters),
  getBalance: parameters => client.getBalance(parameters),
  getBlock: parameters =>
    parameters.blockNumber === undefined
      ? client.getBlock({ blockTag: 'latest' })
      : client.getBlock({ blockNumber: parameters.blockNumber }),
  readContract: parameters => client.readContract(parameters as never)
})

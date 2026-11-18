import { describe, expect, test } from 'vitest'

import { createReadClients } from '../../../src/infrastructure/provider/read-clients'

const rpcUrl = 'https://rpc.example/'
const requestTimeoutMs = 10_000

describe('createReadClients', () => {
  test.each([undefined, rpcUrl])(
    'shares one client for chain and reference reads when the reference RPC is %s',
    referenceRpcUrl => {
      const clients = createReadClients({
        chainId: 8453,
        rpcUrl,
        referenceRpcUrl,
        requestTimeoutMs
      })

      expect(clients.reference).toBe(clients.chain)
      expect(clients.chain.transport.key).toBe('viem-dlc-deployless')
      expect(clients.chain.chain?.id).toBe(8453)
    }
  )

  test('gives a distinct reference RPC its own client of the same kind', () => {
    const clients = createReadClients({
      chainId: 8453,
      rpcUrl,
      referenceRpcUrl: 'https://archive.example/',
      requestTimeoutMs
    })

    expect(clients.reference).not.toBe(clients.chain)
    expect(clients.reference.transport.key).toBe('viem-dlc-deployless')
  })
})

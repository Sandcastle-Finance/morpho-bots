import type { KmsSigner } from '@repo/kit'
import type { Hex, PrivateKeyAccount } from 'viem'

import { bytesToHex, hexToBytes, parseSignature } from 'viem'

const SPKI_SECP256K1_PREFIX = '3056301006072a8648ce3d020106052b8104000a034200'

const derInteger = (value: Hex) => {
  const bytes = [...hexToBytes(value)]
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1]! & 0x80) === 0) bytes.shift()
  if ((bytes[0]! & 0x80) !== 0) bytes.unshift(0)
  return [0x02, bytes.length, ...bytes]
}

/** A KMS that answers as AWS would for a key it holds as `account`, for a delegated signer. */
export const localKms = (account: PrivateKeyAccount): KmsSigner => ({
  getPublicKey: async () =>
    Uint8Array.from([
      ...hexToBytes(`0x${SPKI_SECP256K1_PREFIX}`),
      ...hexToBytes(account.publicKey)
    ]),
  signDigest: async (_keyId, _region, digest) => {
    const { r, s } = parseSignature(await account.sign({ hash: bytesToHex(digest) }))
    const body = [...derInteger(r), ...derInteger(s)]
    return Uint8Array.from([0x30, body.length, ...body])
  }
})

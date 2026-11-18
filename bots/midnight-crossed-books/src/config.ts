import type { KernelSettings } from '@repo/kit'
import type { Address, Chain, Hex } from 'viem'

import { CrossedBooksResolver } from '@repo/contracts'
import { parseKernelSettings } from '@repo/kit'
import { getAddress, isAddress, isAddressEqual, isHex, zeroAddress } from 'viem'
import { base } from 'viem/chains'

import { DEFAULT_MAX_MATCHES } from './domain/matching.service'
import { InvalidConfigurationError } from './errors'

const MIDNIGHT = getAddress('0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A')
const PRIVATE_KEY_HEX_LENGTH = 66
const DEFAULT_API_BASE_URL = 'https://api.morpho.org'
const DEFAULT_SCAN_INTERVAL_MS = '15000'

type Env = Record<string, string | undefined>

/** Write mode: the key the kernel signs with, and what bounds what it signs. */
export type WriteConfig = Readonly<{
  readOnly: false
  privateKey: Hex
  kernel: KernelSettings
}>

/** Readonly mode holds no key: it simulates as the public EOA that would execute. */
export type ReadonlyConfig = Readonly<{ readOnly: true; simulationCaller: Address }>

export type Config = Readonly<{
  chain: Chain
  chainId: number
  midnight: Address
  resolver: Address
  rpcUrl: string
  rpcUrlFallback: string | undefined
  apiBaseUrl: string
  routerApiBaseUrl: string
  scanIntervalMs: number
  /** How long a scan authorizes resolutions, from when it started: two scan intervals. */
  worldValidMs: number
  minimumProfit: bigint
  maxMatches: number
  mode: ReadonlyConfig | WriteConfig
}>

const required = (env: Env, name: string) => {
  const value = env[name]?.trim()
  if (!value) throw new InvalidConfigurationError(`Missing required env var: ${name}`)
  return value
}

const unsignedDecimal = (env: Env, name: string, fallback?: string) => {
  const value = env[name]?.trim() || fallback
  if (!value || !/^\d+$/.test(value))
    throw new InvalidConfigurationError(`${name} must be an unsigned decimal integer`)
  return value
}

const baseUrl = (env: Env, name: string, fallback: string) => {
  const value = (env[name]?.trim() || fallback).replace(/\/$/, '')
  if (!URL.canParse(value)) throw new InvalidConfigurationError(`${name} must be a valid URL`)
  return value
}

/** `true`/`1` is readonly and absent, empty, `false` or `0` is write mode, in any case. */
const parseReadonly = (value: string | undefined) => {
  const normalized = value?.trim().toLowerCase() || ''
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === '' || normalized === 'false' || normalized === '0') return false
  throw new InvalidConfigurationError('READONLY must be one of: true, 1, false, 0')
}

const readonlyConfig = (env: Env): ReadonlyConfig => {
  const caller = env.SIMULATION_CALLER_ADDRESS?.trim()
  if (
    !caller ||
    !isAddress(caller, { strict: false }) ||
    isAddressEqual(getAddress(caller), zeroAddress)
  )
    throw new InvalidConfigurationError(
      'SIMULATION_CALLER_ADDRESS must be a public non-zero EVM address'
    )
  return { readOnly: true, simulationCaller: getAddress(caller) }
}

const writeConfig = (env: Env, chain: Chain): WriteConfig => {
  const privateKey = required(env, 'RESOLVER_PRIVATE_KEY')
  if (!isHex(privateKey, { strict: true }) || privateKey.length !== PRIVATE_KEY_HEX_LENGTH)
    throw new InvalidConfigurationError(
      'RESOLVER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string'
    )
  return {
    readOnly: false,
    privateKey,
    kernel: parseKernelSettings(env, chain, { spendBounds: 'configured' })
  }
}

/**
 * Reads and validates the bot's configuration, with no network access. Readonly mode neither reads
 * nor keeps `RESOLVER_PRIVATE_KEY`, and write mode ignores `SIMULATION_CALLER_ADDRESS`.
 * @throws InvalidConfigurationError - for any missing or malformed value, or one of kit's errors from
 * {@link parseKernelSettings} for a kernel setting.
 */
export const loadConfig = (env: Env = process.env): Config => {
  const chainId = Number(unsignedDecimal(env, 'CHAIN_ID'))
  if (chainId !== base.id)
    throw new InvalidConfigurationError(`Unsupported CHAIN_ID ${chainId}; supported: ${base.id}`)
  const mode = parseReadonly(env.READONLY) ? readonlyConfig(env) : writeConfig(env, base)

  const resolverOverride = env.RESOLVER_ADDRESS?.trim()
  if (resolverOverride && !isAddress(resolverOverride, { strict: false }))
    throw new InvalidConfigurationError('RESOLVER_ADDRESS must be an EVM address')

  const apiBaseUrl = baseUrl(env, 'API_BASE_URL', DEFAULT_API_BASE_URL)
  const routerApiBaseUrl = baseUrl(env, 'ROUTER_API_BASE_URL', apiBaseUrl)

  const scanIntervalMs = Number(unsignedDecimal(env, 'SCAN_INTERVAL_MS', DEFAULT_SCAN_INTERVAL_MS))
  if (!Number.isSafeInteger(scanIntervalMs) || scanIntervalMs <= 0)
    throw new InvalidConfigurationError('SCAN_INTERVAL_MS must be a positive integer')

  const maxMatches = Number(unsignedDecimal(env, 'MAX_MATCHES', String(DEFAULT_MAX_MATCHES)))
  if (!Number.isSafeInteger(maxMatches) || maxMatches <= 0)
    throw new InvalidConfigurationError('MAX_MATCHES must be a positive safe integer')

  return {
    chain: base,
    chainId,
    midnight: MIDNIGHT,
    resolver: resolverOverride
      ? getAddress(resolverOverride)
      : CrossedBooksResolver.with(MIDNIGHT).address,
    rpcUrl: required(env, 'RPC_URL'),
    rpcUrlFallback: env.RPC_URL_FALLBACK?.trim() || undefined,
    apiBaseUrl,
    routerApiBaseUrl,
    scanIntervalMs,
    worldValidMs: 2 * scanIntervalMs,
    minimumProfit: BigInt(unsignedDecimal(env, 'MIN_PROFIT_ASSETS', '1')),
    maxMatches,
    mode
  }
}

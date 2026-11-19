import type {
  DurableLedger,
  Entry,
  KernelActivity,
  KernelChain,
  KernelConfig,
  Log,
  TxPayload
} from '@repo/kernel'
import type { Address, Hex, LocalAccount } from 'viem'

import {
  MAX_CONTINUOUS_FEE,
  midnightAbi,
  type Offer,
  setterRatifierAbi
} from '@morpho-org/midnight-sdk'
import { getChainAddress, MathLib } from '@morpho-org/morpho-ts'
import { createLedgerStore, LEDGER_FORMAT } from '@repo/kernel'
import {
  blocksFor,
  reorgDepthFor,
  callAt,
  createAccountSigner,
  createBalanceMonitor,
  createKernelChain,
  createKernelEffects,
  createKeystoreAccount,
  createKmsAccount,
  type KeystoreDependencies,
  type KmsSigner,
  type Logger,
  type Policy,
  type PolicyRule,
  policyGasLimit,
  SignerAccountError
} from '@repo/kit'
import {
  midnightCommitmentGroup,
  midnightCommitmentRead,
  midnightOffersValidator
} from '@repo/validators'
import { join } from 'node:path'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  isAddressEqual,
  parseAbi,
  toFunctionSelector
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getBalance } from 'viem/actions'

import type { MonitoringEvent } from './application/monitoring/monitoring-event'
import type { ConfigService } from './config/config.service'
import type { QuoterHosting } from './graph'
import type { ReadClient } from './infrastructure/provider/read-clients'

import { operatorErrorName } from './application/monitoring/operator-error-name.utils'
import { supportedChain } from './config/supported-chains.utils'
import { DryRunError, QuoterTransactionError } from './errors'
import { createDryWorld } from './infrastructure/kernel/dry-world'
import { strategyStateDirectory } from './infrastructure/strategy-state/strategy-state-file.utils'

/** The workflow that submitted a plan, carried as its intent id's prefix. */
export type QuoterWorkflow = 'ladder' | 'bootstrap' | 'invalidation'

/** One offer group the kernel holds for the maker, with the offers it was signed with. */
export type KernelGroup = {
  groupId: Hex
  workflow?: QuoterWorkflow
  /**
   * A `retired` group stays for the kernel's retention window, so a lagging index never reads it as
   * foreign.
   */
  state: 'exposed' | 'live' | 'revoking' | 'retired'
  offers: readonly Offer[]
}

/** A replaced book stays reserved until its cancellation is final, so a republish holds two books. */
const REPUBLISH_OVERLAP = 2n
/** How many transactions may await finality at once; each holds the per-transaction spend ceiling. */
const TRANSACTIONS_IN_FLIGHT = 16n

const POLL_MS = 1_000
/** Each window is a time in the chain's blocks, at no fewer blocks than mainnet's 12s ones need. */
const MAX_SIM_LAG_MS = 6_000
const MIN_SIM_LAG_BLOCKS = 3
const STUCK_MS = 20_000
const MIN_STUCK_BLOCKS = 10
/**
 * A desire read holds three polls, at most three minutes; a release restored after a crash also
 * waits this long, so it stays near that.
 */
const MAX_EVIDENCE_AGE_MS = 4 * 60_000
const MIN_EVIDENCE_AGE_BLOCKS = 128
const LATCH_BOUND_MS = 200_000
const MIN_LATCH_BOUND_BLOCKS = 100
const RECOVERY_BOUND_MS = 15 * 60_000
const MAX_RECOVERY_ATTEMPTS = 3
const MAX_DISPATCH_LAG_MS = 10_000
/**
 * A `withdraw` is its selector, four head words, the market tuple's eight head words, and its
 * collateral array's length and four words per collateral, up to Midnight's `MAX_COLLATERALS` (128).
 */
const MAX_REDEMPTION_DATA_BYTES = 4 + 32 * (4 + 8 + 1) + 32 * 4 * 128
/**
 * About twice the most a `withdraw` measured on a Base fork of the deployed Midnight: 296,350 gas
 * at 128 collaterals, its first fee-accrual write, and its full calldata ceiling.
 */
const MAX_REDEMPTION_GAS = 600_000n
/** Missed cycles a workflow may skip before the kernel withdraws the groups it stopped affirming. */
const AFFIRMATION_CYCLES = 3

/** The ledger file for one chain and signer, beside the strategy state. */
const kernelLedgerPath = (chainId: number, signer: Address, directory?: string) =>
  join(strategyStateDirectory(directory), `kernel-${chainId}-${signer.toLowerCase()}.json`)

const operationRules = (config: ConfigService): PolicyRule[] => {
  const policy = config.writePolicy!
  const rules: PolicyRule[] = [
    {
      target: getChainAddress(config.chainId, 'midnightMempool'),
      maxGasLimit: policy.maxPublicationGas,
      maxDataBytes: policy.maxPublicationDataBytes
    },
    {
      target: config.setup.midnight,
      selector: toFunctionSelector(getAbiItem({ abi: midnightAbi, name: 'setConsumed' })),
      maxGasLimit: policy.maxCancellationGas,
      maxDataBytes: 100
    },
    {
      target: config.setup.midnight,
      selector: toFunctionSelector(getAbiItem({ abi: midnightAbi, name: 'multicall' })),
      maxGasLimit: policy.maxBatchCancellationGas,
      maxDataBytes: policy.maxBatchCancellationDataBytes
    },
    {
      target: config.setup.midnight,
      selector: toFunctionSelector(getAbiItem({ abi: midnightAbi, name: 'withdraw' })),
      maxGasLimit: MAX_REDEMPTION_GAS,
      maxDataBytes: MAX_REDEMPTION_DATA_BYTES
    }
  ]
  if (policy.maxRatificationGas !== undefined) {
    rules.push({
      target: config.setup.ratifier,
      selector: toFunctionSelector(
        getAbiItem({ abi: setterRatifierAbi, name: 'setIsRootRatified' })
      ),
      maxGasLimit: policy.maxRatificationGas,
      maxDataBytes: 100
    })
  }
  return rules
}

const signingPolicy = (config: ConfigService, rules: readonly PolicyRule[]): Policy => {
  const policy = config.writePolicy!
  return {
    chainId: config.chainId,
    targets: rules.map(rule => rule.target),
    maxFeePerGasWei: policy.maxFeePerGasWei,
    maxSpendWei: policy.maxTransactionSpendWei,
    maxGasLimit: rules.reduce((max, rule) => (rule.maxGasLimit > max ? rule.maxGasLimit : max), 0n),
    maxDataBytes: Math.max(...rules.map(rule => rule.maxDataBytes)),
    rules
  }
}

/** Any positive bound lets a dry plan take a fee; at zero every transaction step is refused. */
const DRY_TRANSACTION_SPEND_WEI = MathLib.WAD
/** A read-only run's dry kernel signs nothing, so its validator reads offers at any fee cap. */
const DRY_POLICY = {
  maxContinuousFeeCap: MAX_CONTINUOUS_FEE,
  maxTransactionSpendWei: DRY_TRANSACTION_SPEND_WEI
}

/**
 * The kernel's configuration for the quoter's signer. Exposure is read only by the Midnight offers
 * validator; the caps bound it from configuration alone.
 * @param config - Validated runtime config; without a write policy the dry policy applies.
 * @param signer - The address the kernel signs as.
 * @returns The kernel configuration.
 */
export const quoterKernelConfig = (config: ConfigService, signer: Address): KernelConfig => {
  const policy = config.writePolicy ?? DRY_POLICY
  const chain = supportedChain(config.chainId)
  const slowestCycleMs = Math.max(
    60_000,
    ...config.ladder.map(market => market.loopIntervalSeconds * 1_000)
  )
  const maxEvidenceAgeBlocks = blocksFor(MAX_EVIDENCE_AGE_MS, chain, MIN_EVIDENCE_AGE_BLOCKS)
  return {
    chainId: config.chainId,
    account: signer,
    validators: [
      midnightOffersValidator({
        chainId: config.chainId,
        maker: config.setup.maker,
        markets: config.setup.marketIds,
        maxContinuousFeeCap: policy.maxContinuousFeeCap,
        debtMarkets: config.ladder
          .filter(market => market.debt !== undefined)
          .map(market => market.marketId)
      })
    ],
    policy: {
      targets: [
        getChainAddress(config.chainId, 'midnightMempool'),
        getChainAddress(config.chainId, 'midnight'),
        getChainAddress(config.chainId, 'setterRatifier')
      ],
      recoveryTargets: [getChainAddress(config.chainId, 'midnight')]
    },
    caps: {
      [`loan:${config.setup.loanAsset.toLowerCase()}`]:
        REPUBLISH_OVERLAP * config.setup.requiredAllowance,
      ...Object.fromEntries(
        config.ladder.flatMap(market =>
          market.debt === undefined
            ? []
            : [
                [
                  `debt:${market.marketId.toLowerCase()}`,
                  REPUBLISH_OVERLAP * market.debt.maximumDebtUnits
                ]
              ]
        )
      ),
      native: TRANSACTIONS_IN_FLIGHT * policy.maxTransactionSpendWei
    },
    observedResources: [],
    feeReserve: policy.maxTransactionSpendWei,
    feePolicy: () => policy.maxTransactionSpendWei,
    maxSimLagBlocks: blocksFor(MAX_SIM_LAG_MS, chain, MIN_SIM_LAG_BLOCKS),
    maxEvidenceAgeBlocks,
    retiredRetentionBlocks: maxEvidenceAgeBlocks,
    stuckBlocks: blocksFor(STUCK_MS, chain, MIN_STUCK_BLOCKS),
    latchBoundBlocks: blocksFor(LATCH_BOUND_MS, chain, MIN_LATCH_BOUND_BLOCKS),
    recoveryBoundMs: RECOVERY_BOUND_MS,
    revokeAfterStaleMs: AFFIRMATION_CYCLES * (slowestCycleMs + config.transactionReceiptTimeoutMs),
    maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS,
    maxDispatchLagMs: MAX_DISPATCH_LAG_MS
  }
}

const emitSafely = (
  writeEvent: ((event: MonitoringEvent) => void | Promise<void>) | undefined,
  event: MonitoringEvent
) => {
  try {
    void Promise.resolve(writeEvent?.(event)).catch(() => {})
  } catch {
    // A failing log writer must never wedge the kernel.
  }
}

/** Writes the signer's policy refusals as `signer.policy_violation` records, and nothing else. */
const signerLogger = (writeEvent: Parameters<typeof emitSafely>[0]): Logger => {
  const quiet = () => undefined
  return {
    debug: quiet,
    info: quiet,
    warn: quiet,
    error: (event, fields) => {
      if (event === 'signer.policy_violation')
        emitSafely(writeEvent, { event, ...fields } as MonitoringEvent)
    }
  }
}

/** Writes the signer's `signer.balance` records, and a failed read without its error text. */
const balanceLogger = (writeEvent: Parameters<typeof emitSafely>[0]): Logger => {
  const quiet = () => undefined
  return {
    debug: quiet,
    info: (event, fields) => {
      if (event === 'signer.balance')
        emitSafely(writeEvent, { event, ...fields } as MonitoringEvent)
    },
    warn: (event, fields) => {
      if (event === 'signer.balance_failed')
        emitSafely(writeEvent, {
          event,
          address: (fields as { address: Address }).address,
          status: 'failed'
        })
    },
    error: quiet
  }
}

const reportKernelErrors =
  (writeEvent: ((event: MonitoringEvent) => void | Promise<void>) | undefined) =>
  (source: string, error: unknown) =>
    emitSafely(writeEvent, { event: 'kernel.error', source, errorName: operatorErrorName(error) })

/**
 * Writes each kernel transition's sends and receipts as `transaction.lifecycle` records, and its
 * commitment moves as `kernel.commitment` records.
 * @param writeEvent - Record writer; a missing or failing writer never wedges the kernel.
 * @returns An activity listener that holds nothing between transitions.
 */
export const createKernelLog =
  (writeEvent?: (event: MonitoringEvent) => void | Promise<void>) =>
  (activity: readonly KernelActivity[]) => {
    for (const a of activity) {
      if (a.type === 'sent')
        emitSafely(writeEvent, {
          event: 'transaction.lifecycle',
          state:
            a.status === 'unknown'
              ? 'broadcast-unknown'
              : a.status === 'accepted'
                ? a.replaces
                  ? 'replaced'
                  : 'submitted'
                : 'dropped',
          nonce: a.nonce,
          txHash: a.hash as Hex,
          intentId: a.intentId,
          ...(a.replaces && a.status === 'accepted' && { previousTxHash: a.replaces as Hex }),
          ...((a.status === 'rejected' || a.status === 'withheld') && { reason: a.status })
        })
      if (a.type === 'resolved' && a.winner !== null)
        emitSafely(writeEvent, {
          event: 'transaction.lifecycle',
          state: a.success ? 'confirmed' : 'reverted',
          nonce: a.nonce,
          txHash: a.winner as Hex,
          blockNumber: BigInt(a.block)
        })
      if (a.type === 'entry')
        emitSafely(writeEvent, {
          event: 'kernel.commitment',
          groupId: midnightCommitmentGroup(a.id),
          intentId: a.intentId,
          state: a.to,
          ...(a.reason && { reason: a.reason })
        })
    }
  }

/** How a ledger read from disk is handed to a dry kernel: every entry, with no candidate open. */
const dryLedger = (
  config: ConfigService,
  entries: Readonly<Record<string, Entry>>
): DurableLedger | undefined => {
  const kept = Object.entries(entries).flatMap(([id, entry]) =>
    entry.state === 'exposed' || entry.state === 'live' || entry.state === 'revoking'
      ? [
          [
            id,
            {
              spec: entry.spec,
              state: entry.state,
              intentId: entry.intentId,
              validator: entry.validator,
              creators: entry.creators,
              deadCreators: entry.deadCreators,
              origin: entry.origin!,
              consumedFinal: entry.consumedFinal,
              compensate: entry.compensate,
              affirmedBy: entry.affirmedAt
            }
          ] as const
        ]
      : []
  )
  if (kept.length === 0) return undefined
  return {
    header: { format: LEDGER_FORMAT, chainId: config.chainId, account: config.setup.maker, seq: 1 },
    nextNonce: null,
    entries: Object.fromEntries(kept),
    nonces: {},
    submissions: {},
    watermarks: {},
    conflictMarks: [],
    evidenceFloor: 0,
    releases: {}
  }
}

const dryEvents = parseAbi([
  'event SetConsumed(address indexed caller, bytes32 indexed group, uint256 amount, address indexed onBehalf)',
  'event SetIsRootRatified(address indexed caller, address indexed maker, bytes32 indexed root, bool newIsRootRatified)'
])

/** A call's decoding under `abi`, or nothing when the calldata is not one of its functions. */
const decodeWith = <const abi extends typeof midnightAbi | typeof setterRatifierAbi>(
  abi: abi,
  data: Hex
) => {
  try {
    return decodeFunctionData({ abi, data })
  } catch {
    return undefined
  }
}

/**
 * The logs a quoter transaction emits once mined, as its validator confirms them.
 * @param maker - The maker the logs are attributed to.
 * @returns A mapper from a transaction payload to its logs; an unrecognized call emits none.
 */
export const quoterReceiptLogs =
  (maker: Address) =>
  (payload: TxPayload): readonly Log[] => {
    const data = payload.data as Hex
    const ratification = decodeWith(setterRatifierAbi, data)
    if (ratification?.functionName === 'setIsRootRatified') {
      const [, root, ratified] = ratification.args
      return [
        {
          address: payload.to,
          topics: encodeEventTopics({
            abi: dryEvents,
            eventName: 'SetIsRootRatified',
            args: { caller: maker, maker, root }
          }) as string[],
          data: encodeAbiParameters([{ type: 'bool' }], [ratified])
        }
      ]
    }
    const call = decodeWith(midnightAbi, data)
    const calls = call?.functionName === 'multicall' ? call.args[0] : [data]
    return calls.flatMap(inner => {
      const cancel = decodeWith(midnightAbi, inner)
      if (cancel?.functionName !== 'setConsumed') return []
      const [group, amount, onBehalf] = cancel.args
      return [
        {
          address: payload.to,
          topics: encodeEventTopics({
            abi: dryEvents,
            eventName: 'SetConsumed',
            args: { caller: maker, group, onBehalf }
          }) as string[],
          data: encodeAbiParameters([{ type: 'uint256' }], [amount])
        }
      ]
    })
  }

/**
 * The configured chain's heads, blocks and finality, for a read-only run's dry kernel to follow, so
 * its world reads pin to real blocks.
 * @param config - Validated runtime config.
 * @param client - The process's shared chain read client.
 * @returns The chain reads a dry world follows.
 */
export const followedChain = (
  config: ConfigService,
  client: ReadClient
): Pick<KernelChain, 'latest' | 'block' | 'safe'> =>
  createKernelChain({
    client,
    account: config.setup.maker,
    finality: config.finality,
    commitment: () => Promise.reject(new DryRunError('a dry run observes no commitment'))
  })

/**
 * A kernel that signs and sends nothing, starting from what an earlier run's ledgers hold: the real
 * reducer on a dry world whose receipts emit what the quoter's transactions would.
 * @param config - Validated runtime config.
 * @param entries - The maker's entries the ledgers on disk record, for a read-only run.
 * @param writeEvent - Where the kernel's failed reads and effects are reported.
 * @param follow - The real chain the dry chain follows; without it every block is fabricated.
 * @returns The dry kernel hosting.
 */
export const dryHosting = (
  config: ConfigService,
  entries: Readonly<Record<string, Entry>> = {},
  writeEvent?: (event: MonitoringEvent) => void,
  follow?: Pick<KernelChain, 'latest' | 'block' | 'safe'>
): QuoterHosting => {
  const maker = config.setup.maker
  const ledger = dryLedger(config, entries)
  return {
    ...createDryWorld({
      ...(ledger ? { ledger } : {}),
      logs: quoterReceiptLogs(maker),
      ...(follow && { follow })
    }),
    dry: true,
    config: quoterKernelConfig(config, maker),
    enrollment: ledger ? 'enrolled' : 'enrolling',
    pollMs: POLL_MS,
    effectTimeoutMs: config.requestTimeoutMs,
    reorgDepth: reorgDepthFor(supportedChain(config.chainId)),
    onError: reportKernelErrors(writeEvent)
  }
}

declare const loaded: unique symbol

/** A signer {@link loadQuoterSigner} loaded: its address, while its account stays in this module. */
export type QuoterSigner = Readonly<{ address: Address; [loaded]: true }>

const accounts = new WeakMap<QuoterSigner, LocalAccount>()

/**
 * Loads the account the kernel signs with, with no nonce manager: the kernel allocates every nonce.
 * @param identity - Validated write-enabled signer identity.
 * @param dependencies - Overrides for the keystore read and decryption, and the KMS calls.
 * @returns The signer the private-key, keystore, or KMS identity selects, holding only its address.
 * @throws `SignerAccountError` when the credential cannot be loaded, or the account is not the one
 * the identity requires: the maker itself, or for KMS a separate key the maker authorized.
 */
export const loadQuoterSigner = async (
  identity: Exclude<ConfigService['identity'], { readOnly: true }>,
  dependencies: KeystoreDependencies & { kms?: KmsSigner } = {}
): Promise<QuoterSigner> => {
  const account =
    identity.method === 'private-key'
      ? privateKeyToAccount(identity.privateKey)
      : identity.method === 'keystore'
        ? await createKeystoreAccount(identity, dependencies)
        : await createKmsAccount(identity, dependencies.kms)
  if ((identity.method === 'aws') === isAddressEqual(account.address, identity.maker))
    throw new SignerAccountError('signer-address')
  const signer = Object.freeze({ address: account.address }) as QuoterSigner
  accounts.set(signer, account)
  return signer
}

/**
 * The kernel the quoter's engine hosts for its signer: its configuration, ledger, chain reads, and
 * effects. The engine builds every plan's dependent step itself.
 * @param parameters - Validated write configuration, the loaded signer, the process's shared chain
 * read client, and optional writers.
 * @returns The kernel's hosting, and the signer's address.
 * @throws `QuoterTransactionError` when writes are not configured, the signer was not loaded by
 * {@link loadQuoterSigner}, or it is not the one the configuration names.
 * @remarks Every transaction the kernel signs also passes the kit signer's policy. Each head the
 * hosted chain reads also samples the signer's balance about once a minute without waiting for it,
 * and a failed sample is reported, never thrown.
 */
export const quoterKernelSpec = (parameters: {
  config: ConfigService
  signer: QuoterSigner
  client: ReadClient
  writeEvent?: (event: MonitoringEvent) => void | Promise<void>
  stateDirectory?: string
}): { hosting: QuoterHosting; signer: Address } => {
  const { config, client } = parameters
  const account = accounts.get(parameters.signer)
  const writePolicy = config.writePolicy
  const identity = config.identity
  if (!writePolicy || identity.readOnly || !account)
    throw new QuoterTransactionError('configuration')
  // A KMS signer is a separate key the maker authorized; every other method signs as the maker.
  if ((identity.method === 'aws') === isAddressEqual(account.address, config.setup.maker))
    throw new QuoterTransactionError('signer-identity-mismatch')
  const chain = supportedChain(config.chainId)
  const rules = operationRules(config)
  const policy = signingPolicy(config, rules)
  const signer = createAccountSigner({
    account,
    chain,
    rpcUrl: config.rpcUrl,
    policy,
    logger: signerLogger(parameters.writeEvent)
  })
  const commitments = midnightCommitmentRead(config.chainId, config.setup.maker)
  const effects = createKernelEffects({
    client,
    signer,
    typedSigner: account,
    maxFeePerGasWei: writePolicy.maxFeePerGasWei,
    maxGasLimit: request => policyGasLimit(policy, request),
    materialize: () => Promise.reject(new QuoterTransactionError('configuration'))
  })
  const chainReads = createKernelChain({
    client,
    account: account.address,
    finality: config.finality,
    commitment: async (id, at) =>
      commitments.observe(await callAt(client, at, commitments.request(id)))
  })
  const balance = createBalanceMonitor({
    address: account.address,
    read: () => getBalance(client, { address: account.address }),
    logger: balanceLogger(parameters.writeEvent),
    chain
  })
  return {
    signer: account.address,
    hosting: {
      config: quoterKernelConfig(config, account.address),
      store: createLedgerStore(
        kernelLedgerPath(config.chainId, account.address, parameters.stateDirectory)
      ),
      chain: {
        ...chainReads,
        latest: async () => {
          const latest = await chainReads.latest()
          void balance.maybeLog(BigInt(latest.head.number))
          return latest
        }
      },
      effects,
      enrollment: writePolicy.enrollment,
      pollMs: POLL_MS,
      effectTimeoutMs: config.requestTimeoutMs,
      reorgDepth: reorgDepthFor(chain),
      onError: reportKernelErrors(parameters.writeEvent)
    }
  }
}

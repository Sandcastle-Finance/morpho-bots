import { createDeploylessClient, simulateCall } from '@repo/kit'
import { formatUnits, getAddress } from 'viem'
import { getBlockNumber } from 'viem/actions'

import { loadConfig } from '../src/config'
import { encodeReallocation } from '../src/encode'
import { getUtilization } from '../src/math'
import { revertReason } from '../src/revert.utils'
import { createStrategy } from '../src/strategies'
import { fetchVaults } from '../src/vault-data'

/**
 * Reads each whitelisted vault once, runs the configured strategy and prints the plan it would
 * send, simulated as `EOA`. Holds no key and sends nothing: `EOA` is the allocator's address, so a
 * plan can be reviewed before that key is given to the bot.
 *
 *   CHAIN_ID=4663 RPC_URL=… VAULT_WHITELIST=0x… EOA=0x<allocator> DECIMALS=6 \
 *     bun run --cwd bots/vault-v2-reallocation plan:once
 */

// loadConfig needs a key and the kernel's settings; this script uses neither.
const UNUSED = {
  REALLOCATOR_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  MAX_FEE_GWEI: '1',
  KERNEL_STATE_DIR: './state',
  JOURNAL_RUN_CAP_BYTES: String(64 * 1024 * 1024),
  KERNEL_ENROLLMENT: 'enrolling',
  BUILD_REVISION: '0'.repeat(40),
  BUILD_IMAGE_TAG: 'plan-once'
}

const pct = (wad: bigint) => `${(Number(wad) / 1e16).toFixed(2)}%`

async function main() {
  const chainId = process.env.CHAIN_ID ?? ''
  const config = loadConfig({ ...UNUSED, [`FINALITY_${chainId}`]: 'finalized', ...process.env })
  const eoa = getAddress(process.env.EOA ?? '')
  const decimals = Number(process.env.DECIMALS ?? 18)
  const amount = (assets: bigint) => formatUnits(assets, decimals)

  const client = createDeploylessClient({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback
  })
  const blockNumber = await getBlockNumber(client)
  const rows = await fetchVaults(client, config.vaultWhitelist, {
    chainId: config.chainId,
    at: { blockNumber },
    eoa
  })
  const strategy = createStrategy(config)

  for (const vault of config.vaultWhitelist) {
    const row = rows.get(vault.toLowerCase())
    console.log(`\n== vault ${vault} at block ${blockNumber}`)
    if (!row?.data) {
      console.log(`unreadable: ${row?.error ? revertReason(row.error) : 'no row'}`)
      continue
    }
    const data = row.data
    console.log(
      `adapter ${data.adapterAddress} · allocator role ${data.isAllocator} · ` +
        `total ${amount(data.totalAssets)} · idle ${amount(data.idleAssets)} · ` +
        `${data.marketsData.length} market(s) held`
    )
    for (const market of data.marketsData) {
      console.log(
        `  ${market.id.slice(0, 10)} collateral ${market.params.collateralToken} · ` +
          `vault ${amount(market.vaultAssets)} · supply ${amount(market.state.totalSupplyAssets)} · ` +
          `borrow ${amount(market.state.totalBorrowAssets)} · ` +
          `utilization ${pct(getUtilization(market.state))} · cap ${amount(market.cap.absolute)}`
      )
    }

    const plan = strategy(data)
    if (!plan) {
      console.log(`plan (${config.strategy}): none`)
      continue
    }
    console.log(`plan (${config.strategy}):`)
    for (const leg of plan.deallocations)
      console.log(`  deallocate ${amount(leg.assets)} from ${leg.marketId.slice(0, 10)}`)
    for (const leg of plan.allocations)
      console.log(`  allocate   ${amount(leg.assets)} to   ${leg.marketId.slice(0, 10)}`)
    const simulated = await simulateCall(client, {
      eoa,
      to: vault,
      data: encodeReallocation(data.adapterAddress, plan)
    })
    console.log(
      simulated.status === 'ok' ? 'simulation: ok' : `simulation: REVERT ${simulated.reason}`
    )
  }
}

main().catch(error => {
  console.error(revertReason(error))
  process.exitCode = 1
})

import hre from "hardhat"

const { ethers } = hre

async function main() {
  const treasury = process.env.NFT_TREASURY_WALLET
  if (!treasury || !/^0x[0-9a-fA-F]{40}$/.test(treasury)) {
    throw new Error("NFT_TREASURY_WALLET missing/invalid in .env.local")
  }

  // Optional: a hot watcher EOA to receive minter authority for URI backfills.
  // If WATCHER_ADDRESS is omitted, the deployer is the initial minter.
  const watcherEnv = process.env.WATCHER_ADDRESS
  const watcher = (watcherEnv && /^0x[0-9a-fA-F]{40}$/.test(watcherEnv)) ? watcherEnv : null

  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()
  console.log(`\nDeploying SentinelETH`)
  console.log(`  network    : ${network.name} (chainId ${network.chainId})`)
  console.log(`  deployer   : ${deployer.address}`)
  console.log(`  treasury   : ${treasury}`)
  console.log(`  minter     : ${watcher ?? deployer.address}`)

  const Sentinel = await ethers.getContractFactory("SentinelETH")
  const c = await Sentinel.deploy(treasury, watcher ?? deployer.address)
  console.log(`  tx         : ${c.deploymentTransaction()?.hash}`)
  await c.waitForDeployment()
  const addr = await c.getAddress()
  console.log(`\n✅ Deployed at: ${addr}`)

  console.log(`\nOwner/minter:`)
  console.log(`  owner      : ${await c.owner()}`)
  console.log(`  minter     : ${await c.minter()}`)

  console.log(`\nVerify with:`)
  console.log(`  npx hardhat verify --network ${network.name === "unknown" ? "<network>" : network.name} ${addr} ${treasury}`)

  console.log(`\nAdd to .env.local:`)
  console.log(`  NEXT_PUBLIC_NFT_CONTRACT_ADDRESS=${addr}`)

  if (!watcher) {
    console.log(`\nNext step (manual): from the deployer key, run`)
    console.log(`  c.setMinter(<watcher hot wallet>)`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

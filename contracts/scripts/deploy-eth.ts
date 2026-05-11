import hre from "hardhat"

const { ethers } = hre

async function main() {
  const treasury = process.env.NFT_TREASURY_WALLET
  if (!treasury || !/^0x[0-9a-fA-F]{40}$/.test(treasury)) {
    throw new Error("NFT_TREASURY_WALLET missing/invalid in .env.local")
  }

  // Optional: a hot watcher EOA to receive URI_SETTER_ROLE post-deploy.
  // If WATCHER_ADDRESS is omitted, no role is granted (the deployer keeps it).
  const watcherEnv = process.env.WATCHER_ADDRESS
  const watcher = (watcherEnv && /^0x[0-9a-fA-F]{40}$/.test(watcherEnv)) ? watcherEnv : null

  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()
  console.log(`\nDeploying SentinelETH`)
  console.log(`  network    : ${network.name} (chainId ${network.chainId})`)
  console.log(`  deployer   : ${deployer.address}`)
  console.log(`  treasury   : ${treasury}`)
  console.log(`  watcher    : ${watcher ?? "(none — grant URI_SETTER_ROLE manually after deploy)"}`)

  const Sentinel = await ethers.getContractFactory("SentinelETH")
  const c = await Sentinel.deploy(treasury)
  console.log(`  tx         : ${c.deploymentTransaction()?.hash}`)
  await c.waitForDeployment()
  const addr = await c.getAddress()
  console.log(`\n✅ Deployed at: ${addr}`)

  // Deployer holds DEFAULT_ADMIN_ROLE + PAUSER_ROLE + URI_SETTER_ROLE by default.
  if (watcher) {
    const URI_SETTER_ROLE = ethers.id("URI_SETTER_ROLE")
    console.log(`\nGranting URI_SETTER_ROLE to watcher ${watcher}…`)
    const tx = await c.grantRole(URI_SETTER_ROLE, watcher)
    console.log(`  tx         : ${tx.hash}`)
    await tx.wait()
    console.log(`✅ URI_SETTER_ROLE granted`)
  }

  console.log(`\nVerify with:`)
  console.log(`  npx hardhat verify --network ${network.name === "unknown" ? "<network>" : network.name} ${addr} ${treasury}`)

  console.log(`\nAdd to .env.local:`)
  console.log(`  NEXT_PUBLIC_NFT_CONTRACT_ADDRESS=${addr}`)

  if (!watcher) {
    console.log(`\nNext step (manual): from the deployer key, run`)
    console.log(`  c.grantRole(keccak256("URI_SETTER_ROLE"), <watcher hot wallet>)`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

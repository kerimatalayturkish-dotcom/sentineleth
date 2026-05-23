import { expect } from "chai"
import hre from "hardhat"

const { ethers } = hre

const CLAIM_TYPES = {
  Claim: [
    { name: "blockNumber", type: "uint256" },
    { name: "bucketId", type: "uint256" },
    { name: "blockHash", type: "bytes32" },
    { name: "winner", type: "address" },
    { name: "winnerPower", type: "uint256" },
  ],
}

const AGGREGATE_CLAIM_TYPES = {
  AggregateClaim: [
    { name: "winner", type: "address" },
    { name: "bucketIdsHash", type: "bytes32" },
    { name: "cumulativeRoundsHash", type: "bytes32" },
  ],
}

interface ClaimPayload {
  blockNumber: bigint
  bucketId: bigint
  blockHash: string
  winner: string
  winnerPower: bigint
}

interface AggregateClaimPayload {
  winner: string
  bucketIdsHash: string
  cumulativeRoundsHash: string
}

interface AddressableContract {
  getAddress(): Promise<string>
}

interface ClaimSigner {
  signTypedData(
    domain: { name: string; version: string; chainId: bigint; verifyingContract: string },
    types: typeof CLAIM_TYPES,
    value: ClaimPayload,
  ): Promise<string>
}

interface AggregateClaimSigner {
  signTypedData(
    domain: { name: string; version: string; chainId: bigint; verifyingContract: string },
    types: typeof AGGREGATE_CLAIM_TYPES,
    value: AggregateClaimPayload,
  ): Promise<string>
}

async function signClaim(
  miner: AddressableContract,
  signer: ClaimSigner,
  claim: ClaimPayload,
  verifyingContract?: string,
) {
  const network = await ethers.provider.getNetwork()
  return signer.signTypedData(
    {
      name: "PatrolMiner",
      version: "1",
      chainId: network.chainId,
      verifyingContract: verifyingContract ?? await miner.getAddress(),
    },
    CLAIM_TYPES,
    claim,
  )
}

async function signAggregateClaim(
  miner: AddressableContract,
  signer: AggregateClaimSigner,
  claim: AggregateClaimPayload,
  verifyingContract?: string,
) {
  const network = await ethers.provider.getNetwork()
  return signer.signTypedData(
    {
      name: "PatrolMiner",
      version: "1",
      chainId: network.chainId,
      verifyingContract: verifyingContract ?? await miner.getAddress(),
    },
    AGGREGATE_CLAIM_TYPES,
    claim,
  )
}

describe("PatrolMiner", function () {
  const coder = ethers.AbiCoder.defaultAbiCoder()

  function hourBucket(timestamp: bigint) {
    return timestamp / 3600n
  }

  function hashUint256Array(values: bigint[]) {
    return ethers.keccak256(coder.encode(["uint256[]"], [values]))
  }

  async function deployFixture(opts: { start?: boolean } = {}) {
    const [deployer, admin, signer, newSigner, winner, other, liquidityRecipient, aiAgentMinter] = await ethers.getSigners()

    const SENTI = await ethers.getContractFactory("SENTI")
    const token = await SENTI.deploy(deployer.address)
    await token.waitForDeployment()

    const PatrolMiner = await ethers.getContractFactory("PatrolMiner")
    const miner = await PatrolMiner.deploy(
      await token.getAddress(),
      admin.address,
      signer.address,
    )
    await miner.waitForDeployment()
    await token.connect(deployer).transferMinter(await miner.getAddress())

    let startBlock = 0n
    if (opts.start ?? true) {
      const startTx = await miner.connect(admin).startMining()
      const receipt = await startTx.wait()
      startBlock = BigInt(receipt?.blockNumber ?? 0)
    }

    return { token, miner, deployer, admin, signer, newSigner, winner, other, liquidityRecipient, aiAgentMinter, startBlock }
  }

  async function signedClaim(fixture: Awaited<ReturnType<typeof deployFixture>>, offset = 0n) {
    if (offset > 0n) {
      await ethers.provider.send("hardhat_mine", [`0x${offset.toString(16)}`])
    }
    const blockNumber = BigInt(await ethers.provider.getBlockNumber())
    const block = await ethers.provider.getBlock(blockNumber)
    const bucketId = hourBucket(BigInt(block!.timestamp))
    const claim = {
      blockNumber,
      bucketId,
      blockHash: ethers.id(`block-${blockNumber}`),
      winner: fixture.winner.address,
      winnerPower: 123n,
    }
    return { ...claim, signature: await signClaim(fixture.miner, fixture.signer, claim) }
  }

  async function signedAggregateClaim(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    opts: { bucketIds?: bigint[]; cumulativeRounds?: bigint[] } = {},
  ) {
    const bucketIds = opts.bucketIds ?? [hourBucket(BigInt((await ethers.provider.getBlock("latest"))!.timestamp))]
    const cumulativeRounds = opts.cumulativeRounds ?? [2n]
    const claim = {
      winner: fixture.winner.address,
      bucketIdsHash: hashUint256Array(bucketIds),
      cumulativeRoundsHash: hashUint256Array(cumulativeRounds),
    }
    return { ...claim, bucketIds, cumulativeRounds, signature: await signAggregateClaim(fixture.miner, fixture.signer, claim) }
  }

  it("accepts a valid backend-signed claim and mints the block reward", async function () {
    const fixture = await deployFixture()
    const { token, miner, winner, other } = fixture
    const claim = await signedClaim(fixture)
    const reward = await miner.BLOCK_REWARD()

    await expect(miner.connect(other).claim(
      claim.blockNumber,
      claim.bucketId,
      claim.blockHash,
      claim.winner,
      claim.winnerPower,
      claim.signature,
    ))
      .to.emit(miner, "Claimed")
      .withArgs(claim.blockNumber, winner.address, reward, claim.winnerPower, claim.bucketId)

    expect(await miner.claimed(claim.blockNumber)).to.equal(true)
    expect(await miner.claimedBucketRounds(winner.address, claim.bucketId)).to.equal(1n)
    expect(await miner.mined()).to.equal(reward)
    expect(await miner.rewardedRounds()).to.equal(1n)
    expect(await token.balanceOf(winner.address)).to.equal(reward)
  })

  it("starts mining once by admin action", async function () {
    const fixture = await deployFixture({ start: false })
    const { miner, admin, other } = fixture
    const maxRewardRounds = await miner.MAX_REWARD_ROUNDS()

    expect(await miner.miningStartBlock()).to.equal(0n)
    expect(await miner.miningActive()).to.equal(false)

    await expect(miner.connect(other).startMining())
      .to.be.revertedWithCustomError(miner, "NotAdmin")
      .withArgs(other.address)

    const startTx = await miner.connect(admin).startMining()
    const receipt = await startTx.wait()
    const startBlock = BigInt(receipt?.blockNumber ?? 0)

    await expect(startTx)
      .to.emit(miner, "MiningStarted")
      .withArgs(startBlock, maxRewardRounds)
    expect(await miner.miningStartBlock()).to.equal(startBlock)
    expect(await miner.miningActive()).to.equal(true)

    await expect(miner.connect(admin).startMining())
      .to.be.revertedWithCustomError(miner, "MiningAlreadyStarted")
      .withArgs(startBlock)
  })

  it("rejects claims before mining is started", async function () {
    const fixture = await deployFixture({ start: false })
    const { miner, signer, winner } = fixture
    const blockNumber = BigInt(await ethers.provider.getBlockNumber())
    const claim = {
      blockNumber,
      bucketId: hourBucket(BigInt((await ethers.provider.getBlock(blockNumber))!.timestamp)),
      blockHash: ethers.id("pre-start-block"),
      winner: winner.address,
      winnerPower: 123n,
    }
    const signature = await signClaim(miner, signer, claim)

    await expect(miner.claim(blockNumber, claim.bucketId, claim.blockHash, claim.winner, claim.winnerPower, signature))
      .to.be.revertedWithCustomError(miner, "MiningInactive")
      .withArgs(blockNumber)
  })

  it("uses fixed rewarded rounds instead of elapsed chain blocks", async function () {
    const fixture = await deployFixture()
    const { miner, token, winner } = fixture
    const reward = await miner.BLOCK_REWARD()
    const firstClaim = await signedClaim(fixture)

    await miner.claim(firstClaim.blockNumber, firstClaim.bucketId, firstClaim.blockHash, firstClaim.winner, firstClaim.winnerPower, firstClaim.signature)
    expect(await miner.rewardedRounds()).to.equal(1n)

    await ethers.provider.send("hardhat_mine", ["0x3e8"])

    const laterBlock = BigInt(await ethers.provider.getBlockNumber())
    const laterClaim = {
      blockNumber: laterBlock,
      bucketId: hourBucket(BigInt((await ethers.provider.getBlock(laterBlock))!.timestamp)),
      blockHash: ethers.id(`late-block-${laterBlock}`),
      winner: winner.address,
      winnerPower: 456n,
    }
    const laterSignature = await signClaim(miner, fixture.signer, laterClaim)

    await miner.claim(laterClaim.blockNumber, laterClaim.bucketId, laterClaim.blockHash, laterClaim.winner, laterClaim.winnerPower, laterSignature)

    expect(await miner.rewardedRounds()).to.equal(2n)
    expect(await miner.mined()).to.equal(reward * 2n)
    expect(await token.balanceOf(winner.address)).to.equal(reward * 2n)
    expect(await miner.miningActive()).to.equal(true)
  })

  it("publishes exact allocation constants", async function () {
    const fixture = await deployFixture({ start: false })
    const { token, miner } = fixture

    const phaseOneSupply = await miner.PHASE_ONE_SUPPLY()
    const initialLiquiditySupply = await miner.INITIAL_LIQUIDITY_SUPPLY()
    const mineableSupply = await miner.MINEABLE_SUPPLY()
    const liquidityManagerReserveSupply = await miner.LIQUIDITY_MANAGER_RESERVE_SUPPLY()
    const maxAiAgentReservedSupply = await miner.MAX_AI_AGENT_RESERVED_SUPPLY()
    const aiAgentReservedSupply = await miner.aiAgentReservedSupply()
    const blockReward = await miner.BLOCK_REWARD()

    expect(phaseOneSupply).to.equal(ethers.parseEther("600000000"))
    expect(initialLiquiditySupply).to.equal(ethers.parseEther("200000"))
    expect(mineableSupply).to.equal(ethers.parseEther("599800000"))
    expect(liquidityManagerReserveSupply).to.equal(ethers.parseEther("100000000"))
    expect(maxAiAgentReservedSupply).to.equal(ethers.parseEther("300000000"))
    expect(aiAgentReservedSupply).to.equal(maxAiAgentReservedSupply)
    expect(mineableSupply + initialLiquiditySupply + liquidityManagerReserveSupply + maxAiAgentReservedSupply).to.equal(await token.MAX_SUPPLY())
    expect(await miner.MAX_REWARD_ROUNDS()).to.equal((mineableSupply + blockReward - 1n) / blockReward)
    expect(await miner.rewardForNextRound()).to.equal(blockReward)
  })

  it("mints the initial liquidity seed once under admin control", async function () {
    const fixture = await deployFixture({ start: false })
    const { token, miner, admin, other, liquidityRecipient } = fixture
    const liquiditySupply = await miner.INITIAL_LIQUIDITY_SUPPLY()

    await expect(miner.connect(other).mintInitialLiquidity(liquidityRecipient.address))
      .to.be.revertedWithCustomError(miner, "NotAdmin")
      .withArgs(other.address)
    await expect(miner.connect(admin).mintInitialLiquidity(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(miner, "ZeroAddress")

    await expect(miner.connect(admin).mintInitialLiquidity(liquidityRecipient.address))
      .to.emit(miner, "InitialLiquidityMinted")
      .withArgs(liquidityRecipient.address, liquiditySupply)

    expect(await miner.initialLiquidityMinted()).to.equal(true)
    expect(await token.balanceOf(liquidityRecipient.address)).to.equal(liquiditySupply)

    await expect(miner.connect(admin).mintInitialLiquidity(liquidityRecipient.address))
      .to.be.revertedWithCustomError(miner, "InitialLiquidityAlreadyMinted")
  })

  it("reserves AI-agent minting for a later authorized minter", async function () {
    const fixture = await deployFixture({ start: false })
    const { token, miner, admin, other, winner, aiAgentMinter } = fixture
    const aiAgentSupply = await miner.aiAgentReservedSupply()

    await expect(miner.connect(other).setAiAgentMinter(aiAgentMinter.address))
      .to.be.revertedWithCustomError(miner, "NotAdmin")
      .withArgs(other.address)
    await expect(miner.connect(admin).setAiAgentMinter(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(miner, "ZeroAddress")
    await expect(miner.connect(admin).setAiAgentMinter(aiAgentMinter.address))
      .to.emit(miner, "AiAgentMinterSet")
      .withArgs(aiAgentMinter.address)
    await expect(miner.connect(admin).setAiAgentMinter(other.address))
      .to.be.revertedWithCustomError(miner, "AiAgentMinterAlreadySet")
      .withArgs(aiAgentMinter.address)

    await expect(miner.connect(other).mintAiAgent(winner.address, 1n))
      .to.be.revertedWithCustomError(miner, "NotAiAgentMinter")
      .withArgs(other.address)
    await expect(miner.connect(aiAgentMinter).mintAiAgent(ethers.ZeroAddress, 1n))
      .to.be.revertedWithCustomError(miner, "ZeroAddress")

    await expect(miner.connect(aiAgentMinter).mintAiAgent(winner.address, aiAgentSupply))
      .to.emit(miner, "AiAgentMinted")
      .withArgs(winner.address, aiAgentSupply, aiAgentSupply)
    expect(await miner.aiAgentMinted()).to.equal(aiAgentSupply)
    expect(await token.balanceOf(winner.address)).to.equal(aiAgentSupply)

    await expect(miner.connect(aiAgentMinter).mintAiAgent(winner.address, 1n))
      .to.be.revertedWithCustomError(miner, "AiAgentSupplyExceeded")
      .withArgs(aiAgentSupply + 1n, aiAgentSupply)
  })

  it("allows admin to burn only the unminted AI-agent reserve", async function () {
    const fixture = await deployFixture({ start: false })
    const { miner, admin, other, winner, aiAgentMinter } = fixture

    await expect(miner.connect(other).burnUnmintedAiAgentSupply(1n))
      .to.be.revertedWithCustomError(miner, "NotAdmin")
      .withArgs(other.address)

    await expect(miner.connect(admin).burnUnmintedAiAgentSupply(0n))
      .to.be.revertedWithCustomError(miner, "InvalidAiAgentReserveBurn")
      .withArgs(0n)

    await miner.connect(admin).setAiAgentMinter(aiAgentMinter.address)
    await miner.connect(aiAgentMinter).mintAiAgent(winner.address, ethers.parseEther("10"))

    const previousReservedSupply = await miner.aiAgentReservedSupply()
    const burnAmount = ethers.parseEther("100")
    const nextReservedSupply = previousReservedSupply - burnAmount

    await expect(miner.connect(admin).burnUnmintedAiAgentSupply(burnAmount))
      .to.emit(miner, "UnmintedAiAgentSupplyBurned")
      .withArgs(previousReservedSupply, nextReservedSupply, burnAmount)

    expect(await miner.aiAgentReservedSupply()).to.equal(nextReservedSupply)

    await expect(miner.connect(admin).burnUnmintedAiAgentSupply(nextReservedSupply))
      .to.be.revertedWithCustomError(miner, "AiAgentReserveBurnExceeded")
      .withArgs(0n, ethers.parseEther("10"))
  })

  it("rejects duplicate claims", async function () {
    const fixture = await deployFixture()
    const { miner } = fixture
    const claim = await signedClaim(fixture)

    await miner.claim(claim.blockNumber, claim.bucketId, claim.blockHash, claim.winner, claim.winnerPower, claim.signature)
    await expect(miner.claim(claim.blockNumber, claim.bucketId, claim.blockHash, claim.winner, claim.winnerPower, claim.signature))
      .to.be.revertedWithCustomError(miner, "AlreadyClaimed")
      .withArgs(claim.blockNumber)
  })

  it("binds signatures to the signer, chain, and verifying contract", async function () {
    const fixture = await deployFixture()
    const { token, miner, other } = fixture
    const claim = await signedClaim(fixture)
    const wrongSignerSignature = await signClaim(miner, other, claim)
    const wrongContractSignature = await signClaim(miner, fixture.signer, claim, await token.getAddress())

    await expect(miner.claim(claim.blockNumber, claim.bucketId, claim.blockHash, claim.winner, claim.winnerPower, wrongSignerSignature))
      .to.be.revertedWithCustomError(miner, "InvalidSignature")
    await expect(miner.claim(claim.blockNumber, claim.bucketId, claim.blockHash, claim.winner, claim.winnerPower, wrongContractSignature))
      .to.be.revertedWithCustomError(miner, "InvalidSignature")
  })

  it("allows Safe/admin signer rotation only", async function () {
    const fixture = await deployFixture()
    const { miner, admin, newSigner, other } = fixture

    await expect(miner.connect(other).setSigner(newSigner.address))
      .to.be.revertedWithCustomError(miner, "NotAdmin")
      .withArgs(other.address)

    await expect(miner.connect(admin).setSigner(newSigner.address))
      .to.emit(miner, "SignerUpdated")
      .withArgs(fixture.signer.address, newSigner.address)

    const blockNumber = fixture.startBlock + 1n
    const claim = {
      blockNumber,
      bucketId: hourBucket(BigInt((await ethers.provider.getBlock(blockNumber))!.timestamp)),
      blockHash: ethers.id("rotated-signer-block"),
      winner: fixture.winner.address,
      winnerPower: 222n,
    }
    const signature = await signClaim(miner, newSigner, claim)
    await expect(miner.claim(blockNumber, claim.bucketId, claim.blockHash, claim.winner, claim.winnerPower, signature))
      .to.emit(miner, "Claimed")
  })

  it("rejects expired, future, and malformed claims", async function () {
    const fixture = await deployFixture()
    const { miner, winner } = fixture
    const claim = await signedClaim(fixture)

    const futureBlock = BigInt(await ethers.provider.getBlockNumber()) + 10n
    const futureClaim = {
      blockNumber: futureBlock,
      bucketId: hourBucket(BigInt((await ethers.provider.getBlock("latest"))!.timestamp)),
      blockHash: ethers.id("future-block"),
      winner: winner.address,
      winnerPower: 99n,
    }
    const futureSignature = await signClaim(miner, fixture.signer, futureClaim)
    await expect(miner.claim(futureClaim.blockNumber, futureClaim.bucketId, futureClaim.blockHash, futureClaim.winner, futureClaim.winnerPower, futureSignature))
      .to.be.revertedWithCustomError(miner, "MiningInactive")

    await expect(miner.claim(claim.blockNumber, claim.bucketId, ethers.ZeroHash, claim.winner, claim.winnerPower, claim.signature))
      .to.be.revertedWithCustomError(miner, "InvalidBlockHash")
    await expect(miner.claim(claim.blockNumber, claim.bucketId, claim.blockHash, ethers.ZeroAddress, claim.winnerPower, claim.signature))
      .to.be.revertedWithCustomError(miner, "InvalidWinner")
    await expect(miner.claim(claim.blockNumber, claim.bucketId, claim.blockHash, claim.winner, 0, claim.signature))
      .to.be.revertedWithCustomError(miner, "InvalidPower")

    await ethers.provider.send("evm_increaseTime", [25 * 3600])
    await ethers.provider.send("evm_mine", [])
    await expect(miner.claim(claim.blockNumber, claim.bucketId, claim.blockHash, claim.winner, claim.winnerPower, claim.signature))
      .to.be.revertedWithCustomError(miner, "ClaimExpired")
  })

  it("batch claims multiple signed blocks with a cap", async function () {
    const fixture = await deployFixture()
    const { miner, token, winner } = fixture
    const first = await signedClaim(fixture, 0n)
    const second = await signedClaim(fixture, 1n)

    await expect(miner.batchClaim([]))
      .to.be.revertedWithCustomError(miner, "InvalidBatchSize")
      .withArgs(0n)

    await miner.batchClaim([first, second])
    expect(await token.balanceOf(winner.address)).to.equal((await miner.BLOCK_REWARD()) * 2n)
  })

  it("aggregate claims bucket deltas in one mint", async function () {
    const fixture = await deployFixture()
    const { miner, token, winner, other } = fixture
    const currentBlock = await ethers.provider.getBlock("latest")
    const bucketId = hourBucket(BigInt(currentBlock!.timestamp))
    const aggregate = await signedAggregateClaim(fixture, { bucketIds: [bucketId], cumulativeRounds: [3n] })
    const reward = await miner.BLOCK_REWARD() * 3n

    await expect(
      miner.connect(other).aggregateClaim(
        aggregate.winner,
        aggregate.bucketIds,
        aggregate.cumulativeRounds,
        aggregate.signature,
      ),
    )
      .to.emit(miner, "AggregateClaimed")
      .withArgs(winner.address, 3n, reward, aggregate.bucketIds, [3n])

    expect(await miner.claimedBucketRounds(winner.address, bucketId)).to.equal(3n)
    expect(await miner.rewardedRounds()).to.equal(3n)
    expect(await miner.mined()).to.equal(reward)
    expect(await token.balanceOf(winner.address)).to.equal(reward)
  })

  it("rejects aggregate replay once bucket deltas are already consumed", async function () {
    const fixture = await deployFixture()
    const { miner, winner } = fixture
    const currentBlock = await ethers.provider.getBlock("latest")
    const bucketId = hourBucket(BigInt(currentBlock!.timestamp))
    const aggregate = await signedAggregateClaim(fixture, { bucketIds: [bucketId], cumulativeRounds: [2n] })

    await miner.aggregateClaim(
      aggregate.winner,
      aggregate.bucketIds,
      aggregate.cumulativeRounds,
      aggregate.signature,
    )

    await expect(
      miner.aggregateClaim(
        aggregate.winner,
        aggregate.bucketIds,
        aggregate.cumulativeRounds,
        aggregate.signature,
      ),
    )
      .to.be.revertedWithCustomError(miner, "NothingClaimable")
      .withArgs(winner.address)
  })

  it("lets later cumulative claims mint only the new delta", async function () {
    const fixture = await deployFixture()
    const { miner, token, winner } = fixture
    const currentBlock = await ethers.provider.getBlock("latest")
    const bucketId = hourBucket(BigInt(currentBlock!.timestamp))
    const first = await signedAggregateClaim(fixture, { bucketIds: [bucketId], cumulativeRounds: [2n] })
    const second = await signedAggregateClaim(fixture, { bucketIds: [bucketId], cumulativeRounds: [5n] })
    const reward = await miner.BLOCK_REWARD()

    await miner.aggregateClaim(first.winner, first.bucketIds, first.cumulativeRounds, first.signature)
    await miner.aggregateClaim(second.winner, second.bucketIds, second.cumulativeRounds, second.signature)

    expect(await miner.claimedBucketRounds(winner.address, bucketId)).to.equal(5n)
    expect(await token.balanceOf(winner.address)).to.equal(reward * 5n)
    expect(await miner.rewardedRounds()).to.equal(5n)
  })

  it("skips expired buckets and claims only live bucket deltas", async function () {
    const fixture = await deployFixture()
    const { miner, token, winner } = fixture

    const initialBlock = await ethers.provider.getBlock("latest")
    const oldBucketId = hourBucket(BigInt(initialBlock!.timestamp))
    await ethers.provider.send("evm_increaseTime", [25 * 3600])
    await ethers.provider.send("evm_mine", [])
    const liveBlock = await ethers.provider.getBlock("latest")
    const liveBucketId = hourBucket(BigInt(liveBlock!.timestamp))

    const aggregate = await signedAggregateClaim(fixture, {
      bucketIds: [oldBucketId, liveBucketId],
      cumulativeRounds: [4n, 3n],
    })

    await expect(miner.aggregateClaim(aggregate.winner, aggregate.bucketIds, aggregate.cumulativeRounds, aggregate.signature))
      .to.emit(miner, "AggregateClaimed")
      .withArgs(winner.address, 3n, (await miner.BLOCK_REWARD()) * 3n, aggregate.bucketIds, [0n, 3n])

    expect(await miner.claimedBucketRounds(winner.address, oldBucketId)).to.equal(0n)
    expect(await miner.claimedBucketRounds(winner.address, liveBucketId)).to.equal(3n)
    expect(await token.balanceOf(winner.address)).to.equal((await miner.BLOCK_REWARD()) * 3n)
  })

  it("exposes deterministic score calculation", async function () {
    const fixture = await deployFixture()
    const blockHash = ethers.id("score-block")

    const lowPowerScore = await fixture.miner.scoreFor(blockHash, fixture.winner.address, 10n)
    const highPowerScore = await fixture.miner.scoreFor(blockHash, fixture.winner.address, 100n)

    expect(highPowerScore).to.be.lessThan(lowPowerScore)
    await expect(fixture.miner.scoreFor(blockHash, fixture.winner.address, 0n))
      .to.be.revertedWithCustomError(fixture.miner, "InvalidPower")
  })

  it("rejects zero constructor addresses", async function () {
    const [deployer, admin, signer] = await ethers.getSigners()
    const SENTI = await ethers.getContractFactory("SENTI")
    const token = await SENTI.deploy(deployer.address)
    await token.waitForDeployment()

    const PatrolMiner = await ethers.getContractFactory("PatrolMiner")
    await expect(PatrolMiner.deploy(ethers.ZeroAddress, admin.address, signer.address))
      .to.be.revertedWithCustomError(PatrolMiner, "ZeroAddress")
    await expect(PatrolMiner.deploy(await token.getAddress(), ethers.ZeroAddress, signer.address))
      .to.be.revertedWithCustomError(PatrolMiner, "ZeroAddress")
    await expect(PatrolMiner.deploy(await token.getAddress(), admin.address, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(PatrolMiner, "ZeroAddress")
  })
})
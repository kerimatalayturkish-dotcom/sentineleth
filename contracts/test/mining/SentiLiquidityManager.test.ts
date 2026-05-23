import { expect } from "chai"
import hre from "hardhat"

import {
  DEFAULT_POOL_FEE,
  DEFAULT_TICK_SPACING,
  SQRT_PRICE_1_1,
  deployCoreV4,
  deployPositionManagerFixture,
  makeCanonicalNativePoolKey,
  mineAndDeploySentiHook,
} from "./uniswap-v4-test-helpers"

const { ethers } = hre
const CONTRACT_BALANCE = 1n << 255n

describe("SentiLiquidityManager", function () {
  async function deployFixture() {
    const [deployer, adminSafe, opsSafe, keeper, other] = await ethers.getSigners()

    const SENTI = await ethers.getContractFactory("SENTI")
    const token = await SENTI.deploy(deployer.address)
    await token.waitForDeployment()

    const MockPermit2 = await ethers.getContractFactory("MockPermit2")
    const permit2 = await MockPermit2.deploy()
    await permit2.waitForDeployment()

    const MockPositionManager = await ethers.getContractFactory("MockPositionManager")
    const positionManager = await MockPositionManager.deploy()
    await positionManager.waitForDeployment()

    const sentiAddress = await token.getAddress()
    const poolKey = {
      currency0: sentiAddress,
      currency1: ethers.ZeroAddress,
      fee: 3000,
      tickSpacing: 60,
      hooks: other.address,
    }

    const SentiLiquidityManager = await ethers.getContractFactory("SentiLiquidityManager")
    const manager = await SentiLiquidityManager.deploy(
      adminSafe.address,
      opsSafe.address,
      sentiAddress,
      await positionManager.getAddress(),
      await permit2.getAddress(),
      poolKey,
      {
        minEthToCompound: ethers.parseEther("0.5"),
        compoundCooldown: 3600,
        maxEthPerCompound: ethers.parseEther("2"),
        maxSentiPerCompound: ethers.parseEther("1000"),
        maxDeadlineWindow: 600,
      },
    )
    await manager.waitForDeployment()

    await token.connect(deployer).mint(await manager.getAddress(), ethers.parseEther("5000"))
    await adminSafe.sendTransaction({ to: await manager.getAddress(), value: ethers.parseEther("1") })

    return { token, permit2, positionManager, manager, deployer, adminSafe, opsSafe, keeper, other, poolKey }
  }

  async function deployRealFixture(options: {
    reserveEth?: bigint
    reserveSenti?: bigint
    minEthToCompound?: bigint
    compoundCooldown?: number
    maxEthPerCompound?: bigint
    maxSentiPerCompound?: bigint
    maxDeadlineWindow?: number
  } = {}) {
    const [deployer, adminSafe, opsSafe, keeper] = await ethers.getSigners()

    const {
      reserveEth = ethers.parseEther("5"),
      reserveSenti = ethers.parseEther("5000"),
      minEthToCompound = ethers.parseEther("0.5"),
      compoundCooldown = 3600,
      maxEthPerCompound = ethers.parseEther("5"),
      maxSentiPerCompound = ethers.parseEther("5000"),
      maxDeadlineWindow = 600,
    } = options

    const SENTI = await ethers.getContractFactory("SENTI")
    const token = await SENTI.deploy(deployer.address)
    await token.waitForDeployment()

    const { poolManager } = await deployCoreV4(deployer)

    const MockCreate2Deployer = await ethers.getContractFactory("MockCreate2Deployer")
    const create2Deployer = await MockCreate2Deployer.deploy()
    await create2Deployer.waitForDeployment()

    const hook = await mineAndDeploySentiHook({
      deployerSigner: deployer,
      create2DeployerAddress: await create2Deployer.getAddress(),
      poolManagerAddress: await poolManager.getAddress(),
      sentiTokenAddress: await token.getAddress(),
      feeRecipientAddress: deployer.address,
      poolFee: DEFAULT_POOL_FEE,
      tickSpacing: DEFAULT_TICK_SPACING,
    })

    const poolKey = makeCanonicalNativePoolKey(await token.getAddress(), await hook.getAddress())
    const { permit2Address, positionManager } = await deployPositionManagerFixture(deployer, await poolManager.getAddress())

    const SentiLiquidityManager = await ethers.getContractFactory("SentiLiquidityManager")
    const manager = await SentiLiquidityManager.deploy(
      adminSafe.address,
      opsSafe.address,
      await token.getAddress(),
      await positionManager.getAddress(),
      permit2Address,
      poolKey,
      {
        minEthToCompound,
        compoundCooldown,
        maxEthPerCompound,
        maxSentiPerCompound,
        maxDeadlineWindow,
      },
    )
    await manager.waitForDeployment()

    if (reserveSenti > 0n) {
      await token.connect(deployer).mint(await manager.getAddress(), reserveSenti)
    }

    if (reserveEth > 0n) {
      await adminSafe.sendTransaction({ to: await manager.getAddress(), value: reserveEth })
    }

    await manager.connect(adminSafe).setKeeper(keeper.address, true)

    return { token, manager, positionManager, deployer, adminSafe, opsSafe, keeper, poolKey }
  }

  async function bootstrapRealPosition(
    fixture: Awaited<ReturnType<typeof deployRealFixture>>,
    options: {
      bootstrapEth?: bigint
      bootstrapSenti?: bigint
      tickLower?: number
      tickUpper?: number
      deadlineOffset?: number
    } = {},
  ) {
    const {
      bootstrapEth = ethers.parseEther("1"),
      bootstrapSenti = ethers.parseEther("500"),
      tickLower = -120,
      tickUpper = 120,
      deadlineOffset = 300,
    } = options

    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + deadlineOffset)

    const tx = await fixture.manager.connect(fixture.adminSafe).bootstrapInitialPosition(
      SQRT_PRICE_1_1,
      tickLower,
      tickUpper,
      bootstrapEth,
      bootstrapSenti,
      deadline,
      { value: bootstrapEth },
    )

    return { tx, deadline, bootstrapEth, bootstrapSenti, tickLower, tickUpper }
  }

  it("primes Permit2 and stores the canonical pair config", async function () {
    const { token, permit2, positionManager, manager, adminSafe, opsSafe } = await deployFixture()

    expect(await manager.senti()).to.equal(await token.getAddress())
    expect(await manager.positionManager()).to.equal(await positionManager.getAddress())
    expect(await manager.adminSafe()).to.equal(adminSafe.address)
    expect(await manager.opsSafe()).to.equal(opsSafe.address)
    expect(await token.allowance(await manager.getAddress(), await permit2.getAddress())).to.equal(ethers.MaxUint256)
    expect(await permit2.lastToken()).to.equal(await token.getAddress())
    expect(await permit2.lastSpender()).to.equal(await positionManager.getAddress())
  })

  it("lets admin manage keeper authorization", async function () {
    const { manager, adminSafe, keeper, other } = await deployFixture()

    await expect(manager.connect(other).setKeeper(keeper.address, true))
      .to.be.revertedWithCustomError(manager, "NotAdminSafe")
      .withArgs(other.address)

    await expect(manager.connect(adminSafe).setKeeper(keeper.address, true))
      .to.emit(manager, "KeeperUpdated")
      .withArgs(keeper.address, true)
    expect(await manager.authorizedKeepers(keeper.address)).to.equal(true)
  })

  it("burns only manager-held reserve inventory", async function () {
    const { token, manager, adminSafe, other } = await deployFixture()
    const burnAmount = ethers.parseEther("125")

    await expect(manager.connect(other).burnReserveSenti(burnAmount))
      .to.be.revertedWithCustomError(manager, "NotAdminSafe")
      .withArgs(other.address)

    const totalSupplyBefore = await token.totalSupply()
    const balanceBefore = await token.balanceOf(await manager.getAddress())
    await expect(manager.connect(adminSafe).burnReserveSenti(burnAmount))
      .to.emit(manager, "ReserveBurned")
      .withArgs(adminSafe.address, burnAmount)

    expect(await token.balanceOf(await manager.getAddress())).to.equal(balanceBefore - burnAmount)
    expect(await token.totalSupply()).to.equal(totalSupplyBefore - burnAmount)
  })

  it("tracks only manager-owned positions on the configured pool", async function () {
    const { positionManager, manager, adminSafe, other, poolKey } = await deployFixture()

    await positionManager.setPosition(1n, other.address, poolKey, -120, 120)
    await expect(manager.connect(adminSafe).setTrackedPositionTokenId(1n))
      .to.be.revertedWithCustomError(manager, "PositionOwnerMismatch")
      .withArgs(1n, other.address)

    await positionManager.setPosition(
      2n,
      await manager.getAddress(),
      { ...poolKey, fee: 500 },
      -120,
      120,
    )
    await expect(manager.connect(adminSafe).setTrackedPositionTokenId(2n))
      .to.be.revertedWithCustomError(manager, "PoolKeyMismatch")
  })

  it("bootstraps the initial LP position directly into the manager", async function () {
    const { token, positionManager, manager, adminSafe, poolKey } = await deployFixture()
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 120)
    const sentiAmount = ethers.parseEther("200")
    const ethAmount = ethers.parseEther("0.125")
    const sqrtPriceX96 = 79228162514264337593543950336n

    await expect(
      manager.connect(adminSafe).bootstrapInitialPosition(
        sqrtPriceX96,
        -120,
        120,
        sentiAmount,
        ethAmount,
        deadline,
        { value: ethAmount },
      ),
    )
      .to.emit(manager, "TrackedPositionUpdated")
      .withArgs(0n, 1n, -120, 120)

    expect(await manager.trackedPositionTokenId()).to.equal(1n)
    expect(await positionManager.ownerOf(1n)).to.equal(await manager.getAddress())
    expect(await positionManager.lastValue()).to.equal(ethAmount)
    expect(await positionManager.lastSettleCurrency0()).to.equal(poolKey.currency0)
    expect(await positionManager.lastSettleCurrency1()).to.equal(poolKey.currency1)
    expect(await positionManager.lastSettleAmount0()).to.equal(CONTRACT_BALANCE)
    expect(await positionManager.lastSettleAmount1()).to.equal(CONTRACT_BALANCE)
    expect(await positionManager.lastAmount0Max()).to.equal(ethers.MaxUint256 >> 128n)
    expect(await positionManager.lastAmount1Max()).to.equal(ethers.MaxUint256 >> 128n)
    expect(await positionManager.lastMintTickLower()).to.equal(-120)
    expect(await positionManager.lastMintTickUpper()).to.equal(120)
    expect(await positionManager.lastMintOwner()).to.equal(await manager.getAddress())
    expect(await positionManager.lastTakeCurrency0()).to.equal(poolKey.currency0)
    expect(await positionManager.lastTakeCurrency1()).to.equal(poolKey.currency1)
    expect(await positionManager.lastTakeRecipient()).to.equal(await manager.getAddress())
    expect(await token.balanceOf(await positionManager.getAddress())).to.equal(sentiAmount)
  })

  it("compounds through the tracked position with threshold, caps, and cooldown guards", async function () {
    const { positionManager, manager, adminSafe, keeper, poolKey } = await deployFixture()
    await positionManager.setPosition(7n, await manager.getAddress(), poolKey, -180, 180)
    await manager.connect(adminSafe).setTrackedPositionTokenId(7n)
    await manager.connect(adminSafe).setKeeper(keeper.address, true)

    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 120)
    const sentiMax = ethers.parseEther("50")
    const ethMax = ethers.parseEther("0.6")

    await expect(manager.connect(keeper).compoundLiquidity(123456n, sentiMax, ethMax, deadline))
      .to.emit(manager, "LiquidityCompounded")
      .withArgs(keeper.address, 7n, 123456n, sentiMax, ethMax, deadline)

    expect(await positionManager.lastTokenId()).to.equal(7n)
    expect(await positionManager.lastLiquidityIncrease()).to.equal(123456n)
    expect(await positionManager.lastAmount0Max()).to.equal(sentiMax)
    expect(await positionManager.lastAmount1Max()).to.equal(ethMax)
    expect(await positionManager.lastValue()).to.equal(ethMax)
    expect(await positionManager.lastSettleCurrency0()).to.equal(poolKey.currency0)
    expect(await positionManager.lastSettleCurrency1()).to.equal(poolKey.currency1)
    expect(await positionManager.lastSweepCurrency()).to.equal(ethers.ZeroAddress)
    expect(await positionManager.lastSweepRecipient()).to.equal(await manager.getAddress())

    await expect(manager.connect(keeper).compoundLiquidity(1n, sentiMax, ethMax, deadline))
      .to.be.revertedWithCustomError(manager, "CompoundCooldownActive")
  })

  it("rejects compound when ETH threshold is not met", async function () {
    const [deployer, adminSafe, opsSafe, keeper, other] = await ethers.getSigners()

    const SENTI = await ethers.getContractFactory("SENTI")
    const token = await SENTI.deploy(deployer.address)
    await token.waitForDeployment()

    const MockPermit2 = await ethers.getContractFactory("MockPermit2")
    const permit2 = await MockPermit2.deploy()
    await permit2.waitForDeployment()

    const MockPositionManager = await ethers.getContractFactory("MockPositionManager")
    const positionManager = await MockPositionManager.deploy()
    await positionManager.waitForDeployment()

    const poolKey = {
      currency0: await token.getAddress(),
      currency1: ethers.ZeroAddress,
      fee: 3000,
      tickSpacing: 60,
      hooks: other.address,
    }

    const SentiLiquidityManager = await ethers.getContractFactory("SentiLiquidityManager")
    const manager = await SentiLiquidityManager.deploy(
      adminSafe.address,
      opsSafe.address,
      await token.getAddress(),
      await positionManager.getAddress(),
      await permit2.getAddress(),
      poolKey,
      {
        minEthToCompound: ethers.parseEther("0.5"),
        compoundCooldown: 0,
        maxEthPerCompound: ethers.parseEther("2"),
        maxSentiPerCompound: ethers.parseEther("1000"),
        maxDeadlineWindow: 600,
      },
    )
    await manager.waitForDeployment()

    await token.connect(deployer).mint(await manager.getAddress(), ethers.parseEther("100"))
    await positionManager.setPosition(9n, await manager.getAddress(), poolKey, -120, 120)
    await manager.connect(adminSafe).setTrackedPositionTokenId(9n)
    await manager.connect(adminSafe).setKeeper(keeper.address, true)

    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 120)
    await expect(manager.connect(keeper).compoundLiquidity(1n, ethers.parseEther("10"), ethers.parseEther("0.49"), deadline))
      .to.be.revertedWithCustomError(manager, "CompoundThresholdNotMet")
      .withArgs(ethers.parseEther("0.49"), ethers.parseEther("0.5"))
  })

  it("bootstraps and compounds through the real PositionManager settlement path", async function () {
    const fixture = await deployRealFixture()
    const { token, manager, positionManager, deployer, adminSafe, keeper, poolKey } = fixture

    const managerEthBeforeBootstrap = await ethers.provider.getBalance(await manager.getAddress())
    const managerTokenBeforeBootstrap = await token.balanceOf(await manager.getAddress())
    const bootstrap = await bootstrapRealPosition(fixture)

    await expect(bootstrap.tx)
      .to.emit(manager, "InitialPositionMinted")
      .withArgs(adminSafe.address, 1n, -120, 120, bootstrap.bootstrapSenti, bootstrap.bootstrapEth, bootstrap.deadline)

    expect(await manager.trackedPositionTokenId()).to.equal(1n)
    expect(await positionManager.ownerOf(1n)).to.equal(await manager.getAddress())
    expect(await positionManager.nextTokenId()).to.equal(2n)

    const [actualPoolKey] = await positionManager.getPoolAndPositionInfo(1n)
    expect(actualPoolKey.currency0).to.equal(poolKey.currency0)
    expect(actualPoolKey.currency1).to.equal(poolKey.currency1)
    expect(actualPoolKey.fee).to.equal(poolKey.fee)
    expect(actualPoolKey.tickSpacing).to.equal(poolKey.tickSpacing)
    expect(actualPoolKey.hooks).to.equal(poolKey.hooks)

    const managerEthAfterBootstrap = await ethers.provider.getBalance(await manager.getAddress())
    const managerTokenAfterBootstrap = await token.balanceOf(await manager.getAddress())
    expect(managerEthAfterBootstrap).to.equal(managerEthBeforeBootstrap)
    expect(managerTokenAfterBootstrap).to.be.lessThan(managerTokenBeforeBootstrap)

    await token.connect(deployer).mint(await manager.getAddress(), ethers.parseEther("1000"))
    await adminSafe.sendTransaction({ to: await manager.getAddress(), value: ethers.parseEther("2") })

    const compoundDeadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 300)
    const liquidityIncrease = 10n ** 18n
    const compoundEthMax = ethers.parseEther("1")
    const compoundSentiMax = ethers.parseEther("500")
    const managerEthBeforeCompound = await ethers.provider.getBalance(await manager.getAddress())
    const managerTokenBeforeCompound = await token.balanceOf(await manager.getAddress())

    await expect(
      manager.connect(keeper).compoundLiquidity(liquidityIncrease, compoundEthMax, compoundSentiMax, compoundDeadline),
    )
      .to.emit(manager, "LiquidityCompounded")
      .withArgs(keeper.address, 1n, liquidityIncrease, compoundSentiMax, compoundEthMax, compoundDeadline)

    expect(await manager.trackedPositionTokenId()).to.equal(1n)
    expect(await positionManager.ownerOf(1n)).to.equal(await manager.getAddress())
    expect(await manager.lastCompoundAt()).to.be.greaterThan(0n)
    expect(await ethers.provider.getBalance(await manager.getAddress())).to.be.lessThan(managerEthBeforeCompound)
    expect(await token.balanceOf(await manager.getAddress())).to.be.lessThan(managerTokenBeforeCompound)
  })

  it("rejects real-path compounding when ETH reserves are insufficient", async function () {
    const fixture = await deployRealFixture({ reserveEth: ethers.parseEther("0.75") })
    const { manager, keeper } = fixture
    const availableEth = ethers.parseEther("0.75")
    const compoundEthMax = ethers.parseEther("1")
    const compoundSentiMax = ethers.parseEther("500")

    await bootstrapRealPosition(fixture)

    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 300)

    await expect(manager.connect(keeper).compoundLiquidity(1n, compoundEthMax, compoundSentiMax, deadline))
      .to.be.revertedWithCustomError(manager, "InsufficientEthReserve")
      .withArgs(compoundEthMax, availableEth)
  })

  it("rejects real-path compounding when SENTI reserves are insufficient", async function () {
    const fixture = await deployRealFixture({ reserveSenti: ethers.parseEther("500") })
    const { token, manager, keeper } = fixture
    const compoundEthMax = ethers.parseEther("1")

    await bootstrapRealPosition(fixture, { bootstrapSenti: ethers.parseEther("500") })

    const availableSenti = await token.balanceOf(await manager.getAddress())
    const compoundSentiMax = availableSenti + 1n

    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 300)

    await expect(manager.connect(keeper).compoundLiquidity(1n, compoundEthMax, compoundSentiMax, deadline))
      .to.be.revertedWithCustomError(manager, "InsufficientSentiReserve")
      .withArgs(compoundSentiMax, availableSenti)
  })

  it("rejects real-path compounding above the configured ETH cap", async function () {
    const fixture = await deployRealFixture({ maxEthPerCompound: ethers.parseEther("1") })
    const { manager, keeper } = fixture
    const configuredMax = ethers.parseEther("1")
    const compoundEthMax = ethers.parseEther("1.1")
    const compoundSentiMax = ethers.parseEther("500")

    await bootstrapRealPosition(fixture)

    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 300)

    await expect(manager.connect(keeper).compoundLiquidity(1n, compoundEthMax, compoundSentiMax, deadline))
      .to.be.revertedWithCustomError(manager, "MaxEthSpendExceeded")
      .withArgs(compoundEthMax, configuredMax)
  })

  it("rejects real-path compounding past the deadline window", async function () {
    const fixture = await deployRealFixture({ maxDeadlineWindow: 600 })
    const { manager, keeper } = fixture

    await bootstrapRealPosition(fixture)

    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 700)

    await expect(manager.connect(keeper).compoundLiquidity(1n, ethers.parseEther("1"), ethers.parseEther("500"), deadline))
      .to.be.revertedWithCustomError(manager, "InvalidDeadline")
  })
})
import { expect } from "chai"
import { ethers } from "hardhat"

import { assertSentiHookBindings } from "../../scripts/mining/hook-binding-utils"

import {
  DEFAULT_LIQUIDITY_PARAMS,
  DEFAULT_POOL_FEE,
  DEFAULT_SWAP_SETTINGS,
  DEFAULT_TICK_SPACING,
  MAX_PRICE_LIMIT,
  MIN_PRICE_LIMIT,
  SQRT_PRICE_1_1,
  decodePackedBalanceDelta,
  deployCoreV4,
  makeCanonicalNativePoolKey,
  mineAndDeploySentiHook,
} from "./uniswap-v4-test-helpers"

describe("SentiHook", function () {
  async function deployFixture() {
    const [deployer, feeRecipient, trader] = await ethers.getSigners()

    const SENTI = await ethers.getContractFactory("SENTI")
    const token = await SENTI.deploy(deployer.address)
    await token.waitForDeployment()

    await token.mint(deployer.address, ethers.parseEther("1000"))
    await token.mint(trader.address, ethers.parseEther("1000"))

    const { poolManager, swapRouter, modifyLiquidityRouter } = await deployCoreV4(deployer)

    const MockCreate2Deployer = await ethers.getContractFactory("MockCreate2Deployer")
    const create2Deployer = await MockCreate2Deployer.deploy()
    await create2Deployer.waitForDeployment()

    const hook = await mineAndDeploySentiHook({
      deployerSigner: deployer,
      create2DeployerAddress: await create2Deployer.getAddress(),
      poolManagerAddress: await poolManager.getAddress(),
      sentiTokenAddress: await token.getAddress(),
      feeRecipientAddress: feeRecipient.address,
      poolFee: DEFAULT_POOL_FEE,
      tickSpacing: DEFAULT_TICK_SPACING,
    })

    const poolKey = makeCanonicalNativePoolKey(await token.getAddress(), await hook.getAddress())

    await token.approve(await modifyLiquidityRouter.getAddress(), ethers.MaxUint256)
    await token.connect(trader).approve(await swapRouter.getAddress(), ethers.MaxUint256)

    await poolManager.initialize(poolKey, SQRT_PRICE_1_1)
    await modifyLiquidityRouter.modifyLiquidity(poolKey, DEFAULT_LIQUIDITY_PARAMS, "0x", {
      value: ethers.parseEther("1"),
    })

    return { deployer, token, feeRecipient, trader, poolManager, swapRouter, modifyLiquidityRouter, hook, poolKey }
  }

  it("takes the ETH-side fee on buys through the real settlement path", async function () {
    const { token, feeRecipient, trader, swapRouter, poolKey } = await deployFixture()
    const amountIn = ethers.parseEther("0.01")
    const expectedFee = amountIn * 1500n / 10_000n

    const preview = decodePackedBalanceDelta(
      await swapRouter.connect(trader).swap.staticCall(
        poolKey,
        {
          zeroForOne: true,
          amountSpecified: -amountIn,
          sqrtPriceLimitX96: MIN_PRICE_LIMIT,
        },
        DEFAULT_SWAP_SETTINGS,
        "0x",
        { value: amountIn },
      ),
    )

    expect(preview.amount1).to.be.greaterThan(0n)

    const feeBefore = await ethers.provider.getBalance(feeRecipient.address)
    const traderTokenBefore = await token.balanceOf(trader.address)

    await swapRouter.connect(trader).swap(
      poolKey,
      {
        zeroForOne: true,
        amountSpecified: -amountIn,
        sqrtPriceLimitX96: MIN_PRICE_LIMIT,
      },
      DEFAULT_SWAP_SETTINGS,
      "0x",
      { value: amountIn },
    )

    const feeAfter = await ethers.provider.getBalance(feeRecipient.address)
    const traderTokenAfter = await token.balanceOf(trader.address)

    expect(feeAfter - feeBefore).to.equal(expectedFee)
    expect(traderTokenAfter - traderTokenBefore).to.equal(preview.amount1)
  })

  it("takes the ETH-side fee on sells through the real settlement path", async function () {
    const { feeRecipient, trader, swapRouter, poolKey } = await deployFixture()
    const amountIn = ethers.parseEther("0.01")

    const preview = decodePackedBalanceDelta(
      await swapRouter.connect(trader).swap.staticCall(
        poolKey,
        {
          zeroForOne: false,
          amountSpecified: -amountIn,
          sqrtPriceLimitX96: MAX_PRICE_LIMIT,
        },
        DEFAULT_SWAP_SETTINGS,
        "0x",
      ),
    )

    expect(preview.amount0).to.be.greaterThan(0n)

    const feeBefore = await ethers.provider.getBalance(feeRecipient.address)

    await swapRouter.connect(trader).swap(
      poolKey,
      {
        zeroForOne: false,
        amountSpecified: -amountIn,
        sqrtPriceLimitX96: MAX_PRICE_LIMIT,
      },
      DEFAULT_SWAP_SETTINGS,
      "0x",
    )

    const feeAfter = await ethers.provider.getBalance(feeRecipient.address)
    const feeDelta = feeAfter - feeBefore

    expect(feeDelta).to.be.greaterThan(0n)
    expect(feeDelta).to.equal(preview.amount0 * 1500n / 8_500n)
  })

  it("reverts exact output swaps on the real swap path", async function () {
    const { trader, swapRouter, hook, poolKey } = await deployFixture()

    await expect(
      swapRouter.connect(trader).swap(
        poolKey,
        {
          zeroForOne: true,
          amountSpecified: ethers.parseEther("0.001"),
          sqrtPriceLimitX96: MIN_PRICE_LIMIT,
        },
        DEFAULT_SWAP_SETTINGS,
        "0x",
        { value: ethers.parseEther("0.01") },
      ),
    ).to.be.reverted
  })

  it("detects hook binding mismatches before core deployment", async function () {
    const { deployer, token, feeRecipient, poolManager, hook } = await deployFixture()

    await assertSentiHookBindings(deployer, {
      hookAddress: await hook.getAddress(),
      poolManagerAddress: await poolManager.getAddress(),
      sentiTokenAddress: await token.getAddress(),
      feeRecipientAddress: feeRecipient.address,
      poolFee: DEFAULT_POOL_FEE,
      tickSpacing: DEFAULT_TICK_SPACING,
    })

    let mismatchError: Error | undefined
    try {
      await assertSentiHookBindings(deployer, {
        hookAddress: await hook.getAddress(),
        poolManagerAddress: await poolManager.getAddress(),
        sentiTokenAddress: await token.getAddress(),
        feeRecipientAddress: deployer.address,
        poolFee: DEFAULT_POOL_FEE,
        tickSpacing: DEFAULT_TICK_SPACING,
      })
    } catch (error) {
      mismatchError = error as Error
    }

    expect(mismatchError).to.be.instanceOf(Error)
    expect(mismatchError?.message).to.contain("fee recipient mismatch")
  })

  it("reverts non-canonical pools through the real swap path", async function () {
    const { deployer, trader, poolManager, swapRouter, modifyLiquidityRouter, hook } = await deployFixture()
    const amountIn = ethers.parseEther("0.01")

    const SENTI = await ethers.getContractFactory("SENTI")
    const otherToken = await SENTI.deploy(deployer.address)
    await otherToken.waitForDeployment()

    await otherToken.mint(deployer.address, ethers.parseEther("1000"))
    await otherToken.mint(trader.address, ethers.parseEther("1000"))

    const badPoolKey = makeCanonicalNativePoolKey(await otherToken.getAddress(), await hook.getAddress())

    await otherToken.approve(await modifyLiquidityRouter.getAddress(), ethers.MaxUint256)
    await otherToken.connect(trader).approve(await swapRouter.getAddress(), ethers.MaxUint256)

    await poolManager.initialize(badPoolKey, SQRT_PRICE_1_1)
    await modifyLiquidityRouter.modifyLiquidity(badPoolKey, DEFAULT_LIQUIDITY_PARAMS, "0x", {
      value: ethers.parseEther("1"),
    })

    await expect(
      swapRouter.connect(trader).swap(
        badPoolKey,
        {
          zeroForOne: true,
          amountSpecified: -amountIn,
          sqrtPriceLimitX96: MIN_PRICE_LIMIT,
        },
        DEFAULT_SWAP_SETTINGS,
        "0x",
        { value: amountIn },
      ),
    ).to.be.reverted
  })
})
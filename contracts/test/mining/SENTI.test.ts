import { expect } from "chai"
import hre from "hardhat"

const { ethers } = hre

describe("SENTI", function () {
  async function deployFixture() {
    const [minter, nextMinter, alice, stranger] = await ethers.getSigners()
    const SENTI = await ethers.getContractFactory("SENTI")
    const token = await SENTI.deploy(minter.address)
    await token.waitForDeployment()
    return { token, minter, nextMinter, alice, stranger }
  }

  it("sets ERC-20 metadata and initial minter", async function () {
    const { token, minter } = await deployFixture()
    expect(await token.name()).to.equal("Sentinel Mining Token")
    expect(await token.symbol()).to.equal("SENTI")
    expect(await token.minter()).to.equal(minter.address)
    expect(await token.minterLocked()).to.equal(false)
    expect(await token.MAX_SUPPLY()).to.equal(ethers.parseEther("1000000000"))
  })

  it("allows only the minter to mint and enforces the hard cap", async function () {
    const { token, minter, alice, stranger } = await deployFixture()
    const maxSupply = await token.MAX_SUPPLY()

    await expect(token.connect(stranger).mint(alice.address, 1n))
      .to.be.revertedWithCustomError(token, "NotMinter")
      .withArgs(stranger.address)

    await token.connect(minter).mint(alice.address, maxSupply)
    expect(await token.totalSupply()).to.equal(maxSupply)
    expect(await token.balanceOf(alice.address)).to.equal(maxSupply)

    await expect(token.connect(minter).mint(alice.address, 1n))
      .to.be.revertedWithCustomError(token, "CapExceeded")
  })

  it("transfers the minter once and locks the handoff", async function () {
    const { token, minter, nextMinter, alice } = await deployFixture()

    await expect(token.connect(minter).transferMinter(nextMinter.address))
      .to.emit(token, "MinterTransferred")
      .withArgs(minter.address, nextMinter.address, true)

    expect(await token.minter()).to.equal(nextMinter.address)
    expect(await token.minterLocked()).to.equal(true)

    await expect(token.connect(minter).mint(alice.address, 1n))
      .to.be.revertedWithCustomError(token, "NotMinter")
      .withArgs(minter.address)

    await token.connect(nextMinter).mint(alice.address, 1n)
    expect(await token.balanceOf(alice.address)).to.equal(1n)

    await expect(token.connect(nextMinter).transferMinter(minter.address))
      .to.be.revertedWithCustomError(token, "MinterAlreadyLocked")
  })

  it("allows holders to burn only their own balances", async function () {
    const { token, minter, alice } = await deployFixture()

    await token.connect(minter).mint(alice.address, 10n)
    await token.connect(alice).burn(4n)

    expect(await token.balanceOf(alice.address)).to.equal(6n)
    expect(await token.totalSupply()).to.equal(6n)
  })

  it("rejects zero addresses", async function () {
    const SENTI = await ethers.getContractFactory("SENTI")
    await expect(SENTI.deploy(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(SENTI, "ZeroAddress")

    const { token, minter } = await deployFixture()
    await expect(token.connect(minter).mint(ethers.ZeroAddress, 1n))
      .to.be.revertedWithCustomError(token, "ZeroAddress")
    await expect(token.connect(minter).transferMinter(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(token, "ZeroAddress")
  })
})
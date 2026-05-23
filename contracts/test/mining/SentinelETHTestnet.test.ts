import { expect } from "chai"
import { ethers } from "hardhat"

describe("SentinelETHTestnet", function () {
  async function deployFixture() {
    const [owner, holder, other] = await ethers.getSigners()
    const TestNft = await ethers.getContractFactory("SentinelETHTestnet")
    const contract = await TestNft.deploy(20, "")
    await contract.waitForDeployment()
    return { contract, owner, holder, other }
  }

  it("owner mints metadata-backed NFTs and holders can transfer them", async function () {
    const { contract, holder, other } = await deployFixture()
    const uris = ["https://gateway.irys.xyz/one", "https://gateway.irys.xyz/two"]

    await expect(contract.mintBatch(holder.address, uris))
      .to.emit(contract, "TokenURIsSet")
      .withArgs(1n, 2n)

    expect(await contract.totalSupply()).to.equal(2n)
    expect(await contract.ownerOf(1)).to.equal(holder.address)
    expect(await contract.tokenURI(1)).to.equal(uris[0])

    await contract.connect(holder).transferFrom(holder.address, other.address, 1)
    expect(await contract.ownerOf(1)).to.equal(other.address)
  })

  it("enforces max supply and owner-only minting", async function () {
    const { contract, holder } = await deployFixture()
    const uris = Array.from({ length: 20 }, (_, index) => `https://gateway.irys.xyz/${index + 1}`)

    await expect(contract.connect(holder).mintBatch(holder.address, [uris[0]]))
      .to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount")

    await contract.mintBatch(holder.address, uris)
    await expect(contract.mintBatch(holder.address, ["https://gateway.irys.xyz/overflow"]))
      .to.be.revertedWithCustomError(contract, "MaxSupplyExceeded")
  })
})
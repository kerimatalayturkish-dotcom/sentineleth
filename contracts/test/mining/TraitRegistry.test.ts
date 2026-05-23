import { expect } from "chai"
import hre from "hardhat"

const { ethers } = hre

describe("TraitRegistry", function () {
  async function deployFixture() {
    const [admin, stranger] = await ethers.getSigners()
    const traitsSourceHash = ethers.id("config/traits.json")
    const powerConfigHash = ethers.id("mining-sentinel/config/trait-power.json")
    const synergyRulesHash = ethers.id("synergy-rules-v1")
    const rulesCommitment = ethers.id("rules-v1")
    const TraitRegistry = await ethers.getContractFactory("TraitRegistry")
    const registry = await TraitRegistry.deploy(
      admin.address,
      traitsSourceHash,
      powerConfigHash,
      synergyRulesHash,
      rulesCommitment,
      10_000,
      2,
      3,
      2,
    )
    await registry.waitForDeployment()
    return { registry, admin, stranger, traitsSourceHash, powerConfigHash, synergyRulesHash, rulesCommitment }
  }

  it("exposes hashes, counts, and scale constants", async function () {
    const { registry, admin, traitsSourceHash, powerConfigHash, synergyRulesHash, rulesCommitment } = await deployFixture()
    expect(await registry.admin()).to.equal(admin.address)
    expect(await registry.traitsSourceHash()).to.equal(traitsSourceHash)
    expect(await registry.powerConfigHash()).to.equal(powerConfigHash)
    expect(await registry.synergyRulesHash()).to.equal(synergyRulesHash)
    expect(await registry.rulesCommitment()).to.equal(rulesCommitment)
    expect(await registry.collectionCap()).to.equal(10_000n)
    expect(await registry.expectedLayerCount()).to.equal(2n)
    expect(await registry.expectedTraitCount()).to.equal(3n)
    expect(await registry.expectedSynergyCount()).to.equal(2n)
    expect(await registry.POWER_SCALE()).to.equal(1_000n)
    expect(await registry.MULTIPLIER_SCALE()).to.equal(10_000n)
    expect(await registry.MAX_SYNERGY_MULTIPLIER_BPS()).to.equal(40_000n)
  })

  it("stores trait values, layer weights, and synergy multipliers", async function () {
    const { registry, admin } = await deployFixture()

    await expect(registry.connect(admin).setLayerWeights(["body", "eyes"], [2000, 1500]))
      .to.emit(registry, "LayerWeightSet")
    await expect(registry.connect(admin).setTraitValues(
      ["body", "body", "eyes"],
      ["carbon_fiber", "royal_gold", "diamond_core"],
      [5, 100, 100],
    )).to.emit(registry, "TraitValueSet")
    await expect(registry.connect(admin).setSynergyMultipliers(["royal_sentinel", "wired_mind"], [14000, 13000]))
      .to.emit(registry, "SynergyMultiplierSet")

    expect(await registry.layerWeightBps("body")).to.equal(2000n)
    expect(await registry.traitValue("body", "royal_gold")).to.equal(100n)
    expect(await registry.synergyMultiplierBps("royal_sentinel")).to.equal(14000n)
    expect(await registry.configuredLayerCount()).to.equal(2n)
    expect(await registry.configuredTraitCount()).to.equal(3n)
    expect(await registry.configuredSynergyCount()).to.equal(2n)
  })

  it("finalizes only after expected scoring rules are loaded", async function () {
    const { registry, admin, rulesCommitment, powerConfigHash, synergyRulesHash } = await deployFixture()

    await registry.connect(admin).setLayerWeights(["body"], [2000])
    await registry.connect(admin).setTraitValues(["body"], ["royal_gold"], [100])
    await registry.connect(admin).setSynergyMultipliers(["royal_sentinel"], [14000])

    await expect(registry.connect(admin).finalize())
      .to.be.revertedWithCustomError(registry, "IncompleteRegistry")
      .withArgs(1n, 1n, 1n)

    await registry.connect(admin).setLayerWeights(["eyes"], [1500])
    await registry.connect(admin).setTraitValues(["body", "eyes"], ["carbon_fiber", "diamond_core"], [5, 100])
    await registry.connect(admin).setSynergyMultipliers(["wired_mind"], [13000])

    await expect(registry.connect(admin).finalize())
      .to.emit(registry, "Finalized")
      .withArgs(rulesCommitment, powerConfigHash, synergyRulesHash)
    expect(await registry.finalized()).to.equal(true)
  })

  it("prevents non-admin writes and post-finalization rewrites", async function () {
    const { registry, admin, stranger } = await deployFixture()

    await expect(registry.connect(stranger).setLayerWeights(["body"], [2000]))
      .to.be.revertedWithCustomError(registry, "NotAdmin")
      .withArgs(stranger.address)

    await registry.connect(admin).setLayerWeights(["body", "eyes"], [2000, 1500])
    await registry.connect(admin).setTraitValues(["body", "body", "eyes"], ["carbon_fiber", "royal_gold", "diamond_core"], [5, 100, 100])
    await registry.connect(admin).setSynergyMultipliers(["royal_sentinel", "wired_mind"], [14000, 13000])
    await registry.connect(admin).finalize()

    await expect(registry.connect(admin).setTraitValues(["body"], ["royal_gold"], [50]))
      .to.be.revertedWithCustomError(registry, "AlreadyFinalized")
  })

  it("validates constructor and setter inputs", async function () {
    const { registry, admin } = await deployFixture()
    const TraitRegistry = await ethers.getContractFactory("TraitRegistry")

    await expect(TraitRegistry.deploy(admin.address, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 0, 1, 1, 1))
      .to.be.revertedWithCustomError(TraitRegistry, "InvalidCollectionCap")
    await expect(TraitRegistry.deploy(ethers.ZeroAddress, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 10_000, 1, 1, 1))
      .to.be.revertedWithCustomError(TraitRegistry, "ZeroAddress")
    await expect(TraitRegistry.deploy(admin.address, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 10_000, 0, 1, 1))
      .to.be.revertedWithCustomError(TraitRegistry, "InvalidExpectedCount")
    await expect(TraitRegistry.deploy(admin.address, ethers.ZeroHash, ethers.id("power"), ethers.id("synergy"), ethers.id("rules"), 10_000, 1, 1, 1))
      .to.be.revertedWithCustomError(TraitRegistry, "ZeroHash")

    await expect(registry.connect(admin).setLayerWeights(["body"], []))
      .to.be.revertedWithCustomError(registry, "LengthMismatch")
    await expect(registry.connect(admin).setLayerWeights(["body"], [0]))
      .to.be.revertedWithCustomError(registry, "InvalidWeight")
    await expect(registry.connect(admin).setTraitValues(["body"], ["royal_gold"], [0]))
      .to.be.revertedWithCustomError(registry, "InvalidTraitValue")
    await expect(registry.connect(admin).setTraitValues(["body"], [], [100]))
      .to.be.revertedWithCustomError(registry, "LengthMismatch")
    await expect(registry.connect(admin).setSynergyMultipliers(["royal_sentinel"], [9999]))
      .to.be.revertedWithCustomError(registry, "InvalidSynergyMultiplier")
    await expect(registry.connect(admin).setSynergyMultipliers(["royal_sentinel"], [40001]))
      .to.be.revertedWithCustomError(registry, "InvalidSynergyMultiplier")
  })

  it("rejects loading more unique rules than expected", async function () {
    const { registry, admin } = await deployFixture()

    await expect(registry.connect(admin).setLayerWeights(["body", "eyes", "mouth"], [2000, 1500, 400]))
      .to.be.revertedWithCustomError(registry, "TooManyRules")
      .withArgs(3n, 0n, 0n)

    await registry.connect(admin).setLayerWeights(["body", "eyes"], [2000, 1500])
    await expect(registry.connect(admin).setTraitValues(["body", "body", "eyes", "mouth"], ["carbon_fiber", "royal_gold", "diamond_core", "og"], [5, 100, 100, 100]))
      .to.be.revertedWithCustomError(registry, "TooManyRules")
      .withArgs(2n, 4n, 0n)

    await registry.connect(admin).setTraitValues(["body", "body", "eyes"], ["carbon_fiber", "royal_gold", "diamond_core"], [5, 100, 100])
    await expect(registry.connect(admin).setSynergyMultipliers(["royal_sentinel", "wired_mind", "glitch_anomaly"], [14000, 13000, 13000]))
      .to.be.revertedWithCustomError(registry, "TooManyRules")
      .withArgs(2n, 3n, 3n)
  })

  it("reverts unknown rule lookups", async function () {
    const { registry } = await deployFixture()
    await expect(registry.layerWeightBps("body"))
      .to.be.revertedWithCustomError(registry, "UnknownLayer")
    await expect(registry.traitValue("body", "royal_gold"))
      .to.be.revertedWithCustomError(registry, "UnknownTrait")
    await expect(registry.synergyMultiplierBps("royal_sentinel"))
      .to.be.revertedWithCustomError(registry, "UnknownSynergy")
  })
})
import { expect } from "chai"
import hre from "hardhat"
import { StandardMerkleTree } from "@openzeppelin/merkle-tree"

const { ethers } = hre

const MINT_PRICE = ethers.parseEther("0.0025")
const MAX_PER_WALLET = 4n
const PUBLIC_CAP = 8_293n
const AIRDROP_CAP = 1_707n

const PAUSER_ROLE     = ethers.id("PAUSER_ROLE")
const URI_SETTER_ROLE = ethers.id("URI_SETTER_ROLE")
const DEFAULT_ADMIN_ROLE = ethers.ZeroHash

function uri(n: number): string {
  return `https://gateway.irys.xyz/test-tx-${n}`
}
function uris(n: number, start = 0): string[] {
  return Array.from({ length: n }, (_, i) => uri(start + i))
}

async function deployFixture() {
  const [owner, watcher, treasury, alice, bob, carol, dave] = await ethers.getSigners()
  const Sentinel = await ethers.getContractFactory("SentinelETH")
  const c = await Sentinel.deploy(treasury.address)
  await c.waitForDeployment()
  // Owner grants the watcher hot key URI_SETTER_ROLE (the post-deploy step).
  await c.connect(owner).grantRole(URI_SETTER_ROLE, watcher.address)
  return { c, owner, watcher, treasury, alice, bob, carol, dave }
}

function buildAirdropTree(entries: Array<[string, number]>) {
  const values = entries.map(([addr, id]) => [addr, id])
  return StandardMerkleTree.of(values, ["address", "uint256"])
}
function proofFor(tree: ReturnType<typeof buildAirdropTree>, addr: string, id: number): string[] {
  for (const [i, v] of tree.entries()) {
    if (v[0].toLowerCase() === addr.toLowerCase() && BigInt(v[1] as number) === BigInt(id)) {
      return tree.getProof(i)
    }
  }
  throw new Error(`no proof for ${addr}/${id}`)
}

describe("SentinelETH", function () {
  describe("Deployment", function () {
    it("sets name, symbol, treasury", async function () {
      const { c, treasury } = await deployFixture()
      expect(await c.name()).to.equal("SentinelETH")
      expect(await c.symbol()).to.equal("SETH")
      expect(await c.treasury()).to.equal(treasury.address)
    })

    it("grants all roles to deployer", async function () {
      const { c, owner } = await deployFixture()
      expect(await c.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.equal(true)
      expect(await c.hasRole(PAUSER_ROLE,        owner.address)).to.equal(true)
      expect(await c.hasRole(URI_SETTER_ROLE,    owner.address)).to.equal(true)
    })

    it("exposes correct constants", async function () {
      const { c } = await deployFixture()
      expect(await c.MAX_SUPPLY()).to.equal(10_000n)
      expect(await c.PUBLIC_CAP()).to.equal(8_293n)
      expect(await c.AIRDROP_CAP()).to.equal(1_707n)
      expect(await c.MINT_PRICE()).to.equal(MINT_PRICE)
      expect(await c.MAX_PER_WALLET()).to.equal(MAX_PER_WALLET)
    })

    it("rejects zero treasury", async function () {
      const Sentinel = await ethers.getContractFactory("SentinelETH")
      await expect(Sentinel.deploy(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(Sentinel, "ZeroAddress")
    })

    it("totalSupply starts at 0", async function () {
      const { c } = await deployFixture()
      expect(await c.totalSupply()).to.equal(0n)
    })
  })

  describe("publicMint (user-callable)", function () {
    it("happy path: user mints qty for themselves, pays exactly", async function () {
      const { c, alice } = await deployFixture()
      const qty = 2n
      await expect(c.connect(alice).publicMint(qty, { value: MINT_PRICE * qty }))
        .to.emit(c, "PublicMint")
        .withArgs(alice.address, 1n, qty, MINT_PRICE * qty)
      expect(await c.balanceOf(alice.address)).to.equal(qty)
      expect(await c.publicMintedBy(alice.address)).to.equal(qty)
      expect(await c.publicMinted()).to.equal(qty)
      expect(await c.ownerOf(1)).to.equal(alice.address)
      expect(await c.ownerOf(2)).to.equal(alice.address)
      expect(await ethers.provider.getBalance(await c.getAddress())).to.equal(MINT_PRICE * qty)
    })

    it("tokenURI is empty until setTokenURIs runs", async function () {
      const { c, alice } = await deployFixture()
      await c.connect(alice).publicMint(1, { value: MINT_PRICE })
      expect(await c.tokenURI(1)).to.equal("")
    })

    it("rejects qty=0, qty>MAX_BATCH_SIZE", async function () {
      const { c, alice } = await deployFixture()
      await expect(c.connect(alice).publicMint(0, { value: 0 }))
        .to.be.revertedWithCustomError(c, "InvalidQty")
      await expect(c.connect(alice).publicMint(5, { value: MINT_PRICE * 5n }))
        .to.be.revertedWithCustomError(c, "InvalidQty")
    })

    it("rejects under- and over-payment", async function () {
      const { c, alice } = await deployFixture()
      await expect(c.connect(alice).publicMint(2, { value: MINT_PRICE * 2n - 1n }))
        .to.be.revertedWithCustomError(c, "WrongPayment")
      await expect(c.connect(alice).publicMint(2, { value: MINT_PRICE * 2n + 1n }))
        .to.be.revertedWithCustomError(c, "WrongPayment")
    })

    it("enforces MAX_PER_WALLET across calls", async function () {
      const { c, alice } = await deployFixture()
      await c.connect(alice).publicMint(4, { value: MINT_PRICE * 4n })
      await expect(c.connect(alice).publicMint(1, { value: MINT_PRICE }))
        .to.be.revertedWithCustomError(c, "WalletCapExceeded")
    })

    it("blocked when paused, blocked after closeMint", async function () {
      const { c, owner, alice } = await deployFixture()
      await c.connect(owner).pause()
      await expect(c.connect(alice).publicMint(1, { value: MINT_PRICE }))
        .to.be.revertedWithCustomError(c, "EnforcedPause")
      await c.connect(owner).unpause()
      await c.connect(owner).closeMint()
      await expect(c.connect(alice).publicMint(1, { value: MINT_PRICE }))
        .to.be.revertedWithCustomError(c, "PublicMintIsClosed")
    })
  })

  describe("setTokenURIs", function () {
    it("happy path: URI_SETTER_ROLE backfills URIs after publicMint", async function () {
      const { c, watcher, alice } = await deployFixture()
      await c.connect(alice).publicMint(3, { value: MINT_PRICE * 3n })
      const list = uris(3)
      await expect(c.connect(watcher).setTokenURIs(1, list))
        .to.emit(c, "TokenURIsSet").withArgs(1n, 3n)
      expect(await c.tokenURI(1)).to.equal(list[0])
      expect(await c.tokenURI(2)).to.equal(list[1])
      expect(await c.tokenURI(3)).to.equal(list[2])
    })

    it("rejects callers without URI_SETTER_ROLE", async function () {
      const { c, alice } = await deployFixture()
      await c.connect(alice).publicMint(1, { value: MINT_PRICE })
      await expect(c.connect(alice).setTokenURIs(1, uris(1)))
        .to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount")
    })

    it("rejects empty / oversized batches", async function () {
      const { c, watcher, alice } = await deployFixture()
      await c.connect(alice).publicMint(1, { value: MINT_PRICE })
      await expect(c.connect(watcher).setTokenURIs(1, []))
        .to.be.revertedWithCustomError(c, "InvalidQty")
      await expect(c.connect(watcher).setTokenURIs(1, uris(5)))
        .to.be.revertedWithCustomError(c, "InvalidQty")
    })

    it("rejects nonexistent tokenIds", async function () {
      const { c, watcher } = await deployFixture()
      await expect(c.connect(watcher).setTokenURIs(99, uris(1)))
        .to.be.revertedWithCustomError(c, "URIQueryForNonexistentToken")
    })

    it("rejects empty / too-long URIs", async function () {
      const { c, watcher, alice } = await deployFixture()
      await c.connect(alice).publicMint(1, { value: MINT_PRICE })
      await expect(c.connect(watcher).setTokenURIs(1, [""]))
        .to.be.revertedWithCustomError(c, "UriEmpty")
      const tooLong = "x".repeat(257)
      await expect(c.connect(watcher).setTokenURIs(1, [tooLong]))
        .to.be.revertedWithCustomError(c, "UriTooLong")
    })

    it("one-shot: cannot overwrite an already-set URI", async function () {
      const { c, watcher, alice } = await deployFixture()
      await c.connect(alice).publicMint(1, { value: MINT_PRICE })
      await c.connect(watcher).setTokenURIs(1, uris(1))
      await expect(c.connect(watcher).setTokenURIs(1, uris(1, 9)))
        .to.be.revertedWithCustomError(c, "UriAlreadySet")
    })
  })

  describe("burn (token holder)", function () {
    it("token owner can burn their token", async function () {
      const { c, alice } = await deployFixture()
      await c.connect(alice).publicMint(1, { value: MINT_PRICE })
      await c.connect(alice).burn(1)
      expect(await c.balanceOf(alice.address)).to.equal(0n)
    })

    it("non-owner cannot burn", async function () {
      const { c, alice, bob } = await deployFixture()
      await c.connect(alice).publicMint(1, { value: MINT_PRICE })
      await expect(c.connect(bob).burn(1))
        .to.be.revertedWithCustomError(c, "TransferCallerNotOwnerNorApproved")
    })

    it("approved address can burn", async function () {
      const { c, alice, bob } = await deployFixture()
      await c.connect(alice).publicMint(1, { value: MINT_PRICE })
      await c.connect(alice).approve(bob.address, 1)
      await c.connect(bob).burn(1)
      expect(await c.balanceOf(alice.address)).to.equal(0n)
    })

    it("burned token's tokenURI reverts", async function () {
      const { c, alice } = await deployFixture()
      await c.connect(alice).publicMint(1, { value: MINT_PRICE })
      await c.connect(alice).burn(1)
      await expect(c.tokenURI(1))
        .to.be.revertedWithCustomError(c, "URIQueryForNonexistentToken")
    })

    it("burn does NOT reduce publicMinted counter (slot stays consumed)", async function () {
      const { c, alice } = await deployFixture()
      await c.connect(alice).publicMint(2, { value: MINT_PRICE * 2n })
      await c.connect(alice).burn(1)
      expect(await c.publicMinted()).to.equal(2n)
      expect(await c.publicMintedBy(alice.address)).to.equal(2n)
      // alice has now minted 2 against her cap of 4; she can still mint 2 more.
      await c.connect(alice).publicMint(2, { value: MINT_PRICE * 2n })
      await expect(c.connect(alice).publicMint(1, { value: MINT_PRICE }))
        .to.be.revertedWithCustomError(c, "WalletCapExceeded")
    })
  })

  describe("closeMint", function () {
    it("only DEFAULT_ADMIN_ROLE can call", async function () {
      const { c, alice } = await deployFixture()
      await expect(c.connect(alice).closeMint())
        .to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount")
    })

    it("blocks future public mints, leaves existing tokens intact", async function () {
      const { c, owner, alice } = await deployFixture()
      await c.connect(alice).publicMint(2, { value: MINT_PRICE * 2n })
      await c.connect(owner).closeMint()
      expect(await c.publicClosed()).to.equal(true)
      expect(await c.balanceOf(alice.address)).to.equal(2n)
      await expect(c.connect(alice).publicMint(1, { value: MINT_PRICE }))
        .to.be.revertedWithCustomError(c, "PublicMintIsClosed")
    })

    it("status shows publicRemaining=0 after close", async function () {
      const { c, owner, alice } = await deployFixture()
      await c.connect(alice).publicMint(1, { value: MINT_PRICE })
      await c.connect(owner).closeMint()
      const s = await c.status()
      expect(s._publicRemaining).to.equal(0n)
      expect(s._publicClosed).to.equal(true)
    })

    it("emits PublicMintClosed with final count", async function () {
      const { c, owner, alice } = await deployFixture()
      await c.connect(alice).publicMint(2, { value: MINT_PRICE * 2n })
      await expect(c.connect(owner).closeMint()).to.emit(c, "PublicMintClosed").withArgs(2n)
    })
  })

  describe("closeAirdrop", function () {
    it("only DEFAULT_ADMIN_ROLE can call", async function () {
      const { c, alice } = await deployFixture()
      await expect(c.connect(alice).closeAirdrop())
        .to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount")
    })

    it("blocks future claims, leaves prior claims intact", async function () {
      const { c, owner, alice, bob } = await deployFixture()
      const tree = buildAirdropTree([
        [alice.address, 0],
        [bob.address, 1],
      ])
      await c.connect(owner).setAirdropRoot(tree.root)
      await c.connect(alice).claim([0], [uri(0)], [proofFor(tree, alice.address, 0)])
      await c.connect(owner).closeAirdrop()
      expect(await c.airdropClosed()).to.equal(true)
      await expect(c.connect(bob).claim([1], [uri(1)], [proofFor(tree, bob.address, 1)]))
        .to.be.revertedWithCustomError(c, "AirdropIsClosed")
    })

    it("status shows airdropRemaining=0 after close", async function () {
      const { c, owner } = await deployFixture()
      await c.connect(owner).closeAirdrop()
      const s = await c.status()
      expect(s._airdropRemaining).to.equal(0n)
      expect(s._airdropClosed).to.equal(true)
    })

    it("emits AirdropClosed with final count", async function () {
      const { c, owner, alice } = await deployFixture()
      const tree = buildAirdropTree([[alice.address, 0]])
      await c.connect(owner).setAirdropRoot(tree.root)
      await c.connect(alice).claim([0], [uri(0)], [proofFor(tree, alice.address, 0)])
      await expect(c.connect(owner).closeAirdrop()).to.emit(c, "AirdropClosed").withArgs(1n)
    })

    it("does NOT block public mints", async function () {
      const { c, owner, alice } = await deployFixture()
      await c.connect(owner).closeAirdrop()
      await c.connect(alice).publicMint(1, { value: MINT_PRICE })
      expect(await c.balanceOf(alice.address)).to.equal(1n)
    })
  })

  describe("claim (airdrop)", function () {
    it("rejects when airdrop root not set", async function () {
      const { c, alice } = await deployFixture()
      await expect(c.connect(alice).claim([1], [uri(1)], [[]]))
        .to.be.revertedWithCustomError(c, "AirdropRootNotSet")
    })

    it("happy path with valid proof", async function () {
      const { c, owner, alice, bob } = await deployFixture()
      const tree = buildAirdropTree([
        [alice.address, 0],
        [alice.address, 1],
        [bob.address, 2],
      ])
      await c.connect(owner).setAirdropRoot(tree.root)
      const proof = proofFor(tree, alice.address, 0)
      await c.connect(alice).claim([0], [uri(0)], [proof])
      expect(await c.balanceOf(alice.address)).to.equal(1n)
      expect(await c.airdropMinted()).to.equal(1n)
      expect(await c.airdropClaimed(0)).to.equal(true)
      expect(await c.tokenURI(1)).to.equal(uri(0))
    })

    it("rejects double claim of same id", async function () {
      const { c, owner, alice } = await deployFixture()
      const tree = buildAirdropTree([[alice.address, 0]])
      await c.connect(owner).setAirdropRoot(tree.root)
      const proof = proofFor(tree, alice.address, 0)
      await c.connect(alice).claim([0], [uri(0)], [proof])
      await expect(c.connect(alice).claim([0], [uri(0)], [proof]))
        .to.be.revertedWithCustomError(c, "AirdropAlreadyClaimed")
    })

    it("rejects invalid proof (wrong claimer)", async function () {
      const { c, owner, alice, bob } = await deployFixture()
      const tree = buildAirdropTree([[alice.address, 0]])
      await c.connect(owner).setAirdropRoot(tree.root)
      const proof = proofFor(tree, alice.address, 0)
      await expect(c.connect(bob).claim([0], [uri(0)], [proof]))
        .to.be.revertedWithCustomError(c, "InvalidProof")
    })

    it("rejects wrong id with right address proof", async function () {
      const { c, owner, alice } = await deployFixture()
      const tree = buildAirdropTree([[alice.address, 0]])
      await c.connect(owner).setAirdropRoot(tree.root)
      const proof = proofFor(tree, alice.address, 0)
      await expect(c.connect(alice).claim([99], [uri(0)], [proof]))
        .to.be.revertedWithCustomError(c, "InvalidProof")
    })

    it("batch claim works when each has its own proof", async function () {
      const { c, owner, alice } = await deployFixture()
      const tree = buildAirdropTree([
        [alice.address, 10],
        [alice.address, 11],
        [alice.address, 12],
      ])
      await c.connect(owner).setAirdropRoot(tree.root)
      const ids = [10, 11, 12]
      const proofs = ids.map((id) => proofFor(tree, alice.address, id))
      await c.connect(alice).claim(ids, uris(3), proofs)
      expect(await c.balanceOf(alice.address)).to.equal(3n)
      expect(await c.airdropMinted()).to.equal(3n)
    })

    it("rejects mismatched lengths", async function () {
      const { c, owner, alice } = await deployFixture()
      const tree = buildAirdropTree([[alice.address, 0]])
      await c.connect(owner).setAirdropRoot(tree.root)
      const proof = proofFor(tree, alice.address, 0)
      await expect(c.connect(alice).claim([0, 1], [uri(0)], [proof]))
        .to.be.revertedWithCustomError(c, "LengthMismatch")
    })

    it("airdrop still works after closeMint", async function () {
      const { c, owner, alice } = await deployFixture()
      const tree = buildAirdropTree([[alice.address, 0]])
      await c.connect(owner).setAirdropRoot(tree.root)
      await c.connect(owner).closeMint()
      const proof = proofFor(tree, alice.address, 0)
      await c.connect(alice).claim([0], [uri(0)], [proof])
      expect(await c.balanceOf(alice.address)).to.equal(1n)
    })
  })

  describe("Roles & admin controls", function () {
    it("setTreasury updates and emits (admin only)", async function () {
      const { c, owner, alice } = await deployFixture()
      await expect(c.connect(owner).setTreasury(alice.address))
        .to.emit(c, "TreasuryUpdated").withArgs(alice.address)
      expect(await c.treasury()).to.equal(alice.address)
    })

    it("setTreasury rejects zero", async function () {
      const { c, owner } = await deployFixture()
      await expect(c.connect(owner).setTreasury(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(c, "ZeroAddress")
    })

    it("non-admin cannot call setTreasury / setAirdropRoot / closeMint / closeAirdrop / emergency", async function () {
      const { c, alice } = await deployFixture()
      await expect(c.connect(alice).setTreasury(alice.address))
        .to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount")
      await expect(c.connect(alice).setAirdropRoot(ethers.ZeroHash))
        .to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount")
      await expect(c.connect(alice).closeMint())
        .to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount")
      await expect(c.connect(alice).closeAirdrop())
        .to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount")
      await expect(c.connect(alice).emergencyAdminMint(alice.address, 1, uris(1)))
        .to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount")
    })

    it("non-pauser cannot pause/unpause", async function () {
      const { c, alice } = await deployFixture()
      await expect(c.connect(alice).pause())
        .to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount")
      await expect(c.connect(alice).unpause())
        .to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount")
    })

    it("admin can grant URI_SETTER_ROLE to a fresh address", async function () {
      const { c, owner, alice } = await deployFixture()
      await c.connect(owner).grantRole(URI_SETTER_ROLE, alice.address)
      expect(await c.hasRole(URI_SETTER_ROLE, alice.address)).to.equal(true)
      // alice can now set URIs
      const [, , , , bob] = await ethers.getSigners()
      await c.connect(bob).publicMint(1, { value: MINT_PRICE })
      await c.connect(alice).setTokenURIs(1, uris(1))
      expect(await c.tokenURI(1)).to.equal(uri(0))
    })

    it("admin can revoke URI_SETTER_ROLE", async function () {
      const { c, owner, watcher, alice } = await deployFixture()
      await c.connect(alice).publicMint(1, { value: MINT_PRICE })
      await c.connect(owner).revokeRole(URI_SETTER_ROLE, watcher.address)
      await expect(c.connect(watcher).setTokenURIs(1, uris(1)))
        .to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount")
    })
  })

  describe("Pause", function () {
    it("blocks publicMint and claim while paused", async function () {
      const { c, owner, alice } = await deployFixture()
      const tree = buildAirdropTree([[alice.address, 0]])
      await c.connect(owner).setAirdropRoot(tree.root)
      await c.connect(owner).pause()
      await expect(c.connect(alice).publicMint(1, { value: MINT_PRICE }))
        .to.be.revertedWithCustomError(c, "EnforcedPause")
      const proof = proofFor(tree, alice.address, 0)
      await expect(c.connect(alice).claim([0], [uri(0)], [proof]))
        .to.be.revertedWithCustomError(c, "EnforcedPause")
    })

    it("resumes after unpause", async function () {
      const { c, owner, alice } = await deployFixture()
      await c.connect(owner).pause()
      await c.connect(owner).unpause()
      await c.connect(alice).publicMint(1, { value: MINT_PRICE })
      expect(await c.balanceOf(alice.address)).to.equal(1n)
    })
  })

  describe("emergencyAdminMint", function () {
    it("only DEFAULT_ADMIN_ROLE", async function () {
      const { c, alice } = await deployFixture()
      await expect(c.connect(alice).emergencyAdminMint(alice.address, 1, uris(1)))
        .to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount")
    })

    it("mints without payment, counts against public cap", async function () {
      const { c, owner, alice } = await deployFixture()
      await c.connect(owner).emergencyAdminMint(alice.address, 2, uris(2))
      expect(await c.balanceOf(alice.address)).to.equal(2n)
      expect(await c.publicMinted()).to.equal(2n)
      expect(await c.publicMintedBy(alice.address)).to.equal(2n)
    })

    it("respects per-wallet cap", async function () {
      const { c, owner, alice } = await deployFixture()
      await c.connect(owner).emergencyAdminMint(alice.address, 4, uris(4))
      await expect(c.connect(owner).emergencyAdminMint(alice.address, 1, uris(1, 4)))
        .to.be.revertedWithCustomError(c, "WalletCapExceeded")
    })
  })

  describe("withdraw", function () {
    it("anyone can call; sends contract balance to treasury", async function () {
      const { c, treasury, alice } = await deployFixture()
      await c.connect(alice).publicMint(4, { value: MINT_PRICE * 4n })
      const before = await ethers.provider.getBalance(treasury.address)
      // Random caller (alice) can call withdraw, but funds go to treasury.
      await c.connect(alice).withdraw()
      const after = await ethers.provider.getBalance(treasury.address)
      expect(after - before).to.equal(MINT_PRICE * 4n)
      expect(await ethers.provider.getBalance(await c.getAddress())).to.equal(0n)
    })

    it("reverts when balance is zero", async function () {
      const { c, alice } = await deployFixture()
      await expect(c.connect(alice).withdraw())
        .to.be.revertedWithCustomError(c, "NoBalance")
    })

    it("withdraw destination cannot be redirected by non-admin", async function () {
      const { c, alice, bob } = await deployFixture()
      await c.connect(alice).publicMint(1, { value: MINT_PRICE })
      await expect(c.connect(alice).setTreasury(bob.address))
        .to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount")
    })
  })

  describe("Views", function () {
    it("publicRemainingFor returns walletRoom-vs-globalRoom min", async function () {
      const { c, alice } = await deployFixture()
      expect(await c.publicRemainingFor(alice.address)).to.equal(4n)
      await c.connect(alice).publicMint(3, { value: MINT_PRICE * 3n })
      expect(await c.publicRemainingFor(alice.address)).to.equal(1n)
    })

    it("publicRemainingFor returns 0 after closeMint", async function () {
      const { c, owner, alice } = await deployFixture()
      await c.connect(owner).closeMint()
      expect(await c.publicRemainingFor(alice.address)).to.equal(0n)
    })

    it("status returns expected shape", async function () {
      const { c, alice } = await deployFixture()
      await c.connect(alice).publicMint(2, { value: MINT_PRICE * 2n })
      const s = await c.status()
      expect(s._totalSupply).to.equal(2n)
      expect(s._publicMinted).to.equal(2n)
      expect(s._airdropMinted).to.equal(0n)
      expect(s._publicRemaining).to.equal(PUBLIC_CAP - 2n)
      expect(s._airdropRemaining).to.equal(AIRDROP_CAP)
      expect(s._mintPrice).to.equal(MINT_PRICE)
      expect(s._publicClosed).to.equal(false)
      expect(s._airdropClosed).to.equal(false)
      expect(s._paused).to.equal(false)
    })

    it("tokenURI reverts for nonexistent", async function () {
      const { c } = await deployFixture()
      await expect(c.tokenURI(999)).to.be.revertedWithCustomError(c, "URIQueryForNonexistentToken")
    })

    it("supportsInterface returns true for ERC721 + AccessControl", async function () {
      const { c } = await deployFixture()
      expect(await c.supportsInterface("0x80ac58cd")).to.equal(true) // ERC721
      expect(await c.supportsInterface("0x7965db0b")).to.equal(true) // AccessControl
    })
  })
})

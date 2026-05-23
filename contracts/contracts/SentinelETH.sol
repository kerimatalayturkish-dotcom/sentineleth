// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "erc721a/contracts/ERC721A.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title SentinelETH
/// @notice ERC-721A collection of 10,000 Sentinels on Ethereum.
///         8,293 are publicly mintable directly by users (`publicMint`) at a
///         fixed ETH price, with metadata URIs filled in by the off-chain
///         composer immediately after via `setTokenURIs`. The remaining 1,707
///         are reserved for an airdrop, claimable via Merkle proof (`claim`).
///         The legacy `mintFor` relayer path is retained for back-compat /
///         emergency relayer use; `publicMint` is the canonical user path.
contract SentinelETH is ERC721A, Ownable, Pausable, ReentrancyGuard {
    // ─── Constants ─────────────────────────────────────────────────────────
    uint256 public constant MAX_SUPPLY        = 10_000;
    uint256 public constant PUBLIC_CAP        = 8_293;
    uint256 public constant AIRDROP_CAP       = 1_707;
    uint256 public constant MINT_PRICE        = 0.0025 ether;
    uint256 public constant MAX_PER_WALLET    = 4;
    uint256 public constant MAX_URI_LENGTH    = 256;
    uint256 public constant MAX_BATCH_SIZE    = 4;

    // ─── Mutable config ────────────────────────────────────────────────────
    address public treasury;
    address public minter;
    bytes32 public airdropRoot;
    bool    public publicClosed;  // once true, no further public mints allowed
    bool    public airdropClosed; // once true, no further airdrop claims allowed

    /// @notice Collection-level metadata URI (OpenSea / Reservoir / Magic Eden).
    ///         Points to a JSON document with {name, description, image,
    ///         banner_image_url, external_link, ...}. Owner-settable so the
    ///         JSON can be uploaded to Irys post-deploy.
    string public contractURI;

    // ─── Counters ──────────────────────────────────────────────────────────
    uint256 public publicMinted;
    uint256 public airdropMinted;

    // ─── Per-wallet / per-token bookkeeping ────────────────────────────────
    mapping(address => uint256) public publicMintedBy;        // wallet -> qty publicly minted
    mapping(uint256 => bool)    public airdropClaimed;        // airdrop id -> claimed
    mapping(uint256 => string)  private _tokenURIs;           // tokenId -> Irys URI

    // ─── Events ────────────────────────────────────────────────────────────
    event PublicMint(address indexed to, uint256 indexed startTokenId, uint256 qty, uint256 paid);
    event AirdropClaim(address indexed to, uint256 indexed airdropId, uint256 indexed tokenId);
    event MinterUpdated(address indexed minter);
    event TreasuryUpdated(address indexed treasury);
    event AirdropRootUpdated(bytes32 root);
    event PublicMintClosed(uint256 finalPublicMinted);
    event AirdropClosed(uint256 finalAirdropMinted);
    event Withdrawn(address indexed to, uint256 amount);
    event EmergencyAdminMint(address indexed to, uint256 indexed startTokenId, uint256 qty);
    event TokenURIsSet(uint256 indexed startTokenId, uint256 qty);
    event ContractURIUpdated(string uri);

    // ─── Errors ────────────────────────────────────────────────────────────
    error NotMinter();
    error PublicMintIsClosed();
    error AirdropIsClosed();
    error InvalidQty();
    error UriCountMismatch();
    error UriTooLong();
    error UriEmpty();
    error UriAlreadySet();
    error WalletCapExceeded();
    error PublicCapExceeded();
    error MaxSupplyExceeded();
    error AirdropCapExceeded();
    error WrongPayment();
    error AirdropAlreadyClaimed();
    error InvalidProof();
    error AirdropRootNotSet();
    error LengthMismatch();
    error ZeroAddress();
    error WithdrawFailed();
    error NoBalance();

    constructor(address initialTreasury, address initialMinter)
        ERC721A("SentinelETH", "SETH")
        Ownable(msg.sender)
    {
        if (initialTreasury == address(0)) revert ZeroAddress();
        if (initialMinter == address(0)) revert ZeroAddress();
        treasury = initialTreasury;
        minter   = initialMinter;
        emit TreasuryUpdated(initialTreasury);
        emit MinterUpdated(initialMinter);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PUBLIC MINT (user-callable)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Mint `qty` Sentinels to the caller. Caller must forward exactly
    ///         `MINT_PRICE * qty` wei. Token URIs are filled in by the off-chain
    ///         composer via `setTokenURIs` shortly after this call. Until then
    ///         `tokenURI(id)` returns an empty string (marketplaces show a
    ///         placeholder).
    function publicMint(uint256 qty)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        if (publicClosed) revert PublicMintIsClosed();
        if (qty == 0 || qty > MAX_BATCH_SIZE) revert InvalidQty();
        if (msg.value != MINT_PRICE * qty) revert WrongPayment();
        if (publicMintedBy[msg.sender] + qty > MAX_PER_WALLET) revert WalletCapExceeded();
        if (publicMinted + qty > PUBLIC_CAP) revert PublicCapExceeded();
        if (_totalMinted() + qty > MAX_SUPPLY) revert MaxSupplyExceeded();

        uint256 startTokenId = _nextTokenId();
        publicMintedBy[msg.sender] += qty;
        publicMinted               += qty;

        _safeMint(msg.sender, qty);

        emit PublicMint(msg.sender, startTokenId, qty, msg.value);
    }

    /// @notice Backfill metadata URIs for a contiguous range of tokens. Called
    ///         by the off-chain composer (`minter`) immediately after a
    ///         `publicMint`. One-shot per token: cannot overwrite a previously
    ///         set URI. Length of `uris` determines how many tokens are filled
    ///         starting at `startTokenId`.
    function setTokenURIs(uint256 startTokenId, string[] calldata uris) external {
        if (msg.sender != minter) revert NotMinter();
        uint256 n = uris.length;
        if (n == 0 || n > MAX_BATCH_SIZE) revert InvalidQty();
        for (uint256 i = 0; i < n; ++i) {
            uint256 tokenId = startTokenId + i;
            if (!_exists(tokenId)) revert URIQueryForNonexistentToken();
            if (bytes(_tokenURIs[tokenId]).length != 0) revert UriAlreadySet();
            string calldata uri = uris[i];
            if (bytes(uri).length == 0) revert UriEmpty();
            if (bytes(uri).length > MAX_URI_LENGTH) revert UriTooLong();
            _tokenURIs[tokenId] = uri;
        }
        emit TokenURIsSet(startTokenId, n);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  PUBLIC MINT (relayer-only, legacy / sponsored path)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Mint `qty` Sentinels to `to` with the given Irys metadata `uris`.
    ///         Caller must be the authorized `minter` and must forward exactly
    ///         `MINT_PRICE * qty` wei. The relayer is expected to collect ETH
    ///         from the end user (off-chain) and forward it here.
    function mintFor(address to, uint256 qty, string[] calldata uris)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        if (msg.sender != minter) revert NotMinter();
        if (publicClosed) revert PublicMintIsClosed();
        if (to == address(0)) revert ZeroAddress();
        if (qty == 0 || qty > MAX_BATCH_SIZE) revert InvalidQty();
        if (uris.length != qty) revert UriCountMismatch();
        if (msg.value != MINT_PRICE * qty) revert WrongPayment();
        if (publicMintedBy[to] + qty > MAX_PER_WALLET) revert WalletCapExceeded();
        if (publicMinted + qty > PUBLIC_CAP) revert PublicCapExceeded();
        if (_totalMinted() + qty > MAX_SUPPLY) revert MaxSupplyExceeded();

        uint256 startTokenId = _nextTokenId();
        for (uint256 i = 0; i < qty; ++i) {
            string calldata uri = uris[i];
            if (bytes(uri).length == 0) revert UriEmpty();
            if (bytes(uri).length > MAX_URI_LENGTH) revert UriTooLong();
            _tokenURIs[startTokenId + i] = uri;
        }

        publicMintedBy[to] += qty;
        publicMinted       += qty;

        _safeMint(to, qty);

        emit PublicMint(to, startTokenId, qty, msg.value);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  AIRDROP CLAIM (Merkle-gated, free, paid by claimer's gas)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Claim airdropped Sentinels. Each `airdropIds[i]` must be unique
    ///         and proven via Merkle proof over leaf = keccak256(abi.encode(msg.sender, airdropId)).
    function claim(
        uint256[] calldata airdropIds,
        string[] calldata uris,
        bytes32[][] calldata proofs
    )
        external
        whenNotPaused
        nonReentrant
    {
        if (airdropClosed) revert AirdropIsClosed();
        if (airdropRoot == bytes32(0)) revert AirdropRootNotSet();
        uint256 qty = airdropIds.length;
        if (qty == 0) revert InvalidQty();
        if (uris.length != qty || proofs.length != qty) revert LengthMismatch();
        if (airdropMinted + qty > AIRDROP_CAP) revert AirdropCapExceeded();
        if (_totalMinted() + qty > MAX_SUPPLY) revert MaxSupplyExceeded();

        uint256 startTokenId = _nextTokenId();

        for (uint256 i = 0; i < qty; ++i) {
            uint256 airdropId = airdropIds[i];
            string calldata uri = uris[i];

            if (airdropClaimed[airdropId]) revert AirdropAlreadyClaimed();
            if (bytes(uri).length == 0) revert UriEmpty();
            if (bytes(uri).length > MAX_URI_LENGTH) revert UriTooLong();

            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, airdropId))));
            if (!MerkleProof.verify(proofs[i], airdropRoot, leaf)) revert InvalidProof();

            airdropClaimed[airdropId] = true;
            _tokenURIs[startTokenId + i] = uri;

            emit AirdropClaim(msg.sender, airdropId, startTokenId + i);
        }

        airdropMinted += qty;
        _safeMint(msg.sender, qty);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  OWNER CONTROLS
    // ═══════════════════════════════════════════════════════════════════════

    function setMinter(address newMinter) external onlyOwner {
        if (newMinter == address(0)) revert ZeroAddress();
        minter = newMinter;
        emit MinterUpdated(newMinter);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function setAirdropRoot(bytes32 root) external onlyOwner {
        airdropRoot = root;
        emit AirdropRootUpdated(root);
    }

    /// @notice Set the collection-level metadata URI used by marketplaces.
    ///         Upload the collection JSON to Irys, then pass the resulting
    ///         gateway URL here. Can be updated to swap banner/logo later.
    function setContractURI(string calldata uri) external onlyOwner {
        if (bytes(uri).length == 0) revert UriEmpty();
        if (bytes(uri).length > MAX_URI_LENGTH) revert UriTooLong();
        contractURI = uri;
        emit ContractURIUpdated(uri);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Permanently end public minting. Existing tokens are unaffected.
    ///         Any unminted portion of PUBLIC_CAP becomes un-mintable forever.
    ///         Airdrop claims continue to work after this is called.
    function closeMint() external onlyOwner {
        publicClosed = true;
        emit PublicMintClosed(publicMinted);
    }

    /// @notice Permanently end the airdrop. Any unclaimed slots in AIRDROP_CAP
    ///         become un-mintable forever, effectively reducing total supply.
    ///         Existing claimed tokens are unaffected.
    function closeAirdrop() external onlyOwner {
        airdropClosed = true;
        emit AirdropClosed(airdropMinted);
    }

    /// @notice Owner-only emergency mint, used only if the relayer is unrecoverable.
    ///         Mints from the same supply pools as `mintFor` (counts against PUBLIC_CAP
    ///         and per-wallet cap). Bypasses payment.
    function emergencyAdminMint(address to, uint256 qty, string[] calldata uris)
        external
        onlyOwner
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        if (qty == 0 || qty > MAX_BATCH_SIZE) revert InvalidQty();
        if (uris.length != qty) revert UriCountMismatch();
        if (publicMintedBy[to] + qty > MAX_PER_WALLET) revert WalletCapExceeded();
        if (publicMinted + qty > PUBLIC_CAP) revert PublicCapExceeded();
        if (_totalMinted() + qty > MAX_SUPPLY) revert MaxSupplyExceeded();

        uint256 startTokenId = _nextTokenId();
        for (uint256 i = 0; i < qty; ++i) {
            string calldata uri = uris[i];
            if (bytes(uri).length == 0) revert UriEmpty();
            if (bytes(uri).length > MAX_URI_LENGTH) revert UriTooLong();
            _tokenURIs[startTokenId + i] = uri;
        }

        publicMintedBy[to] += qty;
        publicMinted       += qty;

        _safeMint(to, qty);

        emit EmergencyAdminMint(to, startTokenId, qty);
    }

    /// @notice Sweep contract ETH balance to `treasury`.
    function withdraw() external nonReentrant {
        uint256 bal = address(this).balance;
        if (bal == 0) revert NoBalance();
        (bool ok,) = payable(treasury).call{value: bal}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(treasury, bal);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  VIEWS
    // ═══════════════════════════════════════════════════════════════════════

    function tokenURI(uint256 tokenId) public view virtual override returns (string memory) {
        if (!_exists(tokenId)) revert URIQueryForNonexistentToken();
        return _tokenURIs[tokenId];
    }

    /// @notice First minted token id is 1, matching most marketplaces' expectations.
    function _startTokenId() internal pure override returns (uint256) {
        return 1;
    }

    /// @notice Aggregate state for the frontend / MCP server in a single call.
    function status()
        external
        view
        returns (
            uint256 _totalSupply,
            uint256 _publicMinted,
            uint256 _airdropMinted,
            uint256 _publicRemaining,
            uint256 _airdropRemaining,
            uint256 _mintPrice,
            bool    _publicClosed,
            bool    _airdropClosed,
            bool    _paused
        )
    {
        _totalSupply       = _totalMinted();
        _publicMinted      = publicMinted;
        _airdropMinted     = airdropMinted;
        _publicRemaining   = publicClosed ? 0 : (PUBLIC_CAP - publicMinted);
        _airdropRemaining  = airdropClosed ? 0 : (AIRDROP_CAP - airdropMinted);
        _mintPrice         = MINT_PRICE;
        _publicClosed      = publicClosed;
        _airdropClosed     = airdropClosed;
        _paused            = paused();
    }

    /// @notice How many more a wallet can mint via the public path.
    function publicRemainingFor(address wallet) external view returns (uint256) {
        if (publicClosed) return 0;
        uint256 used = publicMintedBy[wallet];
        if (used >= MAX_PER_WALLET) return 0;
        uint256 walletRoom = MAX_PER_WALLET - used;
        uint256 globalRoom = PUBLIC_CAP - publicMinted;
        return walletRoom < globalRoom ? walletRoom : globalRoom;
    }
}

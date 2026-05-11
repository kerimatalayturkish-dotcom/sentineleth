// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "erc721a/contracts/ERC721A.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title SentinelETH
/// @notice ERC-721A collection of up to 10,000 Sentinels on Ethereum.
///         - Up to 8,293 publicly mintable via `publicMint` at a fixed ETH price.
///           Metadata URIs are filled in by the off-chain composer (URI_SETTER_ROLE)
///           immediately after via `setTokenURIs`.
///         - Up to 1,707 reserved for an airdrop, claimable via Merkle proof
///           (`claim`). Each (claimer, airdropId) leaf is one-shot.
///         - Public pool can be permanently frozen below cap with `closeMint`.
///         - Airdrop pool can be permanently frozen below cap with `closeAirdrop`.
///         - Token holders may `burn` their own tokens (does not free the slot).
///         - All ETH from mints stays in the contract until `withdraw` is called
///           (permissionless), which sweeps the full balance to the immutable-by-role
///           `treasury` address. Treasury can only be changed by DEFAULT_ADMIN_ROLE.
contract SentinelETH is ERC721A, AccessControl, Pausable, ReentrancyGuard {
    // ─── Roles ─────────────────────────────────────────────────────────────
    /// @dev DEFAULT_ADMIN_ROLE is inherited from AccessControl (== 0x00).
    ///      Holds: setTreasury, setAirdropRoot, closeMint, closeAirdrop,
    ///             emergencyAdminMint, grant/revoke roles.
    bytes32 public constant PAUSER_ROLE     = keccak256("PAUSER_ROLE");
    bytes32 public constant URI_SETTER_ROLE = keccak256("URI_SETTER_ROLE");

    // ─── Constants ─────────────────────────────────────────────────────────
    uint256 public constant MAX_SUPPLY        = 10_000;
    uint256 public constant PUBLIC_CAP        = 8_293;
    uint256 public constant AIRDROP_CAP       = 1_707;
    uint256 public constant MINT_PRICE        = 0.0025 ether;
    uint256 public constant MAX_PER_WALLET    = 4;
    uint256 public constant MAX_URI_LENGTH    = 256;
    uint256 public constant MAX_BATCH_SIZE    = 4;
    uint256 public constant MAX_CLAIM_BATCH_SIZE = 25;

    // ─── Mutable config ────────────────────────────────────────────────────
    address public treasury;
    bytes32 public airdropRoot;
    bool    public publicClosed;   // once true, no further public mints allowed
    bool    public airdropClosed;  // once true, no further airdrop claims allowed

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
    event TreasuryUpdated(address indexed treasury);
    event AirdropRootUpdated(bytes32 root);
    event PublicMintClosed(uint256 finalPublicMinted);
    event AirdropClosed(uint256 finalAirdropMinted);
    event Withdrawn(address indexed to, uint256 amount);
    event EmergencyAdminMint(address indexed to, uint256 indexed startTokenId, uint256 qty);
    event TokenURIsSet(uint256 indexed startTokenId, uint256 qty);

    // ─── Errors ────────────────────────────────────────────────────────────
    error PublicMintIsClosed();
    error AirdropIsClosed();
    error InvalidQty();
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

    /// @notice Constructor grants ALL roles to the deployer. After deploy, the
    ///         deployer should `grantRole(URI_SETTER_ROLE, watcherWallet)` so the
    ///         server-side composer can backfill metadata. The deployer keeps
    ///         DEFAULT_ADMIN_ROLE and PAUSER_ROLE for ongoing admin operations.
    constructor(address initialTreasury)
        ERC721A("SentinelETH", "SETH")
    {
        if (initialTreasury == address(0)) revert ZeroAddress();
        treasury = initialTreasury;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE,        msg.sender);
        _grantRole(URI_SETTER_ROLE,    msg.sender);

        emit TreasuryUpdated(initialTreasury);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PUBLIC MINT (user-callable)
    // ═══════════════════════════════════════════════════════════════════════

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
    ///         by the off-chain composer (URI_SETTER_ROLE) immediately after a
    ///         `publicMint`. One-shot per token: cannot overwrite a previously
    ///         set URI. Length of `uris` determines how many tokens are filled
    ///         starting at `startTokenId`.
    function setTokenURIs(uint256 startTokenId, string[] calldata uris)
        external
        onlyRole(URI_SETTER_ROLE)
        nonReentrant
    {
        uint256 n = uris.length;
        if (n == 0 || n > MAX_BATCH_SIZE) revert InvalidQty();
        for (uint256 i = 0; i < n; ++i) {
            uint256 tokenId = startTokenId + i;
            if (!_exists(tokenId)) revert URIQueryForNonexistentToken();
            if (bytes(_tokenURIs[tokenId]).length != 0) revert UriAlreadySet();
            string calldata u = uris[i];
            if (bytes(u).length == 0) revert UriEmpty();
            if (bytes(u).length > MAX_URI_LENGTH) revert UriTooLong();
            _tokenURIs[tokenId] = u;
        }
        emit TokenURIsSet(startTokenId, n);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  AIRDROP CLAIM (Merkle-gated, free, paid by claimer's gas)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Claim airdropped Sentinels. Each `airdropIds[i]` must be unique
    ///         and proven via Merkle proof over leaf = keccak256(abi.encode(msg.sender, airdropId)).
    ///         URIs are provided by the claimer (assembled client-side from the
    ///         airdrop manifest published with the merkle root).
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
        if (qty == 0 || qty > MAX_CLAIM_BATCH_SIZE) revert InvalidQty();
        if (uris.length != qty || proofs.length != qty) revert LengthMismatch();
        if (airdropMinted + qty > AIRDROP_CAP) revert AirdropCapExceeded();
        if (_totalMinted() + qty > MAX_SUPPLY) revert MaxSupplyExceeded();

        uint256 startTokenId = _nextTokenId();

        for (uint256 i = 0; i < qty; ++i) {
            uint256 airdropId = airdropIds[i];
            string calldata u = uris[i];

            if (airdropClaimed[airdropId]) revert AirdropAlreadyClaimed();
            if (bytes(u).length == 0) revert UriEmpty();
            if (bytes(u).length > MAX_URI_LENGTH) revert UriTooLong();

            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, airdropId))));
            if (!MerkleProof.verify(proofs[i], airdropRoot, leaf)) revert InvalidProof();

            airdropClaimed[airdropId] = true;
            _tokenURIs[startTokenId + i] = u;

            emit AirdropClaim(msg.sender, airdropId, startTokenId + i);
        }

        airdropMinted += qty;
        _safeMint(msg.sender, qty);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  BURN (token holder)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Burn a token you own (or are approved for). Mint counters are
    ///         NOT decremented — caps still apply, the freed id is not
    ///         re-mintable. This is purely supply reduction by the holder.
    function burn(uint256 tokenId) external {
        // ERC721A._burn(tokenId, true) checks msg.sender is owner or approved.
        _burn(tokenId, true);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ADMIN CONTROLS
    // ═══════════════════════════════════════════════════════════════════════

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function setAirdropRoot(bytes32 root) external onlyRole(DEFAULT_ADMIN_ROLE) {
        airdropRoot = root;
        emit AirdropRootUpdated(root);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Permanently freeze the public pool at the current `publicMinted`.
    ///         Any unminted portion of PUBLIC_CAP becomes un-mintable forever.
    ///         Existing tokens and the airdrop pool are unaffected.
    function closeMint() external onlyRole(DEFAULT_ADMIN_ROLE) {
        publicClosed = true;
        emit PublicMintClosed(publicMinted);
    }

    /// @notice Permanently freeze the airdrop pool at the current `airdropMinted`.
    ///         Use this if migrators stop claiming and you want to lock in the
    ///         final supply. Existing tokens and the public pool are unaffected.
    function closeAirdrop() external onlyRole(DEFAULT_ADMIN_ROLE) {
        airdropClosed = true;
        emit AirdropClosed(airdropMinted);
    }

    /// @notice Admin-only emergency mint. Mints from the public pool (counts
    ///         against PUBLIC_CAP and per-wallet cap). Bypasses payment.
    ///         Used only if there is a serious failure in the user mint flow.
    function emergencyAdminMint(address to, uint256 qty, string[] calldata uris)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        if (qty == 0 || qty > MAX_BATCH_SIZE) revert InvalidQty();
        if (uris.length != qty) revert LengthMismatch();
        if (publicMintedBy[to] + qty > MAX_PER_WALLET) revert WalletCapExceeded();
        if (publicMinted + qty > PUBLIC_CAP) revert PublicCapExceeded();
        if (_totalMinted() + qty > MAX_SUPPLY) revert MaxSupplyExceeded();

        uint256 startTokenId = _nextTokenId();
        for (uint256 i = 0; i < qty; ++i) {
            string calldata u = uris[i];
            if (bytes(u).length == 0) revert UriEmpty();
            if (bytes(u).length > MAX_URI_LENGTH) revert UriTooLong();
            _tokenURIs[startTokenId + i] = u;
        }

        publicMintedBy[to] += qty;
        publicMinted       += qty;

        _safeMint(to, qty);

        emit EmergencyAdminMint(to, startTokenId, qty);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  WITHDRAW (permissionless, forced destination)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Sweep entire contract ETH balance to `treasury`.
    ///         Permissionless: anyone can call. Funds always go to `treasury`.
    ///         The only way to redirect is `setTreasury`, which is admin-only.
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

    // ═══════════════════════════════════════════════════════════════════════
    //  ERC165
    // ═══════════════════════════════════════════════════════════════════════

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC721A, AccessControl)
        returns (bool)
    {
        return ERC721A.supportsInterface(interfaceId)
            || AccessControl.supportsInterface(interfaceId);
    }
}

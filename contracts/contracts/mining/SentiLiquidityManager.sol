// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./SENTI.sol";

type Currency is address;
type PositionInfo is uint256;

struct PoolKey {
    Currency currency0;
    Currency currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct CompoundConfig {
    uint256 minEthToCompound;
    uint256 compoundCooldown;
    uint256 maxEthPerCompound;
    uint256 maxSentiPerCompound;
    uint256 maxDeadlineWindow;
}

interface IAllowanceTransfer {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IPositionManager {
    function initializePool(PoolKey calldata key, uint160 sqrtPriceX96) external payable returns (int24);

    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;

    function nextTokenId() external view returns (uint256);

    function ownerOf(uint256 tokenId) external view returns (address);
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory poolKey, PositionInfo info);
}

library PositionInfoLibrary {
    uint24 internal constant MASK_24_BITS = 0xFFFFFF;
    uint8 internal constant TICK_LOWER_OFFSET = 8;
    uint8 internal constant TICK_UPPER_OFFSET = 32;

    function tickLower(PositionInfo info) internal pure returns (int24 lower) {
        assembly ("memory-safe") {
            lower := signextend(2, shr(TICK_LOWER_OFFSET, info))
        }
    }

    function tickUpper(PositionInfo info) internal pure returns (int24 upper) {
        assembly ("memory-safe") {
            upper := signextend(2, shr(TICK_UPPER_OFFSET, info))
        }
    }
}

contract SentiLiquidityManager {
    using PositionInfoLibrary for PositionInfo;

    uint8 internal constant ACTION_INCREASE_LIQUIDITY = 0x00;
    uint8 internal constant ACTION_MINT_POSITION_FROM_DELTAS = 0x05;
    uint8 internal constant ACTION_SETTLE = 0x0b;
    uint8 internal constant ACTION_SETTLE_PAIR = 0x0d;
    uint8 internal constant ACTION_TAKE_PAIR = 0x11;
    uint8 internal constant ACTION_SWEEP = 0x14;
    uint256 internal constant CONTRACT_BALANCE = uint256(1) << 255;
    uint48 internal constant MAX_PERMIT2_EXPIRATION = type(uint48).max;

    SENTI public immutable senti;
    IPositionManager public immutable positionManager;
    IAllowanceTransfer public immutable permit2;
    address public immutable adminSafe;
    address public immutable opsSafe;
    PoolKey public poolKey;
    bool public immutable sentiIsCurrency0;

    uint256 public trackedPositionTokenId;
    uint256 public minEthToCompound;
    uint256 public compoundCooldown;
    uint256 public maxEthPerCompound;
    uint256 public maxSentiPerCompound;
    uint256 public maxDeadlineWindow;
    uint256 public lastCompoundAt;

    mapping(address => bool) public authorizedKeepers;

    error ZeroAddress();
    error InvalidPoolPair(address currency0, address currency1, address sentiToken);
    error NotAdminSafe(address caller);
    error NotCompoundCaller(address caller);
    error InvalidKeeper(address keeper);
    error InvalidTrackedPosition(uint256 tokenId);
    error PositionOwnerMismatch(uint256 tokenId, address owner);
    error PoolKeyMismatch();
    error TrackedPositionNotSet();
    error InvalidCompoundConfig();
    error InvalidBurnAmount(uint256 amount);
    error InvalidDeadline(uint256 deadline, uint256 maxDeadline);
    error InitialPositionAlreadyMinted(uint256 tokenId);
    error CompoundThresholdNotMet(uint256 availableEth, uint256 minEthToCompound);
    error CompoundCooldownActive(uint256 nextCompoundAt);
    error IncorrectNativeValue(uint256 provided, uint256 required);
    error InsufficientEthReserve(uint256 requested, uint256 available);
    error InsufficientSentiReserve(uint256 requested, uint256 available);
    error MaxEthSpendExceeded(uint256 requested, uint256 maxAllowed);
    error MaxSentiSpendExceeded(uint256 requested, uint256 maxAllowed);
    error NativeSpendRequired();
    error SentiSpendRequired();
    error TokenApprovalFailed();
    error TokenTransferFailed();

    event KeeperUpdated(address indexed keeper, bool authorized);
    event CompoundConfigUpdated(
        uint256 minEthToCompound,
        uint256 compoundCooldown,
        uint256 maxEthPerCompound,
        uint256 maxSentiPerCompound,
        uint256 maxDeadlineWindow
    );
    event TrackedPositionUpdated(
        uint256 indexed previousTokenId,
        uint256 indexed newTokenId,
        int24 tickLower,
        int24 tickUpper
    );
    event LiquidityCompounded(
        address indexed caller,
        uint256 indexed tokenId,
        uint256 liquidityIncrease,
        uint256 sentiAmountMax,
        uint256 ethAmountMax,
        uint256 deadline
    );
    event InitialPositionMinted(
        address indexed caller,
        uint256 indexed tokenId,
        int24 tickLower,
        int24 tickUpper,
        uint256 sentiAmount,
        uint256 ethAmount,
        uint256 deadline
    );
    event ReserveBurned(address indexed caller, uint256 amount);

    constructor(
        address initialAdminSafe,
        address initialOpsSafe,
        address sentiToken,
        address initialPositionManager,
        address initialPermit2,
        PoolKey memory initialPoolKey,
        CompoundConfig memory initialCompoundConfig
    ) {
        if (
            initialAdminSafe == address(0)
                || initialOpsSafe == address(0)
                || sentiToken == address(0)
                || initialPositionManager == address(0)
                || initialPermit2 == address(0)
        ) {
            revert ZeroAddress();
        }

        senti = SENTI(sentiToken);
        positionManager = IPositionManager(initialPositionManager);
        permit2 = IAllowanceTransfer(initialPermit2);
        adminSafe = initialAdminSafe;
        opsSafe = initialOpsSafe;
        poolKey = initialPoolKey;

        bool currency0IsSenti = Currency.unwrap(initialPoolKey.currency0) == sentiToken;
        bool currency1IsSenti = Currency.unwrap(initialPoolKey.currency1) == sentiToken;
        bool currency0IsNative = Currency.unwrap(initialPoolKey.currency0) == address(0);
        bool currency1IsNative = Currency.unwrap(initialPoolKey.currency1) == address(0);
        if (!(currency0IsSenti && currency1IsNative) && !(currency1IsSenti && currency0IsNative)) {
            revert InvalidPoolPair(
                Currency.unwrap(initialPoolKey.currency0),
                Currency.unwrap(initialPoolKey.currency1),
                sentiToken
            );
        }

        sentiIsCurrency0 = currency0IsSenti;
        _setCompoundConfig(initialCompoundConfig);
        _refreshPermit2Allowance();
    }

    receive() external payable {}

    modifier onlyAdminSafe() {
        if (msg.sender != adminSafe) revert NotAdminSafe(msg.sender);
        _;
    }

    modifier onlyCompoundCaller() {
        if (msg.sender != adminSafe && msg.sender != opsSafe && !authorizedKeepers[msg.sender]) {
            revert NotCompoundCaller(msg.sender);
        }
        _;
    }

    function refreshPermit2Allowance() external onlyAdminSafe {
        _refreshPermit2Allowance();
    }

    function setKeeper(address keeper, bool authorized) external onlyAdminSafe {
        if (keeper == address(0)) revert InvalidKeeper(keeper);
        authorizedKeepers[keeper] = authorized;
        emit KeeperUpdated(keeper, authorized);
    }

    function setCompoundConfig(
        uint256 newMinEthToCompound,
        uint256 newCompoundCooldown,
        uint256 newMaxEthPerCompound,
        uint256 newMaxSentiPerCompound,
        uint256 newMaxDeadlineWindow
    ) external onlyAdminSafe {
        _setCompoundConfig(
            CompoundConfig({
                minEthToCompound: newMinEthToCompound,
                compoundCooldown: newCompoundCooldown,
                maxEthPerCompound: newMaxEthPerCompound,
                maxSentiPerCompound: newMaxSentiPerCompound,
                maxDeadlineWindow: newMaxDeadlineWindow
            })
        );
    }

    function setTrackedPositionTokenId(uint256 tokenId) external onlyAdminSafe {
        if (tokenId == 0) revert InvalidTrackedPosition(tokenId);

        address owner = positionManager.ownerOf(tokenId);
        if (owner != address(this)) revert PositionOwnerMismatch(tokenId, owner);

        (PoolKey memory actualPoolKey, PositionInfo info) = positionManager.getPoolAndPositionInfo(tokenId);
        if (!_samePoolKey(actualPoolKey, poolKey)) revert PoolKeyMismatch();

        uint256 previousTokenId = trackedPositionTokenId;
        trackedPositionTokenId = tokenId;

        emit TrackedPositionUpdated(previousTokenId, tokenId, info.tickLower(), info.tickUpper());
    }

    function burnReserveSenti(uint256 amount) external onlyAdminSafe {
        if (amount == 0) revert InvalidBurnAmount(amount);

        uint256 available = senti.balanceOf(address(this));
        if (amount > available) revert InsufficientSentiReserve(amount, available);

        senti.burn(amount);

        emit ReserveBurned(msg.sender, amount);
    }

    function bootstrapInitialPosition(
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Desired,
        uint128 amount1Desired,
        uint256 deadline
    ) external payable onlyAdminSafe returns (uint256 tokenId) {
        if (trackedPositionTokenId != 0) revert InitialPositionAlreadyMinted(trackedPositionTokenId);

        _requireValidDeadline(deadline);

        uint256 ethAmount = sentiIsCurrency0 ? uint256(amount1Desired) : uint256(amount0Desired);
        uint256 sentiAmount = sentiIsCurrency0 ? uint256(amount0Desired) : uint256(amount1Desired);
        if (ethAmount == 0) revert NativeSpendRequired();
        if (sentiAmount == 0) revert SentiSpendRequired();
        if (msg.value != ethAmount) revert IncorrectNativeValue(msg.value, ethAmount);

        uint256 availableSenti = senti.balanceOf(address(this));
        if (availableSenti < sentiAmount) revert InsufficientSentiReserve(sentiAmount, availableSenti);

        positionManager.initializePool(poolKey, sqrtPriceX96);

        tokenId = positionManager.nextTokenId();
    if (!senti.transfer(address(positionManager), sentiAmount)) revert TokenTransferFailed();

    bytes memory unlockData = _encodeInitialPositionUnlockData(tickLower, tickUpper);

        positionManager.modifyLiquidities{ value: ethAmount }(unlockData, deadline);
        _requireTrackedPosition(tokenId);

        (, PositionInfo info) = positionManager.getPoolAndPositionInfo(tokenId);
        trackedPositionTokenId = tokenId;

        emit TrackedPositionUpdated(0, tokenId, info.tickLower(), info.tickUpper());
        emit InitialPositionMinted(msg.sender, tokenId, info.tickLower(), info.tickUpper(), sentiAmount, ethAmount, deadline);
    }

    function compoundLiquidity(
        uint256 liquidityIncrease,
        uint128 amount0Max,
        uint128 amount1Max,
        uint256 deadline
    ) external onlyCompoundCaller {
        uint256 tokenId = trackedPositionTokenId;
        if (tokenId == 0) revert TrackedPositionNotSet();

        _requireTrackedPosition(tokenId);
        _requireCompoundTiming(deadline);
        (uint256 ethAmountMax, uint256 sentiAmountMax) = _requireCompoundReserves(amount0Max, amount1Max);
        bytes memory unlockData = _encodeCompoundUnlockData(tokenId, liquidityIncrease, amount0Max, amount1Max);

        positionManager.modifyLiquidities{ value: ethAmountMax }(unlockData, deadline);
        lastCompoundAt = block.timestamp;

        emit LiquidityCompounded(msg.sender, tokenId, liquidityIncrease, sentiAmountMax, ethAmountMax, deadline);
    }

    function _setCompoundConfig(CompoundConfig memory config) private {
        if (
            config.minEthToCompound == 0
                || config.maxEthPerCompound < config.minEthToCompound
                || config.maxSentiPerCompound == 0
                || config.maxDeadlineWindow == 0
        ) {
            revert InvalidCompoundConfig();
        }

        minEthToCompound = config.minEthToCompound;
        compoundCooldown = config.compoundCooldown;
        maxEthPerCompound = config.maxEthPerCompound;
        maxSentiPerCompound = config.maxSentiPerCompound;
        maxDeadlineWindow = config.maxDeadlineWindow;

        emit CompoundConfigUpdated(
            config.minEthToCompound,
            config.compoundCooldown,
            config.maxEthPerCompound,
            config.maxSentiPerCompound,
            config.maxDeadlineWindow
        );
    }

    function _refreshPermit2Allowance() private {
        if (!senti.approve(address(permit2), type(uint256).max)) revert TokenApprovalFailed();
        permit2.approve(address(senti), address(positionManager), type(uint160).max, MAX_PERMIT2_EXPIRATION);
    }

    function _requireTrackedPosition(uint256 tokenId) private view {
        address owner = positionManager.ownerOf(tokenId);
        if (owner != address(this)) revert PositionOwnerMismatch(tokenId, owner);

        (PoolKey memory actualPoolKey,) = positionManager.getPoolAndPositionInfo(tokenId);
        if (!_samePoolKey(actualPoolKey, poolKey)) revert PoolKeyMismatch();
    }

    function _requireCompoundTiming(uint256 deadline) private view {
        _requireValidDeadline(deadline);

        uint256 nextCompoundAt = lastCompoundAt + compoundCooldown;
        if (lastCompoundAt != 0 && block.timestamp < nextCompoundAt) {
            revert CompoundCooldownActive(nextCompoundAt);
        }
    }

    function _requireCompoundReserves(uint128 amount0Max, uint128 amount1Max) private view returns (uint256 ethAmountMax, uint256 sentiAmountMax) {
        ethAmountMax = sentiIsCurrency0 ? uint256(amount1Max) : uint256(amount0Max);
        sentiAmountMax = sentiIsCurrency0 ? uint256(amount0Max) : uint256(amount1Max);
        if (ethAmountMax == 0) revert NativeSpendRequired();
        if (sentiAmountMax == 0) revert SentiSpendRequired();
        if (ethAmountMax < minEthToCompound) revert CompoundThresholdNotMet(ethAmountMax, minEthToCompound);
        if (ethAmountMax > maxEthPerCompound) revert MaxEthSpendExceeded(ethAmountMax, maxEthPerCompound);
        if (sentiAmountMax > maxSentiPerCompound) revert MaxSentiSpendExceeded(sentiAmountMax, maxSentiPerCompound);

        uint256 availableEth = address(this).balance;
        if (availableEth < minEthToCompound) revert CompoundThresholdNotMet(availableEth, minEthToCompound);
        if (availableEth < ethAmountMax) revert InsufficientEthReserve(ethAmountMax, availableEth);

        uint256 availableSenti = senti.balanceOf(address(this));
        if (availableSenti < sentiAmountMax) revert InsufficientSentiReserve(sentiAmountMax, availableSenti);
    }

    function _requireValidDeadline(uint256 deadline) private view {
        uint256 maxDeadline = block.timestamp + maxDeadlineWindow;
        if (deadline < block.timestamp || deadline > maxDeadline) {
            revert InvalidDeadline(deadline, maxDeadline);
        }
    }

    function _encodeInitialPositionUnlockData(int24 tickLower, int24 tickUpper) private view returns (bytes memory unlockData) {
        bytes memory actions = abi.encodePacked(ACTION_SETTLE, ACTION_SETTLE, ACTION_MINT_POSITION_FROM_DELTAS, ACTION_TAKE_PAIR);
        bytes[] memory params = new bytes[](4);
        params[0] = abi.encode(poolKey.currency0, CONTRACT_BALANCE, false);
        params[1] = abi.encode(poolKey.currency1, CONTRACT_BALANCE, false);
        params[2] = abi.encode(poolKey, tickLower, tickUpper, type(uint128).max, type(uint128).max, address(this), bytes(""));
        params[3] = abi.encode(poolKey.currency0, poolKey.currency1, address(this));
        unlockData = abi.encode(actions, params);
    }

    function _encodeCompoundUnlockData(
        uint256 tokenId,
        uint256 liquidityIncrease,
        uint128 amount0Max,
        uint128 amount1Max
    ) private view returns (bytes memory unlockData) {
        bytes memory actions = abi.encodePacked(ACTION_INCREASE_LIQUIDITY, ACTION_SETTLE_PAIR, ACTION_SWEEP);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(tokenId, liquidityIncrease, amount0Max, amount1Max, bytes(""));
        params[1] = abi.encode(poolKey.currency0, poolKey.currency1);
        params[2] = abi.encode(_nativeCurrency(), address(this));
        unlockData = abi.encode(actions, params);
    }

    function _samePoolKey(PoolKey memory left, PoolKey memory right) private pure returns (bool) {
        return Currency.unwrap(left.currency0) == Currency.unwrap(right.currency0)
            && Currency.unwrap(left.currency1) == Currency.unwrap(right.currency1)
            && left.fee == right.fee
            && left.tickSpacing == right.tickSpacing
            && left.hooks == right.hooks;
    }

    function _nativeCurrency() private pure returns (Currency) {
        return Currency.wrap(address(0));
    }
}
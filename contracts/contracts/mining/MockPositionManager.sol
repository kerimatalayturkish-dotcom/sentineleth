// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

type Currency is address;
type PositionInfo is uint256;

struct PoolKey {
    Currency currency0;
    Currency currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

library MockPositionInfoLibrary {
    uint24 internal constant MASK_24_BITS = 0xFFFFFF;

    function pack(int24 tickLower, int24 tickUpper) internal pure returns (PositionInfo info) {
        assembly {
            info := or(
                shl(32, and(MASK_24_BITS, tickUpper)),
                shl(8, and(MASK_24_BITS, tickLower))
            )
        }
    }
}

contract MockPositionManager {
    using MockPositionInfoLibrary for int24;

    uint8 internal constant ACTION_INCREASE_LIQUIDITY = 0x00;
    uint8 internal constant ACTION_MINT_POSITION_FROM_DELTAS = 0x05;
    uint8 internal constant ACTION_SETTLE = 0x0b;
    uint8 internal constant ACTION_SETTLE_PAIR = 0x0d;
    uint8 internal constant ACTION_TAKE_PAIR = 0x11;

    mapping(uint256 => address) private owners;
    mapping(uint256 => PoolKey) private poolKeys;
    mapping(uint256 => PositionInfo) private positionInfos;

    uint256 private nextTokenIdValue = 1;

    bytes public lastActions;
    uint256 public lastDeadline;
    uint256 public lastValue;
    uint256 public lastTokenId;
    uint256 public lastLiquidityIncrease;
    uint128 public lastAmount0Max;
    uint128 public lastAmount1Max;
    uint160 public lastSqrtPriceX96;
    int24 public lastMintTickLower;
    int24 public lastMintTickUpper;
    address public lastMintOwner;
    address public lastSettleCurrency0;
    address public lastSettleCurrency1;
    uint256 public lastSettleAmount0;
    uint256 public lastSettleAmount1;
    address public lastSweepCurrency;
    address public lastSweepRecipient;
    address public lastTakeCurrency0;
    address public lastTakeCurrency1;
    address public lastTakeRecipient;

    function setPosition(uint256 tokenId, address owner, PoolKey memory poolKey, int24 tickLower, int24 tickUpper) external {
        owners[tokenId] = owner;
        poolKeys[tokenId] = poolKey;
        positionInfos[tokenId] = MockPositionInfoLibrary.pack(tickLower, tickUpper);
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return owners[tokenId];
    }

    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory poolKey, PositionInfo info) {
        return (poolKeys[tokenId], positionInfos[tokenId]);
    }

    function nextTokenId() external view returns (uint256) {
        return nextTokenIdValue;
    }

    function initializePool(PoolKey calldata, uint160 sqrtPriceX96) external returns (int24) {
        lastSqrtPriceX96 = sqrtPriceX96;
        return 0;
    }

    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable {
        (bytes memory actions, bytes[] memory params) = abi.decode(unlockData, (bytes, bytes[]));

        lastActions = actions;
        lastDeadline = deadline;
        lastValue = msg.value;
        if (uint8(actions[0]) == ACTION_INCREASE_LIQUIDITY) {
            (lastTokenId, lastLiquidityIncrease, lastAmount0Max, lastAmount1Max,) = abi.decode(
                params[0],
                (uint256, uint256, uint128, uint128, bytes)
            );

            (Currency currency0, Currency currency1) = abi.decode(params[1], (Currency, Currency));
            lastSettleCurrency0 = Currency.unwrap(currency0);
            lastSettleCurrency1 = Currency.unwrap(currency1);

            (Currency sweepCurrency, address sweepRecipient) = abi.decode(params[2], (Currency, address));
            lastSweepCurrency = Currency.unwrap(sweepCurrency);
            lastSweepRecipient = sweepRecipient;
            return;
        }

        if (
            uint8(actions[0]) == ACTION_SETTLE
                && uint8(actions[1]) == ACTION_SETTLE
                && uint8(actions[2]) == ACTION_MINT_POSITION_FROM_DELTAS
                && uint8(actions[3]) == ACTION_TAKE_PAIR
        ) {
            (Currency settleCurrency0, uint256 settleAmount0,) = abi.decode(params[0], (Currency, uint256, bool));
            (Currency settleCurrency1, uint256 settleAmount1,) = abi.decode(params[1], (Currency, uint256, bool));
            lastSettleCurrency0 = Currency.unwrap(settleCurrency0);
            lastSettleCurrency1 = Currency.unwrap(settleCurrency1);
            lastSettleAmount0 = settleAmount0;
            lastSettleAmount1 = settleAmount1;

            PoolKey memory poolKey;
            address owner;
            (poolKey, lastMintTickLower, lastMintTickUpper, lastAmount0Max, lastAmount1Max, owner,) = abi.decode(
                params[2],
                (PoolKey, int24, int24, uint128, uint128, address, bytes)
            );
            lastMintOwner = owner;

            lastTokenId = nextTokenIdValue;
            owners[nextTokenIdValue] = owner;
            poolKeys[nextTokenIdValue] = poolKey;
            positionInfos[nextTokenIdValue] = MockPositionInfoLibrary.pack(lastMintTickLower, lastMintTickUpper);
            nextTokenIdValue += 1;

            (Currency takeCurrency0, Currency takeCurrency1, address takeRecipient) = abi.decode(
                params[3],
                (Currency, Currency, address)
            );
            lastTakeCurrency0 = Currency.unwrap(takeCurrency0);
            lastTakeCurrency1 = Currency.unwrap(takeCurrency1);
            lastTakeRecipient = takeRecipient;
        }
    }
}
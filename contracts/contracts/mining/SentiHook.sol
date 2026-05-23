// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";

contract SentiHook is BaseHook {
    using BalanceDeltaLibrary for BalanceDelta;
    using CurrencyLibrary for Currency;
    using SafeCast for uint256;

    uint24 public constant ETH_SIDE_FEE_BIPS = 1500;
    uint24 public constant TOTAL_BIPS = 10_000;

    Currency public immutable sentiCurrency;
    address public immutable feeRecipient;
    uint24 public immutable expectedPoolFee;
    int24 public immutable expectedTickSpacing;

    error ZeroAddress();
    error UnsupportedPool(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks);
    error ExactOutputNotSupported();

    constructor(
        IPoolManager manager,
        address sentiToken,
        address initialFeeRecipient,
        uint24 poolFee,
        int24 tickSpacing
    ) BaseHook(manager) {
        if (sentiToken == address(0) || initialFeeRecipient == address(0)) revert ZeroAddress();

        sentiCurrency = Currency.wrap(sentiToken);
        feeRecipient = initialFeeRecipient;
        expectedPoolFee = poolFee;
        expectedTickSpacing = tickSpacing;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _requireCanonicalPool(key);
        if (params.amountSpecified >= 0) revert ExactOutputNotSupported();

        if (!_isBuy(key, params.zeroForOne)) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        Currency nativeCurrency = _nativeCurrency(key);
        uint256 feeAmount = _calculateFee(uint256(-params.amountSpecified));

        poolManager.take(nativeCurrency, feeRecipient, feeAmount);

        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(feeAmount.toInt128(), 0), 0);
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        _requireCanonicalPool(key);
        if (params.amountSpecified >= 0) revert ExactOutputNotSupported();

        if (!_isSell(key, params.zeroForOne)) {
            return (IHooks.afterSwap.selector, 0);
        }

        (Currency specifiedCurrency, Currency unspecifiedCurrency) = _sortCurrencies(key, params);
        if (!(specifiedCurrency == sentiCurrency) || !unspecifiedCurrency.isAddressZero()) {
            revert UnsupportedPool(
                Currency.unwrap(key.currency0),
                Currency.unwrap(key.currency1),
                key.fee,
                key.tickSpacing,
                address(key.hooks)
            );
        }

        int128 grossOutput = _deltaForCurrency(delta, key, unspecifiedCurrency);
        if (grossOutput < 0) grossOutput = -grossOutput;

        uint256 feeAmount = _calculateFee(uint256(uint128(grossOutput)));
        poolManager.take(unspecifiedCurrency, feeRecipient, feeAmount);

        return (IHooks.afterSwap.selector, feeAmount.toInt128());
    }

    function _requireCanonicalPool(PoolKey calldata key) private view {
        bool native0 = key.currency0.isAddressZero();
        bool native1 = key.currency1.isAddressZero();
        bool senti0 = key.currency0 == sentiCurrency;
        bool senti1 = key.currency1 == sentiCurrency;

        bool validPair = (native0 && senti1) || (senti0 && native1);
        bool validFee = key.fee == expectedPoolFee;
        bool validTickSpacing = key.tickSpacing == expectedTickSpacing;
        bool validHook = address(key.hooks) == address(this);

        if (!(validPair && validFee && validTickSpacing && validHook)) {
            revert UnsupportedPool(
                Currency.unwrap(key.currency0),
                Currency.unwrap(key.currency1),
                key.fee,
                key.tickSpacing,
                address(key.hooks)
            );
        }
    }

    function _calculateFee(uint256 amount) private pure returns (uint256) {
        return amount * ETH_SIDE_FEE_BIPS / TOTAL_BIPS;
    }

    function _isBuy(PoolKey calldata key, bool zeroForOne) private view returns (bool) {
        return zeroForOne ? key.currency0.isAddressZero() : key.currency1.isAddressZero();
    }

    function _isSell(PoolKey calldata key, bool zeroForOne) private view returns (bool) {
        return zeroForOne ? key.currency0 == sentiCurrency : key.currency1 == sentiCurrency;
    }

    function _nativeCurrency(PoolKey calldata key) private pure returns (Currency) {
        return key.currency0.isAddressZero() ? key.currency0 : key.currency1;
    }

    function _sortCurrencies(PoolKey calldata key, SwapParams calldata params)
        private
        pure
        returns (Currency specified, Currency unspecified)
    {
        (specified, unspecified) = (params.zeroForOne == (params.amountSpecified < 0))
            ? (key.currency0, key.currency1)
            : (key.currency1, key.currency0);
    }

    function _deltaForCurrency(BalanceDelta delta, PoolKey calldata key, Currency currency) private pure returns (int128) {
        return currency == key.currency0 ? delta.amount0() : delta.amount1();
    }
}
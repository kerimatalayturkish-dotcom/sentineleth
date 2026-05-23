// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";

contract MockHookPoolManager {
    Currency public lastTakeCurrency;
    address public lastTakeRecipient;
    uint256 public lastTakeAmount;

    function take(Currency currency, address recipient, uint256 amount) external {
        lastTakeCurrency = currency;
        lastTakeRecipient = recipient;
        lastTakeAmount = amount;
    }

    function callBeforeSwap(address hook, PoolKey calldata key, SwapParams calldata params)
        external
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return IHooks(hook).beforeSwap(address(this), key, params, bytes(""));
    }

    function callAfterSwap(address hook, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta)
        external
        returns (bytes4, int128)
    {
        return IHooks(hook).afterSwap(address(this), key, params, delta, bytes(""));
    }
}
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

contract SENTI is ERC20, ERC20Burnable {
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;

    address public minter;
    bool public minterLocked;

    error ZeroAddress();
    error NotMinter(address caller);
    error MinterAlreadyLocked();
    error CapExceeded(uint256 requestedSupply, uint256 maxSupply);

    event MinterTransferred(address indexed previousMinter, address indexed newMinter, bool locked);

    constructor(address initialMinter) ERC20("Sentinel Mining Token", "SENTI") {
        if (initialMinter == address(0)) revert ZeroAddress();
        minter = initialMinter;
        emit MinterTransferred(address(0), initialMinter, false);
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter(msg.sender);
        _;
    }

    function mint(address to, uint256 amount) external onlyMinter {
        if (to == address(0)) revert ZeroAddress();
        uint256 requestedSupply = totalSupply() + amount;
        if (requestedSupply > MAX_SUPPLY) revert CapExceeded(requestedSupply, MAX_SUPPLY);
        _mint(to, amount);
    }

    function transferMinter(address newMinter) external onlyMinter {
        if (minterLocked) revert MinterAlreadyLocked();
        if (newMinter == address(0)) revert ZeroAddress();

        address previousMinter = minter;
        minter = newMinter;
        minterLocked = true;

        emit MinterTransferred(previousMinter, newMinter, true);
    }
}
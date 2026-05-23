// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockCreate2Deployer {
    error DeploymentFailed();

    function deploy(bytes32 salt, bytes calldata initCode) external returns (address deployed) {
        bytes memory creationCode = initCode;
        assembly ("memory-safe") {
            deployed := create2(0, add(creationCode, 0x20), mload(creationCode), salt)
        }
        if (deployed == address(0)) revert DeploymentFailed();
    }
}
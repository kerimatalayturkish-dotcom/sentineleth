// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract TraitRegistry {
    uint256 public constant MAX_COLLECTION_CAP = 10_000;
    uint32 public constant POWER_SCALE = 1_000;
    uint32 public constant MULTIPLIER_SCALE = 10_000;
    uint32 public constant MAX_SYNERGY_MULTIPLIER_BPS = 40_000;

    address public immutable admin;
    bytes32 public immutable traitsSourceHash;
    bytes32 public immutable powerConfigHash;
    bytes32 public immutable synergyRulesHash;
    bytes32 public immutable rulesCommitment;
    uint256 public immutable collectionCap;
    uint16 public immutable expectedLayerCount;
    uint16 public immutable expectedTraitCount;
    uint16 public immutable expectedSynergyCount;

    bool public finalized;
    uint16 public configuredLayerCount;
    uint16 public configuredTraitCount;
    uint16 public configuredSynergyCount;

    mapping(bytes32 => uint32) private _layerWeightsBps;
    mapping(bytes32 => uint32) private _traitValues;
    mapping(bytes32 => uint32) private _synergyMultipliersBps;
    mapping(bytes32 => bool) private _layerConfigured;
    mapping(bytes32 => bool) private _traitConfigured;
    mapping(bytes32 => bool) private _synergyConfigured;

    error ZeroAddress();
    error ZeroHash();
    error NotAdmin(address caller);
    error AlreadyFinalized();
    error InvalidCollectionCap();
    error InvalidExpectedCount();
    error InvalidWeight(string layerId, uint32 weightBps);
    error InvalidTraitValue(string layerId, string traitId, uint32 value);
    error InvalidSynergyMultiplier(string synergyId, uint32 multiplierBps);
    error LengthMismatch();
    error TooManyRules(uint16 layers, uint16 traits, uint16 synergies);
    error IncompleteRegistry(uint16 layers, uint16 traits, uint16 synergies);
    error UnknownLayer(string layerId);
    error UnknownTrait(string layerId, string traitId);
    error UnknownSynergy(string synergyId);

    event LayerWeightSet(bytes32 indexed layerKey, string layerId, uint32 weightBps);
    event TraitValueSet(bytes32 indexed traitKey, string layerId, string traitId, uint32 value);
    event SynergyMultiplierSet(bytes32 indexed synergyKey, string synergyId, uint32 multiplierBps);
    event Finalized(bytes32 indexed rulesCommitment, bytes32 indexed powerConfigHash, bytes32 indexed synergyRulesHash);

    constructor(
        address initialAdmin,
        bytes32 initialTraitsSourceHash,
        bytes32 initialPowerConfigHash,
        bytes32 initialSynergyRulesHash,
        bytes32 initialRulesCommitment,
        uint256 initialCollectionCap,
        uint16 initialLayerCount,
        uint16 initialTraitCount,
        uint16 initialSynergyCount
    ) {
        if (initialAdmin == address(0)) revert ZeroAddress();
        if (initialCollectionCap == 0 || initialCollectionCap > MAX_COLLECTION_CAP) revert InvalidCollectionCap();
        if (initialLayerCount == 0 || initialTraitCount == 0 || initialSynergyCount == 0) {
            revert InvalidExpectedCount();
        }
        if (
            initialTraitsSourceHash == bytes32(0) ||
            initialPowerConfigHash == bytes32(0) ||
            initialSynergyRulesHash == bytes32(0) ||
            initialRulesCommitment == bytes32(0)
        ) {
            revert ZeroHash();
        }

        admin = initialAdmin;
        traitsSourceHash = initialTraitsSourceHash;
        powerConfigHash = initialPowerConfigHash;
        synergyRulesHash = initialSynergyRulesHash;
        rulesCommitment = initialRulesCommitment;
        collectionCap = initialCollectionCap;
        expectedLayerCount = initialLayerCount;
        expectedTraitCount = initialTraitCount;
        expectedSynergyCount = initialSynergyCount;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin(msg.sender);
        _;
    }

    modifier notFinalized() {
        if (finalized) revert AlreadyFinalized();
        _;
    }

    function layerKey(string memory layerId) public pure returns (bytes32) {
        return keccak256(bytes(layerId));
    }

    function traitKey(string memory layerId, string memory traitId) public pure returns (bytes32) {
        return keccak256(abi.encode(layerId, traitId));
    }

    function synergyKey(string memory synergyId) public pure returns (bytes32) {
        return keccak256(bytes(synergyId));
    }

    function setLayerWeights(string[] calldata layerIds, uint32[] calldata weightsBps) external onlyAdmin notFinalized {
        uint256 count = layerIds.length;
        if (count != weightsBps.length) revert LengthMismatch();

        for (uint256 i = 0; i < count; ++i) {
            string calldata layerId = layerIds[i];
            uint32 weightBps = weightsBps[i];
            if (weightBps == 0) revert InvalidWeight(layerId, weightBps);

            bytes32 key = layerKey(layerId);
            if (!_layerConfigured[key]) {
                if (configuredLayerCount + 1 > expectedLayerCount) {
                    revert TooManyRules(configuredLayerCount + 1, configuredTraitCount, configuredSynergyCount);
                }
                configuredLayerCount += 1;
                _layerConfigured[key] = true;
            }
            _layerWeightsBps[key] = weightBps;

            emit LayerWeightSet(key, layerId, weightBps);
        }
    }

    function setTraitValues(
        string[] calldata layerIds,
        string[] calldata traitIds,
        uint32[] calldata values
    ) external onlyAdmin notFinalized {
        uint256 count = layerIds.length;
        if (count != traitIds.length || count != values.length) revert LengthMismatch();

        for (uint256 i = 0; i < count; ++i) {
            string calldata layerId = layerIds[i];
            string calldata traitId = traitIds[i];
            uint32 value = values[i];
            if (value == 0) revert InvalidTraitValue(layerId, traitId, value);

            bytes32 key = traitKey(layerId, traitId);
            if (!_traitConfigured[key]) {
                if (configuredTraitCount + 1 > expectedTraitCount) {
                    revert TooManyRules(configuredLayerCount, configuredTraitCount + 1, configuredSynergyCount);
                }
                configuredTraitCount += 1;
                _traitConfigured[key] = true;
            }
            _traitValues[key] = value;

            emit TraitValueSet(key, layerId, traitId, value);
        }
    }

    function setSynergyMultipliers(
        string[] calldata synergyIds,
        uint32[] calldata multipliersBps
    ) external onlyAdmin notFinalized {
        uint256 count = synergyIds.length;
        if (count != multipliersBps.length) revert LengthMismatch();

        for (uint256 i = 0; i < count; ++i) {
            string calldata synergyId = synergyIds[i];
            uint32 multiplierBps = multipliersBps[i];
            if (multiplierBps < MULTIPLIER_SCALE || multiplierBps > MAX_SYNERGY_MULTIPLIER_BPS) {
                revert InvalidSynergyMultiplier(synergyId, multiplierBps);
            }

            bytes32 key = synergyKey(synergyId);
            if (!_synergyConfigured[key]) {
                if (configuredSynergyCount + 1 > expectedSynergyCount) {
                    revert TooManyRules(configuredLayerCount, configuredTraitCount, configuredSynergyCount + 1);
                }
                configuredSynergyCount += 1;
                _synergyConfigured[key] = true;
            }
            _synergyMultipliersBps[key] = multiplierBps;

            emit SynergyMultiplierSet(key, synergyId, multiplierBps);
        }
    }

    function finalize() external onlyAdmin notFinalized {
        if (
            configuredLayerCount != expectedLayerCount ||
            configuredTraitCount != expectedTraitCount ||
            configuredSynergyCount != expectedSynergyCount
        ) {
            revert IncompleteRegistry(configuredLayerCount, configuredTraitCount, configuredSynergyCount);
        }

        finalized = true;
        emit Finalized(rulesCommitment, powerConfigHash, synergyRulesHash);
    }

    function layerWeightBps(string calldata layerId) external view returns (uint32) {
        bytes32 key = layerKey(layerId);
        if (!_layerConfigured[key]) revert UnknownLayer(layerId);
        return _layerWeightsBps[key];
    }

    function traitValue(string calldata layerId, string calldata traitId) external view returns (uint32) {
        bytes32 key = traitKey(layerId, traitId);
        if (!_traitConfigured[key]) revert UnknownTrait(layerId, traitId);
        return _traitValues[key];
    }

    function synergyMultiplierBps(string calldata synergyId) external view returns (uint32) {
        bytes32 key = synergyKey(synergyId);
        if (!_synergyConfigured[key]) revert UnknownSynergy(synergyId);
        return _synergyMultipliersBps[key];
    }

    function layerWeightByKey(bytes32 key) external view returns (uint32) {
        return _layerWeightsBps[key];
    }

    function traitValueByKey(bytes32 key) external view returns (uint32) {
        return _traitValues[key];
    }

    function synergyMultiplierByKey(bytes32 key) external view returns (uint32) {
        return _synergyMultipliersBps[key];
    }
}
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "./SENTI.sol";

contract PatrolMiner is EIP712 {
    struct ClaimData {
        uint256 blockNumber;
        uint256 bucketId;
        bytes32 blockHash;
        address winner;
        uint256 winnerPower;
        bytes signature;
    }

    struct AggregateClaimData {
        address winner;
        uint256[] bucketIds;
        uint256[] cumulativeRounds;
        bytes signature;
    }

    uint256 public constant PHASE_ONE_SUPPLY = 600_000_000 ether;
    uint256 public constant INITIAL_LIQUIDITY_SUPPLY = 200_000 ether;
    uint256 public constant MINEABLE_SUPPLY = PHASE_ONE_SUPPLY - INITIAL_LIQUIDITY_SUPPLY;
    uint256 public constant LIQUIDITY_MANAGER_RESERVE_SUPPLY = 100_000_000 ether;
    uint256 public constant MAX_AI_AGENT_RESERVED_SUPPLY = 300_000_000 ether;
    uint256 public constant BLOCK_REWARD = 5_950 ether;
    uint256 public constant MAX_REWARD_ROUNDS = (MINEABLE_SUPPLY + BLOCK_REWARD - 1) / BLOCK_REWARD;
    uint256 public constant MAX_BATCH_CLAIMS = 25;
    uint256 public constant CLAIM_BUCKET_SECONDS = 1 hours;
    uint256 public constant CLAIM_EXPIRY_SECONDS = 24 hours;
    uint256 public constant MAX_AGGREGATE_BUCKETS = 32;

    bytes32 public constant CLAIM_TYPEHASH = keccak256(
        "Claim(uint256 blockNumber,uint256 bucketId,bytes32 blockHash,address winner,uint256 winnerPower)"
    );
    bytes32 public constant AGGREGATE_CLAIM_TYPEHASH = keccak256(
        "AggregateClaim(address winner,bytes32 bucketIdsHash,bytes32 cumulativeRoundsHash)"
    );

    SENTI public immutable senti;
    address public immutable admin;

    address public signer;
    address public aiAgentMinter;
    uint256 public miningStartBlock;
    uint256 public mined;
    uint256 public rewardedRounds;
    uint256 public aiAgentMinted;
    uint256 public aiAgentReservedSupply = MAX_AI_AGENT_RESERVED_SUPPLY;
    bool public initialLiquidityMinted;

    mapping(uint256 => bool) public claimed;
    mapping(address => mapping(uint256 => uint256)) public claimedBucketRounds;

    error ZeroAddress();
    error NotAdmin(address caller);
    error MiningInactive(uint256 blockNumber);
    error ClaimExpired(uint256 bucketId, uint256 currentTimestamp);
    error AlreadyClaimed(uint256 blockNumber);
    error InvalidBlockHash();
    error InvalidWinner();
    error InvalidPower();
    error InvalidSignature(address recovered);
    error MineableSupplyExceeded(uint256 requestedMined, uint256 maxMineable);
    error MiningComplete(uint256 rewardedRounds, uint256 maxRewardRounds);
    error InvalidBatchSize(uint256 size);
    error MiningAlreadyStarted(uint256 startBlock);
    error InitialLiquidityAlreadyMinted();
    error AiAgentMinterAlreadySet(address currentMinter);
    error NotAiAgentMinter(address caller);
    error AiAgentSupplyExceeded(uint256 requestedMinted, uint256 maxAiAgent);
    error InvalidAiAgentReserveBurn(uint256 amount);
    error AiAgentReserveBurnExceeded(uint256 requestedReservedSupply, uint256 aiAgentMinted);
    error InvalidRoundCount(uint256 roundCount);
    error InvalidAggregateSize(uint256 size);
    error InvalidAggregateLengths(uint256 bucketCount, uint256 cumulativeCount);
    error InvalidBucketId(uint256 bucketId, uint256 currentBucketId);
    error InvalidBucketOrder(uint256 previousBucketId, uint256 bucketId);
    error InvalidCumulativeRounds(address winner, uint256 bucketId, uint256 claimedRounds, uint256 cumulativeRounds);
    error NothingClaimable(address winner);

    event SignerUpdated(address indexed previousSigner, address indexed newSigner);
    event MiningStarted(uint256 indexed startBlock, uint256 maxRewardRounds);
    event InitialLiquidityMinted(address indexed recipient, uint256 amount);
    event AiAgentMinterSet(address indexed aiAgentMinter);
    event AiAgentMinted(address indexed recipient, uint256 amount, uint256 totalAiAgentMinted);
    event UnmintedAiAgentSupplyBurned(uint256 previousReservedSupply, uint256 newReservedSupply, uint256 amountBurned);
    event Claimed(uint256 indexed blockNumber, address indexed winner, uint256 reward, uint256 winnerPower, uint256 bucketId);
    event AggregateClaimed(
        address indexed winner,
        uint256 roundCount,
        uint256 reward,
        uint256[] bucketIds,
        uint256[] settledRounds
    );

    constructor(
        address sentiToken,
        address initialAdmin,
        address initialSigner
    ) EIP712("PatrolMiner", "1") {
        if (sentiToken == address(0) || initialAdmin == address(0) || initialSigner == address(0)) {
            revert ZeroAddress();
        }

        senti = SENTI(sentiToken);
        admin = initialAdmin;
        signer = initialSigner;

        emit SignerUpdated(address(0), initialSigner);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin(msg.sender);
        _;
    }

    function startMining() external onlyAdmin {
        if (miningStartBlock != 0) revert MiningAlreadyStarted(miningStartBlock);

        uint256 startBlock = block.number;
        miningStartBlock = startBlock;

        emit MiningStarted(startBlock, MAX_REWARD_ROUNDS);
    }

    function miningActive() external view returns (bool) {
        return miningStartBlock != 0 && rewardedRounds < MAX_REWARD_ROUNDS;
    }

    function remainingRewardRounds() external view returns (uint256) {
        return MAX_REWARD_ROUNDS - rewardedRounds;
    }

    function remainingMineableSupply() external view returns (uint256) {
        return MINEABLE_SUPPLY - mined;
    }

    function rewardForNextRound() public view returns (uint256) {
        if (rewardedRounds >= MAX_REWARD_ROUNDS) return 0;

        uint256 remaining = MINEABLE_SUPPLY - mined;
        return remaining < BLOCK_REWARD ? remaining : BLOCK_REWARD;
    }

    function setSigner(address newSigner) external onlyAdmin {
        if (newSigner == address(0)) revert ZeroAddress();
        address previousSigner = signer;
        signer = newSigner;
        emit SignerUpdated(previousSigner, newSigner);
    }

    function mintInitialLiquidity(address recipient) external onlyAdmin {
        if (recipient == address(0)) revert ZeroAddress();
        if (initialLiquidityMinted) revert InitialLiquidityAlreadyMinted();

        initialLiquidityMinted = true;
        senti.mint(recipient, INITIAL_LIQUIDITY_SUPPLY);

        emit InitialLiquidityMinted(recipient, INITIAL_LIQUIDITY_SUPPLY);
    }

    function setAiAgentMinter(address newAiAgentMinter) external onlyAdmin {
        if (newAiAgentMinter == address(0)) revert ZeroAddress();
        if (aiAgentMinter != address(0)) revert AiAgentMinterAlreadySet(aiAgentMinter);

        aiAgentMinter = newAiAgentMinter;

        emit AiAgentMinterSet(newAiAgentMinter);
    }

    function mintAiAgent(address recipient, uint256 amount) external {
        if (msg.sender != aiAgentMinter) revert NotAiAgentMinter(msg.sender);
        if (recipient == address(0)) revert ZeroAddress();

        uint256 requestedMinted = aiAgentMinted + amount;
        if (requestedMinted > aiAgentReservedSupply) {
            revert AiAgentSupplyExceeded(requestedMinted, aiAgentReservedSupply);
        }

        aiAgentMinted = requestedMinted;
        senti.mint(recipient, amount);

        emit AiAgentMinted(recipient, amount, requestedMinted);
    }

    function burnUnmintedAiAgentSupply(uint256 amount) external onlyAdmin {
        uint256 previousReservedSupply = aiAgentReservedSupply;
        if (amount == 0 || amount > previousReservedSupply) revert InvalidAiAgentReserveBurn(amount);

        uint256 newReservedSupply = previousReservedSupply - amount;
        if (newReservedSupply < aiAgentMinted) {
            revert AiAgentReserveBurnExceeded(newReservedSupply, aiAgentMinted);
        }

        aiAgentReservedSupply = newReservedSupply;

        emit UnmintedAiAgentSupplyBurned(previousReservedSupply, newReservedSupply, amount);
    }

    function claim(
        uint256 blockNumber,
        uint256 bucketId,
        bytes32 blockHash,
        address winner,
        uint256 winnerPower,
        bytes calldata signature
    ) external {
        _claim(blockNumber, bucketId, blockHash, winner, winnerPower, signature);
    }

    function batchClaim(ClaimData[] calldata claims) external {
        uint256 count = claims.length;
        if (count == 0 || count > MAX_BATCH_CLAIMS) revert InvalidBatchSize(count);

        for (uint256 i = 0; i < count; ++i) {
            ClaimData calldata claimData = claims[i];
            _claim(
                claimData.blockNumber,
                claimData.bucketId,
                claimData.blockHash,
                claimData.winner,
                claimData.winnerPower,
                claimData.signature
            );
        }
    }

    function aggregateClaim(
        address winner,
        uint256[] calldata bucketIds,
        uint256[] calldata cumulativeRounds,
        bytes calldata signature
    ) external {
        _aggregateClaim(winner, bucketIds, cumulativeRounds, signature);
    }

    function claimDigest(
        uint256 blockNumber,
        uint256 bucketId,
        bytes32 blockHash,
        address winner,
        uint256 winnerPower
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(CLAIM_TYPEHASH, blockNumber, bucketId, blockHash, winner, winnerPower))
        );
    }

    function aggregateClaimDigest(
        address winner,
        bytes32 bucketIdsHash,
        bytes32 cumulativeRoundsHash
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(AGGREGATE_CLAIM_TYPEHASH, winner, bucketIdsHash, cumulativeRoundsHash))
        );
    }

    function currentBucketId() public view returns (uint256) {
        return block.timestamp / CLAIM_BUCKET_SECONDS;
    }

    function scoreFor(bytes32 blockHash, address wallet, uint256 walletPower) public pure returns (uint256) {
        if (blockHash == bytes32(0)) revert InvalidBlockHash();
        if (wallet == address(0)) revert InvalidWinner();
        if (walletPower == 0) revert InvalidPower();
        return uint256(keccak256(abi.encodePacked(blockHash, wallet))) / walletPower;
    }

    function _claim(
        uint256 blockNumber,
        uint256 bucketId,
        bytes32 blockHash,
        address winner,
        uint256 winnerPower,
        bytes calldata signature
    ) private {
        _requireActiveAt(blockNumber);
        _requireBucketId(bucketId);
        _requireBucketClaimable(bucketId);
        if (claimed[blockNumber]) revert AlreadyClaimed(blockNumber);
        if (blockHash == bytes32(0)) revert InvalidBlockHash();
        if (winner == address(0)) revert InvalidWinner();
        if (winnerPower == 0) revert InvalidPower();

        _requireValidSignature(claimDigest(blockNumber, bucketId, blockHash, winner, winnerPower), signature);
        uint256 reward = _consumeRewardRounds(1);

        claimed[blockNumber] = true;
        claimedBucketRounds[winner][bucketId] += 1;

        senti.mint(winner, reward);

        emit Claimed(blockNumber, winner, reward, winnerPower, bucketId);
    }

    function _aggregateClaim(
        address winner,
        uint256[] calldata bucketIds,
        uint256[] calldata cumulativeRounds,
        bytes calldata signature
    ) private {
        if (miningStartBlock == 0) revert MiningInactive(0);
        if (winner == address(0)) revert InvalidWinner();

        uint256 count = bucketIds.length;
        if (count == 0 || count > MAX_AGGREGATE_BUCKETS) revert InvalidAggregateSize(count);
        if (count != cumulativeRounds.length) revert InvalidAggregateLengths(count, cumulativeRounds.length);

        _requireValidSignature(
            aggregateClaimDigest(winner, keccak256(abi.encode(bucketIds)), keccak256(abi.encode(cumulativeRounds))),
            signature
        );

        uint256[] memory settledRounds = new uint256[](count);
        uint256 roundCount = _settleAggregateBuckets(winner, bucketIds, cumulativeRounds, settledRounds);
        if (roundCount == 0) revert NothingClaimable(winner);

        uint256 reward = _consumeRewardRounds(roundCount);


        senti.mint(winner, reward);

        emit AggregateClaimed(winner, roundCount, reward, bucketIds, settledRounds);
    }

    function _requireActiveAt(uint256 targetBlock) private view {
        uint256 startBlock = miningStartBlock;
        if (startBlock == 0 || targetBlock < startBlock || targetBlock > block.number) {
            revert MiningInactive(targetBlock);
        }
    }

    function _requireValidSignature(bytes32 digest, bytes calldata signature) private view {
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != signer) revert InvalidSignature(recovered);
    }

    function _requireBucketId(uint256 bucketId) private view {
        uint256 currentBucket = currentBucketId();
        if (bucketId > currentBucket) revert InvalidBucketId(bucketId, currentBucket);
    }

    function _requireBucketClaimable(uint256 bucketId) private view {
        if (_bucketExpired(bucketId)) revert ClaimExpired(bucketId, block.timestamp);
    }

    function _bucketExpired(uint256 bucketId) private view returns (bool) {
        uint256 expiresAt = (bucketId + 1) * CLAIM_BUCKET_SECONDS + CLAIM_EXPIRY_SECONDS;
        return block.timestamp > expiresAt;
    }

    function _settleAggregateBuckets(
        address winner,
        uint256[] calldata bucketIds,
        uint256[] calldata cumulativeRounds,
        uint256[] memory settledRounds
    ) private returns (uint256 totalRounds) {
        uint256 currentBucket = currentBucketId();

        for (uint256 i = 0; i < bucketIds.length; ++i) {
            uint256 bucketId = bucketIds[i];
            if (bucketId > currentBucket) revert InvalidBucketId(bucketId, currentBucket);
            if (i > 0 && bucketId <= bucketIds[i - 1]) revert InvalidBucketOrder(bucketIds[i - 1], bucketId);
            if (_bucketExpired(bucketId)) continue;

            uint256 claimedRounds = claimedBucketRounds[winner][bucketId];
            uint256 cumulative = cumulativeRounds[i];
            if (cumulative < claimedRounds) {
                revert InvalidCumulativeRounds(winner, bucketId, claimedRounds, cumulative);
            }

            uint256 delta = cumulative - claimedRounds;
            if (delta == 0) continue;

            claimedBucketRounds[winner][bucketId] = cumulative;
            settledRounds[i] = delta;
            totalRounds += delta;
        }
    }

    function _consumeRewardRounds(uint256 roundCount) private returns (uint256 reward) {
        if (roundCount == 0) revert InvalidRoundCount(roundCount);

        uint256 remainingRounds = MAX_REWARD_ROUNDS - rewardedRounds;
        if (roundCount > remainingRounds) revert InvalidRoundCount(roundCount);

        uint256 remainingSupply = MINEABLE_SUPPLY - mined;
        reward = roundCount == remainingRounds ? remainingSupply : BLOCK_REWARD * roundCount;

        uint256 requestedMined = mined + reward;
        if (requestedMined > MINEABLE_SUPPLY) revert MineableSupplyExceeded(requestedMined, MINEABLE_SUPPLY);

        mined = requestedMined;
        rewardedRounds += roundCount;
    }
}
import { parseAbi } from 'viem'

export const PATROL_MINER_ABI = parseAbi([
  'function PHASE_ONE_SUPPLY() view returns (uint256)',
  'function INITIAL_LIQUIDITY_SUPPLY() view returns (uint256)',
  'function MINEABLE_SUPPLY() view returns (uint256)',
  'function LIQUIDITY_MANAGER_RESERVE_SUPPLY() view returns (uint256)',
  'function MAX_AI_AGENT_RESERVED_SUPPLY() view returns (uint256)',
  'function aiAgentReservedSupply() view returns (uint256)',
  'function BLOCK_REWARD() view returns (uint256)',
  'function MAX_REWARD_ROUNDS() view returns (uint256)',
  'function admin() view returns (address)',
  'function signer() view returns (address)',
  'function senti() view returns (address)',
  'function miningStartBlock() view returns (uint256)',
  'function mined() view returns (uint256)',
  'function rewardedRounds() view returns (uint256)',
  'function remainingRewardRounds() view returns (uint256)',
  'function remainingMineableSupply() view returns (uint256)',
  'function currentBucketId() view returns (uint256)',
  'function claimedBucketRounds(address winner, uint256 bucketId) view returns (uint256)',
  'function initialLiquidityMinted() view returns (bool)',
  'function aiAgentMinter() view returns (address)',
  'function aiAgentMinted() view returns (uint256)',
  'function miningActive() view returns (bool)',
  'function startMining()',
  'function setAiAgentMinter(address newAiAgentMinter)',
  'function burnUnmintedAiAgentSupply(uint256 amount)',
  'function claim(uint256 blockNumber, uint256 bucketId, bytes32 blockHash, address winner, uint256 winnerPower, bytes signature)',
  'function batchClaim((uint256 blockNumber, uint256 bucketId, bytes32 blockHash, address winner, uint256 winnerPower, bytes signature)[] claims)',
  'function aggregateClaim(address winner, uint256[] bucketIds, uint256[] cumulativeRounds, bytes signature)',
  'function claimed(uint256 blockNumber) view returns (bool)',
  'event Claimed(uint256 indexed blockNumber, address indexed winner, uint256 reward, uint256 winnerPower, uint256 bucketId)',
  'event AggregateClaimed(address indexed winner, uint256 roundCount, uint256 reward, uint256[] bucketIds, uint256[] settledRounds)',
])

export const SENTI_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function totalSupply() view returns (uint256)',
])

export const SENTI_LIQUIDITY_MANAGER_ABI = parseAbi([
  'error NotCompoundCaller(address caller)',
  'error TrackedPositionNotSet()',
  'error InvalidDeadline(uint256 deadline, uint256 maxDeadline)',
  'error CompoundThresholdNotMet(uint256 availableEth, uint256 minEthToCompound)',
  'error CompoundCooldownActive(uint256 nextCompoundAt)',
  'error InsufficientEthReserve(uint256 requested, uint256 available)',
  'error InsufficientSentiReserve(uint256 requested, uint256 available)',
  'error MaxEthSpendExceeded(uint256 requested, uint256 maxAllowed)',
  'error MaxSentiSpendExceeded(uint256 requested, uint256 maxAllowed)',
  'error NativeSpendRequired()',
  'error SentiSpendRequired()',
  'error PoolKeyMismatch()',
  'error PositionOwnerMismatch(uint256 tokenId, address owner)',
  'function senti() view returns (address)',
  'function positionManager() view returns (address)',
  'function permit2() view returns (address)',
  'function adminSafe() view returns (address)',
  'function opsSafe() view returns (address)',
  'function poolKey() view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)',
  'function sentiIsCurrency0() view returns (bool)',
  'function trackedPositionTokenId() view returns (uint256)',
  'function minEthToCompound() view returns (uint256)',
  'function compoundCooldown() view returns (uint256)',
  'function maxEthPerCompound() view returns (uint256)',
  'function maxSentiPerCompound() view returns (uint256)',
  'function maxDeadlineWindow() view returns (uint256)',
  'function lastCompoundAt() view returns (uint256)',
  'function authorizedKeepers(address keeper) view returns (bool)',
  'function refreshPermit2Allowance()',
  'function setKeeper(address keeper, bool authorized)',
  'function setCompoundConfig(uint256 newMinEthToCompound, uint256 newCompoundCooldown, uint256 newMaxEthPerCompound, uint256 newMaxSentiPerCompound, uint256 newMaxDeadlineWindow)',
  'function setTrackedPositionTokenId(uint256 tokenId)',
  'function burnReserveSenti(uint256 amount)',
  'function compoundLiquidity(uint256 liquidityIncrease, uint128 amount0Max, uint128 amount1Max, uint256 deadline)',
])

export const UNISWAP_POSITION_MANAGER_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
])

export const POOL_MANAGER_EXTSLOAD_ABI = parseAbi([
  'function extsload(bytes32 slot) view returns (bytes32)',
])

export const V4_QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
])

export const POOL_SWAP_TEST_ABI = parseAbi([
  'function swap((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, (bool takeClaims, bool settleUsingBurn) testSettings, bytes hookData) payable returns (int256 delta)',
])

export const TRAIT_REGISTRY_ABI = parseAbi([
  'function finalized() view returns (bool)',
  'function traitsSourceHash() view returns (bytes32)',
  'function powerConfigHash() view returns (bytes32)',
  'function synergyRulesHash() view returns (bytes32)',
  'function rulesCommitment() view returns (bytes32)',
  'function collectionCap() view returns (uint256)',
  'function expectedLayerCount() view returns (uint16)',
  'function expectedTraitCount() view returns (uint16)',
  'function expectedSynergyCount() view returns (uint16)',
  'function configuredLayerCount() view returns (uint16)',
  'function configuredTraitCount() view returns (uint16)',
  'function configuredSynergyCount() view returns (uint16)',
  'function layerWeightBps(string layerId) view returns (uint32)',
  'function traitValue(string layerId, string traitId) view returns (uint32)',
  'function synergyMultiplierBps(string synergyId) view returns (uint32)',
])
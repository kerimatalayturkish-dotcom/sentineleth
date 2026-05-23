import { NextResponse } from "next/server"
import { concatHex, createPublicClient, encodeAbiParameters, formatEther, http, keccak256, toHex, type PublicClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { requireAdmin } from "@/lib/auth"
import { getOptionalServerEnv } from "@/lib/env"
import { getOptionalMiningServerConfig } from "@/lib/mining-server-config"
import { miningChain, miningPublicConfig } from "@/lib/mining-config"
import {
  PATROL_MINER_ABI,
  POOL_MANAGER_EXTSLOAD_ABI,
  SENTI_ABI,
  SENTI_LIQUIDITY_MANAGER_ABI,
  UNISWAP_POSITION_MANAGER_ABI,
} from "@/lib/mining-contracts"
import {
  ethChain,
  NFT_CONTRACT_ADDRESS,
  MINT_PRICE_DISPLAY,
  MINT_PRICE_CURRENCY,
  MAX_PER_WALLET,
  PUBLIC_CAP,
  AIRDROP_CAP,
  MAX_SUPPLY,
} from "@/lib/chain"
import { SENTINEL_ABI } from "@/lib/contract"
import { serverHttp } from "@/lib/server-rpc"

const publicClient = createPublicClient({
  chain: ethChain,
  transport: serverHttp(),
})

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
const MASK_24 = (1n << 24n) - 1n
const MASK_160 = (1n << 160n) - 1n
const Q96 = 1n << 96n
const POOLS_SLOT = toHex(6n, { size: 32 })

function decodeSigned24(value: bigint): number {
  const signBit = 1n << 23n
  const full = 1n << 24n
  const signed = (value & signBit) !== 0n ? value - full : value
  return Number(signed)
}

function getSqrtPriceAtTick(tick: number): bigint {
  const absTick = BigInt(tick < 0 ? -tick : tick)
  if (absTick > 887272n) {
    throw new Error(`tick out of range: ${tick}`)
  }

  let price = (absTick & 0x1n) !== 0n
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n

  if ((absTick & 0x2n) !== 0n) price = (price * 0xfff97272373d413259a46990580e213an) >> 128n
  if ((absTick & 0x4n) !== 0n) price = (price * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n
  if ((absTick & 0x8n) !== 0n) price = (price * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n
  if ((absTick & 0x10n) !== 0n) price = (price * 0xffcb9843d60f6159c9db58835c926644n) >> 128n
  if ((absTick & 0x20n) !== 0n) price = (price * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n
  if ((absTick & 0x40n) !== 0n) price = (price * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n
  if ((absTick & 0x80n) !== 0n) price = (price * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n
  if ((absTick & 0x100n) !== 0n) price = (price * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n
  if ((absTick & 0x200n) !== 0n) price = (price * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n
  if ((absTick & 0x400n) !== 0n) price = (price * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n
  if ((absTick & 0x800n) !== 0n) price = (price * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n
  if ((absTick & 0x1000n) !== 0n) price = (price * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n
  if ((absTick & 0x2000n) !== 0n) price = (price * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n
  if ((absTick & 0x4000n) !== 0n) price = (price * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n
  if ((absTick & 0x8000n) !== 0n) price = (price * 0x31be135f97d08fd981231505542fcfa6n) >> 128n
  if ((absTick & 0x10000n) !== 0n) price = (price * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n
  if ((absTick & 0x20000n) !== 0n) price = (price * 0x5d6af8dedb81196699c329225ee604n) >> 128n
  if ((absTick & 0x40000n) !== 0n) price = (price * 0x2216e584f5fa1ea926041bedfe98n) >> 128n
  if ((absTick & 0x80000n) !== 0n) price = (price * 0x48a170391f7dc42444e8fa2n) >> 128n

  if (tick > 0) {
    price = ((1n << 256n) - 1n) / price
  }

  return (price + ((1n << 32n) - 1n)) >> 32n
}

function getAmount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const lower = sqrtA < sqrtB ? sqrtA : sqrtB
  const upper = sqrtA < sqrtB ? sqrtB : sqrtA
  return ((((liquidity << 96n) * (upper - lower)) / upper) / lower)
}

function getAmount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const diff = sqrtA > sqrtB ? sqrtA - sqrtB : sqrtB - sqrtA
  return (liquidity * diff) / Q96
}

async function readTrackedPositionComposition({
  miningClient,
  poolManager,
  positionManager,
  trackedPositionTokenId,
  sentiIsCurrency0,
}: {
  miningClient: PublicClient
  poolManager?: `0x${string}`
  positionManager: `0x${string}`
  trackedPositionTokenId: bigint
  sentiIsCurrency0: boolean
}) {
  const [owner, liquidity, poolAndPositionInfo] = await Promise.all([
    miningClient.readContract({
      address: positionManager,
      abi: UNISWAP_POSITION_MANAGER_ABI,
      functionName: "ownerOf",
      args: [trackedPositionTokenId],
    }),
    miningClient.readContract({
      address: positionManager,
      abi: UNISWAP_POSITION_MANAGER_ABI,
      functionName: "getPositionLiquidity",
      args: [trackedPositionTokenId],
    }),
    miningClient.readContract({
      address: positionManager,
      abi: UNISWAP_POSITION_MANAGER_ABI,
      functionName: "getPoolAndPositionInfo",
      args: [trackedPositionTokenId],
    }),
  ])

  const positionPoolKey = poolAndPositionInfo[0]
  const positionInfo = poolAndPositionInfo[1]
  const tickLower = decodeSigned24((positionInfo >> 8n) & MASK_24)
  const tickUpper = decodeSigned24((positionInfo >> 32n) & MASK_24)

  let currentTick: number | null = null
  let ethBalance: string | null = null
  let sentiBalance: string | null = null

  if (poolManager) {
    const poolId = keccak256(
      encodeAbiParameters(
        [
          { type: "address", name: "currency0" },
          { type: "address", name: "currency1" },
          { type: "uint24", name: "fee" },
          { type: "int24", name: "tickSpacing" },
          { type: "address", name: "hooks" },
        ],
        [
          positionPoolKey.currency0,
          positionPoolKey.currency1,
          positionPoolKey.fee,
          positionPoolKey.tickSpacing,
          positionPoolKey.hooks,
        ],
      ),
    )

    const poolStateSlot = keccak256(concatHex([poolId, POOLS_SLOT]))
    const slot0WordHex = await miningClient.readContract({
      address: poolManager,
      abi: POOL_MANAGER_EXTSLOAD_ABI,
      functionName: "extsload",
      args: [poolStateSlot],
    })
    const slot0Word = BigInt(slot0WordHex)

    if (slot0Word !== 0n) {
      const currentSqrtPriceX96 = slot0Word & MASK_160
      currentTick = decodeSigned24((slot0Word >> 160n) & MASK_24)
      const sqrtLower = getSqrtPriceAtTick(tickLower)
      const sqrtUpper = getSqrtPriceAtTick(tickUpper)

      let amount0Wei = 0n
      let amount1Wei = 0n
      if (currentSqrtPriceX96 <= sqrtLower) {
        amount0Wei = getAmount0Delta(sqrtLower, sqrtUpper, liquidity)
      } else if (currentSqrtPriceX96 < sqrtUpper) {
        amount0Wei = getAmount0Delta(currentSqrtPriceX96, sqrtUpper, liquidity)
        amount1Wei = getAmount1Delta(sqrtLower, currentSqrtPriceX96, liquidity)
      } else {
        amount1Wei = getAmount1Delta(sqrtLower, sqrtUpper, liquidity)
      }

      const ethWei = sentiIsCurrency0 ? amount1Wei : amount0Wei
      const sentiWei = sentiIsCurrency0 ? amount0Wei : amount1Wei
      ethBalance = formatEther(ethWei)
      sentiBalance = formatEther(sentiWei)
    }
  }

  return {
    owner,
    liquidity: liquidity.toString(),
    tickLower,
    tickUpper,
    currentTick,
    ethBalance,
    sentiBalance,
  }
}

async function readMiningStatus() {
  const config = getOptionalMiningServerConfig()
  const patrolMiner = config.miningChain.contracts.patrolMiner
  const base = {
    configured: Boolean(patrolMiner),
    chainId: miningPublicConfig.miningChain.chainId,
    chainName: miningPublicConfig.miningChain.name,
    explorerUrl: miningPublicConfig.miningChain.explorerUrl,
    contract: null,
  }

  if (!patrolMiner) {
    return {
      ...base,
      error: "NEXT_PUBLIC_PATROL_MINER_ADDRESS not set",
    }
  }

  if (!config.miningChain.rpcUrl) {
    return {
      ...base,
      error: "MINING_RPC_URL not set",
    }
  }

  let adminSigner: `0x${string}` | null = null
  if (config.miningChain.authority.adminPrivateKey) {
    try {
      adminSigner = privateKeyToAccount(config.miningChain.authority.adminPrivateKey).address
    } catch {
      return {
        ...base,
        error: "MINING_ADMIN_PRIVATE_KEY is invalid",
      }
    }
  }

  const miningClient = createPublicClient({
    chain: miningChain,
    transport: http(config.miningChain.rpcUrl),
  })

  try {
    const [
      admin,
      signer,
      senti,
      miningStartBlock,
      mined,
      rewardedRounds,
      remainingRewardRounds,
      remainingMineableSupply,
      phaseOneSupply,
      initialLiquiditySupply,
      mineableSupply,
      liquidityManagerReserveSupply,
      maxAiAgentReservedSupply,
      aiAgentReservedSupply,
      initialLiquidityMinted,
      aiAgentMinter,
      aiAgentMinted,
      maxRewardRounds,
      blockReward,
      currentBlock,
      active,
    ] = await Promise.all([
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "admin" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "signer" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "senti" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "miningStartBlock" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "mined" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "rewardedRounds" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "remainingRewardRounds" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "remainingMineableSupply" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "PHASE_ONE_SUPPLY" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "INITIAL_LIQUIDITY_SUPPLY" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "MINEABLE_SUPPLY" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "LIQUIDITY_MANAGER_RESERVE_SUPPLY" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "MAX_AI_AGENT_RESERVED_SUPPLY" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "aiAgentReservedSupply" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "initialLiquidityMinted" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "aiAgentMinter" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "aiAgentMinted" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "MAX_REWARD_ROUNDS" }),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "BLOCK_REWARD" }),
      miningClient.getBlockNumber(),
      miningClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "miningActive" }),
    ])

    return {
      ...base,
      error: null,
      contract: {
        address: patrolMiner,
        admin,
        adminSigner,
        adminSignerConfigured: adminSigner !== null,
        adminSignerIsAdmin: adminSigner !== null && admin.toLowerCase() === adminSigner.toLowerCase(),
        signer,
        senti,
        currentBlock: Number(currentBlock),
        startBlock: miningStartBlock === 0n ? null : Number(miningStartBlock),
        started: miningStartBlock !== 0n,
        active,
        maxRewardRounds: Number(maxRewardRounds),
        rewardedRounds: Number(rewardedRounds),
        remainingRewardRounds: Number(remainingRewardRounds),
        mined: formatEther(mined),
        remainingMineableSupply: formatEther(remainingMineableSupply),
        phaseOneSupply: formatEther(phaseOneSupply),
        initialLiquiditySupply: formatEther(initialLiquiditySupply),
        initialLiquidityMinted,
        mineableSupply: formatEther(mineableSupply),
        liquidityManagerReserveSupply: formatEther(liquidityManagerReserveSupply),
        maxAiAgentReservedSupply: formatEther(maxAiAgentReservedSupply),
        aiAgentReservedSupply: formatEther(aiAgentReservedSupply),
        aiAgentMinter,
        aiAgentMinterSet: aiAgentMinter !== ZERO_ADDRESS,
        aiAgentMinted: formatEther(aiAgentMinted),
        aiAgentRemainingSupply: formatEther(aiAgentReservedSupply - aiAgentMinted),
        blockReward: formatEther(blockReward),
      },
    }
  } catch (err) {
    console.error("Admin mining status failed:", err)
    const message = err instanceof Error ? err.message.split("\n")[0] : "Failed to fetch mining status"
    return {
      ...base,
      error: message,
    }
  }
}

async function readTokenTreasuryStatus() {
  const config = getOptionalMiningServerConfig()
  const liquidityManager = config.miningChain.contracts.liquidityManager
  const patrolMiner = config.miningChain.contracts.patrolMiner
  const poolManager = miningPublicConfig.miningChain.uniswap.v4PoolManager
  const base = {
    configured: Boolean(liquidityManager),
    chainId: miningPublicConfig.miningChain.chainId,
    chainName: miningPublicConfig.miningChain.name,
    explorerUrl: miningPublicConfig.miningChain.explorerUrl,
    contract: null,
  }

  if (!liquidityManager) {
    return {
      ...base,
      error: "NEXT_PUBLIC_SENTI_LIQUIDITY_MANAGER_ADDRESS not set",
    }
  }

  if (!config.miningChain.rpcUrl) {
    return {
      ...base,
      error: "MINING_RPC_URL not set",
    }
  }

  let adminSigner: `0x${string}` | null = null
  if (config.miningChain.authority.adminPrivateKey) {
    try {
      adminSigner = privateKeyToAccount(config.miningChain.authority.adminPrivateKey).address
    } catch {
      return {
        ...base,
        error: "MINING_ADMIN_PRIVATE_KEY is invalid",
      }
    }
  }

  const miningClient = createPublicClient({
    chain: miningChain,
    transport: http(config.miningChain.rpcUrl),
  })

  try {
    const [
      senti,
      positionManager,
      permit2,
      adminSafe,
      opsSafe,
      trackedPositionTokenId,
      minEthToCompound,
      compoundCooldown,
      maxEthPerCompound,
      maxSentiPerCompound,
      maxDeadlineWindow,
      lastCompoundAt,
      sentiIsCurrency0,
      poolKey,
      managerEthBalance,
      adminSignerAuthorizedKeeper,
      reserveTarget,
    ] = await Promise.all([
      miningClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "senti" }),
      miningClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "positionManager" }),
      miningClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "permit2" }),
      miningClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "adminSafe" }),
      miningClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "opsSafe" }),
      miningClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "trackedPositionTokenId" }),
      miningClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "minEthToCompound" }),
      miningClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "compoundCooldown" }),
      miningClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "maxEthPerCompound" }),
      miningClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "maxSentiPerCompound" }),
      miningClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "maxDeadlineWindow" }),
      miningClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "lastCompoundAt" }),
      miningClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "sentiIsCurrency0" }),
      miningClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "poolKey" }),
      miningClient.getBalance({ address: liquidityManager }),
      adminSigner
        ? miningClient.readContract({
            address: liquidityManager,
            abi: SENTI_LIQUIDITY_MANAGER_ABI,
            functionName: "authorizedKeepers",
            args: [adminSigner],
          })
        : Promise.resolve(false),
      patrolMiner
        ? miningClient.readContract({
            address: patrolMiner,
            abi: PATROL_MINER_ABI,
            functionName: "LIQUIDITY_MANAGER_RESERVE_SUPPLY",
          })
        : Promise.resolve(null),
    ])

    const managerSentiBalance = await miningClient.readContract({
      address: senti,
      abi: SENTI_ABI,
      functionName: "balanceOf",
      args: [liquidityManager],
    })

    const [currency0, currency1, fee, tickSpacing, hooks] = poolKey
    const poolId = keccak256(
      encodeAbiParameters(
        [
          { type: "address", name: "currency0" },
          { type: "address", name: "currency1" },
          { type: "uint24", name: "fee" },
          { type: "int24", name: "tickSpacing" },
          { type: "address", name: "hooks" },
        ],
        [currency0, currency1, fee, tickSpacing, hooks],
      ),
    )
    let trackedPositionOwner: `0x${string}` | null = null
    let trackedPositionLiquidity: string | null = null
    let trackedPositionTickLower: number | null = null
    let trackedPositionTickUpper: number | null = null
    let trackedPositionCurrentTick: number | null = null
    let trackedPositionEthBalance: string | null = null
    let trackedPositionSentiBalance: string | null = null
    if (trackedPositionTokenId !== 0n) {
      try {
        const trackedPosition = await readTrackedPositionComposition({
          miningClient,
          poolManager,
          positionManager,
          trackedPositionTokenId,
          sentiIsCurrency0,
        })
        trackedPositionOwner = trackedPosition.owner
        trackedPositionLiquidity = trackedPosition.liquidity
        trackedPositionTickLower = trackedPosition.tickLower
        trackedPositionTickUpper = trackedPosition.tickUpper
        trackedPositionCurrentTick = trackedPosition.currentTick
        trackedPositionEthBalance = trackedPosition.ethBalance
        trackedPositionSentiBalance = trackedPosition.sentiBalance
      } catch (error) {
        console.error("Admin tracked position composition failed:", error)
      }
    }

    return {
      ...base,
      error: null,
      contract: {
        address: liquidityManager,
        senti,
        positionManager,
        permit2,
        adminSafe,
        opsSafe,
        adminSigner,
        adminSignerConfigured: adminSigner !== null,
        adminSignerIsAdminSafe: adminSigner !== null && adminSigner.toLowerCase() === adminSafe.toLowerCase(),
        adminSignerIsOpsSafe: adminSigner !== null && adminSigner.toLowerCase() === opsSafe.toLowerCase(),
        adminSignerAuthorizedKeeper: Boolean(adminSignerAuthorizedKeeper),
        adminSignerCanCompound: adminSigner !== null && (
          adminSigner.toLowerCase() === adminSafe.toLowerCase()
            || adminSigner.toLowerCase() === opsSafe.toLowerCase()
            || Boolean(adminSignerAuthorizedKeeper)
        ),
        reserveTarget: reserveTarget === null ? null : formatEther(reserveTarget),
        reserveEthBalance: formatEther(managerEthBalance),
        reserveSentiBalance: formatEther(managerSentiBalance),
        sentiIsCurrency0,
        poolKey: {
          currency0,
          currency1,
          fee: Number(fee),
          tickSpacing: Number(tickSpacing),
          hooks,
        },
        poolId,
        trackedPositionTokenId: trackedPositionTokenId.toString(),
        trackedPositionSet: trackedPositionTokenId !== 0n,
        trackedPositionOwner,
        trackedPositionLiquidity,
        trackedPositionTickLower,
        trackedPositionTickUpper,
        trackedPositionCurrentTick,
        trackedPositionEthBalance,
        trackedPositionSentiBalance,
        minEthToCompound: formatEther(minEthToCompound),
        compoundCooldown: Number(compoundCooldown),
        maxEthPerCompound: formatEther(maxEthPerCompound),
        maxSentiPerCompound: formatEther(maxSentiPerCompound),
        maxDeadlineWindow: Number(maxDeadlineWindow),
        lastCompoundAt: Number(lastCompoundAt),
      },
    }
  } catch (err) {
    console.error("Admin token treasury status failed:", err)
    const message = err instanceof Error ? err.message.split("\n")[0] : "Failed to fetch token treasury status"
    return {
      ...base,
      error: message,
    }
  }
}

export async function GET() {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const env = getOptionalServerEnv()
    const serverAddress = env.serverPrivateKey
      ? privateKeyToAccount(env.serverPrivateKey).address
      : null
    const ownerSigner = env.ownerPrivateKey
      ? privateKeyToAccount(env.ownerPrivateKey).address
      : null

    const [
      statusResult,
      treasury,
      airdropRoot,
      onChainMinter,
      onChainOwner,
      mining,
      token,
    ] = await Promise.all([
      publicClient.readContract({ address: NFT_CONTRACT_ADDRESS, abi: SENTINEL_ABI, functionName: "status" }),
      publicClient.readContract({ address: NFT_CONTRACT_ADDRESS, abi: SENTINEL_ABI, functionName: "treasury" }),
      publicClient.readContract({ address: NFT_CONTRACT_ADDRESS, abi: SENTINEL_ABI, functionName: "airdropRoot" }),
      publicClient.readContract({ address: NFT_CONTRACT_ADDRESS, abi: SENTINEL_ABI, functionName: "minter" }),
      publicClient.readContract({ address: NFT_CONTRACT_ADDRESS, abi: SENTINEL_ABI, functionName: "owner" }),
      readMiningStatus(),
      readTokenTreasuryStatus(),
    ])

    const serverHasUriSetter = serverAddress !== null
      && (onChainMinter as string).toLowerCase() === serverAddress.toLowerCase()
    const ownerHasAdmin = ownerSigner !== null
      && (onChainOwner as string).toLowerCase() === ownerSigner.toLowerCase()

    const [
      totalSupply,
      publicMinted,
      airdropMinted,
      publicRemaining,
      airdropRemaining,
      mintPriceWei,
      publicClosed,
      airdropClosed,
      paused,
    ] = statusResult as readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean]

    // Native ETH balances (best-effort).
    const [treasuryEth, serverEth, contractEth] = await Promise.all([
      publicClient.getBalance({ address: treasury as `0x${string}` }).catch(() => null),
      serverAddress
        ? publicClient.getBalance({ address: serverAddress }).catch(() => null)
        : Promise.resolve(null),
      publicClient.getBalance({ address: NFT_CONTRACT_ADDRESS }).catch(() => null),
    ])

    return NextResponse.json({
      contract: {
        address: NFT_CONTRACT_ADDRESS,
        treasury,
        watcher: serverAddress,
        watcherHasUriSetterRole: Boolean(serverHasUriSetter),
        ownerSigner,
        ownerHasAdminRole: Boolean(ownerHasAdmin),
        ownerConfigured: ownerSigner !== null,
        airdropRoot,
        airdropRootSet: airdropRoot !== "0x0000000000000000000000000000000000000000000000000000000000000000",
        publicClosed,
        airdropClosed,
        paused,
      },
      constants: {
        maxSupply: MAX_SUPPLY,
        publicCap: PUBLIC_CAP,
        airdropCap: AIRDROP_CAP,
        mintPrice: MINT_PRICE_DISPLAY,
        mintPriceWei: mintPriceWei.toString(),
        currency: MINT_PRICE_CURRENCY,
        maxPerWallet: MAX_PER_WALLET,
      },
      supply: {
        total: Number(totalSupply),
        max: MAX_SUPPLY,
        publicMinted: Number(publicMinted),
        publicCap: PUBLIC_CAP,
        publicRemaining: Number(publicRemaining),
        airdropMinted: Number(airdropMinted),
        airdropCap: AIRDROP_CAP,
        airdropRemaining: Number(airdropRemaining),
        remaining: MAX_SUPPLY - Number(totalSupply),
      },
      balances: {
        treasuryEth: treasuryEth !== null ? formatEther(treasuryEth) : null,
        serverEth: serverEth !== null ? formatEther(serverEth) : null,
        contractEth: contractEth !== null ? formatEther(contractEth) : null,
      },
      timing: {
        now: Math.floor(Date.now() / 1000),
      },
      mining,
      token,
    })
  } catch (err) {
    console.error("Admin status failed:", err)
    return NextResponse.json(
      { error: "Failed to fetch contract status" },
      { status: 500 },
    )
  }
}

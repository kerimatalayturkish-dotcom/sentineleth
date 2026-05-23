import { concatHex, encodeAbiParameters, keccak256, toHex, type Address, type PublicClient } from "viem"
import { POOL_MANAGER_EXTSLOAD_ABI, UNISWAP_POSITION_MANAGER_ABI } from "@/lib/mining-contracts"

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

export interface TrackedPositionComposition {
  owner: Address
  liquidity: bigint
  tickLower: number
  tickUpper: number
  currentTick: number | null
  ethBalanceWei: bigint | null
  sentiBalanceWei: bigint | null
}

export async function readTrackedPositionComposition({
  miningClient,
  poolManager,
  positionManager,
  trackedPositionTokenId,
  sentiIsCurrency0,
}: {
  miningClient: PublicClient
  poolManager?: Address
  positionManager: Address
  trackedPositionTokenId: bigint
  sentiIsCurrency0: boolean
}): Promise<TrackedPositionComposition> {
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
  let ethBalanceWei: bigint | null = null
  let sentiBalanceWei: bigint | null = null

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

      ethBalanceWei = sentiIsCurrency0 ? amount1Wei : amount0Wei
      sentiBalanceWei = sentiIsCurrency0 ? amount0Wei : amount1Wei
    }
  }

  return {
    owner,
    liquidity,
    tickLower,
    tickUpper,
    currentTick,
    ethBalanceWei,
    sentiBalanceWei,
  }
}
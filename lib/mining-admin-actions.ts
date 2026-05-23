import { encodeFunctionData, formatEther, type Abi, type Address, type Hex } from "viem"
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts"
import type { MiningServerConfig } from "@/lib/mining-server-config"
import { miningPublicConfig } from "@/lib/mining-config"

export interface ManualExecutionPayload {
  to: Address
  data: Hex
  valueWei: string
  valueEth: string
  chainId: number
  chainName: string
  requiredSigners: Address[]
  note: string
}

export interface ResolvedMiningOperator {
  account: PrivateKeyAccount | null
  warning: string | null
}

export function sameAddress(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false
  return left.toLowerCase() === right.toLowerCase()
}

export function uniqueAddresses(addresses: Address[]): Address[] {
  const seen = new Set<string>()
  const unique: Address[] = []
  for (const address of addresses) {
    const normalized = address.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(address)
  }
  return unique
}

export function resolveMiningOperator(config: MiningServerConfig): ResolvedMiningOperator {
  const privateKey = config.miningChain.authority.adminPrivateKey
  if (!privateKey) {
    return {
      account: null,
      warning: null,
    }
  }

  try {
    return {
      account: privateKeyToAccount(privateKey),
      warning: null,
    }
  } catch {
    return {
      account: null,
      warning: "Configured mining operator private key is invalid; manual Safe or wallet execution is still available.",
    }
  }
}

export function buildManualExecution(params: {
  to: Address
  abi: Abi
  functionName: string
  args?: readonly unknown[]
  value?: bigint
  requiredSigners: Address[]
  note: string
}): ManualExecutionPayload {
  const value = params.value ?? 0n
  return {
    to: params.to,
    data: encodeFunctionData({
      abi: params.abi,
      functionName: params.functionName,
      args: params.args,
    }),
    valueWei: value.toString(),
    valueEth: formatEther(value),
    chainId: miningPublicConfig.miningChain.chainId,
    chainName: miningPublicConfig.miningChain.name,
    requiredSigners: uniqueAddresses(params.requiredSigners),
    note: params.note,
  }
}

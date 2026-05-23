import type { ContractRunner } from "ethers"
import { ethers } from "ethers"

export type CoreDeploymentAddresses = {
  tokenAddress: string
  managerAddress: string
  minerAddress: string
}

export type ExpectedSentiHookBindings = {
  hookAddress: string
  poolManagerAddress: string
  sentiTokenAddress: string
  feeRecipientAddress: string
  poolFee: number
  tickSpacing: number
}

export type ActualSentiHookBindings = {
  poolManagerAddress: string
  sentiTokenAddress: string
  feeRecipientAddress: string
  poolFee: bigint
  tickSpacing: bigint
}

const SENTI_HOOK_ABI = [
  "function poolManager() view returns (address)",
  "function sentiCurrency() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function expectedPoolFee() view returns (uint24)",
  "function expectedTickSpacing() view returns (int24)",
] as const

function normalizeAddress(address: string): string {
  return ethers.getAddress(address)
}

export function predictCoreDeploymentAddresses(deployerAddress: string, nextNonce: number): CoreDeploymentAddresses {
  if (!Number.isInteger(nextNonce) || nextNonce < 0) {
    throw new Error(`invalid next nonce: ${nextNonce}`)
  }

  return {
    tokenAddress: ethers.getCreateAddress({ from: deployerAddress, nonce: nextNonce }),
    managerAddress: ethers.getCreateAddress({ from: deployerAddress, nonce: nextNonce + 1 }),
    minerAddress: ethers.getCreateAddress({ from: deployerAddress, nonce: nextNonce + 2 }),
  }
}

export async function readSentiHookBindings(runner: ContractRunner, hookAddress: string): Promise<ActualSentiHookBindings> {
  const hook = new ethers.Contract(hookAddress, SENTI_HOOK_ABI, runner)
  const [poolManagerAddress, sentiTokenAddress, feeRecipientAddress, poolFee, tickSpacing] = await Promise.all([
    hook.poolManager(),
    hook.sentiCurrency(),
    hook.feeRecipient(),
    hook.expectedPoolFee(),
    hook.expectedTickSpacing(),
  ])

  return {
    poolManagerAddress: normalizeAddress(poolManagerAddress),
    sentiTokenAddress: normalizeAddress(sentiTokenAddress),
    feeRecipientAddress: normalizeAddress(feeRecipientAddress),
    poolFee: BigInt(poolFee),
    tickSpacing: BigInt(tickSpacing),
  }
}

export async function assertSentiHookBindings(
  runner: ContractRunner,
  expected: ExpectedSentiHookBindings,
): Promise<ActualSentiHookBindings> {
  const actual = await readSentiHookBindings(runner, expected.hookAddress)
  const mismatches: string[] = []

  if (actual.poolManagerAddress !== normalizeAddress(expected.poolManagerAddress)) {
    mismatches.push(`pool manager mismatch: expected ${expected.poolManagerAddress}, got ${actual.poolManagerAddress}`)
  }
  if (actual.sentiTokenAddress !== normalizeAddress(expected.sentiTokenAddress)) {
    mismatches.push(`senti token mismatch: expected ${expected.sentiTokenAddress}, got ${actual.sentiTokenAddress}`)
  }
  if (actual.feeRecipientAddress !== normalizeAddress(expected.feeRecipientAddress)) {
    mismatches.push(`fee recipient mismatch: expected ${expected.feeRecipientAddress}, got ${actual.feeRecipientAddress}`)
  }
  if (actual.poolFee !== BigInt(expected.poolFee)) {
    mismatches.push(`pool fee mismatch: expected ${expected.poolFee}, got ${actual.poolFee}`)
  }
  if (actual.tickSpacing !== BigInt(expected.tickSpacing)) {
    mismatches.push(`tick spacing mismatch: expected ${expected.tickSpacing}, got ${actual.tickSpacing}`)
  }

  if (mismatches.length > 0) {
    throw new Error(`SentiHook binding mismatch at ${expected.hookAddress}: ${mismatches.join("; ")}`)
  }

  return actual
}
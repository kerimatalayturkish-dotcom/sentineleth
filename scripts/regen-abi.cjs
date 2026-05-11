// Regenerate lib/contract.ts SENTINEL_ABI from the Hardhat artifact in NFTagent.
// Usage: node scripts/regen-abi.cjs
const fs = require("fs");
const path = require("path");

const ARTIFACT = path.resolve(
  __dirname,
  "..",
  "..",
  "NFTagent",
  "contracts",
  "artifacts",
  "contracts",
  "SentinelETH.sol",
  "SentinelETH.json"
);
const OUT = path.resolve(__dirname, "..", "lib", "contract.ts");

const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
const header = [
  "// SentinelETH (ERC-721A + Ownable + minter) - Ethereum mainnet / Sepolia.",
  "// ABI extracted from contracts/artifacts/contracts/SentinelETH.sol/SentinelETH.json",
  "// after `pnpm hardhat compile`. Regenerate with `node scripts/regen-abi.cjs`.",
  "export const SENTINEL_ABI = ",
].join("\n");
const body = JSON.stringify(artifact.abi, null, 2) + " as const\n";
fs.writeFileSync(OUT, header + body);
console.log("wrote", OUT, header.length + body.length, "bytes");

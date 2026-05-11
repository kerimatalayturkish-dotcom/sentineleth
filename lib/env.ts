function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

/**
 * Server-only env (API routes, not client components).
 *
 * Wallet roles:
 *  - OWNER_PRIVATE_KEY:  cold deployer/admin EOA — DEFAULT_ADMIN_ROLE + PAUSER_ROLE + URI_SETTER_ROLE
 *    (setTreasury, setAirdropRoot, pause/unpause, closeMint, closeAirdrop, grantRole, etc).
 *    Optional on the server; admin txs can be signed in the admin UI by an EOA wallet instead.
 *  - SERVER_PRIVATE_KEY: hot watcher EOA — granted URI_SETTER_ROLE post-deploy. Calls setTokenURIs
 *    after watching PublicMint / AirdropClaim events.
 *  - IRYS_PRIVATE_KEY:   funds Irys node only.
 *
 * Treasury is an ADDRESS ONLY — no key on server.
 */
export function getServerEnv() {
  return {
    ownerPrivateKey: process.env.OWNER_PRIVATE_KEY as `0x${string}` | undefined,
    serverPrivateKey: requireEnv('SERVER_PRIVATE_KEY') as `0x${string}`,
    irysPrivateKey: requireEnv('IRYS_PRIVATE_KEY') as `0x${string}`,

    treasuryWallet: requireEnv('NFT_TREASURY_WALLET') as `0x${string}`,

    irysRpcUrl: requireEnv('IRYS_RPC_URL'),
    irysNetwork: (process.env.IRYS_NETWORK || 'devnet') as 'devnet' | 'mainnet',

    adminUsername: requireEnv('ADMIN_USERNAME'),
    adminPassword: requireEnv('ADMIN_PASSWORD'), // plaintext, compared in constant time
    jwtSecret: requireEnv('JWT_SECRET'),
  }
}

/**
 * Optional-variant used in contexts that should NOT crash at import time
 * if an env var is missing (e.g. build-time static analysis).
 */
export function getOptionalServerEnv() {
  return {
    ownerPrivateKey: process.env.OWNER_PRIVATE_KEY as `0x${string}` | undefined,
    serverPrivateKey: process.env.SERVER_PRIVATE_KEY as `0x${string}` | undefined,
    irysPrivateKey: process.env.IRYS_PRIVATE_KEY as `0x${string}` | undefined,
    treasuryWallet: process.env.NFT_TREASURY_WALLET as `0x${string}` | undefined,
    irysRpcUrl: process.env.IRYS_RPC_URL,
    irysNetwork: (process.env.IRYS_NETWORK || 'devnet') as 'devnet' | 'mainnet',
    adminUsername: process.env.ADMIN_USERNAME,
    adminPassword: process.env.ADMIN_PASSWORD,
    jwtSecret: process.env.JWT_SECRET,
  }
}

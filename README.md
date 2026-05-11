# SentinelETH

Generative ERC-721A NFT collection on Ethereum. 1707 reserved airdrop slots for Tempo migrators + a public mint. Built on Next.js 16 (Turbopack) + viem + wagmi + RainbowKit, deployed on Render.

This repo contains:

- **Web app** (`app/`, `components/`, `lib/`) — Next 16 App Router, server-side viem client, admin dashboard, holder views.
- **Smart contracts** (`contracts/`) — `SentinelETH.sol` (ERC-721A + Merkle airdrop + paid public mint, currently `Ownable`; AccessControl rework planned in Phase B).
- **Watcher** (`scripts/run-watcher.ts`) — listens for `PublicMint` / `MintFor` events, generates traits + image via `sharp`, uploads to Irys, calls `setTokenURI`.
- **Trait engine** (`config/traits.json`, `assets/layers/`, `public/layers/`) — 7 layers × ~16 options, deterministic per token.

The MCP server (Claude / agent integration) lives in a sibling repo: [`sentineleth-mcp`](../sentineleth-mcp).

## Quick start

```powershell
# 1. install
pnpm install
cd contracts; pnpm install; cd ..

# 2. configure
Copy-Item .env.example .env.local
# edit .env.local: chain id, RPC URL, contract address, server keys, DB

# 3. dev
pnpm dev                # http://localhost:3000

# 4. checks
pnpm lint               # zero errors required
pnpm build              # Turbopack production build
cd contracts; pnpm test # 55 contract tests
```

## Environment

See `.env.example` for the full list. Highlights:

| Var | Purpose |
| --- | --- |
| `NEXT_PUBLIC_ETH_CHAIN_ID` | `11155111` (Sepolia) or `1` (Mainnet) |
| `NEXT_PUBLIC_ETH_RPC_URL` | Public RPC (HTTP), embedded in client bundle |
| `NEXT_PUBLIC_NFT_CONTRACT_ADDRESS` | Deployed contract address |
| `NEXT_PUBLIC_WC_PROJECT_ID` | WalletConnect Cloud project id |
| `MINT_RPC_URL` | Server-only private RPC for relayer/MCP hot path |
| `OWNER_PRIVATE_KEY` | `DEFAULT_ADMIN_ROLE` — deploys, grants roles. Transfer to Safe at launch. |
| `SERVER_PRIVATE_KEY` | `URI_SETTER_ROLE` — watcher hot key |
| `IRYS_PRIVATE_KEY` | Funds Irys uploads |
| `NFT_TREASURY_WALLET` | Receives mint ETH (set immutable in constructor) |
| `DATABASE_URL` | Postgres for merkle proofs, watcher cursor, retry queue |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Admin dashboard login |
| `JWT_SECRET` | Admin session JWT signing key (>= 32 chars) |
| `DISCORD_WEBHOOK_URL` | Watcher alert sink |

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | Next 16 dev server (Turbopack) |
| `pnpm build` | Production build |
| `pnpm start` | Serve the production build |
| `pnpm lint` | ESLint (Next + React 19 rules) |
| `pnpm generate-merkle` | Build the airdrop Merkle tree from `config/airdrop.json` |
| `pnpm watcher` | Run the mint-event watcher |

Lower-level scripts in `scripts/`:

- `build-whitelist.ts` — assemble whitelist input from on-chain Tempo holders
- `generate-merkle.ts` / `verify-merkle.ts` — Merkle tree build + proof verification
- `generate-placeholders.ts` — sharp-based PNG layer placeholders
- `check-irys.ts` / `fund-irys.ts` / `test-irys-upload.ts` — Irys ops
- `hash-password.ts` — generate `ADMIN_PASSWORD` hash
- `run-watcher.ts` — long-running mint watcher
- `migrate-render.sql`, `schema.sql` — DB schema bootstrap

## Architecture

```
Browser ──► Next 16 app (RainbowKit + wagmi)
              │
              ├─► /api/nft/*       (server reads via viem, public RPC)
              ├─► /api/admin/*     (JWT-gated, server keys)
              └─► /api/skill/train (gated by NFT ownership, Markdown payload)

On-chain SentinelETH.sol
   ▲ publicMint / mintFor / claim
   │
Watcher (scripts/run-watcher.ts)
   │  Postgres cursor + retry queue
   │  generates trait JSON + composite PNG (sharp)
   │  uploads to Irys
   └─ calls setTokenURI(tokenId, uri) with SERVER_PRIVATE_KEY
```

## Security

Phase C (pre-mainnet) work — non-negotiable before deploy:

- AccessControl rework (`DEFAULT_ADMIN_ROLE`, `URI_SETTER_ROLE`, `PAUSER_ROLE`)
- Slither + manual review pass on `SentinelETH.sol`
- Watcher hardening (Postgres-backed cursor, exponential backoff, retry queue)
- MCP rate limiting
- Irys mainnet switch
- Admin dashboard rebuild
- 24h soak test on Sepolia v2

See `NFT-LAUNCHPAD-PLAN.md` for the full Phase 0–H plan.

## Contracts

`contracts/SentinelETH.sol`:

- ERC-721A (cheap batch mints)
- 1707 airdrop cap + `MAX_BATCH_SIZE` per call
- Merkle proof per `(claimer, id)` pair
- One-shot `setTokenURI` (URI cannot be overwritten)
- Pause + `closeMint` (terminal)
- `withdraw` to immutable treasury
- Constants: `AIRDROP_CAP=1707`, `MAX_PER_WALLET`, `MINT_PRICE`

Test suite: 55 passing (`cd contracts && pnpm test`).

## Deployment

Render (planned):

- `web` service: `pnpm build && pnpm start`
- `worker` service: `pnpm watcher`
- Postgres add-on for merkle + watcher state

DNS / Safe / mainnet-deploy steps are in `NFT-LAUNCHPAD-PLAN.md` (Phases A, D, E, F, G, H).

## License

UNLICENSED — internal project.

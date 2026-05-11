-- SentinelTEMPO — Postgres schema for Merkle proofs + refund queue
-- Run: psql -h localhost -U postgres -d sentinel_tempo -f scripts/schema.sql

CREATE TABLE IF NOT EXISTS merkle_proofs (
    address    TEXT PRIMARY KEY,
    proof      JSONB NOT NULL,
    root       TEXT  NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS merkle_proofs_root_idx ON merkle_proofs(root);

CREATE TABLE IF NOT EXISTS merkle_meta (
    id           INT  PRIMARY KEY DEFAULT 1,
    root         TEXT NOT NULL,
    leaf_count   INT  NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL,
    CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS refund_queue (
    id         SERIAL PRIMARY KEY,
    agent      TEXT   NOT NULL,
    amount     NUMERIC NOT NULL,
    mpp_tx     TEXT,
    reason     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled    BOOL   NOT NULL DEFAULT false,
    settled_at TIMESTAMPTZ,
    settled_tx TEXT
);

CREATE INDEX IF NOT EXISTS refund_queue_unsettled_idx ON refund_queue(settled, created_at) WHERE settled = false;

-- Off-chain mint receipts. The on-chain tokenURI is immutable and pinned to
-- Irys before the mint tx exists, so the canonical metadata cannot embed the
-- mint tx hash. This table joins (tokenId → txHash + block + recipient) at
-- read time so collection / detail pages can display the source tx without a
-- contract upgrade.
CREATE TABLE IF NOT EXISTS mint_receipts (
    token_id    INTEGER PRIMARY KEY,
    tx_hash     TEXT NOT NULL,
    block_number BIGINT NOT NULL,
    recipient   TEXT NOT NULL,
    minted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mint_receipts_recipient_idx ON mint_receipts(recipient);
CREATE INDEX IF NOT EXISTS mint_receipts_tx_hash_idx ON mint_receipts(tx_hash);

-- Additive enrichment columns added 2026-04-22 so the admin wallet-lookup
-- endpoint can show the actual treasury-receive tx (which is the SAME tx as
-- the mint for human paths, but a SEPARATE MPP charge tx for agent paths)
-- and the fee payer address for agent mints. Backfilled rows leave these
-- NULL; new mints populate them.
ALTER TABLE mint_receipts ADD COLUMN IF NOT EXISTS mpp_tx     TEXT;
ALTER TABLE mint_receipts ADD COLUMN IF NOT EXISTS fee_payer  TEXT;
ALTER TABLE mint_receipts ADD COLUMN IF NOT EXISTS kind       TEXT;
-- kind ∈ {'wl_human','public_human','wl_agent','agent_public'} or NULL for legacy rows.

-- Persistent backing store for the mppx charge replay-protection layer.
-- mppx writes one row per consumed credential hash (key shape:
-- "mppx:charge:<txhash>") so the same charge cannot be replayed across
-- server restarts or instances. Schema mirrors mppx's Store interface:
-- get(key) → value | null, put(key, value), delete(key).
CREATE TABLE IF NOT EXISTS mpp_store (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mpp_store_created_at_idx ON mpp_store(created_at);

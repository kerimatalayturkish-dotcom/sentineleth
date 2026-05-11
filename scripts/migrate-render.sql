-- Migration: bring Render Postgres up to parity with local schema.
-- Render currently has only quest_challenges + quest_entries.
-- Adds the 5 tables required by the NFT mint flow.
-- All statements are idempotent (IF NOT EXISTS).

-- ─── merkle_meta ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.merkle_meta (
    id integer DEFAULT 1 NOT NULL,
    root text NOT NULL,
    leaf_count integer NOT NULL,
    generated_at timestamp with time zone NOT NULL,
    CONSTRAINT merkle_meta_id_check CHECK ((id = 1)),
    CONSTRAINT merkle_meta_pkey PRIMARY KEY (id)
);

-- ─── merkle_proofs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.merkle_proofs (
    address text NOT NULL,
    proof jsonb NOT NULL,
    root text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT merkle_proofs_pkey PRIMARY KEY (address)
);
CREATE INDEX IF NOT EXISTS merkle_proofs_root_idx ON public.merkle_proofs USING btree (root);

-- ─── mint_receipts ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mint_receipts (
    token_id integer NOT NULL,
    tx_hash text NOT NULL,
    block_number bigint NOT NULL,
    recipient text NOT NULL,
    minted_at timestamp with time zone DEFAULT now() NOT NULL,
    mpp_tx text,
    fee_payer text,
    kind text,
    CONSTRAINT mint_receipts_pkey PRIMARY KEY (token_id)
);
CREATE INDEX IF NOT EXISTS mint_receipts_recipient_idx ON public.mint_receipts USING btree (recipient);
CREATE INDEX IF NOT EXISTS mint_receipts_tx_hash_idx ON public.mint_receipts USING btree (tx_hash);

-- ─── mpp_store ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mpp_store (
    key text NOT NULL,
    value jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mpp_store_pkey PRIMARY KEY (key)
);
CREATE INDEX IF NOT EXISTS mpp_store_created_at_idx ON public.mpp_store USING btree (created_at);

-- ─── refund_queue ───────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.refund_queue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE IF NOT EXISTS public.refund_queue (
    id integer DEFAULT nextval('public.refund_queue_id_seq'::regclass) NOT NULL,
    agent text NOT NULL,
    amount numeric NOT NULL,
    mpp_tx text,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled boolean DEFAULT false NOT NULL,
    settled_at timestamp with time zone,
    settled_tx text,
    CONSTRAINT refund_queue_pkey PRIMARY KEY (id)
);
ALTER SEQUENCE public.refund_queue_id_seq OWNED BY public.refund_queue.id;
CREATE INDEX IF NOT EXISTS refund_queue_unsettled_idx
    ON public.refund_queue USING btree (settled, created_at) WHERE (settled = false);

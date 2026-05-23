alter table mining_block_winners
  add column if not exists bucket_id bigint
  check (bucket_id is null or bucket_id >= 0);

create index if not exists mining_block_winners_live_bucket_idx
  on mining_block_winners (lower(winner_wallet), claimed, bucket_id, block_number desc);

create table if not exists mining_chain_sync (
  sync_key text primary key,
  last_processed_block bigint not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists mining_block_outcomes (
  block_number bigint primary key,
  patrol_miner_address text not null check (patrol_miner_address ~* '^0x[0-9a-f]{40}$'),
  block_hash char(66) not null,
  block_timestamp timestamptz not null,
  bucket_id bigint check (bucket_id is null or bucket_id >= 0),
  status text not null check (status in ('won', 'missed')),
  eligible_wallet_count integer not null default 0 check (eligible_wallet_count >= 0),
  winner_wallet text check (winner_wallet is null or winner_wallet ~* '^0x[0-9a-f]{40}$'),
  winner_power numeric(78, 0),
  miss_reason text check (miss_reason is null or miss_reason in ('no_eligible_power')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mining_block_outcomes_status_idx
  on mining_block_outcomes (status, block_number desc);

create index if not exists mining_block_outcomes_patrol_miner_idx
  on mining_block_outcomes (lower(patrol_miner_address), block_number desc);

create index if not exists mining_block_outcomes_winner_idx
  on mining_block_outcomes (lower(winner_wallet), block_number desc)
  where winner_wallet is not null;
alter table mining_block_winners
  add column if not exists patrol_miner_address text
  check (patrol_miner_address is null or patrol_miner_address ~* '^0x[0-9a-f]{40}$');

create index if not exists mining_block_winners_patrol_miner_idx
  on mining_block_winners (lower(patrol_miner_address), block_number desc);
alter table if exists mining_block_outcomes
  add column if not exists eligible_power_total numeric(78, 0)
  check (eligible_power_total is null or eligible_power_total >= 0);

update mining_block_outcomes
set eligible_power_total = 0
where status = 'missed'
  and eligible_power_total is null;
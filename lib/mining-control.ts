import type { PoolClient, QueryResultRow } from 'pg'
import { miningQuery, withMiningTransaction } from '@/lib/mining-db'
import {
  createMiningChallengeDraft,
  getNextMiningChallengeDelaySeconds,
  publicMiningChallenge,
  type MiningChallengeRow,
} from '@/lib/mining-challenge'
import {
  challengeLockMinutesForFailureStreak,
  MINING_CHALLENGE_ANSWER_SECONDS,
  MINING_HEARTBEAT_SECONDS,
  MINING_INACTIVE_AFTER_SECONDS,
  MINING_SESSION_CLEANUP_DAYS,
  type MiningStopReason,
  secondsUntil,
} from '@/lib/mining-session'

export interface MiningSessionRow extends QueryResultRow {
  id: string
  wallet: string
  connected_at: Date
  last_heartbeat_at: Date
  warmup_until: Date
  active: boolean
  status: 'active' | 'challenge_pending' | 'stopped'
  stop_reason: MiningStopReason | null
  stopped_at: Date | null
  next_challenge_at: Date | null
  mining_locked_until: Date | null
  challenge_failure_streak: number | null
}

interface AccountLockRow extends QueryResultRow {
  challenge_failure_streak: number
  mining_locked_until: Date | null
}

interface BlacklistRow extends QueryResultRow {
  reason: string
  expires_at: Date | null
}

interface ExpiredChallengeRow extends QueryResultRow {
  id: string
  session_id: string
  wallet: string
}

export function serializeMiningSession(row: MiningSessionRow, challenge?: MiningChallengeRow | null) {
  const warmupRemainingSeconds = secondsUntil(row.warmup_until)
  const lockRemainingSeconds = secondsUntil(row.mining_locked_until)
  const sessionStatus = !row.active || row.status === 'stopped'
    ? 'stopped'
    : challenge
      ? 'challenge_pending'
      : warmupRemainingSeconds > 0
        ? 'warming_up'
        : 'active'

  return {
    id: row.id,
    wallet: row.wallet,
    connectedAt: row.connected_at.toISOString(),
    lastHeartbeatAt: row.last_heartbeat_at.toISOString(),
    warmupUntil: row.warmup_until.toISOString(),
    warmupRemainingSeconds,
    warmupPassed: warmupRemainingSeconds === 0,
    active: row.active && row.status !== 'stopped',
    sessionStatus,
    stopReason: row.stop_reason,
    stoppedAt: row.stopped_at?.toISOString() ?? null,
    nextChallengeAt: row.next_challenge_at?.toISOString() ?? null,
    challengeFailureStreak: row.challenge_failure_streak ?? 0,
    miningLockedUntil: row.mining_locked_until?.toISOString() ?? null,
    lockRemainingSeconds,
    heartbeatEverySeconds: MINING_HEARTBEAT_SECONDS,
    inactiveAfterSeconds: MINING_INACTIVE_AFTER_SECONDS,
    challenge: challenge ? publicMiningChallenge(challenge) : null,
  }
}

export async function readSessionByTokenHash(tokenHash: string): Promise<MiningSessionRow | null> {
  const result = await miningQuery<MiningSessionRow>(
    `select
      s.id,
      s.wallet,
      s.connected_at,
      s.last_heartbeat_at,
      s.warmup_until,
      s.active,
      s.status,
      s.stop_reason,
      s.stopped_at,
      s.next_challenge_at,
      a.mining_locked_until,
      a.challenge_failure_streak
    from mining_sessions s
    left join mining_accounts a on lower(a.wallet) = lower(s.wallet)
    where s.session_token_hash = $1
    limit 1`,
    [tokenHash],
  )
  return result.rows[0] ?? null
}

export async function readActiveBlacklist(wallet: string): Promise<BlacklistRow | null> {
  const result = await miningQuery<BlacklistRow>(
    `select reason, expires_at
    from mining_blacklist
    where lower(wallet) = lower($1)
      and (expires_at is null or expires_at > now())
    limit 1`,
    [wallet],
  )
  return result.rows[0] ?? null
}

export async function getPendingChallenge(sessionId: string): Promise<MiningChallengeRow | null> {
  const result = await miningQuery<MiningChallengeRow>(
    `select id, session_id, wallet, challenge_type, issued_at, expires_at, answered_at, status, metadata
    from mining_challenges
    where session_id = $1 and status = 'issued'
    order by issued_at desc
    limit 1`,
    [sessionId],
  )
  return result.rows[0] ?? null
}

export async function createMiningChallenge(sessionId: string, wallet: string): Promise<MiningChallengeRow> {
  const draft = createMiningChallengeDraft()
  const result = await miningQuery<MiningChallengeRow>(
    `insert into mining_challenges (
      session_id,
      wallet,
      challenge_type,
      expires_at,
      answer_salt,
      expected_answer_hash,
      metadata
    ) values ($1, $2, $3, now() + ($4::int * interval '1 second'), $5, $6, $7::jsonb)
    returning id, session_id, wallet, challenge_type, issued_at, expires_at, answered_at, status, metadata`,
    [
      sessionId,
      wallet,
      draft.challengeType,
      MINING_CHALLENGE_ANSWER_SECONDS,
      draft.answerSalt,
      draft.expectedAnswerHash,
      JSON.stringify(draft.metadata),
    ],
  )

  await miningQuery(
    `update mining_sessions
    set status = 'challenge_pending', updated_at = now()
    where id = $1`,
    [sessionId],
  )

  return result.rows[0]
}

export async function stopSession(sessionId: string, reason: MiningStopReason): Promise<MiningSessionRow | null> {
  const result = await miningQuery<MiningSessionRow>(
    `update mining_sessions
    set active = false,
      status = 'stopped',
      stop_reason = $2,
      stopped_at = coalesce(stopped_at, now()),
      updated_at = now()
    where id = $1
    returning id, wallet, connected_at, last_heartbeat_at, warmup_until, active, status, stop_reason, stopped_at, next_challenge_at,
      null::timestamptz as mining_locked_until,
      null::int as challenge_failure_streak`,
    [sessionId, reason],
  )
  return result.rows[0] ?? null
}

export async function stopSessionWithChallengePenalty(input: {
  sessionId: string
  challengeId: string
  wallet: string
  challengeStatus: 'failed' | 'expired'
  stopReason: 'challenge_failed' | 'challenge_expired'
}) {
  return withMiningTransaction(async (client) => applyChallengePenalty(client, input))
}

async function applyChallengePenalty(client: PoolClient, input: {
  sessionId: string
  challengeId: string
  wallet: string
  challengeStatus: 'failed' | 'expired'
  stopReason: 'challenge_failed' | 'challenge_expired'
}) {
  const challengeUpdate = await client.query(
    `update mining_challenges
    set status = $2,
      answered_at = coalesce(answered_at, now()),
      updated_at = now()
    where id = $1 and status = 'issued'
    returning id`,
    [input.challengeId, input.challengeStatus],
  )

  if (challengeUpdate.rowCount === 0) {
    const account = await client.query<AccountLockRow>(
      `select challenge_failure_streak, mining_locked_until
      from mining_accounts
      where lower(wallet) = lower($1)
      limit 1`,
      [input.wallet],
    )
    return account.rows[0] ?? { challenge_failure_streak: 0, mining_locked_until: null }
  }

  await client.query(
    `update mining_sessions
    set active = false,
      status = 'stopped',
      stop_reason = $2,
      stopped_at = coalesce(stopped_at, now()),
      updated_at = now()
    where id = $1`,
    [input.sessionId, input.stopReason],
  )

  await client.query(
    `insert into mining_accounts (wallet, first_seen_at, last_seen_at, updated_at)
    values ($1, now(), now(), now())
    on conflict (wallet) do nothing`,
    [input.wallet],
  )

  const current = await client.query<AccountLockRow>(
    `select challenge_failure_streak, mining_locked_until
    from mining_accounts
    where lower(wallet) = lower($1)
    for update`,
    [input.wallet],
  )
  const nextStreak = (current.rows[0]?.challenge_failure_streak ?? 0) + 1
  const lockMinutes = challengeLockMinutesForFailureStreak(nextStreak)

  const account = await client.query<AccountLockRow>(
    `update mining_accounts
    set challenge_failure_streak = $2,
      challenge_fail_count = challenge_fail_count + case when $3 = 'challenge_failed' then 1 else 0 end,
      challenge_expire_count = challenge_expire_count + case when $3 = 'challenge_expired' then 1 else 0 end,
      last_challenge_failed_at = case when $3 = 'challenge_failed' then now() else last_challenge_failed_at end,
      last_challenge_expired_at = case when $3 = 'challenge_expired' then now() else last_challenge_expired_at end,
      mining_locked_until = now() + ($4::int * interval '1 minute'),
      last_session_ended_at = now(),
      last_session_end_reason = $3,
      updated_at = now()
    where lower(wallet) = lower($1)
    returning challenge_failure_streak, mining_locked_until`,
    [input.wallet, nextStreak, input.stopReason, lockMinutes],
  )

  return account.rows[0]
}

export async function markChallengePassed(input: {
  sessionId: string
  challengeId: string
  wallet: string
}) {
  const nextDelaySeconds = getNextMiningChallengeDelaySeconds()
  return withMiningTransaction(async (client) => {
    await client.query(
      `update mining_challenges
      set status = 'passed', answered_at = now(), updated_at = now()
      where id = $1 and status = 'issued'`,
      [input.challengeId],
    )

    await client.query(
      `update mining_accounts
      set challenge_failure_streak = 0,
        challenge_pass_count = challenge_pass_count + 1,
        last_challenge_passed_at = now(),
        last_seen_at = now(),
        updated_at = now()
      where lower(wallet) = lower($1)`,
      [input.wallet],
    )

    const result = await client.query<MiningSessionRow>(
      `update mining_sessions
      set status = 'active',
        next_challenge_at = now() + ($2::int * interval '1 second'),
        updated_at = now()
      where id = $1
      returning id, wallet, connected_at, last_heartbeat_at, warmup_until, active, status, stop_reason, stopped_at, next_challenge_at,
        null::timestamptz as mining_locked_until,
        0::int as challenge_failure_streak`,
      [input.sessionId, nextDelaySeconds],
    )

    return result.rows[0] ?? null
  })
}

export async function sweepMiningState() {
  const expired = await miningQuery<ExpiredChallengeRow>(
    `select c.id, c.session_id, c.wallet
    from mining_challenges c
    join mining_sessions s on s.id = c.session_id
    where c.status = 'issued'
      and c.expires_at <= now()
    order by c.expires_at asc
    limit 50`,
  )

  for (const row of expired.rows) {
    await stopSessionWithChallengePenalty({
      sessionId: row.session_id,
      challengeId: row.id,
      wallet: row.wallet,
      challengeStatus: 'expired',
      stopReason: 'challenge_expired',
    })
  }

  await miningQuery(
    `update mining_sessions s
    set active = false,
      status = 'stopped',
      stop_reason = 'heartbeat_timeout',
      stopped_at = coalesce(stopped_at, now()),
      updated_at = now()
    where s.active = true
      and s.last_heartbeat_at < now() - ($1::int * interval '1 second')
      and not exists (
        select 1 from mining_challenges c
        where c.session_id = s.id and c.status = 'issued'
      )`,
    [MINING_INACTIVE_AFTER_SECONDS],
  )

  await miningQuery(
    `delete from mining_sessions
    where active = false
      and coalesce(stopped_at, updated_at, created_at) < now() - ($1::int * interval '1 day')`,
    [MINING_SESSION_CLEANUP_DAYS],
  )

  await miningQuery(
    `delete from mining_power_cache
    where updated_at < now() - ($1::int * interval '1 day')`,
    [MINING_SESSION_CLEANUP_DAYS],
  )
}
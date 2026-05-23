import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto'
import type { QueryResultRow } from 'pg'
import {
  MINING_CHALLENGE_ANSWER_SECONDS,
  MINING_CHALLENGE_MAX_SECONDS,
  MINING_CHALLENGE_MIN_SECONDS,
} from '@/lib/mining-session'

export const MINING_CHALLENGE_TYPE = 'arithmetic_v1'

export interface MiningChallengeRow extends QueryResultRow {
  id: string
  session_id: string
  wallet: string
  challenge_type: string
  issued_at: Date
  expires_at: Date
  answered_at: Date | null
  status: 'issued' | 'passed' | 'failed' | 'expired'
  metadata: Record<string, unknown>
}

export interface MiningChallengeDraft {
  challengeType: typeof MINING_CHALLENGE_TYPE
  answerSalt: string
  expectedAnswerHash: string
  metadata: Record<string, unknown>
}

export function getNextMiningChallengeDelaySeconds(): number {
  return randomInt(MINING_CHALLENGE_MIN_SECONDS, MINING_CHALLENGE_MAX_SECONDS + 1)
}

export function createMiningChallengeDraft(): MiningChallengeDraft {
  const left = randomInt(2, 20)
  const right = randomInt(2, 20)
  const answer = String(left + right)
  const answerSalt = randomBytes(16).toString('hex')

  return {
    challengeType: MINING_CHALLENGE_TYPE,
    answerSalt,
    expectedAnswerHash: hashMiningChallengeAnswer(answerSalt, answer),
    metadata: {
      prompt: `${left} + ${right}`,
      inputMode: 'numeric',
      answerWindowSeconds: MINING_CHALLENGE_ANSWER_SECONDS,
    },
  }
}

export function hashMiningChallengeAnswer(salt: string, answer: string): string {
  return createHash('sha256').update(`${salt}:${answer.trim().toLowerCase()}`).digest('hex')
}

export function verifyMiningChallengeAnswer(salt: string, expectedHash: string, answer: string): boolean {
  const actual = Buffer.from(hashMiningChallengeAnswer(salt, answer), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function publicMiningChallenge(row: MiningChallengeRow) {
  const prompt = typeof row.metadata.prompt === 'string' ? row.metadata.prompt : 'Confirm presence'
  const inputMode = typeof row.metadata.inputMode === 'string' ? row.metadata.inputMode : 'text'

  return {
    id: row.id,
    type: row.challenge_type,
    prompt,
    inputMode,
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    answerWindowSeconds: MINING_CHALLENGE_ANSWER_SECONDS,
  }
}
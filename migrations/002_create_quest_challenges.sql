-- Migration: Create quest_challenges table for Phase 3 math challenge system
-- Run this on your PostgreSQL database to enable the math challenge WL gate.

CREATE TABLE IF NOT EXISTS quest_challenges (
  challenge_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quest_id       UUID NOT NULL REFERENCES quest_entries(quest_id) ON DELETE CASCADE,
  seed           BIGINT NOT NULL,
  answers        JSONB NOT NULL,            -- correct answers array (server truth)
  attempts       INT NOT NULL DEFAULT 0,
  max_attempts   INT NOT NULL DEFAULT 3,
  solved         BOOLEAN NOT NULL DEFAULT FALSE,
  final_answer   VARCHAR(64),               -- last answer used for tweet verification
  locked_out     BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at     TIMESTAMPTZ NOT NULL,       -- 5-minute window
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  solved_at      TIMESTAMPTZ,
  CONSTRAINT uq_challenge_quest UNIQUE (quest_id)
);

CREATE INDEX IF NOT EXISTS idx_challenge_quest ON quest_challenges (quest_id);
CREATE INDEX IF NOT EXISTS idx_challenge_expires ON quest_challenges (expires_at);

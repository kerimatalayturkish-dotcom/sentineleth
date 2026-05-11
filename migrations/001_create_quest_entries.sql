-- Migration: Create quest_entries table
-- Run this on your Render PostgreSQL database to set up the quest system.

CREATE TABLE IF NOT EXISTS quest_entries (
  quest_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  twitter        VARCHAR(17) NOT NULL,
  code           VARCHAR(16) NOT NULL,
  tweet_url      TEXT,
  tempo_address  VARCHAR(42),
  verified       BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_twitter UNIQUE (twitter),
  CONSTRAINT uq_tempo_address UNIQUE (tempo_address)
);

CREATE INDEX IF NOT EXISTS idx_quest_twitter ON quest_entries (LOWER(twitter));
CREATE INDEX IF NOT EXISTS idx_quest_address ON quest_entries (LOWER(tempo_address));

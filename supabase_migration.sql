-- AR Tours WhatsApp Agent — Supabase Migration
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New query)
--
-- This creates the new tables needed for persistent storage of:
--   1. AI conversation history (survives Render restarts)
--   2. Human handoff state (survives Render restarts)
--   3. Bokun bookings (migrated from ephemeral local JSON)
--   4. message_id on messages table (for media joins)

-- ============================================================
-- 1. AI conversation history
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_history (
  phone TEXT PRIMARY KEY,
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 2. Human handoff state
-- ============================================================
CREATE TABLE IF NOT EXISTS handoffs (
  phone TEXT PRIMARY KEY,
  reason TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 3. Bokun bookings
-- ============================================================
CREATE TABLE IF NOT EXISTS bokun_bookings (
  booking_id TEXT PRIMARY KEY,
  phone TEXT,
  customer_name TEXT,
  tour_name TEXT,
  date TEXT,
  pax INTEGER,
  price NUMERIC,
  currency TEXT DEFAULT 'AUD',
  status TEXT DEFAULT 'confirmed',
  raw JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bokun_bookings_phone ON bokun_bookings(phone);

-- ============================================================
-- 4. Add message_id to messages table for media joins
-- ============================================================
ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);

-- ============================================================
-- 5. Add dir='system' support (for Bokun notes that should not
--    reopen the 24h WhatsApp messaging window)
-- ============================================================
-- No schema change needed — dir is a TEXT column that already
-- accepts any string value. We just need the code to use 'system'
-- instead of 'inbound' for server-generated notes.

-- ============================================================
-- Done! All tables created successfully.
-- ============================================================

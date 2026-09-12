-- ==============================================================================
-- AR Tours WhatsApp Agent — Complete Database Schema & Migration
-- ==============================================================================
-- Run this in your Supabase SQL Editor (Dashboard -> SQL Editor -> New query)
-- This creates all required tables with IF NOT EXISTS, adds RLS policies,
-- and ensures both existing and new tables are completely setup.

-- 1. Conversations Table
CREATE TABLE IF NOT EXISTS conversations (
  phone TEXT PRIMARY KEY,
  name TEXT,
  last_at TIMESTAMPTZ DEFAULT NOW(),
  operator_id TEXT DEFAULT 'ar_tours',
  business_number_id TEXT
);

-- 2. Messages Table
CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  dir TEXT NOT NULL, -- 'inbound', 'outbound', or 'system'
  body TEXT DEFAULT '',
  at TIMESTAMPTZ DEFAULT NOW(),
  message_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);

-- Ensure message_id exists if messages table was created previously without it
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='messages' AND column_name='message_id'
  ) THEN
    ALTER TABLE messages ADD COLUMN message_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);
  END IF;
END $$;

-- 3. AI Conversation History Table (Survives Render free-tier restarts)
CREATE TABLE IF NOT EXISTS ai_history (
  phone TEXT PRIMARY KEY,
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Human Handoff State Table (Survives Render free-tier restarts)
CREATE TABLE IF NOT EXISTS handoffs (
  phone TEXT PRIMARY KEY,
  reason TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Bokun Bookings Table (Migrated from local JSON)
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

-- 6. Web Push Subscriptions Table
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  keys JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Media Metadata Table
CREATE TABLE IF NOT EXISTS media (
  id BIGSERIAL PRIMARY KEY,
  message_id TEXT,
  phone TEXT,
  media_id TEXT,
  type TEXT,
  mime TEXT,
  size BIGINT,
  filename TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_media_phone ON media(phone);
CREATE INDEX IF NOT EXISTS idx_media_message_id ON media(message_id);

-- ==============================================================================
-- Security: Enable Row Level Security (RLS) and allow service_role / backend
-- ==============================================================================
-- Since your backend server uses SUPABASE_SECRET_KEY (the service_role key),
-- service_role automatically bypasses RLS while protecting your database from
-- unauthorized public access via anon keys.

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bokun_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE media ENABLE ROW LEVEL SECURITY;

-- Allow service_role full access (explicit safety policies)
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN (
    'conversations', 'messages', 'ai_history', 'handoffs', 'bokun_bookings', 'push_subscriptions', 'media'
  )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Service role access" ON %I;', t);
    EXECUTE format('CREATE POLICY "Service role access" ON %I FOR ALL TO service_role USING (true) WITH CHECK (true);', t);
  END LOOP;
END $$;

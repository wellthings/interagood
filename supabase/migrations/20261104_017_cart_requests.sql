-- Client cart requests submitted from the website. Only the backend (service role) reads this table;
-- RLS is enabled with no policies, so anon/authenticated keys cannot access it.
CREATE TABLE IF NOT EXISTS cart_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name   TEXT NOT NULL,
  client_phone  TEXT NOT NULL,
  location_name TEXT NOT NULL,
  latitude      DOUBLE PRECISION,
  longitude     DOUBLE PRECISION,
  items         JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cart_requests_created_idx ON cart_requests (created_at DESC);
ALTER TABLE cart_requests ENABLE ROW LEVEL SECURITY;

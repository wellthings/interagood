-- Business profiles are reviewed by an admin first. The submitted form waits in profile_submissions;
-- only after approval is it copied into profiles with is_verified = true.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_mode TEXT,
  ADD COLUMN IF NOT EXISTS tools_photo_url TEXT,
  ADD COLUMN IF NOT EXISTS team_photo_url TEXT;

DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_verification_mode_check CHECK (verification_mode IN ('offline', 'online'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS profile_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  data JSONB NOT NULL,
  verification_mode TEXT NOT NULL CHECK (verification_mode IN ('offline', 'online')),
  aadhaar_front_path TEXT,
  aadhaar_back_path TEXT,
  selfie_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS profile_submissions_status_idx ON profile_submissions (status, submitted_at);
ALTER TABLE profile_submissions ENABLE ROW LEVEL SECURITY;

-- Verification (selfie / video call / admin review) is removed; profiles are saved directly on submit.
DROP TABLE IF EXISTS profile_submissions;
ALTER TABLE profiles
  DROP COLUMN IF EXISTS is_verified,
  DROP COLUMN IF EXISTS verified_at,
  DROP COLUMN IF EXISTS verification_mode;

-- Payment state and dates, kept so users can be notified when the next payment is due.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS last_paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_due_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_payment_status_check CHECK (payment_status IN ('unpaid', 'paid', 'failed', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 028 Split operational data out of profiles so the profiles table holds only
-- profile inputs + uid. Onboarding (plan/payment/ig_id) and dashboard
-- (online/upload counters) get their own tables.

CREATE TABLE IF NOT EXISTS onboarding (
    user_id            UUID PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE,
    ig_id              VARCHAR(10),
    skill_level        TEXT,
    payment_status     TEXT NOT NULL DEFAULT 'unpaid',
    payment_due_date   TIMESTAMPTZ,
    last_paid_at       TIMESTAMPTZ,
    next_due_at        TIMESTAMPTZ,
    leads_status       VARCHAR(40) DEFAULT 'inactive',
    terms_accepted     BOOLEAN DEFAULT FALSE,
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dashboard (
    user_id               UUID PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE,
    is_online             BOOLEAN DEFAULT TRUE,
    daily_upload_count    INTEGER NOT NULL DEFAULT 0,
    daily_upload_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Copy existing values across (idempotent)
INSERT INTO onboarding (user_id, ig_id, skill_level, payment_status, payment_due_date, last_paid_at, next_due_at, leads_status, terms_accepted)
SELECT user_id, ig_id, skill_level, payment_status, payment_due_date, last_paid_at, next_due_at, leads_status, terms_accepted
FROM profiles
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO dashboard (user_id, is_online, daily_upload_count, daily_upload_reset_at)
SELECT user_id, is_online, daily_upload_count, daily_upload_reset_at
FROM profiles
ON CONFLICT (user_id) DO NOTHING;

-- Drop moved + unused columns from profiles
ALTER TABLE profiles
    DROP COLUMN IF EXISTS ig_id,
    DROP COLUMN IF EXISTS skill_level,
    DROP COLUMN IF EXISTS payment_status,
    DROP COLUMN IF EXISTS payment_due_date,
    DROP COLUMN IF EXISTS last_paid_at,
    DROP COLUMN IF EXISTS next_due_at,
    DROP COLUMN IF EXISTS leads_status,
    DROP COLUMN IF EXISTS terms_accepted,
    DROP COLUMN IF EXISTS is_online,
    DROP COLUMN IF EXISTS daily_upload_count,
    DROP COLUMN IF EXISTS daily_upload_reset_at,
    DROP COLUMN IF EXISTS tools_photo_url,
    DROP COLUMN IF EXISTS team_photo_url,
    DROP COLUMN IF EXISTS has_tools,
    DROP COLUMN IF EXISTS knows_work_completely,
    DROP COLUMN IF EXISTS knows_measurement_system,
    DROP COLUMN IF EXISTS can_deal_with_customers,
    DROP COLUMN IF EXISTS can_manage_quotation_workflow,
    DROP COLUMN IF EXISTS knows_pricing,
    DROP COLUMN IF EXISTS uses_boq_tools,
    DROP COLUMN IF EXISTS worked_with_team_before;

-- Recreate indexes / constraints on the new tables
CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_ig_id ON onboarding (ig_id) WHERE ig_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_onboarding_cards ON onboarding (user_id) WHERE payment_status = 'paid';

DO $$ BEGIN
    ALTER TABLE onboarding ADD CONSTRAINT onboarding_payment_status_check CHECK (payment_status IN ('unpaid', 'paid', 'failed', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE onboarding ADD CONSTRAINT onboarding_skill_level_check CHECK (skill_level IS NULL OR skill_level IN ('new', 'intermediate', 'experienced'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
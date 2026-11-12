-- 024 Complete profiles table (superset of all business-profile fields for partner / supplier / architect)
-- and removal of AutoPay. Payment is now a manual monthly payment:
--   payment_status = 'paid' + next_due_at in the future  => the user is live/online
--   otherwise                                             => offline, hidden from business cards
-- Columns a role does not use stay NULL, so one shared table serves all three roles.

-- ---------------------------------------------------------------------------
-- Full column set (idempotent). Fresh databases also get every column here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
    user_id               UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email                 VARCHAR(120),
    category_id           INT,
    category_name         VARCHAR(100),
    full_name             VARCHAR(120),
    address               TEXT,
    city                  VARCHAR(80),
    state                 VARCHAR(80),
    pincode               VARCHAR(20),
    latitude              NUMERIC(10, 7),
    longitude             NUMERIC(10, 7),
    business_name         VARCHAR(150),
    profile_photo_url     TEXT,
    banner_url            TEXT,
    tools_photo_url       TEXT,
    team_photo_url        TEXT,
    age                   INT,
    experience_years      INT,
    has_tools             BOOLEAN DEFAULT FALSE,
    has_team              BOOLEAN DEFAULT FALSE,
    team_members_count    INT DEFAULT 0,
    knows_work_completely BOOLEAN DEFAULT FALSE,
    knows_measurement_system BOOLEAN DEFAULT FALSE,
    can_deal_with_customers  BOOLEAN DEFAULT FALSE,
    can_manage_quotation_workflow BOOLEAN DEFAULT FALSE,
    knows_pricing         BOOLEAN DEFAULT FALSE,
    terms_accepted        BOOLEAN DEFAULT FALSE,
    leads_status          VARCHAR(40) DEFAULT 'inactive',
    is_online             BOOLEAN DEFAULT TRUE,
    ig_id                 VARCHAR(10),
    education             VARCHAR(150),
    design_software       VARCHAR(80),
    uses_boq_tools        BOOLEAN,
    worked_with_team_before BOOLEAN,
    skill_level           TEXT,
    shop_years            INTEGER,
    daily_upload_count    INTEGER NOT NULL DEFAULT 0,
    daily_upload_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payment_status        TEXT NOT NULL DEFAULT 'unpaid',
    payment_due_date      TIMESTAMPTZ,
    last_paid_at          TIMESTAMPTZ,
    next_due_at           TIMESTAMPTZ,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure every column exists on databases created before this migration.
ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS email                 VARCHAR(120),
    ADD COLUMN IF NOT EXISTS category_id           INT,
    ADD COLUMN IF NOT EXISTS category_name         VARCHAR(100),
    ADD COLUMN IF NOT EXISTS full_name             VARCHAR(120),
    ADD COLUMN IF NOT EXISTS address               TEXT,
    ADD COLUMN IF NOT EXISTS city                  VARCHAR(80),
    ADD COLUMN IF NOT EXISTS state                 VARCHAR(80),
    ADD COLUMN IF NOT EXISTS pincode               VARCHAR(20),
    ADD COLUMN IF NOT EXISTS latitude              NUMERIC(10, 7),
    ADD COLUMN IF NOT EXISTS longitude             NUMERIC(10, 7),
    ADD COLUMN IF NOT EXISTS business_name         VARCHAR(150),
    ADD COLUMN IF NOT EXISTS profile_photo_url     TEXT,
    ADD COLUMN IF NOT EXISTS banner_url            TEXT,
    ADD COLUMN IF NOT EXISTS tools_photo_url       TEXT,
    ADD COLUMN IF NOT EXISTS team_photo_url        TEXT,
    ADD COLUMN IF NOT EXISTS age                   INT,
    ADD COLUMN IF NOT EXISTS experience_years      INT,
    ADD COLUMN IF NOT EXISTS has_tools             BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS has_team              BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS team_members_count    INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS knows_work_completely BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS knows_measurement_system BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS can_deal_with_customers  BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS can_manage_quotation_workflow BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS knows_pricing         BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS terms_accepted        BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS leads_status          VARCHAR(40) DEFAULT 'inactive',
    ADD COLUMN IF NOT EXISTS is_online             BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS ig_id                 VARCHAR(10),
    ADD COLUMN IF NOT EXISTS education             VARCHAR(150),
    ADD COLUMN IF NOT EXISTS design_software       VARCHAR(80),
    ADD COLUMN IF NOT EXISTS uses_boq_tools        BOOLEAN,
    ADD COLUMN IF NOT EXISTS worked_with_team_before BOOLEAN,
    ADD COLUMN IF NOT EXISTS skill_level           TEXT,
    ADD COLUMN IF NOT EXISTS shop_years            INTEGER,
    ADD COLUMN IF NOT EXISTS daily_upload_count    INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS daily_upload_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS payment_status        TEXT NOT NULL DEFAULT 'unpaid',
    ADD COLUMN IF NOT EXISTS payment_due_date      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_paid_at          TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS next_due_at           TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS created_at            TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ DEFAULT NOW();

-- ---------------------------------------------------------------------------
-- Constraints (idempotent)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_experience_years_check CHECK (experience_years IS NULL OR (experience_years >= 0 AND experience_years <= 40));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_skill_level_check CHECK (skill_level IS NULL OR skill_level IN ('new', 'intermediate', 'experienced'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_shop_years_check CHECK (shop_years IS NULL OR (shop_years >= 0 AND shop_years <= 100));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_payment_status_check CHECK (payment_status IN ('unpaid', 'paid', 'failed', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_ig_id ON profiles (ig_id) WHERE ig_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Remove AutoPay: no recurring mandate, no is_autopay_active / autopay_mandate_id.
-- ---------------------------------------------------------------------------
-- Drop the partial index that depends on is_autopay_active first (Postgres will
-- not drop the column while it is in use), then drop the columns.
DROP INDEX IF EXISTS idx_profiles_cards;
ALTER TABLE profiles DROP COLUMN IF EXISTS is_autopay_active;
ALTER TABLE profiles DROP COLUMN IF EXISTS autopay_mandate_id;

-- Cards now list only paid users whose monthly cycle has not expired.
CREATE INDEX IF NOT EXISTS idx_profiles_cards ON profiles (category_id) WHERE payment_status = 'paid';

-- Existing rows: anyone still marked "paid" without a due date gets a 30-day cycle from now,
-- so their online state is well-defined after the column change.
UPDATE profiles
   SET next_due_at = COALESCE(next_due_at, NOW() + INTERVAL '30 days'),
       payment_due_date = COALESCE(payment_due_date, next_due_at, NOW() + INTERVAL '30 days')
 WHERE payment_status = 'paid' AND next_due_at IS NULL;
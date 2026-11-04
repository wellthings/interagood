-- users keeps only login identity: id, role, phone, username, password_hash.
-- Everything else (business profile, subscription, onboarding flags) moves to profiles, one row per user.
CREATE TABLE IF NOT EXISTS profiles (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email VARCHAR(120),
    category_id INT,
    category_name VARCHAR(100),
    full_name VARCHAR(120),
    address TEXT,
    city VARCHAR(80),
    state VARCHAR(80),
    pincode VARCHAR(20),
    latitude NUMERIC(10, 7),
    longitude NUMERIC(10, 7),
    business_name VARCHAR(150),
    profile_photo_url TEXT,
    banner_url TEXT,
    age INT,
    experience_years INT CHECK (experience_years >= 4 AND experience_years <= 20),
    has_tools BOOLEAN DEFAULT FALSE,
    has_team BOOLEAN DEFAULT FALSE,
    team_members_count INT DEFAULT 0,
    knows_work_completely BOOLEAN DEFAULT FALSE,
    knows_measurement_system BOOLEAN DEFAULT FALSE,
    can_deal_with_customers BOOLEAN DEFAULT FALSE,
    can_manage_quotation_workflow BOOLEAN DEFAULT FALSE,
    knows_pricing BOOLEAN DEFAULT FALSE,
    terms_accepted BOOLEAN DEFAULT FALSE,
    is_autopay_active BOOLEAN DEFAULT FALSE,
    autopay_mandate_id VARCHAR(100),
    leads_status VARCHAR(40) DEFAULT 'inactive',
    is_online BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Keep any existing data
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'business_name') THEN
    INSERT INTO profiles (user_id, email, category_id, category_name, full_name, address, city, state, pincode, latitude, longitude,
      business_name, profile_photo_url, banner_url, age, experience_years, has_tools, has_team, team_members_count,
      knows_work_completely, knows_measurement_system, can_deal_with_customers, can_manage_quotation_workflow, knows_pricing,
      terms_accepted, is_autopay_active, autopay_mandate_id, leads_status, is_online, created_at, updated_at)
    SELECT id, email, category_id, category_name, full_name, address, city, state, pincode, latitude, longitude,
      business_name, profile_photo_url, banner_url, age, experience_years, has_tools, has_team, team_members_count,
      knows_work_completely, knows_measurement_system, can_deal_with_customers, can_manage_quotation_workflow, knows_pricing,
      terms_accepted, is_autopay_active, autopay_mandate_id, leads_status, is_online, created_at, updated_at
    FROM users
    ON CONFLICT (user_id) DO NOTHING;
  END IF;
END $$;

ALTER TABLE users
    DROP COLUMN IF EXISTS email,
    DROP COLUMN IF EXISTS category_id,
    DROP COLUMN IF EXISTS category_name,
    DROP COLUMN IF EXISTS full_name,
    DROP COLUMN IF EXISTS address,
    DROP COLUMN IF EXISTS city,
    DROP COLUMN IF EXISTS state,
    DROP COLUMN IF EXISTS pincode,
    DROP COLUMN IF EXISTS latitude,
    DROP COLUMN IF EXISTS longitude,
    DROP COLUMN IF EXISTS business_name,
    DROP COLUMN IF EXISTS profile_photo_url,
    DROP COLUMN IF EXISTS banner_url,
    DROP COLUMN IF EXISTS age,
    DROP COLUMN IF EXISTS experience_years,
    DROP COLUMN IF EXISTS has_tools,
    DROP COLUMN IF EXISTS has_team,
    DROP COLUMN IF EXISTS team_members_count,
    DROP COLUMN IF EXISTS knows_work_completely,
    DROP COLUMN IF EXISTS knows_measurement_system,
    DROP COLUMN IF EXISTS can_deal_with_customers,
    DROP COLUMN IF EXISTS can_manage_quotation_workflow,
    DROP COLUMN IF EXISTS knows_pricing,
    DROP COLUMN IF EXISTS terms_accepted,
    DROP COLUMN IF EXISTS is_autopay_active,
    DROP COLUMN IF EXISTS autopay_mandate_id,
    DROP COLUMN IF EXISTS leads_status,
    DROP COLUMN IF EXISTS is_online;

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Business cards shown to clients list only subscribed profiles
CREATE INDEX IF NOT EXISTS idx_profiles_cards ON profiles (category_id) WHERE is_autopay_active = TRUE;

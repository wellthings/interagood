-- Interagood Database Schema Migration for Supabase
-- Target: PostgreSQL / Supabase
-- Author: Interagood Platform Team

-- Enable UUID extension if not already available
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Partner Categories Table (10 initial categories)
CREATE TABLE IF NOT EXISTS partner_categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    hindi_name VARCHAR(100) NOT NULL,
    icon_name VARCHAR(50) DEFAULT 'wrench',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Supplier Categories Table
CREATE TABLE IF NOT EXISTS supplier_categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    hindi_name VARCHAR(100) NOT NULL,
    icon_name VARCHAR(50) DEFAULT 'store',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Age Master Table (Greater than 19 years: 20 to 65 years)
CREATE TABLE IF NOT EXISTS master_ages (
    id SERIAL PRIMARY KEY,
    age_value INT NOT NULL UNIQUE CHECK (age_value >= 20)
);

-- 4. Single Unified Users Table
-- Holds both Partner and Supplier details in a single progressive row updated by UUID
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    role VARCHAR(20) NOT NULL CHECK (role IN ('partner', 'supplier')),
    
    -- Step 1: Registration Credentials
    username VARCHAR(60) NOT NULL UNIQUE,
    email VARCHAR(120) NOT NULL UNIQUE,
    phone VARCHAR(20) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    
    -- Step 2: Personal Profile Details
    category_id INT,
    category_name VARCHAR(100),
    full_name VARCHAR(120),
    address TEXT,
    city VARCHAR(80),
    state VARCHAR(80),
    pincode VARCHAR(10),
    latitude NUMERIC(10, 7), -- Stored only in backend DB, not shown in UI
    longitude NUMERIC(10, 7), -- Stored only in backend DB, not shown in UI
    
    -- Step 3: Business Profile Details
    business_name VARCHAR(150),
    profile_photo_url TEXT,
    banner_url TEXT,
    
    -- Partner Specific (Nullable for Supplier)
    age INT,
    experience_years INT CHECK (experience_years >= 4 AND experience_years <= 20),
    has_toolbox BOOLEAN DEFAULT FALSE,
    toolbox_image_url TEXT,
    has_team BOOLEAN DEFAULT FALSE,
    team_members_count INT DEFAULT 0,
    team_image_url TEXT,
    knows_work_completely BOOLEAN DEFAULT FALSE,
    knows_measurement_system BOOLEAN DEFAULT FALSE,
    can_deal_with_customers BOOLEAN DEFAULT FALSE,
    can_manage_quotation_workflow BOOLEAN DEFAULT FALSE,
    knows_pricing BOOLEAN DEFAULT FALSE,
    
    -- Step 4: Onboarding & Subscription Details
    terms_accepted BOOLEAN DEFAULT FALSE,
    is_autopay_active BOOLEAN DEFAULT FALSE,
    autopay_mandate_id VARCHAR(100),
    leads_status VARCHAR(40) DEFAULT 'inactive', -- 'leads_activated' for partner, 'deals_activated' for supplier
    
    -- Status & Controls
    is_online BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. User Daily Upload Samples Table (Daily Limit: 6 items max - 3 images & 3 videos)
CREATE TABLE IF NOT EXISTS user_samples (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_type VARCHAR(10) NOT NULL CHECK (media_type IN ('image', 'video')),
    title VARCHAR(120),
    media_url TEXT NOT NULL,
    thumbnail_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for lightning fast lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_user_samples_user_day ON user_samples(user_id, created_at);

-- Seed Data for Partner Categories
INSERT INTO partner_categories (name, hindi_name, icon_name) VALUES
('Carpenter', 'बढ़ई (लकड़ी का काम)', 'hammer'),
('Plumber', 'प्लम्बर (नल व पाइप फिटिंग)', 'droplet'),
('Painter', 'पेंटर व पॉलिशर (दीवार व फर्नीचर)', 'paint-brush'),
('Electrician', 'इलेक्ट्रीशियन (वायरिंग व उपकरण)', 'zap'),
('Mason / Rajmistri', 'राजमिस्त्री (चिनाई व प्लास्टर)', 'wall'),
('Welder & Fabricator', 'वेल्डर व फेब्रिकेटर (लोहा व स्टील)', 'flame'),
('False Ceiling & POP', 'फॉल्स सीलिंग व पीओपी कारीगर', 'layers'),
('Tile & Marble Mason', 'टाइल्स व मार्बल कारीगर', 'grid'),
('Interior Decorator', 'इंटीरियर डेकोरेटर व फर्निशर', 'home'),
('Glass & Aluminum Worker', 'ग्लास व एल्युमिनियम कारीगर', 'maximize')
ON CONFLICT (name) DO NOTHING;

-- Seed Data for Supplier Categories
INSERT INTO supplier_categories (name, hindi_name, icon_name) VALUES
('Plywood & Timber Shop', 'प्लाईवुड व टिम्बर स्टोर', 'tree'),
('Tiles & Sanitary Shop', 'टाइल्स व सेनेटरी वेयर', 'layout-grid'),
('Paint & Polish Store', 'पेंट, प्राइमर व पॉलिश शॉप', 'palette'),
('Hardware & Tools Store', 'हार्डवेयर, फिटिंग्स व टूल्स', 'tool'),
('Electrical Supply Shop', 'इलेक्ट्रिकल वायर्स व स्विच शॉप', 'zap'),
('Glass & Mirror Studio', 'ग्लास, टफन व मिरर डीलर', 'square'),
('Marble & Granite Dealer', 'मार्बल, ग्रेनाइट व कोटा स्टोन', 'mountain'),
('Cement & Building Materials', 'सीमेंट, रेत व रोड़ी सप्लायर', 'package')
ON CONFLICT (name) DO NOTHING;

-- Seed Data for Master Ages (20 to 65 years)
INSERT INTO master_ages (age_value)
SELECT generate_series(20, 65)
ON CONFLICT (age_value) DO NOTHING;
-- The backend uses the service_role key (bypasses RLS). Enabling RLS with no
-- policies blocks all direct access through Supabase's public anon key.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_ages ENABLE ROW LEVEL SECURITY;
-- Allow flexible pincode lengths up to 20 characters
ALTER TABLE users ALTER COLUMN pincode TYPE VARCHAR(20);
-- Signup is now phone + OTP only; email is optional.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
-- OTPs are now generated and verified by Fast2SMS, so the local OTP table is no longer needed.
DROP TABLE IF EXISTS phone_otps;
-- Price tag for each uploaded sample: amount + unit chosen from a fixed list
ALTER TABLE user_samples
    ADD COLUMN IF NOT EXISTS price NUMERIC(12, 2) CHECK (price > 0),
    ADD COLUMN IF NOT EXISTS price_unit VARCHAR(20)
        CHECK (price_unit IN ('inch', 'sqfit', 'runningfit', 'pcs', 'bundle', 'combo', 'fit'));
-- Short caption describing the sample (the sample name is stored in the existing title column)
ALTER TABLE user_samples
    ADD COLUMN IF NOT EXISTS caption VARCHAR(300);
-- Aligns user_samples with the API: caption is a plain string and price is a positive decimal.
-- 006/007 used ADD COLUMN IF NOT EXISTS, which silently kept pre-existing columns of the wrong type
-- (caption text[], price integer) and made every sample insert fail.
DO $$
BEGIN
    IF (SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_samples' AND column_name = 'caption') = 'ARRAY' THEN
        ALTER TABLE user_samples
            ALTER COLUMN caption TYPE VARCHAR(300) USING left(array_to_string(caption, ' '), 300);
    END IF;
END $$;

ALTER TABLE user_samples
    ALTER COLUMN price TYPE NUMERIC(12, 2);

ALTER TABLE user_samples
    DROP CONSTRAINT IF EXISTS user_samples_price_check;
ALTER TABLE user_samples
    ADD CONSTRAINT user_samples_price_check CHECK (price > 0);
-- One like (1) or dislike (-1) per user per sample
CREATE TABLE IF NOT EXISTS sample_votes (
    sample_id UUID NOT NULL REFERENCES user_samples(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vote SMALLINT NOT NULL CHECK (vote IN (1, -1)),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (sample_id, user_id)
);

ALTER TABLE sample_votes ENABLE ROW LEVEL SECURITY;
-- Partner toggles no longer take photos: drop the image columns and rename the tools flag.
-- has_tools = "Kya aapke paas kaam karne ka auzar hai", has_team + team_members_count = "saath kaam karne wali team".
ALTER TABLE users DROP COLUMN IF EXISTS toolbox_image_url;
ALTER TABLE users DROP COLUMN IF EXISTS team_image_url;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'has_toolbox'
  ) THEN
    ALTER TABLE users RENAME COLUMN has_toolbox TO has_tools;
  END IF;
END $$;

-- Business cards shown to clients list only subscribed users
CREATE INDEX IF NOT EXISTS idx_users_cards ON users (role, category_id) WHERE is_autopay_active = TRUE;
-- Website signup: four roles (partner, supplier, architect, site_inspector) saved in users.role,
-- plus the two storage buckets used by the backend.
-- Requires the earlier migrations (001-010) to have created the users table.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
    ADD CONSTRAINT users_role_check
    CHECK (role IN ('partner', 'supplier', 'architect', 'site_inspector'));

-- Cards are listed per role, so keep the card index in step with the new roles
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- media: public uploads (banner, profile photo, samples). admin_uploads: private legal documents and guides.
INSERT INTO storage.buckets (id, name, public)
VALUES ('media', 'media', TRUE), ('admin_uploads', 'admin_uploads', FALSE)
ON CONFLICT (id) DO NOTHING;

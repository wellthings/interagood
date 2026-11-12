-- 20261112_022_multirole_enhancement.sql
-- Interagood Platform Multi-Role Enhancement:
-- Enhanced profiles, dynamic posts/products table, and admin verification

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS skill_level VARCHAR(30) DEFAULT 'Intermediate',
  ADD COLUMN IF NOT EXISTS courses_completed TEXT,
  ADD COLUMN IF NOT EXISTS design_software TEXT,
  ADD COLUMN IF NOT EXISTS shop_history_years INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_samples_uploaded INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_videos_uploaded INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_sample_upload_date DATE DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS next_billing_date TIMESTAMPTZ DEFAULT (NOW() + interval '30 days'),
  ADD COLUMN IF NOT EXISTS payment_timing VARCHAR(50) DEFAULT 'Monthly Recurring',
  ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT TRUE;

-- Product & Post Listings table for Suppliers (independent hardware/materials) & Architects (designs/structures)
CREATE TABLE IF NOT EXISTS product_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('supplier', 'architect', 'partner')),
  title VARCHAR(200) NOT NULL,
  category VARCHAR(100) NOT NULL,
  sub_category VARCHAR(100),
  description TEXT,
  unit VARCHAR(30) NOT NULL DEFAULT 'sqft',
  rate_per_unit NUMERIC(10, 2) NOT NULL DEFAULT 0,
  quantity NUMERIC(10, 2) NOT NULL DEFAULT 1,
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  with_material BOOLEAN DEFAULT TRUE,
  image_url TEXT,
  media_type VARCHAR(20) DEFAULT 'image', -- 'image' or 'video'
  is_private BOOLEAN DEFAULT FALSE, -- TRUE for Partner sample uploads (for admin-only evaluation)
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Admin credentials table linking securely to users
CREATE TABLE IF NOT EXISTS admin_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  username VARCHAR(60) NOT NULL UNIQUE,
  phone VARCHAR(20) NOT NULL UNIQUE,
  secret_key_hash TEXT NOT NULL,
  role VARCHAR(30) DEFAULT 'super_admin',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure public storage bucket exists for products and architect portfolios
INSERT INTO storage.buckets (id, name, public)
VALUES ('products', 'products', TRUE), ('portfolios', 'portfolios', TRUE)
ON CONFLICT (id) DO NOTHING;

-- RLS Policies
ALTER TABLE product_listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can view active public product listings"
  ON product_listings FOR SELECT
  USING (is_active = TRUE AND is_private = FALSE);

CREATE POLICY "Users can manage their own listings"
  ON product_listings FOR ALL
  USING (auth.uid() = user_id);

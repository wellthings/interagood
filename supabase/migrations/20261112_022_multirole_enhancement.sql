-- 20261112_022_multirole_enhancement.sql
-- Interagood Platform Multi-Role Enhancement:
-- Enhanced profiles, dynamic posts/products table, private partner samples, and admin credentials linking

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS skill_level TEXT DEFAULT 'intermediate',
  ADD COLUMN IF NOT EXISTS courses_completed TEXT,
  ADD COLUMN IF NOT EXISTS design_software TEXT,
  ADD COLUMN IF NOT EXISTS shop_history_years INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_samples_uploaded INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_videos_uploaded INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_sample_upload_date DATE DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS next_billing_date TIMESTAMPTZ DEFAULT (NOW() + interval '30 days'),
  ADD COLUMN IF NOT EXISTS payment_timing VARCHAR(50) DEFAULT 'Monthly Cycle',
  ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT TRUE;

-- Ensure skill_level uses consistent lowercase enum values
UPDATE profiles SET skill_level = lower(skill_level) WHERE skill_level IS NOT NULL;
ALTER TABLE profiles ALTER COLUMN skill_level SET DEFAULT 'intermediate';

-- Compatibility view alias if any query checks partner_category singular
DO $$
BEGIN
  IF to_regclass('public.partner_categories') IS NOT NULL AND to_regclass('public.partner_category') IS NULL THEN
    CREATE VIEW partner_category AS SELECT * FROM partner_categories;
  END IF;
END $$;

-- Track private flag & owner snapshot fields on user_samples
ALTER TABLE user_samples
  ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS category VARCHAR(100),
  ADD COLUMN IF NOT EXISTS sub_category VARCHAR(100),
  ADD COLUMN IF NOT EXISTS with_material BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS role VARCHAR(20),
  ADD COLUMN IF NOT EXISTS phone VARCHAR(20),
  ADD COLUMN IF NOT EXISTS username VARCHAR(60),
  ADD COLUMN IF NOT EXISTS business_name VARCHAR(150);

-- Product & Post Listings table for Suppliers, Architects & Partners
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
  expected_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  with_material BOOLEAN DEFAULT TRUE,
  image_url TEXT,
  media_type VARCHAR(20) DEFAULT 'image', -- 'image' or 'video'
  is_private BOOLEAN DEFAULT FALSE, -- TRUE for Partner sample uploads (for admin-only evaluation)
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE product_listings ADD COLUMN IF NOT EXISTS expected_amount NUMERIC(12, 2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_product_listings_public ON product_listings (role, is_active, is_private, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_listings_user ON product_listings (user_id, created_at DESC);

-- Link admin_panel securely with primary users table
ALTER TABLE admin_panel
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Admin credentials table linking securely to users
CREATE TABLE IF NOT EXISTS admin_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  username VARCHAR(60) NOT NULL UNIQUE,
  phone VARCHAR(20) NOT NULL UNIQUE,
  password_hash TEXT,
  secret_key_hash TEXT NOT NULL,
  role VARCHAR(30) DEFAULT 'super_admin',
  is_active BOOLEAN DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE admin_credentials ENABLE ROW LEVEL SECURITY;

-- Ensure public & private storage buckets exist with correct visibility
INSERT INTO storage.buckets (id, name, public)
VALUES
  ('media', 'media', TRUE),
  ('products', 'products', TRUE),
  ('portfolios', 'portfolios', TRUE),
  ('partner_samples', 'partner_samples', FALSE),
  ('architect_portfolio', 'architect_portfolio', TRUE),
  ('supplier_products', 'supplier_products', TRUE)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- RLS Policies for product_listings
ALTER TABLE product_listings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'product_listings' AND policyname = 'Public can view active public product listings'
  ) THEN
    CREATE POLICY "Public can view active public product listings"
      ON product_listings FOR SELECT
      USING (is_active = TRUE AND is_private = FALSE);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'product_listings' AND policyname = 'Users can manage their own listings'
  ) THEN
    CREATE POLICY "Users can manage their own listings"
      ON product_listings FOR ALL
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- Allow 'in_progress' status on order_assignments for Order tab (Pending / In Progress / Completed)
DO $$
BEGIN
  IF to_regclass('public.order_assignments') IS NOT NULL THEN
    ALTER TABLE order_assignments DROP CONSTRAINT IF EXISTS order_assignments_status_check;
    ALTER TABLE order_assignments ADD CONSTRAINT order_assignments_status_check
      CHECK (status IN ('unassigned', 'assigned', 'in_progress', 'completed', 'cancelled'));
  END IF;
END $$;

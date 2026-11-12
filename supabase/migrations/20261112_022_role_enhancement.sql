-- 022 Role enhancement: partner/supplier/architect onboarding fields, upload quota, media buckets.
-- All columns are additive so existing rows keep working (defaults / NULLs).

-- Skill level for partner and architect (new / intermediate / experienced)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS skill_level TEXT;

-- Supplier shop operational history (years the shop has been active)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS shop_years INTEGER CHECK (shop_years >= 0 AND shop_years <= 100);

-- Daily sample upload quota tracking (supplier max 4/day: 2 images + 2 videos)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS daily_upload_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS daily_upload_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Payment timing shown in the dashboard header (set on payment)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS payment_due_date TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_skill_level_check CHECK (skill_level IN ('new', 'intermediate', 'experienced'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Storage buckets for role media (private, served via signed URLs / admin only)
INSERT INTO storage.buckets (id, name, public)
VALUES ('partner_samples', 'partner_samples', FALSE),
       ('architect_portfolio', 'architect_portfolio', FALSE),
       ('supplier_products', 'supplier_products', FALSE)
ON CONFLICT (id) DO NOTHING;
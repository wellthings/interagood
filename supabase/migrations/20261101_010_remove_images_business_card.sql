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

-- 029 Admin special columns on users + sync with admin_panel table
-- Normal users keep email = NULL and admin_code = NULL.
-- Admin users have role = 'admin', email, and admin_code.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email VARCHAR(150),
  ADD COLUMN IF NOT EXISTS admin_code VARCHAR(100);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_admin_email
  ON users (lower(email))
  WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_admin_code
  ON users (admin_code)
  WHERE admin_code IS NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('partner', 'supplier', 'architect', 'site_inspector', 'admin'));

ALTER TABLE admin_panel
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS email VARCHAR(150),
  ADD COLUMN IF NOT EXISTS admin_code VARCHAR(100);

-- Replace guard BEFORE backfill so existing bound admin rows can safely receive email & admin_code
CREATE OR REPLACE FUNCTION admin_panel_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.bound_at IS NOT NULL AND NEW.bound_at IS NOT NULL
     AND (NEW.id IS DISTINCT FROM OLD.id
          OR NEW.phone IS DISTINCT FROM OLD.phone
          OR NEW.username IS DISTINCT FROM OLD.username
          OR NEW.login_id IS DISTINCT FROM OLD.login_id
          OR (OLD.admin_code IS NOT NULL AND NEW.admin_code IS DISTINCT FROM OLD.admin_code)
          OR (OLD.email IS NOT NULL AND NEW.email IS DISTINCT FROM OLD.email)
          OR NEW.host IS DISTINCT FROM OLD.host) THEN
    RAISE EXCEPTION 'This admin is bound after first login. Set bound_at to NULL in the same update to change the login details.';
  END IF;

  IF NEW.admin_code IS NULL AND NEW.login_id IS NOT NULL THEN
    NEW.admin_code := NEW.login_id;
  END IF;
  IF NEW.login_id IS NULL AND NEW.admin_code IS NOT NULL THEN
    NEW.login_id := NEW.admin_code;
  END IF;

  IF NEW.host !~ '^\$2[aby]\$' THEN
    NEW.host := crypt(NEW.host, gen_salt('bf', 10));
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

UPDATE admin_panel
SET admin_code = login_id
WHERE admin_code IS NULL AND login_id IS NOT NULL;

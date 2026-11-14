-- 030 Admin phone + password + OTP login (no username required for admin)
-- Normal users have 3 fields (username, phone, password_hash).
-- Admin has 2 credential fields (phone, password/host) + OTP; username stays NULL.

-- 1. Make admin_panel compatible with minimal 2-field manual inserts (phone + host)
ALTER TABLE admin_panel
  ALTER COLUMN id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN username DROP NOT NULL,
  ALTER COLUMN login_id DROP NOT NULL;

ALTER TABLE admin_panel DROP CONSTRAINT IF EXISTS admin_panel_username_check;
ALTER TABLE admin_panel
  ADD CONSTRAINT admin_panel_username_check
  CHECK (username IS NULL OR length(username) >= 3);

ALTER TABLE admin_panel DROP CONSTRAINT IF EXISTS admin_panel_login_id_check;
ALTER TABLE admin_panel
  ADD CONSTRAINT admin_panel_login_id_check
  CHECK (login_id IS NULL OR length(login_id) >= 3);

-- 2. Keep normal users strict (3 fields), allow NULL username when role = 'admin'
ALTER TABLE users ALTER COLUMN username DROP NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('partner', 'supplier', 'architect', 'site_inspector', 'admin'));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_normal_username_required;
ALTER TABLE users
  ADD CONSTRAINT users_normal_username_required
  CHECK (role = 'admin' OR username IS NOT NULL);

-- 3. Guard trigger: allow NULL username/login_id/email/admin_code and auto-hash host password
CREATE OR REPLACE FUNCTION admin_panel_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.bound_at IS NOT NULL AND NEW.bound_at IS NOT NULL
     AND (NEW.id IS DISTINCT FROM OLD.id
          OR NEW.phone IS DISTINCT FROM OLD.phone
          OR (OLD.username IS NOT NULL AND NEW.username IS DISTINCT FROM OLD.username)
          OR (OLD.login_id IS NOT NULL AND NEW.login_id IS DISTINCT FROM OLD.login_id)
          OR (OLD.admin_code IS NOT NULL AND NEW.admin_code IS DISTINCT FROM OLD.admin_code)
          OR (OLD.email IS NOT NULL AND NEW.email IS DISTINCT FROM OLD.email)
          OR NEW.host IS DISTINCT FROM OLD.host) THEN
    RAISE EXCEPTION 'This admin is bound after first login. Set bound_at to NULL in the same update to change the login details.';
  END IF;

  IF NEW.host !~ '^\$2[aby]\$' THEN
    NEW.host := crypt(NEW.host, gen_salt('bf', 10));
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

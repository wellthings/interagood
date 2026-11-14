-- 031 Clean admin_panel to minimal phone + host (password) columns only
-- Drops legacy username, login_id, user_id, email, admin_code columns from admin_panel.
-- Keeps id (auto UUID), phone, host (auto-hashed bcrypt password), is_active, bound_at, last_login_at, created_at, updated_at.

CREATE OR REPLACE FUNCTION admin_panel_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.bound_at IS NOT NULL AND NEW.bound_at IS NOT NULL
     AND (NEW.id IS DISTINCT FROM OLD.id
          OR NEW.phone IS DISTINCT FROM OLD.phone
          OR NEW.host IS DISTINCT FROM OLD.host) THEN
    RAISE EXCEPTION 'This admin is bound after first login. Set bound_at to NULL in the same update to change the login details.';
  END IF;

  IF NEW.host !~ '^\$2[aby]\$' THEN
    NEW.host := crypt(NEW.host, gen_salt('bf', 10));
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

ALTER TABLE admin_panel
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE admin_panel
  DROP CONSTRAINT IF EXISTS admin_panel_username_check,
  DROP CONSTRAINT IF EXISTS admin_panel_login_id_check,
  DROP CONSTRAINT IF EXISTS admin_panel_username_key,
  DROP CONSTRAINT IF EXISTS admin_panel_login_id_key;

ALTER TABLE admin_panel
  DROP COLUMN IF EXISTS username,
  DROP COLUMN IF EXISTS login_id,
  DROP COLUMN IF EXISTS user_id,
  DROP COLUMN IF EXISTS email,
  DROP COLUMN IF EXISTS admin_code;

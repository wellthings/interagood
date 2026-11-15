-- 033 Rename admin_panel.host to admin_panel.password so table & login match 1:1 (phone + password)
-- Also keeps users.username nullable for role = 'admin' and auto-links admin_panel -> users via trigger.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

ALTER TABLE users ALTER COLUMN username DROP NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('partner', 'supplier', 'architect', 'site_inspector', 'admin'));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_normal_username_required;
ALTER TABLE users
  ADD CONSTRAINT users_normal_username_required
  CHECK (role = 'admin' OR username IS NOT NULL);

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

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'admin_panel' AND column_name = 'host'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'admin_panel' AND column_name = 'password'
  ) THEN
    ALTER TABLE admin_panel RENAME COLUMN host TO password;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION admin_panel_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_user_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.bound_at IS NOT NULL AND NEW.bound_at IS NOT NULL
     AND (NEW.id IS DISTINCT FROM OLD.id
          OR NEW.phone IS DISTINCT FROM OLD.phone
          OR NEW.password IS DISTINCT FROM OLD.password) THEN
    RAISE EXCEPTION 'This admin is bound after first login. Set bound_at to NULL in the same update to change the login details.';
  END IF;

  IF NEW.password !~ '^\$2[aby]\$' THEN
    NEW.password := crypt(NEW.password, gen_salt('bf', 10));
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.id IS NULL THEN
      NEW.id := gen_random_uuid();
    END IF;

    SELECT id INTO v_user_id
    FROM public.users
    WHERE phone = NEW.phone OR id = NEW.id
    LIMIT 1;

    IF v_user_id IS NOT NULL THEN
      NEW.id := v_user_id;
      UPDATE public.users
      SET role = 'admin',
          phone = NEW.phone,
          username = NULL,
          password_hash = NEW.password
      WHERE id = v_user_id;
    ELSE
      INSERT INTO public.users (id, role, phone, username, password_hash)
      VALUES (NEW.id, 'admin', NEW.phone, NULL, NEW.password);
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS admin_panel_guard_trg ON admin_panel;
CREATE TRIGGER admin_panel_guard_trg
  BEFORE INSERT OR UPDATE ON admin_panel
  FOR EACH ROW EXECUTE FUNCTION admin_panel_guard();

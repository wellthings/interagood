-- Admin accounts for the website admin panel. Rows are created manually (SQL editor / dashboard).
-- Login needs ALL of: phone (verified with OTP), username, login_id and host, and they must belong to the same row.
-- RLS enabled with no policies: only the backend (service role) can read this table.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS admin_panel (
  id            UUID PRIMARY KEY,                       -- permanent admin id, entered manually
  phone         TEXT NOT NULL UNIQUE CHECK (phone ~ '^[6-9][0-9]{9}$'),
  username      TEXT NOT NULL UNIQUE CHECK (length(username) >= 3),
  login_id      TEXT NOT NULL UNIQUE CHECK (length(login_id) >= 3),
  host          TEXT NOT NULL CHECK (length(host) >= 4), -- secret value; stored as a bcrypt hash automatically
  is_active     BOOLEAN NOT NULL DEFAULT true,
  bound_at      TIMESTAMPTZ,                             -- set on the first successful login: the id is then locked to the values above
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE admin_panel ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION admin_panel_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions AS $$
BEGIN
  -- once bound, id / phone / username / login_id / host cannot change (set bound_at to NULL in the same update to reset on purpose)
  IF TG_OP = 'UPDATE' AND OLD.bound_at IS NOT NULL AND NEW.bound_at IS NOT NULL
     AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.phone IS DISTINCT FROM OLD.phone OR NEW.username IS DISTINCT FROM OLD.username
          OR NEW.login_id IS DISTINCT FROM OLD.login_id OR NEW.host IS DISTINCT FROM OLD.host) THEN
    RAISE EXCEPTION 'This admin is bound after first login. Set bound_at to NULL in the same update to change the login details.';
  END IF;
  -- store host as a bcrypt hash (a value that already looks like a hash is kept as is)
  IF NEW.host !~ '^\$2[aby]\$' THEN
    NEW.host := crypt(NEW.host, gen_salt('bf', 10));
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS admin_panel_guard_trg ON admin_panel;
CREATE TRIGGER admin_panel_guard_trg BEFORE INSERT OR UPDATE ON admin_panel
FOR EACH ROW EXECUTE FUNCTION admin_panel_guard();

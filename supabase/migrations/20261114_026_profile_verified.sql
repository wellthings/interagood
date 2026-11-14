-- 026 Partner verification flag: only a lean profile row is stored and a single
-- verified flag records whether the partner has the required readiness
-- (own tools/toolbox + complete work & pricing knowledge) to take orders.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE;
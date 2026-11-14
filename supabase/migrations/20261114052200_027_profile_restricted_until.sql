-- 027 Partner re-apply cooldown: an unverified partner is restricted from re-applying
-- for 7 days after their unverified submission. restricted_until holds the cooldown end.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS restricted_until TIMESTAMPTZ;
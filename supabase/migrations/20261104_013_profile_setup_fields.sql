-- Business profile (web signup): one shared profiles table for all four roles.
-- Role-specific columns stay NULL for roles that do not use them.
ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS ig_id VARCHAR(10),
    ADD COLUMN IF NOT EXISTS education VARCHAR(150),
    ADD COLUMN IF NOT EXISTS design_software VARCHAR(80),
    ADD COLUMN IF NOT EXISTS uses_boq_tools BOOLEAN,
    ADD COLUMN IF NOT EXISTS worked_with_team_before BOOLEAN;

-- experience_years: 0 means fresher; the old 4..20 check is replaced by 0..40
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'profiles'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%experience_years%'
  LOOP
    EXECUTE format('ALTER TABLE profiles DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE profiles ADD CONSTRAINT profiles_experience_years_check CHECK (experience_years BETWEEN 0 AND 40);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_ig_id ON profiles (ig_id) WHERE ig_id IS NOT NULL;

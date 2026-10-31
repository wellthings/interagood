-- Short caption describing the sample (the sample name is stored in the existing title column)
ALTER TABLE user_samples
    ADD COLUMN IF NOT EXISTS caption VARCHAR(300);

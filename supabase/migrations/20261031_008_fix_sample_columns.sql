-- Aligns user_samples with the API: caption is a plain string and price is a positive decimal.
-- 006/007 used ADD COLUMN IF NOT EXISTS, which silently kept pre-existing columns of the wrong type
-- (caption text[], price integer) and made every sample insert fail.
DO $$
BEGIN
    IF (SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_samples' AND column_name = 'caption') = 'ARRAY' THEN
        ALTER TABLE user_samples
            ALTER COLUMN caption TYPE VARCHAR(300) USING left(array_to_string(caption, ' '), 300);
    END IF;
END $$;

ALTER TABLE user_samples
    ALTER COLUMN price TYPE NUMERIC(12, 2);

ALTER TABLE user_samples
    DROP CONSTRAINT IF EXISTS user_samples_price_check;
ALTER TABLE user_samples
    ADD CONSTRAINT user_samples_price_check CHECK (price > 0);

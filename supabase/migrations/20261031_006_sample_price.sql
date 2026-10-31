-- Price tag for each uploaded sample: amount + unit chosen from a fixed list
ALTER TABLE user_samples
    ADD COLUMN IF NOT EXISTS price NUMERIC(12, 2) CHECK (price > 0),
    ADD COLUMN IF NOT EXISTS price_unit VARCHAR(20)
        CHECK (price_unit IN ('inch', 'sqfit', 'runningfit', 'pcs', 'bundle', 'combo', 'fit'));

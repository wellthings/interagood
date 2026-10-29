-- Allow flexible pincode lengths up to 20 characters
ALTER TABLE users ALTER COLUMN pincode TYPE VARCHAR(20);

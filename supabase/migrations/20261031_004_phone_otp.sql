-- Signup is now phone + OTP only; email is optional.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

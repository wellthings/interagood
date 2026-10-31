-- Signup is now phone + OTP only; email is optional.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- One row per phone holding the latest pending OTP (stored as an HMAC, never in plain text)
CREATE TABLE IF NOT EXISTS phone_otps (
    phone VARCHAR(20) PRIMARY KEY,
    otp_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    send_count INT NOT NULL DEFAULT 1,
    window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE phone_otps ENABLE ROW LEVEL SECURITY;

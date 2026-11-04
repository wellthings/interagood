-- One complete verification for everyone (Aadhaar front/back, live selfie, video call), replacing the offline/online choice.
ALTER TABLE profile_submissions DROP COLUMN IF EXISTS verification_mode;
ALTER TABLE profile_submissions ADD COLUMN IF NOT EXISTS video_call_slot TEXT;
ALTER TABLE profiles DROP COLUMN IF EXISTS verification_mode;

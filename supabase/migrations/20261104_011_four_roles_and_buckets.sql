-- Website signup: four roles (partner, supplier, architect, site_inspector) saved in users.role,
-- plus the two storage buckets used by the backend.
-- Requires the earlier migrations (001-010) to have created the users table.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
    ADD CONSTRAINT users_role_check
    CHECK (role IN ('partner', 'supplier', 'architect', 'site_inspector'));

-- Cards are listed per role, so keep the card index in step with the new roles
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- media: public uploads (banner, profile photo, samples). admin_uploads: private legal documents and guides.
INSERT INTO storage.buckets (id, name, public)
VALUES ('media', 'media', TRUE), ('admin_uploads', 'admin_uploads', FALSE)
ON CONFLICT (id) DO NOTHING;

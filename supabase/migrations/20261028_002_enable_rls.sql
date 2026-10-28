-- The backend uses the service_role key (bypasses RLS). Enabling RLS with no
-- policies blocks all direct access through Supabase's public anon key.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_ages ENABLE ROW LEVEL SECURITY;

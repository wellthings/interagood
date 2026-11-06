-- ========================================================
-- DATABASE SCHEMA FOR INTERAGOOD (by wellthings)
-- Compatible with Supabase PostgreSQL & Railway Postgres
-- ========================================================

-- Enable standard UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. USERS TABLE
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username VARCHAR(50) UNIQUE NOT NULL,
  phone VARCHAR(20) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(30) NOT NULL CHECK (role IN ('client', 'partner', 'supplier', 'architect', 'site_inspector', 'admin')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast user search
CREATE INDEX IF NOT EXISTS idx_users_username ON public.users(username);
CREATE INDEX IF NOT EXISTS idx_users_phone ON public.users(phone);
CREATE INDEX IF NOT EXISTS idx_users_role ON public.users(role);

-- 2. BUSINESS PROFILES TABLE
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
  ig_id VARCHAR(30) UNIQUE NOT NULL,
  legal_name VARCHAR(150) NOT NULL,
  business_name VARCHAR(150) NOT NULL,
  role VARCHAR(30) NOT NULL CHECK (role IN ('partner', 'supplier', 'architect', 'site_inspector')),
  category VARCHAR(100),
  age INTEGER,
  experience_years INTEGER,
  banner_url TEXT,
  profile_photo_url TEXT,
  location TEXT,
  
  -- Partner Assessment Specific Checklist (NULL for other 3 roles)
  work_knowledge BOOLEAN DEFAULT FALSE,
  has_team BOOLEAN DEFAULT FALSE,
  team_size INTEGER,
  team_photo_url TEXT,
  has_toolbox BOOLEAN DEFAULT FALSE,
  tools_photo_url TEXT,
  knows_measurement BOOLEAN DEFAULT FALSE,
  knows_pricing BOOLEAN DEFAULT FALSE,
  knows_customer_dealing BOOLEAN DEFAULT FALSE,
  can_explain_to_customer BOOLEAN DEFAULT FALSE,
  can_understand_requirements BOOLEAN DEFAULT FALSE,
  
  -- Verification & Onboarding status
  is_verified BOOLEAN DEFAULT TRUE,
  is_onboarded BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT FALSE,
  is_online BOOLEAN DEFAULT FALSE,
  
  -- Payment Details (PayU Onboarding Gateway)
  payment_status VARCHAR(20) DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid')),
  payment_amount NUMERIC(10,2) DEFAULT 0.00,
  payment_gateway VARCHAR(30) DEFAULT 'None',
  payment_datetime TIMESTAMP WITH TIME ZONE,
  payment_txnid VARCHAR(100),
  payment_phone VARCHAR(20),
  payment_username VARCHAR(50),
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_ig_id ON public.profiles(ig_id);
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON public.profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_status ON public.profiles(is_active, is_online);

-- 3. CLIENT ORDERS TABLE
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_number VARCHAR(30) UNIQUE NOT NULL,
  client_name VARCHAR(150) NOT NULL,
  client_phone VARCHAR(20) NOT NULL,
  client_email VARCHAR(150),
  address TEXT NOT NULL,
  city VARCHAR(100) NOT NULL,
  latitude NUMERIC(10,6),
  longitude NUMERIC(10,6),
  service_type VARCHAR(50) NOT NULL CHECK (service_type IN ('repair_fixing', 'full_interior')),
  scheduled_date DATE NOT NULL,
  scheduled_slot VARCHAR(20) NOT NULL CHECK (scheduled_slot IN ('morning', 'afternoon', 'evening')),
  items JSONB NOT NULL,
  estimated_total NUMERIC(10,2) NOT NULL,
  status VARCHAR(30) DEFAULT 'pending' CHECK (status IN ('pending', 'contacted', 'assigned', 'in_progress', 'completed', 'cancelled')),
  assigned_to VARCHAR(50), -- IG ID of the assigned professional
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_order_number ON public.orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_client_phone ON public.orders(client_phone);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);

-- 4. TRANSACTIONS TABLE (PayU Onboarding Logs)
CREATE TABLE IF NOT EXISTS public.transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.users(id),
  amount NUMERIC(10,2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'INR',
  gateway VARCHAR(30) DEFAULT 'PayU',
  txnid VARCHAR(100) UNIQUE NOT NULL,
  status VARCHAR(30) NOT NULL,
  response_payload JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_txnid ON public.transactions(txnid);

-- 5. AUTO-UPDATE TIMESTAMP FUNCTION
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_users_updated_at ON public.users;
CREATE TRIGGER trigger_users_updated_at
BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_profiles_updated_at ON public.profiles;
CREATE TRIGGER trigger_profiles_updated_at
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_orders_updated_at ON public.orders;
CREATE TRIGGER trigger_orders_updated_at
BEFORE UPDATE ON public.orders
FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

-- ========================================================
-- SEED DATA (For Immediate Testing on Supabase / Railway)
-- ========================================================

-- Insert Demo Admin
INSERT INTO public.users (id, username, phone, password_hash, role)
VALUES ('00000000-0000-0000-0000-000000000001', 'admin', '9811001122', 'admin123', 'admin')
ON CONFLICT (username) DO NOTHING;

-- Insert Demo Partner User & Profile
INSERT INTO public.users (id, username, phone, password_hash, role)
VALUES ('00000000-0000-0000-0000-000000000002', 'rajesh_carpenter', '9876543210', 'rajesh123', 'partner')
ON CONFLICT (username) DO NOTHING;

INSERT INTO public.profiles (
  id, user_id, ig_id, legal_name, business_name, role, category, age, experience_years,
  location, work_knowledge, has_team, team_size, has_toolbox, knows_measurement,
  knows_pricing, knows_customer_dealing, can_explain_to_customer, can_understand_requirements,
  is_verified, is_onboarded, is_active, is_online, payment_status, payment_amount,
  payment_gateway, payment_txnid, payment_phone, payment_username
)
VALUES (
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  'IG-PTR-82914',
  'Rajesh Kumar Verma',
  'Verma Premium Woodcraft & Interiors',
  'partner',
  'Carpenter',
  36,
  14,
  'Sector 50, Noida & Greater Noida',
  TRUE, TRUE, 6, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE,
  TRUE, TRUE, TRUE, TRUE, 'paid', 109.00,
  'PayU', 'PAYU_TXN_819203810', '9876543210', 'rajesh_carpenter'
)
ON CONFLICT (ig_id) DO NOTHING;

-- Insert Demo Supplier User & Profile
INSERT INTO public.users (id, username, phone, password_hash, role)
VALUES ('00000000-0000-0000-0000-000000000003', 'apex_plywood_delhi', '9822334455', 'supplier123', 'supplier')
ON CONFLICT (username) DO NOTHING;

INSERT INTO public.profiles (
  id, user_id, ig_id, legal_name, business_name, role, category, location,
  is_verified, is_onboarded, is_active, is_online, payment_status, payment_amount,
  payment_gateway, payment_txnid, payment_phone, payment_username
)
VALUES (
  '10000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003',
  'IG-SUP-19402',
  'Sanjay Aggarwal',
  'Apex Timber & Architectural Hardware',
  'supplier',
  'Plywood, Laminates & Hardware',
  'Kirti Nagar Timber Market, Delhi',
  TRUE, TRUE, TRUE, TRUE, 'paid', 219.00,
  'PayU', 'PAYU_TXN_991820491', '9822334455', 'apex_plywood_delhi'
)
ON CONFLICT (ig_id) DO NOTHING;

-- Insert Demo Orders
INSERT INTO public.orders (
  id, order_number, client_name, client_phone, client_email, address, city,
  service_type, scheduled_date, scheduled_slot, items, estimated_total, status, assigned_to
)
VALUES (
  '20000000-0000-0000-0000-000000000001',
  'IG-ORD-9021',
  'Priya Malhotra',
  '9810123456',
  'priya.malhotra@gmail.com',
  'Flat 402, Tower B, ATS Greens, Sector 50',
  'Noida',
  'full_interior',
  CURRENT_DATE + INTERVAL '5 days',
  'morning',
  '[{"choice":"full_interior","quantity":2,"service":{"id":"carp-1","name":"Modular Wardrobe & Storage Design","startingPrice":3499}}]',
  17495.00,
  'assigned',
  'IG-PTR-82914'
)
ON CONFLICT (order_number) DO NOTHING;

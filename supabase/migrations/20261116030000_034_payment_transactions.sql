-- 034: Create payment_transactions table for PayU payment verification, idempotency, and audit logs.
create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  txnid text not null unique,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null,
  purpose text not null default 'subscription',
  amount numeric(10, 2) not null,
  status text not null default 'pending' check (status in ('pending', 'success', 'failed', 'cancelled')),
  mihpayid text,
  mode text,
  return_origin text,
  raw_postback jsonb,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payment_transactions_user_id on public.payment_transactions(user_id);
create index if not exists idx_payment_transactions_status on public.payment_transactions(status);

alter table public.payment_transactions enable row level security;

drop policy if exists "Service role manages payment_transactions" on public.payment_transactions;
create policy "Service role manages payment_transactions"
  on public.payment_transactions
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

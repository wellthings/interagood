-- Live cart of a signed-in website client (mirrors what is in the cart right now; replaced on every change).
CREATE TABLE IF NOT EXISTS client_carts (
  client_id  UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  items      JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE client_carts ENABLE ROW LEVEL SECURITY;

-- One assignment per work type (category) of an order: a partner is assigned category-wise.
CREATE TABLE IF NOT EXISTS order_assignments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL REFERENCES cart_requests(id) ON DELETE CASCADE,
  work_type  TEXT NOT NULL,
  partner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status     TEXT NOT NULL DEFAULT 'unassigned' CHECK (status IN ('unassigned', 'assigned', 'completed', 'cancelled')),
  assigned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, work_type)
);
CREATE INDEX IF NOT EXISTS order_assignments_partner_idx ON order_assignments (partner_id);
ALTER TABLE order_assignments ENABLE ROW LEVEL SECURITY;

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS assignment_id UUID REFERENCES order_assignments(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS order_items_assignment_idx ON order_items (assignment_id);

-- backfill existing orders
INSERT INTO order_assignments (order_id, work_type)
SELECT DISTINCT order_id, work_type FROM order_items
ON CONFLICT (order_id, work_type) DO NOTHING;
UPDATE order_items i SET assignment_id = a.id
FROM order_assignments a WHERE a.order_id = i.order_id AND a.work_type = i.work_type AND i.assignment_id IS NULL;

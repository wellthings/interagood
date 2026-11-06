-- One row per selected item of an order (cart_requests = the order, order_items = what was selected).
-- RLS enabled with no policies: only the backend/admin (service role) can read or write.
ALTER TABLE cart_requests ADD COLUMN IF NOT EXISTS order_no BIGINT GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX IF NOT EXISTS cart_requests_order_no_idx ON cart_requests (order_no);

CREATE TABLE IF NOT EXISTS order_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID NOT NULL REFERENCES cart_requests(id) ON DELETE CASCADE,
  work_type        TEXT NOT NULL,
  work_unit        TEXT NOT NULL,
  requirement_type TEXT NOT NULL CHECK (requirement_type IN ('new', 'repair', 'full_interior')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

-- backfill orders placed before this table existed
INSERT INTO order_items (order_id, work_type, work_unit, requirement_type)
SELECT c.id, i->>'category', i->>'module', i->>'mode'
FROM cart_requests c, jsonb_array_elements(c.items) i
WHERE NOT EXISTS (SELECT 1 FROM order_items o WHERE o.order_id = c.id);

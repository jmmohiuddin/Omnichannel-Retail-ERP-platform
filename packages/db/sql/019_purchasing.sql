-- 019_purchasing.sql — purchasing v1: supplier → purchase order → receive
-- against PO. The supplier table already exists (002_catalog.sql); this adds
-- PO headers/lines, a gapless per-tenant PO counter (order_counter pattern,
-- 007_sales.sql), and finally attaches the FK for the dangling
-- stock_unit.purchase_order_id column left in 003_inventory.sql.

CREATE TABLE purchase_order (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    supplier_id  uuid NOT NULL REFERENCES supplier(id),
    po_no        text NOT NULL,
    location_id  uuid NOT NULL REFERENCES location(id),  -- receiving destination
    status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','placed','partially_received','received','cancelled')),
    currency     char(3) NOT NULL,
    expected_at  date,
    note         text,
    created_by   uuid NOT NULL REFERENCES app_user(id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    placed_at    timestamptz,
    UNIQUE (tenant_id, po_no)
);
CREATE INDEX purchase_order_supplier_idx ON purchase_order (tenant_id, supplier_id);
CREATE INDEX purchase_order_status_idx ON purchase_order (tenant_id, status);

CREATE TABLE purchase_order_line (
    po_id           uuid NOT NULL REFERENCES purchase_order(id) ON DELETE CASCADE,
    tenant_id       uuid NOT NULL REFERENCES tenant(id),
    variant_id      uuid NOT NULL REFERENCES variant(id),
    ordered_qty     numeric(14,3) NOT NULL CHECK (ordered_qty > 0),
    received_qty    numeric(14,3) NOT NULL DEFAULT 0,
    unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor >= 0),
    PRIMARY KEY (po_id, variant_id)
);

-- Gapless sequential PO numbers per tenant (same row-lock pattern as
-- order_counter in 007_sales.sql): the increment happens inside the same
-- transaction as the purchase_order insert, so rollbacks leave no gaps.
CREATE TABLE po_counter (
    tenant_id  uuid PRIMARY KEY REFERENCES tenant(id),
    last_no    bigint NOT NULL DEFAULT 0
);

-- 003_inventory.sql created stock_unit.purchase_order_id without a target
-- ("FK added when purchasing lands") — purchasing has landed.
ALTER TABLE stock_unit
    ADD CONSTRAINT stock_unit_po_fk
    FOREIGN KEY (purchase_order_id) REFERENCES purchase_order(id);

-- Row-level security (pattern from 001_foundation.sql)
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['purchase_order','purchase_order_line','po_counter']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I
             USING (tenant_id = current_tenant_id())
             WITH CHECK (tenant_id = current_tenant_id())', t);
    END LOOP;
END $$;

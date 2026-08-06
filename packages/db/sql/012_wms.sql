-- 012_wms.sql — v1 WMS: bin directory + guided picking.
--
-- Deliberately NOT quantity-per-bin: stock quantities remain in stock_level
-- (the ledger read-model from 003_inventory.sql). Bins are a directory that
-- tells pickers WHERE TO WALK for a variant — assigning or picking from a bin
-- never writes a quantity anywhere. Quantity-per-bin (and multi-bin allocation)
-- is a later WMS phase; introducing it would require bin-level movements in the
-- ledger, not a shortcut column here.
--
-- Pick lists guide fulfillment of reserved orders. Completing a pick list does
-- NOT move stock: the existing fulfillment flow (POST /v1/orders/:id/fulfill)
-- consumes the order's reservations (reserved → sale) in the ledger.

-- ---------------------------------------------------------------------------
-- Physical layout: zones within a location, bins within a zone.
-- position drives the picker's walking order.
-- ---------------------------------------------------------------------------
CREATE TABLE warehouse_zone (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    location_id  uuid NOT NULL REFERENCES location(id),
    code         text NOT NULL,                 -- short label on signage, e.g. 'A'
    name         text NOT NULL,
    position     int NOT NULL DEFAULT 0,        -- walking order within the location
    UNIQUE (tenant_id, location_id, code)
);

CREATE TABLE warehouse_bin (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    zone_id      uuid NOT NULL REFERENCES warehouse_zone(id) ON DELETE CASCADE,
    code         text NOT NULL,                 -- shelf/slot label, e.g. '03'
    position     int NOT NULL DEFAULT 0,        -- walking order within the zone
    UNIQUE (tenant_id, zone_id, code)
);

-- Which bins a variant lives in. Directory only — no quantities (see header).
CREATE TABLE bin_assignment (
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    bin_id       uuid NOT NULL REFERENCES warehouse_bin(id) ON DELETE CASCADE,
    variant_id   uuid NOT NULL REFERENCES variant(id) ON DELETE CASCADE,
    PRIMARY KEY (tenant_id, bin_id, variant_id)
);
CREATE INDEX bin_assignment_variant_idx ON bin_assignment (tenant_id, variant_id);

-- ---------------------------------------------------------------------------
-- Guided picking: one pick list per reserved order.
-- ---------------------------------------------------------------------------
CREATE TABLE pick_list (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    order_id     uuid NOT NULL REFERENCES sales_order(id),
    location_id  uuid NOT NULL REFERENCES location(id),
    status       text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','completed','cancelled')),
    created_by   uuid NOT NULL REFERENCES app_user(id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (tenant_id, order_id)               -- one pick list per order
);

CREATE TABLE pick_list_line (
    pick_list_id uuid NOT NULL REFERENCES pick_list(id) ON DELETE CASCADE,
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    variant_id   uuid NOT NULL REFERENCES variant(id),
    quantity     numeric(14,3) NOT NULL CHECK (quantity > 0),
    bin_path     text,                          -- precomputed "ZONE/BIN"; NULL = unassigned
    picked_qty   numeric(14,3),
    picked_by    uuid REFERENCES app_user(id),
    PRIMARY KEY (pick_list_id, variant_id)
);

-- ---------------------------------------------------------------------------
-- Row-level security (pattern from 001_foundation.sql)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['warehouse_zone','warehouse_bin','bin_assignment',
                             'pick_list','pick_list_line']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I
             USING (tenant_id = current_tenant_id())
             WITH CHECK (tenant_id = current_tenant_id())', t);
    END LOOP;
END $$;

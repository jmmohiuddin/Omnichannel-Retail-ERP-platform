-- 003_inventory.sql — the inventory ledger (ADR-002): movements, levels,
-- serialized units, reservations, adjustments, counts, transfers.

-- ---------------------------------------------------------------------------
-- Serialized units (phones etc.). One row per physical unit.
-- ---------------------------------------------------------------------------
CREATE TABLE stock_unit (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenant(id),
    variant_id     uuid NOT NULL REFERENCES variant(id),
    serial_no      text,
    imei1          text,
    imei2          text,
    batch_no       text,
    state          text NOT NULL DEFAULT 'in_stock'
                   CHECK (state IN ('inbound','in_stock','reserved','sold','returned_pending',
                                    'in_transit','in_repair','damaged','written_off')),
    location_id    uuid REFERENCES location(id),
    purchase_order_id uuid,                    -- FK added when purchasing lands
    unit_cost_minor bigint,
    warranty_until date,
    sold_order_id  uuid,                       -- set on sale
    activation_status text,
    notes          text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
-- IMEI/serial uniqueness per tenant (INV: "never permit duplicate IMEI records").
CREATE UNIQUE INDEX stock_unit_imei1_uq  ON stock_unit (tenant_id, imei1)  WHERE imei1  IS NOT NULL;
CREATE UNIQUE INDEX stock_unit_imei2_uq  ON stock_unit (tenant_id, imei2)  WHERE imei2  IS NOT NULL;
CREATE UNIQUE INDEX stock_unit_serial_uq ON stock_unit (tenant_id, variant_id, serial_no)
    WHERE serial_no IS NOT NULL;
CREATE INDEX stock_unit_lookup_idx ON stock_unit (tenant_id, variant_id, state, location_id);

-- ---------------------------------------------------------------------------
-- The ledger. Append-only; every stock change is one row.
-- A movement moves qty from (from_location, from_state) to (to_location, to_state);
-- receipts have no source, write-offs/sales have no destination bucket.
-- ---------------------------------------------------------------------------
CREATE TABLE stock_movement (
    id             uuid PRIMARY KEY,            -- client-generated UUIDv7 (idempotency)
    tenant_id      uuid NOT NULL REFERENCES tenant(id),
    seq            bigint GENERATED ALWAYS AS IDENTITY, -- global sync cursor
    occurred_at    timestamptz NOT NULL DEFAULT now(),
    movement_type  text NOT NULL CHECK (movement_type IN
                   ('receipt','sale','return_in','transfer_out','transfer_in',
                    'adjustment','reservation','release','write_off','count_correction',
                    'repair_out','repair_in')),
    variant_id     uuid NOT NULL REFERENCES variant(id),
    stock_unit_id  uuid REFERENCES stock_unit(id),  -- required when variant is serialized
    quantity       numeric(14,3) NOT NULL CHECK (quantity > 0),
    from_location_id uuid REFERENCES location(id),
    from_state     text,
    to_location_id uuid REFERENCES location(id),
    to_state       text,
    -- attribution: WHO did it, on WHAT device, WHY
    actor_user_id  uuid NOT NULL REFERENCES app_user(id),
    device_id      uuid REFERENCES device(id),
    reference_type text NOT NULL,               -- 'order','transfer','count','adjustment',…
    reference_id   uuid NOT NULL,
    approval_id    uuid,                        -- required for adjustment/write_off (trigger)
    unit_cost_minor bigint,
    note           text,
    CHECK (from_location_id IS NOT NULL OR to_location_id IS NOT NULL),
    CHECK (from_state IS NULL OR from_state IN
          ('on_hand','reserved','in_transit','damaged','returned_pending')),
    CHECK (to_state IS NULL OR to_state IN
          ('on_hand','reserved','in_transit','damaged','returned_pending'))
);
CREATE INDEX stock_movement_seq_idx ON stock_movement (tenant_id, seq);
CREATE INDEX stock_movement_variant_idx ON stock_movement (tenant_id, variant_id, occurred_at DESC);
CREATE INDEX stock_movement_ref_idx ON stock_movement (tenant_id, reference_type, reference_id);
CREATE INDEX stock_movement_actor_idx ON stock_movement (tenant_id, actor_user_id, occurred_at DESC);

CREATE TRIGGER stock_movement_immutable
    BEFORE UPDATE OR DELETE ON stock_movement
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Adjustments and write-offs must carry an approval (fraud control FP-linkage).
CREATE OR REPLACE FUNCTION enforce_movement_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.movement_type IN ('adjustment','write_off') AND NEW.approval_id IS NULL THEN
        RAISE EXCEPTION '% requires an approval_id', NEW.movement_type;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER stock_movement_approval
    BEFORE INSERT ON stock_movement
    FOR EACH ROW EXECUTE FUNCTION enforce_movement_approval();

-- ---------------------------------------------------------------------------
-- Materialized levels: read-model maintained in the same transaction as the
-- movement insert (by the application service). Verified against the ledger by
-- the drift-check job. Never written by anything except the movement poster.
-- ---------------------------------------------------------------------------
CREATE TABLE stock_level (
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    location_id  uuid NOT NULL REFERENCES location(id),
    variant_id   uuid NOT NULL REFERENCES variant(id),
    state        text NOT NULL CHECK (state IN
                 ('on_hand','reserved','in_transit','damaged','returned_pending')),
    quantity     numeric(14,3) NOT NULL DEFAULT 0,
    updated_seq  bigint NOT NULL,               -- last ledger seq applied
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, location_id, variant_id, state),
    -- On-hand/reserved can never be driven negative (oversell handled upstream).
    CHECK (quantity >= 0)
);
CREATE INDEX stock_level_variant_idx ON stock_level (tenant_id, variant_id);

-- ---------------------------------------------------------------------------
-- Reservations (orders/channels hold stock with TTL)
-- ---------------------------------------------------------------------------
CREATE TABLE stock_reservation (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    variant_id   uuid NOT NULL REFERENCES variant(id),
    stock_unit_id uuid REFERENCES stock_unit(id),
    location_id  uuid NOT NULL REFERENCES location(id),
    quantity     numeric(14,3) NOT NULL CHECK (quantity > 0),
    reference_type text NOT NULL,               -- 'order','cart','transfer'
    reference_id uuid NOT NULL,
    status       text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','consumed','released','expired')),
    expires_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_reservation_ref_idx ON stock_reservation (tenant_id, reference_type, reference_id);
CREATE INDEX stock_reservation_expiry_idx ON stock_reservation (expires_at)
    WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Approvals (manager sign-off for adjustments, write-offs, refunds, overrides)
-- ---------------------------------------------------------------------------
CREATE TABLE approval (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    kind          text NOT NULL,                -- 'stock_adjustment','refund','discount',…
    requested_by  uuid NOT NULL REFERENCES app_user(id),
    approved_by   uuid REFERENCES app_user(id),
    status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','expired')),
    payload       jsonb NOT NULL,               -- what is being approved (qty, reason, value)
    reason        text,
    requested_at  timestamptz NOT NULL DEFAULT now(),
    decided_at    timestamptz,
    CHECK (approved_by IS NULL OR approved_by <> requested_by)  -- no self-approval
);
ALTER TABLE stock_movement
    ADD CONSTRAINT stock_movement_approval_fk
    FOREIGN KEY (approval_id) REFERENCES approval(id);

-- ---------------------------------------------------------------------------
-- Transfers & counts (headers; lines reference these from movements)
-- ---------------------------------------------------------------------------
CREATE TABLE stock_transfer (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    from_location_id uuid NOT NULL REFERENCES location(id),
    to_location_id   uuid NOT NULL REFERENCES location(id),
    status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','dispatched','received','cancelled')),
    created_by    uuid NOT NULL REFERENCES app_user(id),
    dispatched_at timestamptz,
    received_at   timestamptz,
    note          text,
    CHECK (from_location_id <> to_location_id)
);

CREATE TABLE stock_count (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    location_id   uuid NOT NULL REFERENCES location(id),
    kind          text NOT NULL DEFAULT 'cycle' CHECK (kind IN ('cycle','full')),
    status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','review','posted','cancelled')),
    created_by    uuid NOT NULL REFERENCES app_user(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    posted_at     timestamptz
);

CREATE TABLE stock_count_line (
    count_id      uuid NOT NULL REFERENCES stock_count(id) ON DELETE CASCADE,
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    variant_id    uuid NOT NULL REFERENCES variant(id),
    expected_qty  numeric(14,3) NOT NULL,
    counted_qty   numeric(14,3),
    counted_by    uuid REFERENCES app_user(id),
    counted_at    timestamptz,
    PRIMARY KEY (count_id, variant_id)
);

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['stock_unit','stock_movement','stock_level','stock_reservation',
                             'approval','stock_transfer','stock_count','stock_count_line']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I
             USING (tenant_id = current_tenant_id())
             WITH CHECK (tenant_id = current_tenant_id())', t);
    END LOOP;
END $$;

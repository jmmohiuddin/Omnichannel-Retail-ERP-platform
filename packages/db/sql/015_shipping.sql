-- 015_shipping.sql — courier-agnostic outbound shipping.
--
-- A shipment is the hand-off of a FULFILLED order (goods already picked/packed;
-- the inventory ledger was settled at fulfillment — shipping never moves stock)
-- to an external courier. The courier itself sits behind the CourierPort
-- interface in the API (apps/api/src/shipping/courierPort.ts): v1 ships with a
-- mock courier; real UAE couriers — Aramex, SMSA, Quiqup, Careem Box — plug in
-- later as adapters without schema changes. `courier` stores the registry key
-- of the adapter that created the shipment ('mock', 'aramex', …).
--
-- cod_amount_minor: cash-on-delivery is the dominant e-commerce payment method
-- in the UAE launch market (docs/08) — amount the courier collects, in minor
-- units of the order currency (fils).

CREATE TABLE shipment (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenant(id),
    order_id         uuid NOT NULL REFERENCES sales_order(id),
    courier          text NOT NULL,              -- CourierPort registry key
    tracking_no      text NOT NULL,              -- courier-issued tracking number
    label_url        text,                       -- printable label, if the courier returns one
    status           text NOT NULL DEFAULT 'created'
                     CHECK (status IN ('created','handed_over','in_transit',
                                       'out_for_delivery','delivered','failed','returned')),
    address          jsonb NOT NULL DEFAULT '{}',-- destination snapshot at ship time
    cod_amount_minor bigint NOT NULL DEFAULT 0,
    created_by       uuid NOT NULL REFERENCES app_user(id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, order_id)                 -- v1: one shipment per order (no splits)
);
CREATE INDEX shipment_tracking_idx ON shipment (tenant_id, tracking_no);
CREATE INDEX shipment_status_idx ON shipment (tenant_id, status, created_at DESC);

-- Append-only tracking history mirrored from the courier (plus the local
-- 'created' event). `raw` keeps the courier's original payload for disputes.
CREATE TABLE shipment_event (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    shipment_id  uuid NOT NULL REFERENCES shipment(id) ON DELETE CASCADE,
    status       text NOT NULL,
    description  text,
    occurred_at  timestamptz NOT NULL DEFAULT now(),
    raw          jsonb
);
CREATE INDEX shipment_event_shipment_idx
    ON shipment_event (tenant_id, shipment_id, occurred_at);

-- Tracking history is evidence: rows are never updated or deleted
-- (forbid_change from 001_foundation.sql — same pattern as audit_log).
CREATE TRIGGER shipment_event_immutable
    BEFORE UPDATE OR DELETE ON shipment_event
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- Row-level security (pattern from 001_foundation.sql)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['shipment','shipment_event']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I
             USING (tenant_id = current_tenant_id())
             WITH CHECK (tenant_id = current_tenant_id())', t);
    END LOOP;
END $$;

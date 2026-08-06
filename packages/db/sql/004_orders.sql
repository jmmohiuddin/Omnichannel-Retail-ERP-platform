-- 004_orders.sql — customers, unified omnichannel orders, payments, refunds,
-- cash sessions, channels/connectors.

CREATE TABLE customer (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    full_name    text NOT NULL,
    email        citext,
    phone        text,
    addresses    jsonb NOT NULL DEFAULT '[]',
    loyalty_points bigint NOT NULL DEFAULT 0,
    credit_limit_minor bigint NOT NULL DEFAULT 0,
    notes        text,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_email_idx ON customer (tenant_id, email) WHERE email IS NOT NULL;
CREATE INDEX customer_phone_idx ON customer (tenant_id, phone) WHERE phone IS NOT NULL;

-- Sales channels: pos | web | mobile | wholesale | marketplace connectors
CREATE TABLE channel (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    kind         text NOT NULL CHECK (kind IN
                 ('pos','web','mobile','wholesale','marketplace','social','custom')),
    name         text NOT NULL,
    connector    text,                          -- 'shopify','daraz',… NULL for native
    config       jsonb NOT NULL DEFAULT '{}',   -- non-secret config
    credentials_enc bytea,                      -- encrypted per-tenant credentials
    status       text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','paused','error','disconnected')),
    UNIQUE (tenant_id, name)
);

CREATE TABLE sales_order (
    id             uuid PRIMARY KEY,             -- client-generated for POS idempotency
    tenant_id      uuid NOT NULL REFERENCES tenant(id),
    order_no       text NOT NULL,                -- human-readable per-tenant sequence
    channel_id     uuid NOT NULL REFERENCES channel(id),
    external_ref   text,                         -- marketplace order id
    location_id    uuid REFERENCES location(id), -- fulfilling/selling location
    customer_id    uuid REFERENCES customer(id),
    cashier_user_id uuid REFERENCES app_user(id),-- REQUIRED for POS sales (trigger below)
    device_id      uuid REFERENCES device(id),
    status         text NOT NULL DEFAULT 'pending' CHECK (status IN
                   ('pending','confirmed','fulfilling','fulfilled','completed',
                    'cancelled','refunded','partially_refunded')),
    currency       char(3) NOT NULL,
    subtotal_minor bigint NOT NULL DEFAULT 0,
    discount_minor bigint NOT NULL DEFAULT 0,
    tax_minor      bigint NOT NULL DEFAULT 0,
    shipping_minor bigint NOT NULL DEFAULT 0,
    total_minor    bigint NOT NULL DEFAULT 0,
    placed_at      timestamptz NOT NULL DEFAULT now(),
    completed_at   timestamptz,
    offline_created boolean NOT NULL DEFAULT false, -- born offline at POS
    meta           jsonb NOT NULL DEFAULT '{}',
    UNIQUE (tenant_id, order_no),
    UNIQUE (tenant_id, channel_id, external_ref)
);
CREATE INDEX sales_order_channel_idx ON sales_order (tenant_id, channel_id, placed_at DESC);
CREATE INDEX sales_order_customer_idx ON sales_order (tenant_id, customer_id);

-- POS sales must be attributable to an authenticated employee (fraud control).
CREATE OR REPLACE FUNCTION enforce_pos_attribution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM channel c
               WHERE c.id = NEW.channel_id AND c.kind = 'pos')
       AND (NEW.cashier_user_id IS NULL OR NEW.device_id IS NULL) THEN
        RAISE EXCEPTION 'POS orders require cashier_user_id and device_id';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER sales_order_pos_attribution
    BEFORE INSERT ON sales_order
    FOR EACH ROW EXECUTE FUNCTION enforce_pos_attribution();

CREATE TABLE sales_order_line (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenant(id),
    order_id       uuid NOT NULL REFERENCES sales_order(id) ON DELETE CASCADE,
    variant_id     uuid NOT NULL REFERENCES variant(id),
    stock_unit_id  uuid REFERENCES stock_unit(id), -- the exact phone sold (serialized)
    description    text NOT NULL,                  -- denormalized for receipt integrity
    quantity       numeric(14,3) NOT NULL CHECK (quantity > 0),
    unit_price_minor bigint NOT NULL,
    discount_minor bigint NOT NULL DEFAULT 0,
    discount_approval_id uuid REFERENCES approval(id), -- required past cashier band
    tax_minor      bigint NOT NULL DEFAULT 0,
    total_minor    bigint NOT NULL
);
CREATE INDEX sales_order_line_order_idx ON sales_order_line (tenant_id, order_id);

CREATE TABLE payment (
    id            uuid PRIMARY KEY,
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    order_id      uuid NOT NULL REFERENCES sales_order(id),
    method        text NOT NULL CHECK (method IN
                  ('cash','card','mobile_wallet','bank_transfer','gift_card',
                   'loyalty_points','store_credit','gateway')),
    gateway       text,                            -- 'stripe','sslcommerz','bkash',…
    gateway_ref   text,                            -- token/charge id — never PANs
    amount_minor  bigint NOT NULL CHECK (amount_minor <> 0), -- negative = refund leg
    currency      char(3) NOT NULL,
    status        text NOT NULL DEFAULT 'captured' CHECK (status IN
                  ('pending','authorized','captured','failed','refunded','voided')),
    received_by   uuid REFERENCES app_user(id),
    cash_session_id uuid,                          -- FK added below
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_order_idx ON payment (tenant_id, order_id);

CREATE TABLE refund (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    order_id      uuid NOT NULL REFERENCES sales_order(id),
    amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
    reason        text NOT NULL,
    requested_by  uuid NOT NULL REFERENCES app_user(id),
    approval_id   uuid REFERENCES approval(id),    -- required above threshold (app-enforced)
    status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','processed')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    processed_at  timestamptz
);

-- Cash sessions: register open/close with blind reconciliation
CREATE TABLE cash_session (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenant(id),
    device_id      uuid NOT NULL REFERENCES device(id),
    opened_by      uuid NOT NULL REFERENCES app_user(id),
    closed_by      uuid REFERENCES app_user(id),
    opening_float_minor bigint NOT NULL,
    declared_close_minor bigint,                   -- cashier's blind count
    expected_close_minor bigint,                   -- system-computed at close
    variance_minor bigint,
    status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    opened_at      timestamptz NOT NULL DEFAULT now(),
    closed_at      timestamptz
);
ALTER TABLE payment
    ADD CONSTRAINT payment_cash_session_fk
    FOREIGN KEY (cash_session_id) REFERENCES cash_session(id);

-- Channel listing state (what's published where, sync cursor per channel)
CREATE TABLE channel_listing (
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    channel_id    uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
    variant_id    uuid NOT NULL REFERENCES variant(id) ON DELETE CASCADE,
    external_id   text,                            -- listing/product id on the channel
    published     boolean NOT NULL DEFAULT false,
    price_minor   bigint,                          -- channel price override
    buffer_qty    numeric(14,3) NOT NULL DEFAULT 0,-- safety stock held back
    last_synced_seq bigint,                        -- ledger cursor last pushed
    last_synced_at timestamptz,
    sync_error    text,
    PRIMARY KEY (tenant_id, channel_id, variant_id)
);

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['customer','channel','sales_order','sales_order_line',
                             'payment','refund','cash_session','channel_listing']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I
             USING (tenant_id = current_tenant_id())
             WITH CHECK (tenant_id = current_tenant_id())', t);
    END LOOP;
END $$;

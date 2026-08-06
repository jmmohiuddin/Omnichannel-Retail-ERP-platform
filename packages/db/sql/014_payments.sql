-- 014_payments.sql — gateway payment intents + webhook idempotency.
-- The ERP never touches PANs: intents reference the gateway's hosted page /
-- token, and webhooks (HMAC-verified) drive state (docs/08 §4, PCI SAQ-A).

CREATE TABLE payment_intent (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    order_id      uuid NOT NULL REFERENCES sales_order(id),
    gateway       text NOT NULL,                -- 'mock','ngenius','telr','stripe',…
    gateway_ref   text NOT NULL,                -- gateway's id for this intent
    amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
    currency      char(3) NOT NULL,
    status        text NOT NULL DEFAULT 'created'
                  CHECK (status IN ('created','processing','succeeded','failed','cancelled')),
    redirect_url  text,                          -- hosted checkout page
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (gateway, gateway_ref)
);
-- One live intent per order at a time.
CREATE UNIQUE INDEX payment_intent_active_uq ON payment_intent (tenant_id, order_id)
    WHERE status IN ('created','processing');

-- Processed webhook deliveries: dedupe key for at-least-once gateway retries.
CREATE TABLE webhook_delivery (
    gateway      text NOT NULL,
    external_id  text NOT NULL,                  -- gateway's event id
    received_at  timestamptz NOT NULL DEFAULT now(),
    payload      jsonb NOT NULL,
    PRIMARY KEY (gateway, external_id)
);

ALTER TABLE payment_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_intent FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_intent
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());
-- webhook_delivery is platform-scoped (no tenant column): webhooks arrive
-- before the tenant is known; the intent lookup provides tenancy. The app
-- role may read/write it without a GUC.

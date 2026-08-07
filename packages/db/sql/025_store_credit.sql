-- 025_store_credit.sql — store credit as a distinct instrument.
--
-- Loyalty gives points that convert to cash value at a configured rate.
-- Gift cards are transferable codes with their own balances.
-- Store credit is DIRECT MONEY attached to a specific customer — the natural
-- outcome of refunds when the shopper prefers store credit over cash back, or
-- of goodwill gestures from a manager. The `payment.method = 'store_credit'`
-- value is already in the payment CHECK (004_orders.sql); this just adds the
-- ledger behind it, mirroring the gift-card / loyalty design.

CREATE TABLE store_credit_account (
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    customer_id   uuid NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
    balance_minor bigint NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
    currency      char(3) NOT NULL,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, customer_id)
);

CREATE TABLE store_credit_transaction (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    customer_id   uuid NOT NULL REFERENCES customer(id),
    order_id      uuid REFERENCES sales_order(id),
    kind          text NOT NULL CHECK (kind IN ('issue','redeem','adjust')),
    amount_minor  bigint NOT NULL CHECK (amount_minor <> 0),  -- signed
    reason        text NOT NULL,
    actor_user_id uuid REFERENCES app_user(id),
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER store_credit_transaction_immutable
    BEFORE UPDATE OR DELETE ON store_credit_transaction
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Idempotent redemption: a replayed sale must never double-debit.
CREATE UNIQUE INDEX store_credit_redeem_once_uq
    ON store_credit_transaction (tenant_id, order_id, customer_id, kind)
    WHERE order_id IS NOT NULL AND kind = 'redeem';

CREATE INDEX store_credit_customer_idx
    ON store_credit_transaction (tenant_id, customer_id, created_at DESC);

ALTER TABLE store_credit_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_credit_account FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON store_credit_account
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE store_credit_transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_credit_transaction FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON store_credit_transaction
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

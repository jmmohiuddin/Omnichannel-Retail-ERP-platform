-- 013_loyalty.sql — loyalty ledger. customer.loyalty_points is a derived
-- balance maintained in the same transaction as each loyalty_transaction row
-- (same read-model pattern as stock_level vs stock_movement).

CREATE TABLE loyalty_transaction (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenant(id),
    customer_id uuid NOT NULL REFERENCES customer(id),
    order_id    uuid REFERENCES sales_order(id),
    kind        text NOT NULL CHECK (kind IN ('earn','redeem','adjust')),
    points      bigint NOT NULL CHECK (points <> 0),  -- signed: earn>0, redeem<0
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
-- One earn per order (idempotent accrual); redeems are keyed to the order too.
CREATE UNIQUE INDEX loyalty_earn_once_uq ON loyalty_transaction (tenant_id, order_id, kind)
    WHERE order_id IS NOT NULL AND kind IN ('earn','redeem');
CREATE INDEX loyalty_customer_idx ON loyalty_transaction (tenant_id, customer_id, created_at DESC);

CREATE TRIGGER loyalty_transaction_immutable
    BEFORE UPDATE OR DELETE ON loyalty_transaction
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE loyalty_transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_transaction FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON loyalty_transaction
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Balance can never go negative.
ALTER TABLE customer ADD CONSTRAINT customer_loyalty_nonneg CHECK (loyalty_points >= 0);

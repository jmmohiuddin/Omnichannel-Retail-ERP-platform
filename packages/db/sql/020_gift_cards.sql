-- 020_gift_cards.sql — gift cards v1. Same ledger discipline as loyalty
-- (013_loyalty.sql): gift_card.balance_minor is a derived balance maintained
-- in the same transaction as each immutable gift_card_transaction row.
-- Codes are stored upper-case; lookups normalise with upper() at the edge.

CREATE TABLE gift_card (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenant(id),
    code            text NOT NULL,                       -- stored UPPER
    balance_minor   bigint NOT NULL CHECK (balance_minor >= 0),
    initial_minor   bigint NOT NULL CHECK (initial_minor > 0),
    currency        char(3) NOT NULL,
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','depleted','cancelled')),
    issued_by       uuid NOT NULL REFERENCES app_user(id),
    issued_order_id uuid REFERENCES sales_order(id),     -- when sold at POS
    expires_at      date,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, code)
);
CREATE INDEX gift_card_status_idx ON gift_card (tenant_id, status);

CREATE TABLE gift_card_transaction (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    gift_card_id  uuid NOT NULL REFERENCES gift_card(id),
    order_id      uuid REFERENCES sales_order(id),
    kind          text NOT NULL CHECK (kind IN ('issue','redeem','adjust','cancel')),
    amount_minor  bigint NOT NULL CHECK (amount_minor <> 0), -- signed: issue>0, redeem<0
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
-- One redemption per (order, card): offline POS replay of the same sale must
-- not double-debit (same idempotency pattern as loyalty_earn_once_uq).
CREATE UNIQUE INDEX gift_card_redeem_once_uq
    ON gift_card_transaction (tenant_id, order_id, gift_card_id, kind)
    WHERE order_id IS NOT NULL AND kind = 'redeem';
CREATE INDEX gift_card_txn_card_idx
    ON gift_card_transaction (tenant_id, gift_card_id, created_at DESC);

-- Ledger rows are immutable (trigger from 001_foundation.sql).
CREATE TRIGGER gift_card_transaction_immutable
    BEFORE UPDATE OR DELETE ON gift_card_transaction
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Row-level security (pattern from 001_foundation.sql)
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['gift_card','gift_card_transaction']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I
             USING (tenant_id = current_tenant_id())
             WITH CHECK (tenant_id = current_tenant_id())', t);
    END LOOP;
END $$;

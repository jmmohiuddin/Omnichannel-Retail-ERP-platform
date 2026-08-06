-- 007_sales.sql — UAE tax fields + gapless per-tenant order numbering

-- TRN (Tax Registration Number) shown on tax invoices; VAT rate is table-driven
-- (FTA changes by decree, not by deploy). Basis points: 500 = 5%.
ALTER TABLE tenant ADD COLUMN trn text;
ALTER TABLE tenant ADD COLUMN vat_rate_bp int NOT NULL DEFAULT 500;

-- Gapless sequential order numbers per tenant (FTA-friendly invoice numbering).
-- A plain sequence can leave gaps on rollback; this row-lock counter cannot:
-- the increment happens inside the same transaction as the order insert.
CREATE TABLE order_counter (
    tenant_id  uuid PRIMARY KEY REFERENCES tenant(id),
    last_no    bigint NOT NULL DEFAULT 0
);

ALTER TABLE order_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_counter FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_counter
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

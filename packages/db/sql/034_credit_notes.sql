-- 034_credit_notes.sql — credit notes with their own gapless sequence (R7.8).
--
-- THE GAP: refunds move money and stock and update the order's status, but no
-- tax document is produced. Under UAE VAT a refund or return against a tax
-- invoice requires a TAX CREDIT NOTE — it is the instrument that reverses the
-- output tax, and without one the VAT on a refunded sale has been collected
-- and never given back on the return. R7.8 requires "credit notes with their
-- own gapless sequence, linked to the original invoice."
--
-- THREE THINGS THAT ARE EASY TO GET WRONG, and how this schema handles them:
--
-- 1. GAPLESS, AND SEPARATE. Tax authorities require sequential numbering with
--    no gaps, and a credit note sequence is its own series — CN-000001 is not
--    a number in the INV- series. A Postgres SEQUENCE cannot be used for
--    either: `nextval` does not roll back, so an aborted transaction burns a
--    number and leaves a hole. The existing `order_counter` row-lock pattern
--    (007_sales.sql) is exactly right and is reused here rather than
--    reinvented — the increment happens inside the same transaction as the
--    insert, so a rollback un-consumes the number.
--
-- 2. THE TAX TREATMENT MUST MIRROR THE ORIGINAL. PRD §10 lists this as an
--    edge case: "Return of a serialised unit sold under RCM → credit note
--    mirrors the original tax treatment." A handset sold under the domestic
--    reverse charge carried no VAT, so crediting it must also carry no VAT.
--    Re-deriving the treatment from today's rules would be wrong — the
--    buyer's declaration may since have been revoked, the VAT rate may have
--    changed by decree. The credit note therefore COPIES the invoice's
--    treatment rather than recomputing it, which is why tax_category and
--    tax_rate_bp are stored per line here too.
--
-- 3. A CREDIT NOTE IS IMMUTABLE. It is a filed tax document. Corrections are
--    made by issuing another document, never by editing this one — the same
--    discipline as stock_movement and audit_log.

-- ---------------------------------------------------------------------------
-- 1. The gapless counter (its own series)
-- ---------------------------------------------------------------------------
CREATE TABLE credit_note_counter (
    tenant_id  uuid PRIMARY KEY REFERENCES tenant(id),
    last_no    bigint NOT NULL DEFAULT 0
);

ALTER TABLE credit_note_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_note_counter FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_note_counter
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- 2. The credit note
-- ---------------------------------------------------------------------------
CREATE TABLE credit_note (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    note_no       text NOT NULL,

    -- R7.8: "linked to the original invoice". NOT NULL — a credit note that
    -- does not say what it credits is not a valid tax document.
    order_id      uuid NOT NULL REFERENCES sales_order(id),
    -- The refund that caused it, when there was one. Nullable because a
    -- credit note can also be issued to correct an invoice with no money
    -- moving (a mis-priced line, a wrongly taxed supply).
    refund_id     uuid REFERENCES refund(id),

    issued_at     timestamptz NOT NULL DEFAULT now(),
    issued_by     uuid NOT NULL REFERENCES app_user(id),
    reason        text NOT NULL,

    currency      char(3) NOT NULL,
    -- POSITIVE amounts. The document's direction is carried by its type, not
    -- by a sign — this is how invoices and credit notes are presented on a
    -- VAT return, and storing negatives here would double-negate the moment
    -- anyone sums the two tables together.
    subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
    tax_minor      bigint NOT NULL CHECK (tax_minor >= 0),
    total_minor    bigint NOT NULL CHECK (total_minor >= 0),

    -- Copied from the invoice, never recomputed (see header note 2).
    tax_treatment text NOT NULL DEFAULT 'standard'
        CHECK (tax_treatment IN ('standard','reverse_charge','mixed')),
    buyer_trn        text CHECK (buyer_trn IS NULL OR buyer_trn ~ '^[0-9]{15}$'),
    buyer_legal_name text,
    buyer_address    jsonb,
    -- The emirate of the original supply, so the credit lands in the same
    -- Box 1 line of the VAT return that the invoice did (R7.6).
    emirate       emirate_code,

    UNIQUE (tenant_id, note_no)
);

CREATE INDEX credit_note_order_idx ON credit_note (tenant_id, order_id);
CREATE INDEX credit_note_issued_idx ON credit_note (tenant_id, issued_at DESC);

-- Immutable: a filed tax document is corrected by issuing another, never by
-- editing it. The trigger, not the grant, is what guarantees this — the app
-- role has UPDATE/DELETE on every table by default (006).
CREATE TRIGGER credit_note_immutable
    BEFORE UPDATE OR DELETE ON credit_note
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE credit_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_note FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_note
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- 3. Credit note lines
-- ---------------------------------------------------------------------------
CREATE TABLE credit_note_line (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenant(id),
    credit_note_id uuid NOT NULL REFERENCES credit_note(id) ON DELETE CASCADE,
    -- Which invoice line is being credited. Nullable for a credit that has no
    -- single originating line (a whole-order goodwill adjustment).
    order_line_id  uuid REFERENCES sales_order_line(id),
    variant_id     uuid REFERENCES variant(id),
    stock_unit_id  uuid REFERENCES stock_unit(id),

    description    text NOT NULL,
    quantity       numeric(14,3) NOT NULL CHECK (quantity > 0),
    unit_price_minor bigint NOT NULL,
    tax_minor      bigint NOT NULL DEFAULT 0,
    total_minor    bigint NOT NULL,

    -- Mirrored from the invoice line (header note 2). A reverse-charged sale
    -- credits back reverse-charged, carrying no VAT.
    tax_category   text NOT NULL DEFAULT 'S'
        CHECK (tax_category IN ('S','Z','E','O','AE')),
    tax_rate_bp    int NOT NULL DEFAULT 0
        CHECK (tax_rate_bp >= 0 AND tax_rate_bp <= 10000),

    -- Same identity the invoice line carries: no VAT rate, no VAT amount.
    CONSTRAINT credit_note_line_zero_rate_zero_tax CHECK (
        tax_rate_bp > 0 OR tax_minor = 0
    )
);

CREATE INDEX credit_note_line_parent_idx ON credit_note_line (tenant_id, credit_note_id);

CREATE TRIGGER credit_note_line_immutable
    BEFORE UPDATE OR DELETE ON credit_note_line
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE credit_note_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_note_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_note_line
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------
-- Explicit rather than relying on ALTER DEFAULT PRIVILEGES from 006, which a
-- future change of migration ownership would silently stop covering.
GRANT SELECT, INSERT, UPDATE, DELETE ON credit_note_counter TO omniretail_app;
GRANT SELECT, INSERT ON credit_note TO omniretail_app;
GRANT SELECT, INSERT ON credit_note_line TO omniretail_app;

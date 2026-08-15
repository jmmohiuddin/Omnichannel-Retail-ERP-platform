-- 033_reverse_charge.sql — domestic reverse charge for electronic devices
-- (R7.3, R7.3a) and the business-buyer record it rests on (R9.3).
--
-- Cabinet Decision 91/2023, in force 30 October 2023: where a UAE VAT
-- registrant supplies mobile phones, smart phones, computer devices, tablets,
-- or pieces and parts thereof to another UAE registrant who declares it is
-- buying them to resell or to produce/manufacture such devices, the supplier
-- charges NO VAT and the buyer accounts for it.
--
-- WHY THIS IS A SCHEMA CONCERN AND NOT JUST A CALCULATION. Three of the four
-- statutory conditions are FACTS THAT MUST BE RETAINED, not values computed
-- at tender time:
--   * the buyer's written declaration, with both of its required limbs;
--   * the supplier's VERIFICATION of the buyer's registration (R7.3a — the
--     declaration alone is expressly not sufficient);
--   * which lines the treatment was actually applied to.
-- If an FTA audit lands in 2029 asking why VAT was not charged on an invoice
-- from 2026, the answer has to be readable out of this database. Getting it
-- wrong leaves the shop liable for the VAT it did not collect, so the record
-- is the point.
--
-- The DECISION logic — which conditions gate the treatment, which lines
-- qualify, what the fallback is — lives in `packages/domain/src/reverseCharge.ts`
-- and is not duplicated here. This migration stores facts and constrains them;
-- it does not re-implement the rule (CLAUDE.md: the domain core owns the
-- invariants, apps and SQL never re-derive them).
--
-- Retention: R7.12 requires 5 years general and 10 years for capital-asset
-- records, extensible while a dispute is open. Nothing here is ever deleted
-- by the application; the declaration is superseded by a new row, never
-- overwritten.

-- ---------------------------------------------------------------------------
-- 1. Which products are "electronic devices" under CD 91/2023
-- ---------------------------------------------------------------------------
-- NULL means "not a qualifying electronic device" — an accessory, a SIM, a
-- service. That is the overwhelmingly common case, so it is the default, and
-- a shop that never sells B2B never has to touch this column.
--
-- Deliberately NOT derived from category: categories are a merchandising tree
-- the merchant reorganises at will, and a tax treatment must not silently
-- change because someone renamed a category. This is a separate, explicit,
-- tax-purpose classification.
ALTER TABLE product
    ADD COLUMN device_class text
        CHECK (device_class IS NULL OR device_class IN (
            'mobile_phone',   -- CD 91/2023: mobile phones
            'smart_phone',    -- smart phones
            'computer',       -- computer devices
            'tablet',         -- tablets
            'part'            -- "pieces and parts thereof"
        ));

COMMENT ON COLUMN product.device_class IS
    'Electronic-device class under UAE Cabinet Decision 91/2023, or NULL when '
    'the product is not a qualifying device. Drives per-line reverse-charge '
    'eligibility; the rule itself lives in packages/domain/src/reverseCharge.ts.';

-- ---------------------------------------------------------------------------
-- 2. The business buyer (R9.3)
-- ---------------------------------------------------------------------------
-- R9.3: "Business customer fields: legal name, TRN, address, resale
-- declaration on file with its date." `customer.full_name` is the contact
-- person; a tax invoice needs the LEGAL entity name, and the two differ
-- (Yusuf Rahman buying for Gulf Devices Trading L.L.C).
ALTER TABLE customer
    ADD COLUMN is_business  boolean NOT NULL DEFAULT false,
    ADD COLUMN legal_name   text,
    ADD COLUMN trn          text,
    -- Structured, because R7.2's full tax invoice and R7.9's PINT AE model
    -- both need the address in parts, not as one free-text blob.
    ADD COLUMN billing_address jsonb;

-- A UAE TRN is 15 digits. Constrained rather than merely documented: a TRN
-- typed with spaces or a trailing letter reaches the invoice and the FTA
-- Audit File, and is not something anyone re-checks by eye.
ALTER TABLE customer
    ADD CONSTRAINT customer_trn_format
        CHECK (trn IS NULL OR trn ~ '^[0-9]{15}$');

-- A business buyer must be nameable on an invoice. Enforced as a constraint
-- rather than left to the application, because the invoice is generated from
-- these rows months later, when the capture path is long out of scope.
ALTER TABLE customer
    ADD CONSTRAINT customer_business_has_legal_name
        CHECK (NOT is_business OR legal_name IS NOT NULL);

CREATE INDEX customer_trn_idx ON customer (tenant_id, trn) WHERE trn IS NOT NULL;

-- The shop's own address. R7.1 requires supplier name, address AND TRN on
-- even a simplified consumer receipt; `tenant.trn` exists (007) but there has
-- never been anywhere to put the address, so every receipt printed to date is
-- missing a mandatory field.
ALTER TABLE tenant
    ADD COLUMN address jsonb;

COMMENT ON COLUMN tenant.address IS
    'Supplier address for R7.1 — mandatory on every tax invoice, simplified '
    'or full. Structured (line1/line2/city/emirate/country) so PINT AE (R7.9) '
    'can emit it without parsing.';

-- ---------------------------------------------------------------------------
-- 3. The declaration and its verification
-- ---------------------------------------------------------------------------
-- Append-mostly: a declaration is superseded by capturing a new one, never
-- edited. `revoked_at` is the one mutable field — a buyer who stops being
-- registered must stop qualifying, and back-dating that would be falsifying
-- the record, so revocation is additive rather than a delete.
CREATE TABLE rcm_declaration (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    customer_id   uuid NOT NULL REFERENCES customer(id),

    -- Snapshotted, not joined. The invoice must show what the buyer declared
    -- ON THE DAY; a later edit to the customer record must not rewrite the
    -- evidence behind a sale that has already been filed.
    trn           text NOT NULL CHECK (trn ~ '^[0-9]{15}$'),
    legal_name    text NOT NULL,
    address       jsonb,

    -- The two limbs of CD 91/2023, stored separately because they fail for
    -- different reasons and the cashier is told which (R7.3 acceptance).
    declares_resale_or_manufacture boolean NOT NULL,
    declares_fta_registered        boolean NOT NULL,

    -- The exact wording the buyer agreed to, retained verbatim. A declaration
    -- is only evidence if we can show what was declared; the template text
    -- lives in the domain package and may be revised, so it is copied here.
    declaration_text text NOT NULL,
    declaration_locale text NOT NULL DEFAULT 'en'
        CHECK (declaration_locale IN ('en','ar')),

    -- ---- R7.3a: the supplier's own verification ----
    -- The clause that is easy to miss: retaining the buyer's declaration is
    -- expressly NOT sufficient — the supplier must verify the registration by
    -- a means approved by the FTA.
    --
    -- PRD Q10 is OPEN: which verification means a retailer actually has at
    -- the counter is unresolved. That blocks the automation, not the record.
    -- 'unavailable' is therefore a first-class outcome, distinct from
    -- 'failed': it means we tried and no means was reachable. Neither one
    -- qualifies the sale — only 'verified' does — but they are different
    -- facts and an auditor will want to see which.
    verification_method  text
        CHECK (verification_method IS NULL OR verification_method IN
               ('fta_portal','certificate','other')),
    verification_outcome text
        CHECK (verification_outcome IS NULL OR verification_outcome IN
               ('verified','failed','unavailable')),
    -- Portal reference, certificate file id, or a note — whatever evidence
    -- the chosen method produced.
    verification_ref     text,
    verified_by_user_id  uuid REFERENCES app_user(id),
    verified_at          timestamptz,

    captured_by_user_id  uuid NOT NULL REFERENCES app_user(id),
    captured_at   timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz,
    revoked_reason text,

    -- A verification outcome without its metadata is not evidence.
    CONSTRAINT rcm_declaration_verification_complete CHECK (
        verification_outcome IS NULL
        OR (verification_method IS NOT NULL AND verified_at IS NOT NULL
            AND verified_by_user_id IS NOT NULL)
    )
);

-- The lookup the till does: this customer's current, usable declaration.
CREATE INDEX rcm_declaration_active_idx
    ON rcm_declaration (tenant_id, customer_id, captured_at DESC)
    WHERE revoked_at IS NULL;

ALTER TABLE rcm_declaration ENABLE ROW LEVEL SECURITY;
ALTER TABLE rcm_declaration FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rcm_declaration
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- 4. Tax treatment on the sale
-- ---------------------------------------------------------------------------
ALTER TABLE sales_order
    -- 'mixed' is not a hedge: a handset (reverse-charged) and its case
    -- (standard-rated) on one invoice is the normal B2B basket, and the
    -- invoice must show both treatments.
    ADD COLUMN tax_treatment text NOT NULL DEFAULT 'standard'
        CHECK (tax_treatment IN ('standard','reverse_charge','mixed')),
    -- Snapshotted buyer identity, for the same reason as on the declaration:
    -- the invoice is evidence of what was true when it was issued.
    ADD COLUMN buyer_trn        text
        CHECK (buyer_trn IS NULL OR buyer_trn ~ '^[0-9]{15}$'),
    ADD COLUMN buyer_legal_name text,
    ADD COLUMN buyer_address    jsonb,
    ADD COLUMN rcm_declaration_id uuid REFERENCES rcm_declaration(id),
    -- Why a requested reverse charge was refused, when it was. Kept so the
    -- pattern is queryable — a shop repeatedly failing verification is a
    -- process problem worth surfacing, not just a per-sale annoyance.
    ADD COLUMN rcm_refused_reason text;

-- A reverse-charged sale MUST be able to name the buyer and the declaration
-- behind it. This is the constraint that makes an unsupportable RCM invoice
-- impossible to write, rather than merely unlikely.
ALTER TABLE sales_order
    ADD CONSTRAINT sales_order_rcm_is_supported CHECK (
        tax_treatment = 'standard'
        OR (buyer_trn IS NOT NULL
            AND buyer_legal_name IS NOT NULL
            AND rcm_declaration_id IS NOT NULL)
    );

CREATE INDEX sales_order_tax_treatment_idx
    ON sales_order (tenant_id, tax_treatment, placed_at DESC)
    WHERE tax_treatment <> 'standard';

-- ---------------------------------------------------------------------------
-- 5. Tax treatment per line
-- ---------------------------------------------------------------------------
-- R7.2's full tax invoice requires the VAT rate and amount PER LINE, and
-- R7.9's PINT AE model requires a tax category code per line. Both are line
-- facts, and a mixed invoice makes them un-derivable from the order header.
--
-- UN/CEFACT 5305 codes, which is what UBL and therefore PINT AE carry, so
-- there is no translation layer at the e-invoicing edge:
--   S  standard rated      Z  zero rated       E  exempt
--   O  outside scope       AE VAT reverse charge
ALTER TABLE sales_order_line
    ADD COLUMN tax_category text NOT NULL DEFAULT 'S'
        CHECK (tax_category IN ('S','Z','E','O','AE')),
    -- Basis points, matching tenant.vat_rate_bp. Always 0 for AE/Z/E/O.
    ADD COLUMN tax_rate_bp int NOT NULL DEFAULT 0
        CHECK (tax_rate_bp >= 0 AND tax_rate_bp <= 10000);

-- Backfill BEFORE the constraint, not after. Order matters and getting it
-- wrong is invisible on an empty database: with no rows, a CHECK added first
-- passes trivially, and the fresh-database CI gate goes green while every
-- populated database rejects the migration. Backfill, then constrain.
--
-- Every line that already exists was sold standard-rated at the tenant's
-- rate. The DEFAULT above handles `tax_category`; the rate needs the tenant's
-- actual value rather than a constant, because vat_rate_bp is table-driven
-- precisely so that it is not assumed.
--
-- Restricted to lines that actually bear VAT. A historical line with
-- tax_minor = 0 (a zero-priced sample, a fully discounted line) must not be
-- given a 5% rate it never had — that would assert a tax fact that is untrue.
UPDATE sales_order_line l
   SET tax_rate_bp = t.vat_rate_bp
  FROM tenant t
 WHERE t.id = l.tenant_id
   AND l.tax_minor <> 0;

-- The arithmetic identity that makes the invoice defensible: a line that
-- charges no VAT must carry no VAT amount. Cheap to enforce, and it turns a
-- whole class of tax bug into a write that cannot happen.
--
-- Any row still violating this after the backfill is a line bearing VAT under
-- a tenant whose vat_rate_bp is 0 — a genuine data contradiction that predates
-- this migration. Failing loudly here is correct: silently widening the
-- constraint would preserve the contradiction into the tax reports.
ALTER TABLE sales_order_line
    ADD CONSTRAINT sales_order_line_zero_rate_zero_tax CHECK (
        tax_rate_bp > 0 OR tax_minor = 0
    );

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------
-- Table-level grants for omniretail_app are blanket (006) and cover new
-- columns automatically, but a NEW TABLE created after 006 ran needs its own
-- grant — ALTER DEFAULT PRIVILEGES covers tables created by the same role,
-- which migrations are, so this is belt and braces rather than strictly
-- required. Explicit beats relying on a default privilege that a future
-- ownership change would silently drop.
GRANT SELECT, INSERT, UPDATE, DELETE ON rcm_declaration TO omniretail_app;

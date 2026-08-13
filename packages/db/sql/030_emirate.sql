-- 030_emirate.sql — the emirate of the supply, on every sales and purchase
-- line (R7.6; TRD §5.3).
--
-- WHY NOW. The UAE VAT return reports standard-rated supplies by emirate in
-- Box 1 (lines 1a–1g), and the FTA Audit File carries an emirate per line.
-- Neither can be reconstructed from an order after the fact once branches
-- move, close or are renamed, so the column lands before the history grows.
--
-- WHICH EMIRATE — the rule that is easy to get wrong. It is the emirate of
-- the FIXED ESTABLISHMENT MOST CLOSELY CONNECTED TO THE SUPPLY: for retail,
-- the branch making the sale, NOT the customer's address. `location.emirate`
-- is therefore the source of the default, and the customer's address is
-- deliberately not consulted.
--   The single exception is an e-commerce supply by a "qualifying registrant"
-- (over AED 100m of e-commerce supplies in a calendar year), which is
-- reported by where the customer receives the supply. That is far above this
-- business's scale, but the column sits on the LINE rather than being derived
-- from the order's location at read time, so the exception — and a single
-- order fulfilled from two branches — remain representable without another
-- schema change. The FTA Audit File is line-level for the same reason.
--
-- NULLABLE, NOT `NOT NULL` — and why. The existing tenant already has real
-- orders. `NOT NULL` needs a DEFAULT, and there is no honest default: any
-- constant would silently assert that historical sales happened in an emirate
-- nobody verified, which is exactly the fabricated tax data an audit looks
-- for. So this is the expand half of expand/contract:
--   1. this migration adds nullable columns (no rewrite, no lock beyond the
--      catalogue update, safe on a populated table);
--   2. operations set `location.emirate` for each branch;
--   3. `backfill_emirate_from_location()` (below) copies it onto historical
--      lines, and can be re-run as more branches are filled in;
--   4. a later migration may add NOT NULL once the backfill reports zero
--      remaining NULLs — deliberately not attempted here.
-- Until then a NULL emirate means "not yet attributed", which is a
-- reportable, queryable state; a wrong emirate is not.
--
-- No RLS changes: `location`, `sales_order_line` and `purchase_order_line`
-- already carry tenant_id with ENABLE/FORCE RLS and the tenant_isolation
-- policy (002/004/019). Grants are table-level (006), so new columns inherit
-- them.

-- ISO 3166-2:AE subdivision codes, stored bare (the "AE-" prefix is added at
-- the presentation edge). A DOMAIN rather than a per-table CHECK so the seven
-- values are defined once and every future table that needs an emirate gets
-- the same constraint. NULL passes the constraint, by design (see above).
CREATE DOMAIN emirate_code AS text
    CONSTRAINT emirate_code_known CHECK (VALUE IN (
        'AZ',  -- Abu Dhabi        — VAT return Box 1a
        'DU',  -- Dubai            — Box 1b
        'SH',  -- Sharjah          — Box 1c
        'AJ',  -- Ajman            — Box 1d
        'UQ',  -- Umm Al Quwain    — Box 1e
        'RK',  -- Ras Al Khaimah   — Box 1f
        'FU'   -- Fujairah         — Box 1g
    ));

COMMENT ON DOMAIN emirate_code IS
    'One of the seven UAE emirates as an ISO 3166-2:AE subdivision code '
    '(AZ, DU, SH, AJ, UQ, RK, FU). Names and VAT-return Box 1 line mapping '
    'live in packages/domain/src/tax.ts — never re-derived in SQL.';

-- The branch. This is the source of truth for the default on every line.
ALTER TABLE location     ADD COLUMN emirate emirate_code;

-- The supply. Copied from the branch at write time, then immutable with the
-- line: a branch that later moves emirate must not rewrite history.
ALTER TABLE sales_order_line    ADD COLUMN emirate emirate_code;
ALTER TABLE purchase_order_line ADD COLUMN emirate emirate_code;

COMMENT ON COLUMN location.emirate IS
    'Emirate of this fixed establishment. Required for any location that '
    'makes or receives supplies (store, warehouse); virtual locations may '
    'leave it NULL. Application must require it when creating a store or '
    'warehouse — the database cannot, because existing rows predate it.';

COMMENT ON COLUMN sales_order_line.emirate IS
    'Emirate of the supply (R7.6): the fixed establishment most closely '
    'connected to it — the SELLING BRANCH, not the customer''s address. '
    'Defaulted from location.emirate of the order''s location at write time '
    'and frozen thereafter. NULL means not yet attributed (pre-R7.6 rows).';

COMMENT ON COLUMN purchase_order_line.emirate IS
    'Emirate of the establishment receiving the purchase (the PO destination '
    'location), for input-VAT attribution in the FTA Audit File. NULL means '
    'not yet attributed (pre-R7.6 rows).';

-- Reporting access path: VAT return Box 1 and the audit file group by
-- (tenant, emirate). Not partial on `emirate IS NOT NULL` — the complement
-- ("which lines are still unattributed?") is the query that drives the
-- backfill, and it wants the index too.
CREATE INDEX sales_order_line_emirate_idx    ON sales_order_line    (tenant_id, emirate);
CREATE INDEX purchase_order_line_emirate_idx ON purchase_order_line (tenant_id, emirate);

-- Step 3 of the expand/contract above, shipped as a function rather than as a
-- comment so the backfill is one call that cannot be mistyped, and so it can
-- be re-run safely as branches get their emirate filled in.
--
-- Only fills NULLs, and only from a location that HAS an emirate: it never
-- overwrites an attributed line and never guesses. Returns what it changed.
--
-- SECURITY INVOKER (the default) on purpose: the caller's row-level security
-- decides the scope. Run it inside a tenant session (app.tenant_id set) to
-- backfill one tenant, or as a BYPASSRLS/superuser admin to backfill all —
-- FORCE ROW LEVEL SECURITY means a SECURITY DEFINER owner would gain nothing.
CREATE FUNCTION backfill_emirate_from_location()
RETURNS TABLE (sales_lines_filled bigint, purchase_lines_filled bigint)
LANGUAGE plpgsql AS $$
DECLARE
    sales_filled    bigint;
    purchase_filled bigint;
BEGIN
    WITH updated AS (
        UPDATE sales_order_line l
           SET emirate = loc.emirate
          FROM sales_order o
          JOIN location loc ON loc.id = o.location_id
         WHERE o.id = l.order_id
           AND l.emirate IS NULL
           AND loc.emirate IS NOT NULL
        RETURNING 1
    )
    SELECT count(*) INTO sales_filled FROM updated;

    WITH updated AS (
        UPDATE purchase_order_line pl
           SET emirate = loc.emirate
          FROM purchase_order po
          JOIN location loc ON loc.id = po.location_id
         WHERE po.id = pl.po_id
           AND pl.emirate IS NULL
           AND loc.emirate IS NOT NULL
        RETURNING 1
    )
    SELECT count(*) INTO purchase_filled FROM updated;

    RETURN QUERY SELECT sales_filled, purchase_filled;
END $$;

COMMENT ON FUNCTION backfill_emirate_from_location() IS
    'One-shot (re-runnable) backfill of sales_order_line.emirate and '
    'purchase_order_line.emirate from the order''s location. Fills NULLs '
    'only, from locations that already have an emirate. Scope follows the '
    'caller''s RLS context.';

-- Ops/tenant-admin tool, not something every role should be able to fire.
REVOKE ALL ON FUNCTION backfill_emirate_from_location() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backfill_emirate_from_location() TO omniretail_app;

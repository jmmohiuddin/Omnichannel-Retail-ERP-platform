-- 031_product_lifecycle.sql — the draft → published → archived lifecycle (R1.1 / R1.5).
--
-- WHAT WAS ALREADY THERE (002_catalog.sql): product.status already allows
-- ('draft','active','archived') and already DEFAULTs to 'draft'. The gap was
-- never the schema — it was that nothing ever WROTE 'draft' or 'archived':
-- POST /v1/products hard-coded 'active', and archiving had no path at all.
-- This migration therefore adds the three things the lifecycle actually needs
-- and does NOT rewrite what already works.
--
--   1. variant.stock_mode — R1.5's publish gate ("at least one variant with a
--      stock mode set") needs a per-variant field to gate on. Product.tracking
--      is a product-wide default; R1.2 requires the tracking mode to be a
--      per-variant property (a 256GB unit can be serialised while its bundled
--      cable is not).
--   2. published_at / archived_at — lifecycle history, so "when did this leave
--      the storefront" is answerable without reading the audit chain.
--   3. product_tracking_lock — a DB-level freeze on changing product.tracking
--      once the ledger has spoken about the product. See the long comment on
--      the trigger; this is a data-corruption guard, which per CLAUDE.md and
--      R2.7 belongs in the database rather than in application logic.
--
-- Backwards compatibility: the tenant has live data. Every statement below is
-- additive; existing rows are backfilled so that products that are selling
-- today keep selling and stay publishable.

-- ---------------------------------------------------------------------------
-- 1. Per-variant stock mode (R1.2, gates R1.5)
-- ---------------------------------------------------------------------------
-- NULL means "not configured yet" — deliberately distinct from 'none', which
-- is a decision the merchant made ("this SKU is not stock-tracked"). R1.5
-- blocks publication until the decision exists, so NULL must not be a valid
-- publishable state and therefore must not be spelled the same as 'none'.
ALTER TABLE variant
    ADD COLUMN stock_mode text
        CHECK (stock_mode IS NULL OR stock_mode IN ('none','batch','serialized'));

-- Backfill: an existing variant inherits its product's tracking mode. Without
-- this, every product already live in the catalogue would fail the R1.5 publish
-- gate the moment someone edited it — a migration that breaks a working shop.
UPDATE variant v
   SET stock_mode = p.tracking
  FROM product p
 WHERE p.id = v.product_id
   AND v.stock_mode IS NULL;

CREATE INDEX variant_product_stock_mode_idx ON variant (tenant_id, product_id)
    WHERE stock_mode IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Lifecycle timestamps
-- ---------------------------------------------------------------------------
ALTER TABLE product
    ADD COLUMN published_at timestamptz,
    ADD COLUMN archived_at  timestamptz;

UPDATE product SET published_at = created_at WHERE status = 'active';
UPDATE product SET archived_at  = updated_at WHERE status = 'archived';

-- Restate the intended default explicitly. 002_catalog.sql already sets it;
-- repeating it here is idempotent and makes this migration self-describing for
-- any database whose product table diverged before the drift guard existed.
ALTER TABLE product ALTER COLUMN status SET DEFAULT 'draft';

-- Defensive: guarantee 'draft' is an accepted status even if this database's
-- CHECK predates 002_catalog.sql's current form. A no-op on a clean database.
DO $$
DECLARE
    con_name text;
    con_def  text;
BEGIN
    SELECT conname, pg_get_constraintdef(oid) INTO con_name, con_def
      FROM pg_constraint
     WHERE conrelid = 'product'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%status%';

    IF con_name IS NOT NULL AND con_def NOT LIKE '%draft%' THEN
        EXECUTE format('ALTER TABLE product DROP CONSTRAINT %I', con_name);
        ALTER TABLE product
            ADD CONSTRAINT product_status_check
            CHECK (status IN ('draft','active','archived'));
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. The serialisation freeze
-- ---------------------------------------------------------------------------
-- RULE: product.tracking may not change once the ledger holds any movement for
-- one of the product's variants, or once any stock_unit exists for one of them.
--
-- WHY THIS IS A DATABASE RULE AND NOT A SERVICE RULE:
--
--   'none'/'batch' → 'serialized'
--       003_inventory.sql requires stock_unit_id on movements for serialised
--       variants. Existing on-hand quantity was posted WITHOUT units behind it,
--       so flipping the switch strands that quantity: stock_level says four in
--       Deira, and no scan can ever satisfy a sale of them. Phantom stock that
--       reconciles to nothing is worse than no stock record at all.
--
--   'serialized' → 'none'/'batch'
--       Orphans every stock_unit already recorded. R2.6 (full IMEI history) and
--       R2.9 (warranty resolved from the unit, not the receipt) both read that
--       chain; severing it turns the homepage's "the IMEI recorded against your
--       order" back into the marketing claim the audit flagged.
--
-- Inventory is an append-only ledger (ADR-002), so there is no correct
-- retro-fit: we cannot rewrite history to invent or discard units. The only
-- safe path is the one the wireframe already specifies — archive the product
-- and recreate it under the correct mode (§3.1, "Cannot be turned off once
-- units exist" / "the only path is archiving and recreating"). Duplicate()
-- makes that a one-click operation.
--
-- The freeze keys on ledger activity rather than on current on-hand quantity:
-- a product that sold out still has an IMEI history to protect, so dropping to
-- zero stock must not silently reopen the switch.
--
-- Scope note: the trigger's lookups run under the caller's RLS context, which
-- is correct — a product and its variants are always in one tenant. A schema
-- owner connection with no app.tenant_id set sees no variant rows and so is not
-- blocked; that path is DBA-only and intentionally left as an escape hatch.
CREATE OR REPLACE FUNCTION enforce_product_tracking_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.tracking IS DISTINCT FROM OLD.tracking THEN
        IF EXISTS (
            SELECT 1 FROM stock_movement m
             WHERE m.variant_id IN (SELECT id FROM variant WHERE product_id = OLD.id)
        ) OR EXISTS (
            SELECT 1 FROM stock_unit u
             WHERE u.variant_id IN (SELECT id FROM variant WHERE product_id = OLD.id)
        ) THEN
            RAISE EXCEPTION
                'product % has stock history: tracking cannot change from % to % '
                '(archive and recreate the product instead)',
                OLD.id, OLD.tracking, NEW.tracking
                USING ERRCODE = 'raise_exception';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER product_tracking_lock
    BEFORE UPDATE ON product
    FOR EACH ROW EXECUTE FUNCTION enforce_product_tracking_lock();

-- ---------------------------------------------------------------------------
-- Selling-surface visibility (R1.5, "not visible on any selling surface")
-- ---------------------------------------------------------------------------
-- No schema change is needed for the storefront: webOrderService.publicCatalog
-- filters `p.status = 'active'` on the catalogue read AND on the variant
-- resolution inside createOrder, so a draft is both invisible and unbuyable
-- there. The admin list (GET /v1/products) filters `p.status <> 'archived'`,
-- which is what R1.1 wants — a new draft appears in the admin list immediately.
--
-- Row-level security is untouched by this migration: product and variant keep
-- the ENABLE/FORCE + tenant_isolation policy set up in 002_catalog.sql, and
-- new columns on an existing table inherit its grants (006_app_role.sql grants
-- at table level), so omniretail_app needs no new privileges.

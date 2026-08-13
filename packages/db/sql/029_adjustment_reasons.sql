-- 029_adjustment_reasons.sql — R4.1: stock adjustment with a mandatory reason
-- code, permissioned and audited.
--
-- 003_inventory.sql already refuses an adjustment/write_off without an
-- approval_id, but nothing could ever mint an adjustment approval (only
-- 'discount', 'refund' and 'stock_count' kinds were created), so adjustments
-- were unusable — and a cashier holding a self-requested 'discount' approval id
-- could attach it to an adjustment and pass the trigger. Two gaps, closed here:
--
--   1. `reason` on the ledger row, drawn from the PRD's enum, mandatory for
--      adjustment/write_off and forbidden elsewhere.
--   2. The adjustment approval kind, with the movement *bound* to it: the
--      posted reason, variant, quantity and location must be the ones a second
--      human approved. The manager approves a fact, not a blank cheque.
--
-- No new table, so no new RLS policy: `stock_movement` and `approval` already
-- carry tenant_id with FORCE RLS + tenant_isolation from 003_inventory.sql.

-- ---------------------------------------------------------------------------
-- The reason code
-- ---------------------------------------------------------------------------
ALTER TABLE stock_movement ADD COLUMN reason text;

COMMENT ON COLUMN stock_movement.reason IS
    'R4.1 adjustment reason code. Mandatory for adjustment/write_off, NULL for '
    'every other movement type. Copied from the approving manager''s decision '
    'by the stock_movement_reason trigger — never taken on trust from a client.';

ALTER TABLE stock_movement
    ADD CONSTRAINT stock_movement_reason_enum CHECK (
        reason IS NULL
        OR reason IN ('damage','theft','found','correction','sample','write_off')
    );

-- Required for adjustment/write_off, NULL otherwise — one equivalence, both
-- directions. movement_type is NOT NULL so this is a total boolean, never NULL.
--
-- NOT VALID: the ledger is append-only and its rows are immutable (the
-- forbid_change trigger blocks UPDATE), so any pre-existing adjustment row
-- cannot be backfilled with a reason. The constraint is fully enforced on every
-- INSERT from here on, which is the whole point; validating history is not
-- possible and would only abort the migration.
ALTER TABLE stock_movement
    ADD CONSTRAINT stock_movement_reason_scope CHECK (
        (movement_type IN ('adjustment','write_off')) = (reason IS NOT NULL)
    ) NOT VALID;

-- Adjustment reporting: "what did we lose to theft at this branch this month".
CREATE INDEX stock_movement_reason_idx
    ON stock_movement (tenant_id, reason, occurred_at DESC)
    WHERE reason IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The adjustment approval kind
-- ---------------------------------------------------------------------------
-- `approval.kind` is deliberately free text (discount, refund, stock_count, …).
-- A 'stock_adjustment' payload is the approved fact, so its shape is pinned:
-- the trigger below compares the movement against it field by field.
ALTER TABLE approval
    ADD CONSTRAINT approval_stock_adjustment_payload CHECK (
        kind <> 'stock_adjustment'
        OR (
            payload->>'reason' IN ('damage','theft','found','correction','sample','write_off')
            AND payload ? 'variantId'
            AND payload ? 'locationId'
            -- Guarantees the trigger's ::numeric cast cannot raise on crafted input.
            AND payload->>'quantity' ~ '^[0-9]+(\.[0-9]{1,3})?$'
        )
    );

-- One approval, one movement. A manager approving "write off 2 of SKU X" must
-- not have that decision replayed into a second write-off.
CREATE UNIQUE INDEX stock_movement_adjustment_approval_uq
    ON stock_movement (tenant_id, approval_id)
    WHERE movement_type IN ('adjustment','write_off');

-- ---------------------------------------------------------------------------
-- Bind the movement to what was actually approved
-- ---------------------------------------------------------------------------
-- Named to sort after `stock_movement_approval`: BEFORE INSERT triggers fire in
-- name order, so a missing approval_id still fails with that trigger's clearer
-- "requires an approval_id" message rather than ours.
--
-- Every RAISE mentions "approval" so translatePgError() maps it onto
-- LedgerError APPROVAL_REQUIRED (403) rather than leaking a raw database error.
CREATE OR REPLACE FUNCTION bind_movement_to_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    a          record;
    movement_location uuid;
BEGIN
    IF NEW.movement_type NOT IN ('adjustment','write_off') THEN
        RETURN NEW;
    END IF;
    -- The sibling stock_movement_approval trigger owns this failure.
    IF NEW.approval_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT kind, status, payload INTO a FROM approval WHERE id = NEW.approval_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'approval % not found for this %', NEW.approval_id, NEW.movement_type;
    END IF;
    IF a.kind <> 'stock_adjustment' THEN
        RAISE EXCEPTION 'approval % is a % approval, not a stock adjustment approval',
            NEW.approval_id, a.kind;
    END IF;
    IF a.status <> 'approved' THEN
        RAISE EXCEPTION 'approval % is %, not approved', NEW.approval_id, a.status;
    END IF;

    IF NEW.reason IS NULL THEN
        NEW.reason := a.payload->>'reason';
    ELSIF NEW.reason IS DISTINCT FROM a.payload->>'reason' THEN
        RAISE EXCEPTION 'reason ''%'' was not what approval % authorised (''%'')',
            NEW.reason, NEW.approval_id, a.payload->>'reason';
    END IF;

    IF NEW.variant_id <> (a.payload->>'variantId')::uuid THEN
        RAISE EXCEPTION 'variant % was not what approval % authorised (%)',
            NEW.variant_id, NEW.approval_id, a.payload->>'variantId';
    END IF;
    IF NEW.quantity <> (a.payload->>'quantity')::numeric THEN
        RAISE EXCEPTION 'quantity % was not what approval % authorised (%)',
            NEW.quantity, NEW.approval_id, a.payload->>'quantity';
    END IF;
    movement_location := coalesce(NEW.from_location_id, NEW.to_location_id);
    IF movement_location <> (a.payload->>'locationId')::uuid THEN
        RAISE EXCEPTION 'location % was not what approval % authorised (%)',
            movement_location, NEW.approval_id, a.payload->>'locationId';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER stock_movement_reason
    BEFORE INSERT ON stock_movement
    FOR EACH ROW EXECUTE FUNCTION bind_movement_to_approval();

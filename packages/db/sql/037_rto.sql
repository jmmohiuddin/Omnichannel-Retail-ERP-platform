-- 037_rto.sql — return to origin as a first-class order state, and the
-- freight a failed delivery actually cost (R5.6).
--
-- WHAT ALREADY WORKS (015_shipping.sql + the fix in commit 15a4b8d): when a
-- courier reports `returned`, the goods come back into the ledger — a
-- `return_in` movement per line, serialized units to `returned_pending` for
-- inspection rather than straight back to sellable. That half is correct and
-- is not touched here.
--
-- WHAT IS MISSING, and why each part matters:
--
--   1. THE ORDER STILL READS `fulfilled`. An order whose goods came back on
--      the van is not fulfilled, and there is no status that says otherwise.
--      Every downstream reader — the order list, revenue reporting, the
--      customer's tracking page — is therefore telling the merchant something
--      untrue about a transaction that lost money.
--
--   2. THE FREIGHT HAS NOWHERE TO GO. R5.6 requires the RTO flow to record
--      "the freight cost against the order". A refused COD delivery costs a
--      round trip, and that is precisely the loss the COD gate (R5.5) exists
--      to reduce — but "did the gate work" is unanswerable while the cost of
--      the failures it did not prevent is never written down. R12.8's "cost
--      of refusal" reads this.
--
-- Both columns default to 0 and the status is additive, so existing rows and
-- existing code keep working unchanged.

-- ---------------------------------------------------------------------------
-- 1. `returned_to_origin` as an order status
-- ---------------------------------------------------------------------------
-- Distinct from `cancelled` (the order never shipped) and from `refunded`
-- (money went back). An RTO order has shipped, come back, and may or may not
-- have been refunded yet — three different facts that a single status cannot
-- carry. Placed at the end of the list so the existing values keep their
-- meaning exactly.
ALTER TABLE sales_order DROP CONSTRAINT sales_order_status_check;
ALTER TABLE sales_order ADD CONSTRAINT sales_order_status_check CHECK (status IN (
    'pending','confirmed','fulfilling','fulfilled','completed',
    'cancelled','refunded','partially_refunded',
    'returned_to_origin'
));

COMMENT ON COLUMN sales_order.status IS
    'Order lifecycle. `returned_to_origin` means the goods shipped, were not '
    'accepted, and came back — distinct from `cancelled` (never shipped) and '
    '`refunded` (money returned). Stock re-entry is a ledger fact recorded '
    'separately as return_in movements.';

-- ---------------------------------------------------------------------------
-- 2. The freight a failed delivery cost
-- ---------------------------------------------------------------------------
-- On the SHIPMENT, because that is where the courier's charges are actually
-- incurred, and a split shipment (R5.8) can fail one leg and deliver another.
ALTER TABLE shipment
    ADD COLUMN outbound_freight_minor bigint NOT NULL DEFAULT 0
        CHECK (outbound_freight_minor >= 0),
    -- The return leg. Zero until a delivery actually fails, which is what
    -- makes `> 0` a meaningful filter for "this delivery cost us money and
    -- earned nothing".
    ADD COLUMN return_freight_minor bigint NOT NULL DEFAULT 0
        CHECK (return_freight_minor >= 0);

-- And rolled up on the ORDER, which is what R5.6 asks for by name and what
-- the margin report (R12.4) needs without joining shipments.
ALTER TABLE sales_order
    ADD COLUMN rto_freight_cost_minor bigint NOT NULL DEFAULT 0
        CHECK (rto_freight_cost_minor >= 0);

COMMENT ON COLUMN sales_order.rto_freight_cost_minor IS
    'Total freight lost on failed delivery attempts for this order (R5.6). '
    'The round-trip cost of a refused COD delivery — the loss the COD advance '
    'gate (R5.5) exists to reduce, and the denominator of "did it work".';

-- Finding the orders that lost money on freight, for R12.8.
CREATE INDEX sales_order_rto_freight_idx
    ON sales_order (tenant_id, placed_at DESC)
    WHERE rto_freight_cost_minor > 0;

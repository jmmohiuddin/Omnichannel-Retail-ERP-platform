-- 036_cod_outcome_key.sql — key a COD delivery outcome to its ORDER, not to
-- its shipment (corrects 035_cod_gate.sql).
--
-- WHAT WAS WRONG. 035 declared `UNIQUE (tenant_id, shipment_id)` to stop a
-- replayed courier feed double-counting a customer's reputation and the
-- freight a refusal cost. Two problems:
--
--   1. It does not actually dedupe. `shipment_id` is nullable — a COD outcome
--      recorded before a shipment row exists, or by a courier integration
--      that has no shipment id to give, stores NULL, and in SQL every NULL is
--      distinct. The unique index silently permits unlimited duplicate rows
--      for exactly the case it was written to guard.
--
--   2. It keys the wrong thing. What the risk score counts, and what R12.8
--      reports as sent/delivered/refused, is ORDERS. One order is delivered
--      or it is not; that is the fact being recorded, and the shipment is
--      provenance for it.
--
-- The order is NOT NULL, so keying on it dedupes for real.
--
-- KNOWN LIMITATION, stated rather than hidden: this makes one order carry at
-- most one COD outcome, so a split shipment (R5.8, a "Should", not in v1)
-- delivered in two legs cannot record an outcome per leg. When split
-- fulfilment lands, this becomes a composite key over the shipment with a
-- generated fallback — not another nullable column.
--
-- `shipment_id` keeps its foreign key and stays nullable: it is now
-- provenance, which is what it always should have been.

ALTER TABLE cod_delivery_outcome
    DROP CONSTRAINT cod_delivery_outcome_tenant_id_shipment_id_key;

-- Deduplicate before constraining. 035 shipped moments ago and no production
-- system has run it, but a developer database may already hold rows, and a
-- migration that only works on empty tables is the exact failure mode the
-- fresh-database CI gate cannot see.
DELETE FROM cod_delivery_outcome a
 USING cod_delivery_outcome b
 WHERE a.tenant_id = b.tenant_id
   AND a.order_id  = b.order_id
   AND a.ctid > b.ctid;

ALTER TABLE cod_delivery_outcome
    ADD CONSTRAINT cod_delivery_outcome_order_uq UNIQUE (tenant_id, order_id);

COMMENT ON COLUMN cod_delivery_outcome.shipment_id IS
    'The shipment this outcome came from, when known. Provenance only — the '
    'row is keyed on the order, because one order has one delivery outcome.';

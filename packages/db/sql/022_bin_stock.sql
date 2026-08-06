-- 022_bin_stock.sql — per-bin quantities as a WMS OVERLAY.
--
-- DESIGN DECISION: the movement ledger (stock_movement) and its read-model
-- stock_level remain the LOCATION-level source of truth for how much stock
-- exists. bin_stock is an overlay that only records physical placement WITHIN
-- a location — which shelf the units currently sit on. It never feeds
-- availability, valuation, or reservations, and it is written by WMS
-- operations (putaway, bin move, pick), not by the ledger poster.
--
-- Invariant (enforced by WmsService.putaway under a per-(tenant, location,
-- variant) advisory lock — deliberately NOT a DB constraint, since stock_level
-- and bin_stock rows are keyed differently):
--
--     for any (location, variant):
--         sum(bin_stock.quantity) over that location's bins
--             <= stock_level.on_hand
--
-- Bins may UNDER-cover on_hand — freshly received, not-yet-putaway stock sits
-- in an implicit "floor" area (on_hand minus binned) — but putaway can never
-- OVER-cover it. Note the check applies at putaway time: a reservation moves
-- on_hand -> reserved without physically touching a shelf, so binned totals
-- can transiently exceed on_hand for reserved-but-unpicked goods; the pick
-- decrement in recordPicks reconciles that.

CREATE TABLE bin_stock (
    tenant_id   uuid NOT NULL REFERENCES tenant(id),
    bin_id      uuid NOT NULL REFERENCES warehouse_bin(id) ON DELETE CASCADE,
    variant_id  uuid NOT NULL REFERENCES variant(id) ON DELETE CASCADE,
    quantity    numeric(14,3) NOT NULL CHECK (quantity >= 0),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, bin_id, variant_id)
);
CREATE INDEX bin_stock_variant_idx ON bin_stock (tenant_id, variant_id);

-- Row-level security (pattern from 001_foundation.sql)
ALTER TABLE bin_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE bin_stock FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bin_stock
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

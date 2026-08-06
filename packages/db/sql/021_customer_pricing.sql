-- 021_customer_pricing.sql — wholesale price-tier assignment: a customer can
-- carry a negotiated price list (kind 'wholesale'); its qty tiers (min_qty)
-- then price that customer's sales.

ALTER TABLE customer ADD COLUMN price_list_id uuid REFERENCES price_list(id);

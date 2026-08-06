-- 017_drift_check_grants.sql — the drift-check job (ADR-002) replays the
-- whole ledger and compares it to the materialized stock_level table across
-- all tenants. Read-only discovery, same pattern as 009/010.

CREATE POLICY worker_drift ON stock_movement FOR SELECT TO omniretail_worker
    USING (true);

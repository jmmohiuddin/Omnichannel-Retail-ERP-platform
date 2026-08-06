-- 009_channel_sync_grants.sql — channel-sync worker needs cross-tenant reads
-- of listings/stock and write access to listing sync-state. Scoped per table;
-- still no BYPASSRLS.

GRANT SELECT ON channel, channel_listing, variant, stock_level, tenant TO omniretail_worker;
GRANT UPDATE ON channel_listing TO omniretail_worker;

CREATE POLICY worker_sync ON channel FOR SELECT TO omniretail_worker USING (true);
CREATE POLICY worker_sync ON channel_listing FOR ALL TO omniretail_worker
    USING (true) WITH CHECK (true);
CREATE POLICY worker_sync ON variant FOR SELECT TO omniretail_worker USING (true);
CREATE POLICY worker_sync ON stock_level FOR SELECT TO omniretail_worker USING (true);

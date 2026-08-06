-- 010_worker_jobs.sql — grants for background jobs (marketplace order import,
-- reservation expiry). The worker sets the tenant GUC per job and flows through
-- the same tenant_isolation policies as the API for writes; only bounded
-- cross-tenant DISCOVERY reads get USING(true) policies.

GRANT SELECT, INSERT ON stock_movement TO omniretail_worker;
GRANT SELECT, INSERT, UPDATE ON stock_level TO omniretail_worker;
GRANT SELECT, INSERT, UPDATE ON stock_reservation TO omniretail_worker;
GRANT SELECT, INSERT, UPDATE ON sales_order, sales_order_line, payment, customer TO omniretail_worker;
GRANT SELECT, INSERT, UPDATE ON order_counter TO omniretail_worker;
GRANT SELECT ON location, product, app_user, approval TO omniretail_worker;
GRANT INSERT ON outbox TO omniretail_worker;

-- Discovery: find expired reservations across tenants to schedule per-tenant work.
CREATE POLICY worker_discover ON stock_reservation FOR SELECT TO omniretail_worker
    USING (true);

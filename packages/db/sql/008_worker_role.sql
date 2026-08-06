-- 008_worker_role.sql — background-worker role. Workers (outbox relay, sync
-- jobs) legitimately operate across tenants, so they get their own role with
-- explicit permissive policies on exactly the tables they need — not BYPASSRLS.

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'omniretail_worker') THEN
        CREATE ROLE omniretail_worker LOGIN PASSWORD 'omniretail_worker_dev';
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO omniretail_worker;
GRANT SELECT, UPDATE ON outbox TO omniretail_worker;

CREATE POLICY worker_relay ON outbox
    FOR ALL TO omniretail_worker
    USING (true) WITH CHECK (true);

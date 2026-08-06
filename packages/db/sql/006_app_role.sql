-- 006_app_role.sql — runtime role for the API. Non-superuser, no BYPASSRLS:
-- row-level security actually applies to every query the application makes.
-- The password below is a DEV default; production ops must rotate it
-- (ALTER ROLE omniretail_app PASSWORD ...) via the secrets pipeline.

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'omniretail_app') THEN
        CREATE ROLE omniretail_app LOGIN PASSWORD 'omniretail_app_dev';
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO omniretail_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO omniretail_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO omniretail_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO omniretail_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO omniretail_app;

-- Immutability of the ledger/audit does not depend on grants: triggers
-- (forbid_change) reject UPDATE/DELETE regardless of privileges.

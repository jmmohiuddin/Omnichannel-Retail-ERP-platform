-- 016_fix_tenant_guc.sql — harden current_tenant_id().
--
-- After a transaction that ran set_config('app.tenant_id', ..., true) ends,
-- the GUC reads back as an EMPTY STRING (not NULL) on that pooled connection.
-- ''::uuid raises 22P02, which made platform-scope queries against RLS tables
-- (e.g. webhook → payment_intent lookup) fail on previously-used connections.
-- NULLIF makes the unset/reset states equivalent: policies simply match no
-- rows, which is the intended fail-closed behavior.

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- Gateway webhooks arrive with no tenant context: the intent row itself is
-- what maps gateway_ref → tenant. The webhook handler opts into this narrow
-- cross-tenant SELECT by setting a transaction-local flag; every other code
-- path remains tenant-scoped. (SECURITY DEFINER is not an option here: FORCE
-- ROW LEVEL SECURITY applies to the table owner as well.)
CREATE POLICY webhook_lookup ON payment_intent FOR SELECT
    USING (current_setting('app.webhook_lookup', true) = 'on');

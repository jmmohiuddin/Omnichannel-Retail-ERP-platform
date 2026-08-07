-- 024_customer_sessions.sql — passwordless shopper accounts for the storefront.
--
-- Two tables. `customer_magic_link` records a request to sign in with an
-- emailed one-time token (short-lived, single-use). `customer_session` is the
-- long-lived session issued after a successful verification, used by the
-- shopper to view their own orders and serialized devices.
--
-- Both store ONLY sha256(token) — raw tokens never sit at rest (same discipline
-- as user_session in 005_auth_sessions.sql). Both are tenant-scoped and carry
-- the standard tenant_isolation RLS policy: a shopper's session for one tenant
-- can never resolve against another tenant's data.

CREATE TABLE customer_magic_link (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    -- Email is what the shopper types; a session mints only after they prove
    -- they can read this inbox by echoing the token back. We store the request
    -- even if no customer row exists yet — customer creation is deferred to
    -- verification (an unverified email is not proof of account ownership).
    email        citext NOT NULL,
    token_hash   bytea NOT NULL,
    expires_at   timestamptz NOT NULL,   -- 15 minutes from creation
    consumed_at  timestamptz,            -- set on successful verify (single use)
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customer_magic_link_hash_uq ON customer_magic_link (token_hash);
CREATE INDEX customer_magic_link_email_idx
    ON customer_magic_link (tenant_id, email, created_at DESC);

CREATE TABLE customer_session (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    customer_id  uuid NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
    token_hash   bytea NOT NULL,
    expires_at   timestamptz NOT NULL,   -- 30 days from creation
    created_at   timestamptz NOT NULL DEFAULT now(),
    revoked_at   timestamptz
);
CREATE UNIQUE INDEX customer_session_hash_uq ON customer_session (token_hash);
CREATE INDEX customer_session_customer_idx
    ON customer_session (tenant_id, customer_id) WHERE revoked_at IS NULL;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['customer_magic_link','customer_session']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I
             USING (tenant_id = current_tenant_id())
             WITH CHECK (tenant_id = current_tenant_id())', t);
    END LOOP;
END $$;

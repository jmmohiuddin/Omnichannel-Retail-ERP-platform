-- 001_foundation.sql — extensions, tenancy, identity, devices, audit, outbox
-- Apply as a role that owns the schema; the application connects as `app_user`
-- (non-superuser, no BYPASSRLS). All timestamps are timestamptz UTC.

CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;       -- trigram search on names/SKUs
CREATE EXTENSION IF NOT EXISTS citext;        -- case-insensitive emails

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE tenant (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name           text NOT NULL,
    slug           text NOT NULL UNIQUE,
    base_currency  char(3) NOT NULL DEFAULT 'USD',
    timezone       text NOT NULL DEFAULT 'UTC',
    plan           text NOT NULL DEFAULT 'trial',
    status         text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','suspended','closed')),
    settings       jsonb NOT NULL DEFAULT '{}',
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- Helper: current tenant from per-connection GUC set by the API after auth.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT current_setting('app.tenant_id', true)::uuid $$;

-- ---------------------------------------------------------------------------
-- Identity & access
-- ---------------------------------------------------------------------------
CREATE TABLE app_user (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenant(id),
    email          citext,
    phone          text,
    full_name      text NOT NULL,
    password_hash  text,                       -- argon2id; NULL for SSO-only users
    totp_secret_enc bytea,                     -- encrypted at rest (app-layer AES-GCM)
    status         text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('invited','active','suspended','deactivated')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);

CREATE TABLE role (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenant(id),
    name        text NOT NULL,                 -- owner|admin|manager|cashier|warehouse|custom…
    is_system   boolean NOT NULL DEFAULT false,
    permissions text[] NOT NULL DEFAULT '{}',  -- e.g. 'inventory.adjust.request'
    UNIQUE (tenant_id, name)
);

CREATE TABLE user_role (
    user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    role_id     uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
    tenant_id   uuid NOT NULL REFERENCES tenant(id),
    location_id uuid,                          -- optional scope to a store/warehouse
    PRIMARY KEY (user_id, role_id, tenant_id)
);

-- Registered devices (POS registers, mobile devices). POS tokens are device-bound.
CREATE TABLE device (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    location_id   uuid,                        -- FK added in 003 (location table)
    kind          text NOT NULL CHECK (kind IN ('pos_register','mobile','kiosk')),
    name          text NOT NULL,
    public_key    text,                        -- for device-bound token proof-of-possession
    status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','revoked')),
    last_seen_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Immutable audit log (hash-chained per tenant for tamper evidence)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    occurred_at  timestamptz NOT NULL DEFAULT now(),
    actor_user_id uuid REFERENCES app_user(id),
    actor_device_id uuid REFERENCES device(id),
    action       text NOT NULL,                -- 'sale.void', 'inventory.adjust', …
    entity_type  text NOT NULL,
    entity_id    text NOT NULL,
    before       jsonb,
    after        jsonb,
    ip           inet,
    prev_hash    bytea,                        -- hash chain: sha256(prev_hash || row)
    row_hash     bytea NOT NULL
);
CREATE INDEX audit_log_tenant_time_idx ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (tenant_id, entity_type, entity_id);

-- Audit rows can never be updated or deleted, even by the app role.
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END $$;
CREATE TRIGGER audit_log_immutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- Transactional outbox (ADR-006)
-- ---------------------------------------------------------------------------
CREATE TABLE outbox (
    id            uuid PRIMARY KEY,            -- event id = consumer dedupe key
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    aggregate     text NOT NULL,               -- 'inventory:variant:<id>' ordering key
    sequence      bigint GENERATED ALWAYS AS IDENTITY,
    event_type    text NOT NULL,               -- 'inventory.level.changed', …
    payload       jsonb NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    relayed_at    timestamptz
);
CREATE INDEX outbox_unrelayed_idx ON outbox (sequence) WHERE relayed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Row-level security. Pattern repeated for every tenant-owned table:
-- the app role sees only rows of the tenant bound to the connection.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['app_user','role','user_role','device','audit_log','outbox']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I
             USING (tenant_id = current_tenant_id())
             WITH CHECK (tenant_id = current_tenant_id())', t);
    END LOOP;
END $$;

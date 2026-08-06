-- 005_auth_sessions.sql — refresh-token sessions (rotating, hashed at rest)

CREATE TABLE user_session (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenant(id),
    user_id            uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    refresh_token_hash bytea NOT NULL,          -- sha256(token); raw token never stored
    device_id          uuid REFERENCES device(id),
    user_agent         text,
    ip                 inet,
    expires_at         timestamptz NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    rotated_from       uuid REFERENCES user_session(id),
    revoked_at         timestamptz
);
CREATE UNIQUE INDEX user_session_hash_uq ON user_session (refresh_token_hash);
CREATE INDEX user_session_user_idx ON user_session (tenant_id, user_id)
    WHERE revoked_at IS NULL;

ALTER TABLE user_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_session FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_session
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

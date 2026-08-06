-- 018_mfa.sql — TOTP MFA activation flag (secret lives in totp_secret_enc
-- from 001, encrypted at the application layer).

ALTER TABLE app_user ADD COLUMN mfa_enabled boolean NOT NULL DEFAULT false;

-- Outbox retention (ADR-006): relayed rows are pruned by the worker after a
-- retention window; the append-only ledger remains the durable history.
GRANT DELETE ON outbox TO omniretail_worker;

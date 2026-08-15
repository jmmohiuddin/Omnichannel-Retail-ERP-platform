-- 038_payment_reconciliation.sql — let the reconciler run as the worker role,
-- and give the exceptions it cannot repair somewhere durable to live (R6.2).
--
-- WHY THE JOB EXISTS. Stripe, N-Genius and Tabby all confirm asynchronously.
-- A webhook that is dropped, or that fails its effect and never retries,
-- leaves a payment intent stuck in `created` while the shopper's money has
-- already moved. R6.2: the reconciliation job "continues as the safety net,
-- and now *repairs* rather than only flagging". PRD §10 lists the same thing
-- as a P0 edge case: "gateway succeeds but our transaction fails".
--
-- TWO THINGS THE JOB NEEDS FROM THE DATABASE, and nothing more.
--
-- 1. DISCOVERY ACROSS TENANTS. Finding stuck intents is inherently a
--    cross-tenant read: one shop's dropped webhook must not wait behind
--    another's. `payment_intent` already carries exactly the right mechanism
--    for this — the `webhook_lookup` policy (016, narrowed in 027): FOR
--    SELECT only, so it grants no write bypass, and gated on a
--    transaction-local GUC so it cannot leak across a pooled connection.
--    027 scoped it to `omniretail_app`. The reconciler is the second
--    legitimate caller, so it gets its own policy with the same shape rather
--    than the old PUBLIC grant being restored — a policy per role that needs
--    it stays auditable; a PUBLIC one does not.
--
-- 2. TABLE GRANTS FOR THE REPAIR. The repair itself goes through
--    `PaymentService.applyWebhook` — the exact path a real webhook takes,
--    because a second implementation of "apply a payment" is how a repair job
--    double-spends. That path runs under `withTenant`, so the existing
--    `tenant_isolation` policies (which have no role list and therefore apply
--    to every role) already scope every write correctly. The worker is
--    missing only the table-level GRANTs, which is what this migration adds.
--    **No permissive bypass policy is created for any write path.**

-- ---------------------------------------------------------------------------
-- 1. Cross-tenant discovery, same shape as 027
-- ---------------------------------------------------------------------------
CREATE POLICY webhook_lookup_worker ON payment_intent
    FOR SELECT
    TO omniretail_worker
    USING (current_setting('app.webhook_lookup', true) = 'on');

GRANT SELECT, UPDATE ON payment_intent TO omniretail_worker;

-- ---------------------------------------------------------------------------
-- 2. Grants for the repair path (RLS still applies — see header note 2)
-- ---------------------------------------------------------------------------
GRANT SELECT, UPDATE ON payment      TO omniretail_worker;
GRANT SELECT, UPDATE ON sales_order  TO omniretail_worker;
-- 008 granted SELECT, UPDATE on outbox for the relay; publishing an
-- `order.paid` event needs INSERT as well.
GRANT INSERT ON outbox TO omniretail_worker;
-- The webhook dedupe table. No tenant_id and no RLS by design: it is keyed on
-- (gateway, external_id), which is globally unique per provider.
GRANT SELECT, INSERT ON webhook_delivery TO omniretail_worker;

-- ---------------------------------------------------------------------------
-- 3. Exceptions the job must not decide alone
-- ---------------------------------------------------------------------------
-- A reconciler that silently "repairs" an amount mismatch or a gateway it
-- cannot reach is worse than one that stops: it would be manufacturing
-- payment state from a guess. Those cases are flagged here instead, and a
-- human decides.
--
-- Keyed on (tenant, intent, reason) so a job on a timer that sees the same
-- problem every five minutes updates one row rather than growing a queue no
-- one can read. `seen_count` is how long it has been broken; `resolved_at`
-- closes it, and re-observing the problem reopens it — a repair that did not
-- hold must not look repaired.
CREATE TABLE payment_reconciliation_exception (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    intent_id     uuid NOT NULL REFERENCES payment_intent(id),
    order_id      uuid REFERENCES sales_order(id),
    gateway       text NOT NULL,
    gateway_ref   text,

    reason        text NOT NULL CHECK (reason IN (
                    'gateway_failed',    -- the gateway says it failed; do not repair to paid
                    'gateway_unknown',   -- the gateway does not recognise the ref
                    'amount_mismatch',   -- the gateway's amount is not ours
                    'currency_mismatch',
                    'no_status_api',     -- this adapter cannot be polled
                    'apply_failed')),    -- the effect threw; the money is unresolved
    detail        jsonb NOT NULL DEFAULT '{}',

    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    seen_count    int NOT NULL DEFAULT 1,
    resolved_at   timestamptz,

    UNIQUE (tenant_id, intent_id, reason)
);

-- The operator's queue: what is broken now, worst-stuck first.
CREATE INDEX payment_reconciliation_open_idx
    ON payment_reconciliation_exception (tenant_id, first_seen_at)
    WHERE resolved_at IS NULL;

ALTER TABLE payment_reconciliation_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_reconciliation_exception FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_reconciliation_exception
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- The job writes these under the tenant GUC, so tenant_isolation scopes it;
-- the API reads them for the exceptions report.
GRANT SELECT, INSERT, UPDATE ON payment_reconciliation_exception TO omniretail_worker;
GRANT SELECT, INSERT, UPDATE ON payment_reconciliation_exception TO omniretail_app;

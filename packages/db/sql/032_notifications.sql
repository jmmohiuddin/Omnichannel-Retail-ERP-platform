-- 032_notifications.sql — customer notification delivery (R13.1, R13.3–R13.5).
--
-- THE GAP: nothing in this platform has ever sent a message. A shopper pays
-- and hears nothing; a dispatch with a tracking number reaches no one. Phase 0
-- of the release plan names this explicitly — "a customer who orders receives
-- an email" is one of its four definition-of-done clauses.
--
-- WHY A SECOND OUTBOX. `outbox` (ADR-006) already exists and is the DOMAIN
-- EVENT relay: internal facts, consumed by workers and connectors, retried
-- until published, then forgotten. A notification is a different object with a
-- different lifecycle — it is addressed to a human, it is rendered content
-- that must be reproducible months later for a dispute, it can bounce, and it
-- must be visible on a Messages screen with a resend button. Overloading the
-- event relay with delivery state would make the relay's "publish then forget"
-- contract untrue. These are two tables on purpose.
--
-- DESIGN NOTES
--   * Content is rendered AT ENQUEUE TIME and stored. A template edited next
--     March must not change what a customer was told last August — the stored
--     body is the evidence. This is also what makes R13.5 (deterministic
--     templated content, no model-generated customer text) checkable after the
--     fact rather than merely intended.
--   * `dedupe_key` is unique per tenant, so enqueueing the same notification
--     twice — a retried transaction, a replayed webhook — delivers once.
--   * Enqueue happens inside the caller's transaction. An order that commits
--     always has its confirmation queued; an order that rolls back never
--     leaves an orphan message promising a purchase that did not happen.
--   * The rows are NOT append-only. Unlike stock_movement and audit_log, a
--     notification's whole purpose is to carry mutable delivery state.

-- ---------------------------------------------------------------------------
-- 1. Customer language preference (R13.4)
-- ---------------------------------------------------------------------------
-- R13.4 requires templates "chosen by customer language preference", and no
-- column held one. NULL means "not stated" and resolves to the tenant default
-- at render time — distinct from an explicit 'en', which is the customer
-- telling us something.
ALTER TABLE customer
    ADD COLUMN locale text CHECK (locale IS NULL OR locale IN ('en','ar'));

-- Tenant-wide fallback for guests and for customers who never stated one.
-- Defaulting to English matches the current storefront default; a shop serving
-- mostly Arabic speakers flips one row.
ALTER TABLE tenant
    ADD COLUMN default_locale text NOT NULL DEFAULT 'en'
        CHECK (default_locale IN ('en','ar'));

-- ---------------------------------------------------------------------------
-- 2. The notification outbox
-- ---------------------------------------------------------------------------
CREATE TABLE notification (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenant(id),

    -- R13.3's six templates. 'low_stock' is the internal one — it goes to
    -- staff, not to a customer, which is why recipient_kind exists below.
    template      text NOT NULL CHECK (template IN (
                    'order_confirmation','dispatch_tracking','cod_reminder',
                    'return_received','warranty_expiring','low_stock')),

    -- R13.2 models WhatsApp as a first-class channel even though only email
    -- delivers in v1: in this market WhatsApp is the primary channel, and a
    -- channel column added later is a migration across live delivery history.
    channel       text NOT NULL CHECK (channel IN ('email','sms','whatsapp')),

    recipient_kind text NOT NULL DEFAULT 'customer'
                    CHECK (recipient_kind IN ('customer','staff')),
    -- Email address or E.164 phone, depending on channel.
    recipient     text NOT NULL,
    locale        text NOT NULL CHECK (locale IN ('en','ar')),

    -- Rendered content, frozen at enqueue (see header).
    subject       text NOT NULL,
    body_text     text NOT NULL,
    body_html     text,

    -- 'bounced' is distinct from 'failed' on purpose: a bounce is the remote
    -- side rejecting the ADDRESS (retrying delivers nothing and harms sender
    -- reputation), while 'failed' is our side or a transient remote fault
    -- (worth retrying). R13.1 requires bounces to be surfaced, not silently
    -- retried forever.
    status        text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sending','sent','failed','bounced','cancelled')),

    attempts      int NOT NULL DEFAULT 0,
    max_attempts  int NOT NULL DEFAULT 5,
    -- When the delivery job may next pick this row up. Exponential backoff is
    -- computed by the job and written here, so the schedule survives a restart.
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error    text,
    sent_at       timestamptz,
    failed_at     timestamptz,

    -- Correlation, for the Messages screen and for the R12.2 post-order funnel.
    order_id      uuid REFERENCES sales_order(id),
    customer_id   uuid REFERENCES customer(id),
    -- Idempotency: 'order_confirmation:<orderId>' and the like.
    dedupe_key    text NOT NULL,
    -- Anything the template rendered from, kept for audit and for resend.
    payload       jsonb NOT NULL DEFAULT '{}',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    -- A terminal row must record when it became terminal.
    CONSTRAINT notification_sent_has_time
        CHECK (status <> 'sent' OR sent_at IS NOT NULL),
    CONSTRAINT notification_failed_has_time
        CHECK (status NOT IN ('failed','bounced') OR failed_at IS NOT NULL)
);

-- The idempotency guarantee (see header). Scoped per tenant, not global.
CREATE UNIQUE INDEX notification_dedupe_uq ON notification (tenant_id, dedupe_key);

-- The delivery job's claim query: due, not terminal, oldest first.
CREATE INDEX notification_due_idx ON notification (next_attempt_at, id)
    WHERE status IN ('pending','failed');

-- The Messages screen: newest first, filtered by state.
CREATE INDEX notification_tenant_status_idx
    ON notification (tenant_id, status, created_at DESC);
CREATE INDEX notification_order_idx ON notification (tenant_id, order_id)
    WHERE order_id IS NOT NULL;

-- `updated_at` is maintained by the writer, not by a trigger. That is this
-- schema's established convention — stock_level, payment_intent, shipment,
-- store_credit_account and bin_stock all do the same — and the delivery job
-- is the only thing that ever updates a notification, so a trigger would add
-- a second place to look for one column's value and buy nothing.

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- 3. Delivery attempt log
-- ---------------------------------------------------------------------------
-- Append-only. "Why did this customer not get their confirmation" is answered
-- from here — every attempt with its provider response — and the answer must
-- not be editable after the fact, exactly as with stock_movement and audit_log.
CREATE TABLE notification_attempt (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenant(id),
    notification_id uuid NOT NULL REFERENCES notification(id) ON DELETE CASCADE,
    attempt_no      int NOT NULL,
    outcome         text NOT NULL CHECK (outcome IN ('sent','failed','bounced')),
    -- Provider's message id when accepted; its error text when not.
    provider_ref    text,
    error           text,
    attempted_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_attempt_parent_idx
    ON notification_attempt (tenant_id, notification_id, attempt_no);

CREATE TRIGGER notification_attempt_immutable
    BEFORE UPDATE OR DELETE ON notification_attempt
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE notification_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_attempt
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- 4. Worker access
-- ---------------------------------------------------------------------------
-- The delivery job runs cross-tenant (one shop's queue must not stall another
-- shop's mail), so it gets explicit permissive policies on exactly these two
-- tables — the same pattern as the outbox relay in 008, never BYPASSRLS.
GRANT SELECT, UPDATE ON notification TO omniretail_worker;
GRANT SELECT, INSERT ON notification_attempt TO omniretail_worker;

CREATE POLICY worker_delivery ON notification
    FOR ALL TO omniretail_worker
    USING (true) WITH CHECK (true);
CREATE POLICY worker_delivery ON notification_attempt
    FOR ALL TO omniretail_worker
    USING (true) WITH CHECK (true);

-- The `confirmation_delivered` step of R12.2's post-order funnel (placed →
-- confirmed → tracked) is only knowable at the moment the mail is accepted,
-- which happens in the worker — so the worker, not the API, has to write it.
-- 028 created product_event with tenant isolation and no worker access at all,
-- so without this grant the funnel's middle step would be permanently zero.
--
-- INSERT only: the worker appends the one event it can observe and can never
-- read another tenant's event stream. product_event's forbid_change() trigger
-- keeps the row immutable afterwards, exactly as for the app role. Identity
-- columns need no separate sequence grant.
GRANT INSERT ON product_event TO omniretail_worker;

CREATE POLICY worker_funnel ON product_event
    FOR INSERT TO omniretail_worker
    WITH CHECK (true);

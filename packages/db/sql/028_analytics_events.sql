-- 028_analytics_events.sql — product event instrumentation (R12.1, R12.2).
--
-- G7 is the meta-goal: "a goal without instrumentation is a wish". Nothing in
-- the platform was measurable because no product events were ever recorded.
-- This is the append-only stream every funnel and product metric reads from.
--
-- Shape notes:
--   * append-only, like stock_movement and audit_log: the forbid_change()
--     trigger rejects UPDATE and DELETE even for the app role, so a funnel
--     number can never be retro-edited into a better one.
--   * `seq` is a per-row monotonic identity. Funnels chain steps on seq, not on
--     occurred_at, because several events recorded inside one transaction share
--     the same now() and would otherwise be unorderable.
--   * `id` is client-suppliable so an offline POS/browser beacon can replay a
--     batch idempotently (INSERT ... ON CONFLICT DO NOTHING).

CREATE TABLE product_event (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- client-generated for replay idempotency
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    seq          bigint GENERATED ALWAYS AS IDENTITY,         -- intra-session ordering + sync cursor
    occurred_at  timestamptz NOT NULL DEFAULT now(),
    name         text NOT NULL CHECK (name IN (
                   -- R12.1's nine required events
                   'product_viewed','add_to_cart','checkout_started','checkout_failed',
                   'order_placed','search_performed','cod_refused','pos_sale','admin_action',
                   -- R12.2 funnel steps R12.1 does not name: the home/landing step of
                   -- home→PDP→cart→checkout→order, and the two tail steps of
                   -- order placed→confirmation delivered→tracked.
                   'page_viewed','confirmation_delivered','order_tracked')),
    -- Correlation keys. session_id is the anonymous visitor/device key and is the
    -- default funnel key; the rest attach an event to a known actor or order.
    session_id   text,
    user_id      uuid REFERENCES app_user(id),   -- staff actor (pos_sale, admin_action)
    customer_id  uuid REFERENCES customer(id),   -- signed-in shopper, when known
    order_id     uuid REFERENCES sales_order(id),
    props        jsonb NOT NULL DEFAULT '{}',
    -- An event with no correlation key can never appear in a funnel or a
    -- per-actor report, so it is not worth storing.
    CHECK (session_id IS NOT NULL OR user_id IS NOT NULL
           OR customer_id IS NOT NULL OR order_id IS NOT NULL)
);

-- Funnel chains walk one key's events in seq order.
CREATE INDEX product_event_session_idx ON product_event (tenant_id, session_id, seq)
    WHERE session_id IS NOT NULL;
CREATE INDEX product_event_order_idx ON product_event (tenant_id, order_id, seq)
    WHERE order_id IS NOT NULL;
CREATE INDEX product_event_customer_idx ON product_event (tenant_id, customer_id, seq)
    WHERE customer_id IS NOT NULL;
-- Per-event counts over a window (dashboard tiles, funnel step filters).
CREATE INDEX product_event_name_time_idx ON product_event (tenant_id, name, occurred_at DESC);
-- Step predicates are jsonb containment (props @> '{"source":"search"}').
CREATE INDEX product_event_props_idx ON product_event USING gin (props jsonb_path_ops);
-- TRD §2.4: BRIN on the time column — the table is append-ordered by time, so a
-- BRIN costs a few pages and prunes whole ranges for retention/rollup scans.
CREATE INDEX product_event_occurred_brin ON product_event USING brin (occurred_at);

CREATE TRIGGER product_event_immutable
    BEFORE UPDATE OR DELETE ON product_event
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['product_event']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I
             USING (tenant_id = current_tenant_id())
             WITH CHECK (tenant_id = current_tenant_id())', t);
    END LOOP;
END $$;

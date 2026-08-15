-- 027_webhook_lookup_scope.sql — narrow the one tenant-bypass policy that
-- applied to every role.
--
-- `webhook_lookup` (016) is the only RLS policy in the schema granted to PUBLIC
-- rather than to a named role. It is otherwise carefully built — FOR SELECT
-- only, so it grants no write bypass; gated on a GUC that `paymentService`
-- sets transaction-locally, so it cannot leak across a pooled connection; and
-- with a single call site that narrows to `withTenant` immediately after
-- resolving gateway_ref -> tenant.
--
-- The residual risk is scope, not mechanism: as PUBLIC it is available to
-- `omniretail_worker` and to every role added later, so any future caller that
-- sets the flag reads every tenant's payment intents. Only the API needs it.
--
-- Recreated rather than altered: PostgreSQL has no ALTER POLICY ... TO that can
-- add a role list to an existing PUBLIC policy without restating it.

DROP POLICY IF EXISTS webhook_lookup ON payment_intent;

CREATE POLICY webhook_lookup ON payment_intent
    FOR SELECT
    TO omniretail_app
    USING (current_setting('app.webhook_lookup', true) = 'on');

COMMENT ON TABLE payment_intent IS
    'Gateway payment intents. Carries the webhook_lookup policy: a FOR SELECT '
    'bypass scoped to omniretail_app and gated on a transaction-local GUC, used '
    'once to resolve an inbound webhook gateway_ref to its tenant.';

-- 035_cod_gate.sql — cash-on-delivery policy, advance gating and the
-- reliability history that feeds the risk score (R5.5, R9.5, R12.8).
--
-- THE PROBLEM. Roughly 71% of UAE e-commerce is cash on delivery, and a
-- refused COD delivery costs the merchant a round-trip freight charge plus
-- stock that has been out on a van and must be inspected before it can be
-- sold again. R5.5 requires that above a threshold, or above a risk score,
-- COD either takes a partial advance or is not offered at all. None of that
-- existed: checkout had no concept of a payment method, so COD was
-- unconditional.
--
-- WHERE THE RULE LIVES. The decision — thresholds, advance arithmetic, the
-- risk score — is in `packages/domain/src/codGate.ts` and is not restated
-- here. This migration stores the policy the rule reads, the outcome history
-- the score is computed from, and the decision that was actually made.
--
-- WHY THE DECISION IS PERSISTED AND NOT JUST APPLIED. A customer refused COD
-- will ask why, and a merchant reviewing losses needs to know what the gate
-- did and on what evidence. Storing the score and the required advance on the
-- order makes the decision reproducible after the policy has since changed —
-- recomputing it later would answer a different question.

-- ---------------------------------------------------------------------------
-- 1. Policy, per tenant
-- ---------------------------------------------------------------------------
-- Typed columns rather than a jsonb blob: these are numbers with real bounds
-- that a misconfiguration would turn into money lost, and a CHECK is a
-- cheaper guard than a validation layer nobody runs on the config path.
CREATE TABLE cod_policy (
    tenant_id  uuid PRIMARY KEY REFERENCES tenant(id),
    enabled    boolean NOT NULL DEFAULT true,

    -- Order totals at or below this need no advance.
    advance_threshold_minor bigint NOT NULL DEFAULT 150000  -- AED 1,500
        CHECK (advance_threshold_minor >= 0),
    advance_mode   text NOT NULL DEFAULT 'percent'
        CHECK (advance_mode IN ('fixed','percent')),
    advance_fixed_minor bigint NOT NULL DEFAULT 0
        CHECK (advance_fixed_minor >= 0),
    advance_percent_bp  int NOT NULL DEFAULT 2000           -- 20%
        CHECK (advance_percent_bp >= 0 AND advance_percent_bp <= 10000),

    -- Risk score (0–100) above which COD is not offered at all. 100 turns the
    -- risk limb off without turning COD off.
    risk_ceiling int NOT NULL DEFAULT 70
        CHECK (risk_ceiling >= 0 AND risk_ceiling <= 100),

    -- Absolute cap; NULL means no cap.
    max_order_minor bigint CHECK (max_order_minor IS NULL OR max_order_minor > 0),

    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cod_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE cod_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cod_policy
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Every existing tenant gets the default policy, so the gate is live from the
-- moment this migration lands rather than waiting for someone to configure
-- it. A gate that defaults to "off until configured" protects nobody.
INSERT INTO cod_policy (tenant_id) SELECT id FROM tenant
ON CONFLICT (tenant_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. COD delivery outcomes — the compounding data asset (R9.5)
-- ---------------------------------------------------------------------------
-- Append-only. This is the evidence behind every refusal, and a merchant who
-- could edit it could manufacture or erase a customer's reputation. It is
-- also the source for the COD performance report (R12.8): sent, delivered,
-- refused, cost of refusal, by area and by customer.
CREATE TABLE cod_delivery_outcome (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    order_id      uuid NOT NULL REFERENCES sales_order(id),
    shipment_id   uuid REFERENCES shipment(id),
    -- Nullable: a guest checkout may have no customer row, and an outcome we
    -- cannot attribute is still worth counting for the shop-wide report.
    customer_id   uuid REFERENCES customer(id),

    outcome       text NOT NULL CHECK (outcome IN ('delivered','refused','undeliverable')),
    -- What the courier actually collected. Zero on a refusal.
    collected_minor bigint NOT NULL DEFAULT 0 CHECK (collected_minor >= 0),
    -- What the order was expecting, so a short collection is visible (R5.4).
    expected_minor  bigint NOT NULL DEFAULT 0 CHECK (expected_minor >= 0),
    -- The round-trip freight a refusal cost. Filled by the RTO flow (R5.6).
    freight_cost_minor bigint NOT NULL DEFAULT 0 CHECK (freight_cost_minor >= 0),

    -- Free-text area/emirate for the by-area breakdown in R12.8.
    area          text,
    emirate       emirate_code,
    note          text,
    occurred_at   timestamptz NOT NULL DEFAULT now(),

    -- One outcome per shipment: a delivery either happened or it did not, and
    -- two rows would double-count the customer's history and the freight.
    UNIQUE (tenant_id, shipment_id)
);

-- The risk-score lookup: this customer's counted history.
CREATE INDEX cod_outcome_customer_idx
    ON cod_delivery_outcome (tenant_id, customer_id, outcome)
    WHERE customer_id IS NOT NULL;
-- The R12.8 report: outcomes over a window, by area.
CREATE INDEX cod_outcome_time_idx ON cod_delivery_outcome (tenant_id, occurred_at DESC);

CREATE TRIGGER cod_delivery_outcome_immutable
    BEFORE UPDATE OR DELETE ON cod_delivery_outcome
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE cod_delivery_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE cod_delivery_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cod_delivery_outcome
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- 3. The gate's decision, recorded on the order
-- ---------------------------------------------------------------------------
ALTER TABLE sales_order
    -- How the order intends to be paid. NULL on the surfaces where the
    -- question does not arise (a POS sale is tendered at the counter), so
    -- this is deliberately not NOT NULL.
    ADD COLUMN payment_method text
        CHECK (payment_method IS NULL OR payment_method IN
               ('cod','card','tabby','bank_transfer','store_credit','mixed')),
    -- What the gate required, and what was actually collected before the
    -- order was allowed to confirm.
    ADD COLUMN cod_advance_required_minor bigint NOT NULL DEFAULT 0
        CHECK (cod_advance_required_minor >= 0),
    ADD COLUMN cod_advance_paid_minor bigint NOT NULL DEFAULT 0
        CHECK (cod_advance_paid_minor >= 0),
    -- The score at the moment of the decision. Stored, not recomputed: the
    -- customer's history keeps moving and the policy may change, and neither
    -- should silently rewrite why this order was treated as it was.
    ADD COLUMN cod_risk_score int
        CHECK (cod_risk_score IS NULL OR (cod_risk_score >= 0 AND cod_risk_score <= 100));

-- The invariant R5.5 exists to create: a COD order may not be confirmed while
-- its required advance is unpaid. Enforced in the database because it is the
-- single sentence the whole requirement reduces to, and because the audit
-- found this rule "read and never enforced anywhere in checkout" — an
-- application-level check is exactly what was missing before.
ALTER TABLE sales_order
    ADD CONSTRAINT sales_order_cod_advance_collected CHECK (
        payment_method IS DISTINCT FROM 'cod'
        OR status = 'pending'
        OR status = 'cancelled'
        OR cod_advance_paid_minor >= cod_advance_required_minor
    );

-- ---------------------------------------------------------------------------
-- 4. Marking a payment as the COD advance
-- ---------------------------------------------------------------------------
-- R5.5: "the order records the advance as a separate transaction against the
-- same order". It is a payment row like any other — same reconciliation, same
-- refund rules — distinguished by its purpose so reports do not read a
-- deposit as settlement of the sale.
ALTER TABLE payment
    ADD COLUMN purpose text NOT NULL DEFAULT 'sale'
        CHECK (purpose IN ('sale','cod_advance','cod_collection'));

CREATE INDEX payment_purpose_idx ON payment (tenant_id, order_id, purpose)
    WHERE purpose <> 'sale';

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON cod_policy TO omniretail_app;
GRANT SELECT, INSERT ON cod_delivery_outcome TO omniretail_app;

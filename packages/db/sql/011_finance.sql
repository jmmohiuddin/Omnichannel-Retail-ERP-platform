-- 011_finance.sql — minimal double-entry finance module (AED, minor units).
--
-- Chart of accounts + append-only journal. Two database-level invariants:
--   1. Every journal entry balances (sum(debit) = sum(credit)) — enforced by a
--      DEFERRABLE INITIALLY DEFERRED constraint trigger that fires at COMMIT,
--      so multi-line entries can be inserted row by row inside a transaction.
--   2. Journal rows are immutable — the existing forbid_change() trigger
--      function (001_foundation.sql) rejects UPDATE/DELETE regardless of role.
-- Accounts are created per tenant at first posting (see FinanceService); the
-- migration seeds no rows.

-- ---------------------------------------------------------------------------
-- Chart of accounts (tenant-scoped)
-- ---------------------------------------------------------------------------
CREATE TABLE account (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenant(id),
    code        text NOT NULL,                  -- '1000' Cash, '4000' Sales Revenue, …
    name        text NOT NULL,
    kind        text NOT NULL CHECK (kind IN
                ('asset','liability','equity','revenue','expense')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT account_tenant_code_key UNIQUE (tenant_id, code)
);

-- ---------------------------------------------------------------------------
-- Journal: entry header + lines
-- ---------------------------------------------------------------------------
CREATE TABLE journal_entry (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    entry_no     bigint GENERATED ALWAYS AS IDENTITY,
    source_type  text NOT NULL,                 -- 'sale' | 'refund' | …
    source_id    uuid NOT NULL,                 -- order id / refund id
    memo         text,
    posted_at    timestamptz NOT NULL DEFAULT now(),
    created_at   timestamptz NOT NULL DEFAULT now(),
    -- One entry per business event: posting the same sale/refund twice hits
    -- this constraint (23505) and the service returns the existing entry.
    CONSTRAINT journal_entry_source_key UNIQUE (tenant_id, source_type, source_id)
);
CREATE INDEX journal_entry_posted_idx ON journal_entry (tenant_id, posted_at);

CREATE TABLE journal_line (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    entry_id      uuid NOT NULL REFERENCES journal_entry(id),
    account_id    uuid NOT NULL REFERENCES account(id),
    debit_minor   bigint NOT NULL DEFAULT 0,
    credit_minor  bigint NOT NULL DEFAULT 0,
    CONSTRAINT journal_line_nonnegative CHECK (debit_minor >= 0 AND credit_minor >= 0),
    CONSTRAINT journal_line_one_side    CHECK (debit_minor = 0 OR credit_minor = 0)
);
CREATE INDEX journal_line_entry_idx   ON journal_line (tenant_id, entry_id);
CREATE INDEX journal_line_account_idx ON journal_line (tenant_id, account_id);

-- ---------------------------------------------------------------------------
-- Balance enforcement: per-entry sum(debit) = sum(credit), checked at COMMIT.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_journal_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    total_debit  bigint;
    total_credit bigint;
BEGIN
    SELECT coalesce(sum(debit_minor), 0), coalesce(sum(credit_minor), 0)
      INTO total_debit, total_credit
      FROM journal_line
     WHERE entry_id = NEW.entry_id;
    IF total_debit <> total_credit THEN
        RAISE EXCEPTION 'journal entry % is unbalanced: debits % <> credits %',
            NEW.entry_id, total_debit, total_credit;
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_line_balanced
    AFTER INSERT ON journal_line
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_journal_entry_balanced();

-- ---------------------------------------------------------------------------
-- Immutability: posted journal rows can never be updated or deleted.
-- ---------------------------------------------------------------------------
CREATE TRIGGER journal_entry_immutable
    BEFORE UPDATE OR DELETE ON journal_entry
    FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER journal_line_immutable
    BEFORE UPDATE OR DELETE ON journal_line
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- Row-level security (pattern from 001_foundation.sql)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['account','journal_entry','journal_line']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I
             USING (tenant_id = current_tenant_id())
             WITH CHECK (tenant_id = current_tenant_id())', t);
    END LOOP;
END $$;

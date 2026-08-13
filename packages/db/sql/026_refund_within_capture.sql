-- 026_refund_within_capture.sql — a refund can never exceed what was captured.
--
-- The application guarded this by comparing against `sales_order.total_minor`,
-- which is the amount *ordered*, not the amount *paid*. Two consequences:
--
--   1. An unpaid or partially-captured order could be refunded in full — the
--      shop pays out money it never took. A COD order that was never collected
--      is the obvious case.
--   2. The guard counted only refunds already `approved`/`processed`, so any
--      number of concurrent *pending* requests each passed the check, and every
--      one could then be approved.
--
-- Both are money-loss paths, so the rule belongs in the database where no code
-- path — a future connector, a migration, a manual fix — can route around it.
--
-- Captured means positive `captured` payment legs. Refund legs are written as
-- negative rows with status 'refunded', so they are excluded by the status
-- filter rather than double-counted.

CREATE OR REPLACE FUNCTION refund_within_capture() RETURNS trigger AS $$
DECLARE
    captured bigint;
    refunded bigint;
BEGIN
    -- A rejected refund moves no money.
    IF NEW.status = 'rejected' THEN
        RETURN NEW;
    END IF;

    -- Serialise concurrent refunds against the same order. Without this two
    -- transactions read the same total, both pass, and both commit.
    PERFORM 1 FROM sales_order WHERE id = NEW.order_id FOR UPDATE;

    SELECT coalesce(sum(amount_minor), 0) INTO captured
      FROM payment
     WHERE order_id = NEW.order_id
       AND status = 'captured'
       AND amount_minor > 0;

    -- Pending counts: a request that has not yet been approved still lays claim
    -- to the money, and excluding it is what allowed the concurrent-request hole.
    SELECT coalesce(sum(amount_minor), 0) INTO refunded
      FROM refund
     WHERE order_id = NEW.order_id
       AND status <> 'rejected'
       AND id <> NEW.id;

    IF refunded + NEW.amount_minor > captured THEN
        RAISE EXCEPTION
            'refund exceeds captured payments for order % (captured %, outstanding %, requested %)',
            NEW.order_id, captured, refunded, NEW.amount_minor
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION refund_within_capture() IS
    'Asserts sum(non-rejected refunds) <= sum(captured payments) per order. '
    'Locks the order row so concurrent refund requests serialise.';

CREATE TRIGGER refund_within_capture_check
    BEFORE INSERT OR UPDATE OF amount_minor, status ON refund
    FOR EACH ROW EXECUTE FUNCTION refund_within_capture();

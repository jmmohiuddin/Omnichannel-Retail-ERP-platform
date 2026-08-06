import { useMemo, useState, type FormEvent } from "react";
import { getPnl, getTrialBalance } from "../lib/api.js";
import { defaultPnlRange, pnlQuery, type PnlRange } from "../lib/finance.js";
import { formatMinor } from "../lib/money.js";
import { humanState } from "../lib/movements.js";
import { useAsync } from "../lib/useAsync.js";

function TrialBalanceCard() {
  const { data: tb, error, loading } = useAsync(getTrialBalance, []);

  return (
    <section className="card">
      <div className="page-head">
        <h2 style={{ marginBlockEnd: 0 }}>Trial balance</h2>
        {tb &&
          (tb.netMinor === 0 ? (
            <span className="badge in">Balanced ✓</span>
          ) : (
            <span className="badge out">Out of balance by {formatMinor(tb.netMinor)}</span>
          ))}
      </div>

      {error && <div className="error-banner">Failed to load trial balance: {error}</div>}
      {loading ? (
        <p className="empty">Loading trial balance…</p>
      ) : tb && tb.rows.length === 0 ? (
        <p className="empty">No ledger accounts yet.</p>
      ) : (
        tb && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Account</th>
                  <th>Kind</th>
                  <th className="num">Debit</th>
                  <th className="num">Credit</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {tb.rows.map((row) => (
                  <tr key={row.code}>
                    <td className="mono">{row.code}</td>
                    <td>{row.name}</td>
                    <td>
                      <span className="badge neutral">{humanState(row.kind)}</span>
                    </td>
                    <td className="num">{formatMinor(row.debitMinor)}</td>
                    <td className="num">{formatMinor(row.creditMinor)}</td>
                    <td className="num">{formatMinor(row.balanceMinor)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} style={{ fontWeight: 650 }}>
                    Totals
                  </td>
                  <td className="num" style={{ fontWeight: 650 }}>
                    {formatMinor(tb.totalDebitMinor)}
                  </td>
                  <td className="num" style={{ fontWeight: 650 }}>
                    {formatMinor(tb.totalCreditMinor)}
                  </td>
                  <td className="num" style={{ fontWeight: 650 }}>
                    {formatMinor(tb.netMinor)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )
      )}
    </section>
  );
}

function PnlCard() {
  const [range, setRange] = useState<PnlRange>(() => defaultPnlRange());
  const [applied, setApplied] = useState<PnlRange>(range);
  const query = useMemo(() => pnlQuery(applied), [applied]);

  const {
    data: pnl,
    error,
    loading,
  } = useAsync(async () => {
    if (!query) throw new Error("Pick a valid date range (from must not be after to).");
    return getPnl(query);
  }, [query]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setApplied(range);
  }

  return (
    <section className="card">
      <h2>Profit &amp; loss</h2>

      <form className="panel" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="pnl-from">From</label>
          <input
            id="pnl-from"
            type="date"
            value={range.from}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="pnl-to">To</label>
          <input
            id="pnl-to"
            type="date"
            value={range.to}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            required
          />
        </div>
        <button type="submit" className="secondary">
          Apply
        </button>
      </form>

      {error && (
        <div className="error-banner" style={{ marginBlockStart: "var(--space-3)" }}>
          {error}
        </div>
      )}
      {loading ? (
        <p className="empty">Loading P&amp;L…</p>
      ) : (
        pnl && (
          <>
            <div className="stat-grid" style={{ marginBlockStart: "var(--space-4)" }}>
              <div className="stat">
                <div className="label">Gross revenue</div>
                <div className="value">{formatMinor(pnl.grossRevenueMinor)}</div>
              </div>
              <div className="stat">
                <div className="label">Refunds</div>
                <div className="value">{formatMinor(pnl.refundsMinor)}</div>
              </div>
              <div className="stat">
                <div className="label">Net revenue</div>
                <div className="value">{formatMinor(pnl.netRevenueMinor)}</div>
              </div>
              <div className="stat">
                <div className="label">Cost of sales</div>
                <div className="value">{formatMinor(pnl.costOfSalesMinor)}</div>
              </div>
              <div className="stat">
                <div className="label">VAT collected</div>
                <div className="value">{formatMinor(pnl.vatCollectedMinor)}</div>
              </div>
            </div>
            <p className="faint" style={{ marginBlockEnd: 0 }}>
              {pnl.costOfSalesNote}
            </p>
          </>
        )
      )}
    </section>
  );
}

export function FinancePage() {
  return (
    <>
      <div className="page-head">
        <h1>Finance</h1>
        <span className="subtle">All amounts in AED</span>
      </div>
      <div className="stack">
        <TrialBalanceCard />
        <PnlCard />
      </div>
    </>
  );
}

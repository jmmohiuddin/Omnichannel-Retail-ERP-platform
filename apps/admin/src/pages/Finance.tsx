import { useMemo, useState, type FormEvent } from "react";
import { getPnl, getTrialBalance } from "../lib/api.js";
import { defaultPnlRange, pnlQuery, type PnlRange } from "../lib/finance.js";
import { formatMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import { useT } from "../lib/useT.js";

function TrialBalanceCard() {
  const { t, tEnum } = useT();
  const { data: tb, error, loading } = useAsync(getTrialBalance, []);

  return (
    <section className="card">
      <div className="page-head">
        <h2 style={{ marginBlockEnd: 0 }}>{t("finance.trialBalance")}</h2>
        {tb &&
          (tb.netMinor === 0 ? (
            <span className="badge in">{t("finance.balanced")}</span>
          ) : (
            <span className="badge out">
              {t("finance.outOfBalance", { amount: formatMinor(tb.netMinor) })}
            </span>
          ))}
      </div>

      {error && <div className="error-banner">{t("finance.tbFailed", { error })}</div>}
      {loading ? (
        <p className="empty">{t("finance.tbLoading")}</p>
      ) : tb && tb.rows.length === 0 ? (
        <p className="empty">{t("finance.noAccounts")}</p>
      ) : (
        tb && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("th.code")}</th>
                  <th>{t("th.account")}</th>
                  <th>{t("th.kind")}</th>
                  <th className="num">{t("th.debit")}</th>
                  <th className="num">{t("th.credit")}</th>
                  <th className="num">{t("th.balance")}</th>
                </tr>
              </thead>
              <tbody>
                {tb.rows.map((row) => (
                  <tr key={row.code}>
                    <td className="mono">{row.code}</td>
                    <td>{row.name}</td>
                    <td>
                      <span className="badge neutral">{tEnum("acct", row.kind)}</span>
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
                    {t("finance.totals")}
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
  const { t } = useT();
  const [range, setRange] = useState<PnlRange>(() => defaultPnlRange());
  const [applied, setApplied] = useState<PnlRange>(range);
  const query = useMemo(() => pnlQuery(applied), [applied]);

  const {
    data: pnl,
    error,
    loading,
  } = useAsync(async () => {
    if (!query) throw new Error(t("finance.invalidRange"));
    return getPnl(query);
  }, [query]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setApplied(range);
  }

  return (
    <section className="card">
      <h2>{t("finance.pnl")}</h2>

      <form className="panel" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="pnl-from">{t("finance.from")}</label>
          <input
            id="pnl-from"
            type="date"
            value={range.from}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="pnl-to">{t("finance.to")}</label>
          <input
            id="pnl-to"
            type="date"
            value={range.to}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            required
          />
        </div>
        <button type="submit" className="secondary">
          {t("common.apply")}
        </button>
      </form>

      {error && (
        <div className="error-banner" style={{ marginBlockStart: "var(--space-3)" }}>
          {error}
        </div>
      )}
      {loading ? (
        <p className="empty">{t("finance.pnlLoading")}</p>
      ) : (
        pnl && (
          <>
            <div className="stat-grid" style={{ marginBlockStart: "var(--space-4)" }}>
              <div className="stat">
                <div className="label">{t("finance.grossRevenue")}</div>
                <div className="value">{formatMinor(pnl.grossRevenueMinor)}</div>
              </div>
              <div className="stat">
                <div className="label">{t("finance.refunds")}</div>
                <div className="value">{formatMinor(pnl.refundsMinor)}</div>
              </div>
              <div className="stat">
                <div className="label">{t("finance.netRevenue")}</div>
                <div className="value">{formatMinor(pnl.netRevenueMinor)}</div>
              </div>
              <div className="stat">
                <div className="label">{t("finance.costOfSales")}</div>
                <div className="value">{formatMinor(pnl.costOfSalesMinor)}</div>
              </div>
              <div className="stat">
                <div className="label">{t("finance.vatCollected")}</div>
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
  const { t } = useT();
  return (
    <>
      <div className="page-head">
        <h1>{t("nav.finance")}</h1>
        <span className="subtle">{t("finance.allAmountsAed")}</span>
      </div>
      <div className="stack">
        <TrialBalanceCard />
        <PnlCard />
      </div>
    </>
  );
}

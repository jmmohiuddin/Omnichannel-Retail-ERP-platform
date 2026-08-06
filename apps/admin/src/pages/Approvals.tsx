import { useState } from "react";
import { decideApproval, listApprovals } from "../lib/api.js";
import { approvalAge, approvalKindTone, summarizeApprovalPayload } from "../lib/approvals.js";
import { formatDubaiTime, shortId } from "../lib/movements.js";
import { useAsync } from "../lib/useAsync.js";
import { useT } from "../lib/useT.js";

export function ApprovalsPage() {
  const { t, tEnum, lang } = useT();
  const { data: items, error, loading, reload } = useAsync(listApprovals, []);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  async function decide(id: string, approve: boolean) {
    setBusyId(id);
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      await decideApproval(id, approve);
      reload();
    } catch (err) {
      // 403 SELF_APPROVAL / FORBIDDEN_ROLE: the ApiError message carries the
      // server's explanation — surface it inline on the row.
      const message = err instanceof Error ? err.message : t("approvals.decisionFailed");
      setRowErrors((prev) => ({ ...prev, [id]: message }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>{t("nav.approvals")}</h1>
        <span className="subtle">
          {items ? t("approvals.countPending", { count: items.length }) : ""}
        </span>
      </div>

      {error && <div className="error-banner">{t("approvals.loadFailed", { error })}</div>}

      <section className="card">
        {loading ? (
          <p className="empty">{t("approvals.loading")}</p>
        ) : !items || items.length === 0 ? (
          <p className="empty">{t("approvals.empty")}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("th.kind")}</th>
                  <th>{t("th.summary")}</th>
                  <th>{t("th.reason")}</th>
                  <th>{t("th.requestedBy")}</th>
                  <th>{t("th.age")}</th>
                  <th aria-label={t("common.actions")} />
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <span className={`badge ${approvalKindTone(a.kind)}`}>
                        {tEnum("kind", a.kind)}
                      </span>
                    </td>
                    <td>{summarizeApprovalPayload(a.kind, a.payload, lang)}</td>
                    <td>{a.reason || <span className="faint">—</span>}</td>
                    <td className="mono" title={a.requestedBy}>
                      {shortId(a.requestedBy)}
                    </td>
                    <td
                      title={formatDubaiTime(a.requested_at, lang)}
                      style={{ whiteSpace: "nowrap" }}
                    >
                      {approvalAge(a.requested_at, Date.now(), lang)}
                    </td>
                    <td>
                      <div className="actions">
                        <button
                          type="button"
                          disabled={busyId === a.id}
                          onClick={() => void decide(a.id, true)}
                        >
                          {t("approvals.approve")}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busyId === a.id}
                          onClick={() => void decide(a.id, false)}
                        >
                          {t("approvals.reject")}
                        </button>
                      </div>
                      {rowErrors[a.id] && <span className="row-error">{rowErrors[a.id]}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

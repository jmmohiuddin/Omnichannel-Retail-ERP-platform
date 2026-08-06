import { useState } from "react";
import { decideApproval, listApprovals } from "../lib/api.js";
import { approvalAge, approvalKindTone, summarizeApprovalPayload } from "../lib/approvals.js";
import { formatDubaiTime, humanState, shortId } from "../lib/movements.js";
import { useAsync } from "../lib/useAsync.js";

export function ApprovalsPage() {
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
      const message = err instanceof Error ? err.message : "Decision failed";
      setRowErrors((prev) => ({ ...prev, [id]: message }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Approvals</h1>
        <span className="subtle">
          {items ? `${items.length} pending` : ""} · times in Asia/Dubai
        </span>
      </div>

      {error && <div className="error-banner">Failed to load approvals: {error}</div>}

      <section className="card">
        {loading ? (
          <p className="empty">Loading approvals…</p>
        ) : !items || items.length === 0 ? (
          <p className="empty">Nothing waiting for approval.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Summary</th>
                  <th>Reason</th>
                  <th>Requested by</th>
                  <th>Age</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <span className={`badge ${approvalKindTone(a.kind)}`}>
                        {humanState(a.kind)}
                      </span>
                    </td>
                    <td>{summarizeApprovalPayload(a.kind, a.payload)}</td>
                    <td>{a.reason || <span className="faint">—</span>}</td>
                    <td className="mono" title={a.requestedBy}>
                      {shortId(a.requestedBy)}
                    </td>
                    <td title={formatDubaiTime(a.requested_at)} style={{ whiteSpace: "nowrap" }}>
                      {approvalAge(a.requested_at)}
                    </td>
                    <td>
                      <div className="actions">
                        <button
                          type="button"
                          disabled={busyId === a.id}
                          onClick={() => void decide(a.id, true)}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busyId === a.id}
                          onClick={() => void decide(a.id, false)}
                        >
                          Reject
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

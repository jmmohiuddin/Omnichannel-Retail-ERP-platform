import { useState } from "react";
import {
  cancelOrder,
  fulfillOrder,
  getOrderReceipt,
  listOrders,
  type OrderDto,
} from "../lib/api.js";
import { formatMinor } from "../lib/money.js";
import { formatDubaiTime, formatQuantity, humanState } from "../lib/movements.js";
import {
  ORDER_STATUS_FILTERS,
  buildOrdersQuery,
  canCancel,
  canFulfill,
  fulfillErrorMessage,
  orderStatusTone,
  type OrderStatusFilter,
} from "../lib/orders.js";
import { useAsync } from "../lib/useAsync.js";

function ReceiptModal({ order, onClose }: { order: OrderDto; onClose: () => void }) {
  const { data: receipt, error, loading } = useAsync(() => getOrderReceipt(order.id), [order.id]);
  const currency = receipt?.currency ?? order.currency;

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-label={`Tax invoice ${order.orderNo}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="page-head">
          <h2 style={{ marginBlockEnd: 0 }}>Tax invoice · {receipt?.orderNo ?? order.orderNo}</h2>
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>

        {loading && <p className="empty">Loading receipt…</p>}
        {error && <div className="error-banner">Failed to load receipt: {error}</div>}

        {receipt && (
          <>
            <div className="kv-grid" style={{ marginBlockEnd: "var(--space-4)" }}>
              <div>
                <div className="group-title" style={{ marginBlock: 0 }}>
                  TRN
                </div>
                <span className="mono">{receipt.trn ?? "—"}</span>
              </div>
              <div>
                <div className="group-title" style={{ marginBlock: 0 }}>
                  Issued
                </div>
                {receipt.issuedAt ? formatDubaiTime(receipt.issuedAt) : "—"}
              </div>
            </div>

            {receipt.lines && receipt.lines.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="num">Qty</th>
                      <th className="num">Unit</th>
                      <th className="num">VAT</th>
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receipt.lines.map((line, i) => (
                      <tr key={i}>
                        <td>
                          {line.name ?? line.sku ?? "—"}
                          {line.name && line.sku && (
                            <>
                              {" "}
                              <span className="faint mono">{line.sku}</span>
                            </>
                          )}
                        </td>
                        <td className="num">
                          {line.qty !== undefined ? formatQuantity(line.qty) : "—"}
                        </td>
                        <td className="num">
                          {line.unitPriceMinor !== undefined
                            ? formatMinor(line.unitPriceMinor, currency)
                            : "—"}
                        </td>
                        <td className="num">
                          {line.vatMinor !== undefined ? formatMinor(line.vatMinor, currency) : "—"}
                        </td>
                        <td className="num">
                          {line.totalMinor !== undefined
                            ? formatMinor(line.totalMinor, currency)
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    {receipt.subtotalMinor !== undefined && (
                      <tr>
                        <td colSpan={4} className="num subtle">
                          Subtotal
                        </td>
                        <td className="num">{formatMinor(receipt.subtotalMinor, currency)}</td>
                      </tr>
                    )}
                    {receipt.vatMinor !== undefined && (
                      <tr>
                        <td colSpan={4} className="num subtle">
                          VAT (5%)
                        </td>
                        <td className="num">{formatMinor(receipt.vatMinor, currency)}</td>
                      </tr>
                    )}
                    {receipt.totalMinor !== undefined && (
                      <tr>
                        <td colSpan={4} className="num" style={{ fontWeight: 650 }}>
                          Total
                        </td>
                        <td className="num" style={{ fontWeight: 650 }}>
                          {formatMinor(receipt.totalMinor, currency)}
                        </td>
                      </tr>
                    )}
                  </tfoot>
                </table>
              </div>
            )}

            {receipt.payments && receipt.payments.length > 0 && (
              <>
                <div className="group-title">Payments</div>
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {receipt.payments.map((p, i) => (
                        <tr key={i}>
                          <td>{p.method ? humanState(p.method) : "—"}</td>
                          <td className="num">
                            {p.amountMinor !== undefined
                              ? formatMinor(p.amountMinor, currency)
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <details style={{ marginBlockStart: "var(--space-3)" }}>
              <summary className="faint">Raw receipt JSON</summary>
              <pre className="mono raw-json">{JSON.stringify(receipt, null, 2)}</pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}

export function OrdersPage() {
  const [filter, setFilter] = useState<OrderStatusFilter>("all");
  const {
    data: orders,
    error,
    loading,
    reload,
  } = useAsync(() => listOrders(buildOrdersQuery(filter)), [filter]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [receiptFor, setReceiptFor] = useState<OrderDto | null>(null);

  async function run(
    id: string,
    action: () => Promise<unknown>,
    mapError: (err: unknown) => string,
  ) {
    setBusyId(id);
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      await action();
      reload();
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [id]: mapError(err) }));
    } finally {
      setBusyId(null);
    }
  }

  function onFulfill(order: OrderDto) {
    void run(order.id, () => fulfillOrder(order.id), fulfillErrorMessage);
  }

  function onCancel(order: OrderDto) {
    const reason = window.prompt(`Reason for cancelling ${order.orderNo}?`);
    if (reason === null) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setRowErrors((prev) => ({ ...prev, [order.id]: "A cancellation reason is required." }));
      return;
    }
    void run(
      order.id,
      () => cancelOrder(order.id, trimmed),
      (err) => (err instanceof Error ? err.message : "Cancel failed"),
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>Orders</h1>
        <span className="subtle">
          {orders ? `${orders.length} orders` : ""} · times in Asia/Dubai
        </span>
      </div>

      <div className="tabs" role="tablist" aria-label="Order status filter">
        {ORDER_STATUS_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            className={filter === f ? "active" : ""}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? "All" : humanState(f)}
          </button>
        ))}
      </div>

      {error && <div className="error-banner">Failed to load orders: {error}</div>}

      <section className="card">
        {loading ? (
          <p className="empty">Loading orders…</p>
        ) : !orders || orders.length === 0 ? (
          <p className="empty">
            No {filter === "all" ? "" : `${humanState(filter).toLowerCase()} `}orders.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Status</th>
                  <th>Channel</th>
                  <th>Customer</th>
                  <th className="num">Total</th>
                  <th>Placed (Dubai)</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">{o.orderNo}</td>
                    <td>
                      <span className={`badge ${orderStatusTone(o.status)}`}>
                        {humanState(o.status)}
                      </span>
                    </td>
                    <td>{humanState(o.channelKind)}</td>
                    <td>{o.customerName ?? <span className="faint">Walk-in</span>}</td>
                    <td className="num">{formatMinor(o.totalMinor, o.currency)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{formatDubaiTime(o.placedAt)}</td>
                    <td>
                      <div className="actions">
                        {canFulfill(o.status) && (
                          <button
                            type="button"
                            disabled={busyId === o.id}
                            onClick={() => onFulfill(o)}
                          >
                            Fulfill
                          </button>
                        )}
                        {canCancel(o.status) && (
                          <button
                            type="button"
                            className="secondary"
                            disabled={busyId === o.id}
                            onClick={() => onCancel(o)}
                          >
                            Cancel
                          </button>
                        )}
                        <button type="button" className="link" onClick={() => setReceiptFor(o)}>
                          Receipt
                        </button>
                      </div>
                      {rowErrors[o.id] && <span className="row-error">{rowErrors[o.id]}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {receiptFor && <ReceiptModal order={receiptFor} onClose={() => setReceiptFor(null)} />}
    </>
  );
}

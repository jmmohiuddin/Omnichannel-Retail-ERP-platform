import { useState } from "react";
import {
  cancelOrder,
  fulfillOrder,
  getOrderReceipt,
  listOrders,
  type OrderDto,
} from "../lib/api.js";
import { formatMinor } from "../lib/money.js";
import { formatDubaiTime, formatQuantity } from "../lib/movements.js";
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
import { useT } from "../lib/useT.js";

function ReceiptModal({ order, onClose }: { order: OrderDto; onClose: () => void }) {
  const { t, tEnum, lang } = useT();
  const { data: receipt, error, loading } = useAsync(() => getOrderReceipt(order.id), [order.id]);
  const currency = receipt?.currency ?? order.currency;

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-label={`${t("receipt.title")} ${order.orderNo}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="page-head">
          <h2 style={{ marginBlockEnd: 0 }}>
            {t("receipt.title")} · {receipt?.orderNo ?? order.orderNo}
          </h2>
          <button type="button" className="secondary" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>

        {loading && <p className="empty">{t("receipt.loading")}</p>}
        {error && <div className="error-banner">{t("receipt.loadFailed", { error })}</div>}

        {receipt && (
          <>
            <div className="kv-grid" style={{ marginBlockEnd: "var(--space-4)" }}>
              <div>
                <div className="group-title" style={{ marginBlock: 0 }}>
                  {t("receipt.trn")}
                </div>
                <span className="mono">{receipt.trn ?? "—"}</span>
              </div>
              <div>
                <div className="group-title" style={{ marginBlock: 0 }}>
                  {t("receipt.issued")}
                </div>
                {receipt.issuedAt ? formatDubaiTime(receipt.issuedAt, lang) : "—"}
              </div>
            </div>

            {receipt.lines && receipt.lines.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t("th.item")}</th>
                      <th className="num">{t("th.qty")}</th>
                      <th className="num">{t("th.unit")}</th>
                      <th className="num">{t("th.vat")}</th>
                      <th className="num">{t("th.total")}</th>
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
                          {t("receipt.subtotal")}
                        </td>
                        <td className="num">{formatMinor(receipt.subtotalMinor, currency)}</td>
                      </tr>
                    )}
                    {receipt.vatMinor !== undefined && (
                      <tr>
                        <td colSpan={4} className="num subtle">
                          {t("receipt.vat5")}
                        </td>
                        <td className="num">{formatMinor(receipt.vatMinor, currency)}</td>
                      </tr>
                    )}
                    {receipt.totalMinor !== undefined && (
                      <tr>
                        <td colSpan={4} className="num" style={{ fontWeight: 650 }}>
                          {t("receipt.total")}
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
                <div className="group-title">{t("receipt.payments")}</div>
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {receipt.payments.map((p, i) => (
                        <tr key={i}>
                          <td>{p.method ? tEnum("pay", p.method) : "—"}</td>
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
              <summary className="faint">{t("receipt.rawJson")}</summary>
              <pre className="mono raw-json">{JSON.stringify(receipt, null, 2)}</pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}

export function OrdersPage() {
  const { t, tEnum, lang } = useT();
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
    void run(order.id, () => fulfillOrder(order.id), (err) => fulfillErrorMessage(err, lang));
  }

  function onCancel(order: OrderDto) {
    const reason = window.prompt(t("orders.cancelPrompt", { orderNo: order.orderNo }));
    if (reason === null) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setRowErrors((prev) => ({ ...prev, [order.id]: t("orders.cancelReasonRequired") }));
      return;
    }
    void run(
      order.id,
      () => cancelOrder(order.id, trimmed),
      (err) => (err instanceof Error ? err.message : t("orders.cancelFailed")),
    );
  }

  const statusLabel = (status: string) => tEnum("status", status);

  return (
    <>
      <div className="page-head">
        <h1>{t("nav.orders")}</h1>
        <span className="subtle">
          {orders ? t("orders.countSummary", { count: orders.length }) : ""}
        </span>
      </div>

      <div className="tabs" role="tablist" aria-label={t("orders.filterLabel")}>
        {ORDER_STATUS_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            className={filter === f ? "active" : ""}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? t("orders.all") : statusLabel(f)}
          </button>
        ))}
      </div>

      {error && <div className="error-banner">{t("orders.loadFailed", { error })}</div>}

      <section className="card">
        {loading ? (
          <p className="empty">{t("orders.loading")}</p>
        ) : !orders || orders.length === 0 ? (
          <p className="empty">
            {filter === "all"
              ? t("orders.none")
              : t("orders.noneFiltered", {
                  status: lang === "en" ? statusLabel(filter).toLowerCase() : statusLabel(filter),
                })}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("th.order")}</th>
                  <th>{t("th.status")}</th>
                  <th>{t("th.channel")}</th>
                  <th>{t("th.customer")}</th>
                  <th className="num">{t("th.total")}</th>
                  <th>{t("th.placedDubai")}</th>
                  <th aria-label={t("common.actions")} />
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">{o.orderNo}</td>
                    <td>
                      <span className={`badge ${orderStatusTone(o.status)}`}>
                        {statusLabel(o.status)}
                      </span>
                    </td>
                    <td>{tEnum("channel", o.channelKind)}</td>
                    <td>{o.customerName ?? <span className="faint">{t("orders.walkIn")}</span>}</td>
                    <td className="num">{formatMinor(o.totalMinor, o.currency)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{formatDubaiTime(o.placedAt, lang)}</td>
                    <td>
                      <div className="actions">
                        {canFulfill(o.status) && (
                          <button
                            type="button"
                            disabled={busyId === o.id}
                            onClick={() => onFulfill(o)}
                          >
                            {t("orders.fulfill")}
                          </button>
                        )}
                        {canCancel(o.status) && (
                          <button
                            type="button"
                            className="secondary"
                            disabled={busyId === o.id}
                            onClick={() => onCancel(o)}
                          >
                            {t("orders.cancel")}
                          </button>
                        )}
                        <button type="button" className="link" onClick={() => setReceiptFor(o)}>
                          {t("orders.receipt")}
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

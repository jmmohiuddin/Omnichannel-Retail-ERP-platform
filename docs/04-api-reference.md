# API Reference

Base URL: `http://localhost:3001` (dev). All amounts are integer minor units (fils);
quantities are decimal numbers. Authenticated endpoints require
`Authorization: Bearer <accessToken>`. Errors return `{error: CODE, message?}`; validation
failures return `{error: "VALIDATION", issues: [...]}` (400). Generated-source of truth:
[`apps/api/src/pgApp.ts`](../apps/api/src/pgApp.ts) — this document is the human index.

## Auth (public)

| Method & path | Body | Returns |
| --- | --- | --- |
| POST `/v1/auth/register` | tenantName, slug, fullName, email, password, currency? | 201 tokens `{accessToken, refreshToken, userId, tenantId}` |
| POST `/v1/auth/login` | slug, email, password | tokens |
| POST `/v1/auth/refresh` | tenantId, refreshToken | rotated tokens (old refresh is dead) |

## Public storefront (no auth)

| Method & path | Notes |
| --- | --- |
| GET `/v1/public/:slug/catalog` | `{tenant, items[{productId,name,slug,tracking,variants[{id,sku,priceMinor,currency,available}]}]}` |
| POST `/v1/public/:slug/orders` | `{customer{name,email?,phone?}, lines[{variantId,quantity}]}` → 201 order with reservation; 422 `INSUFFICIENT_STOCK` |
| POST `/v1/public/:slug/orders/:orderId/pay` | `{gateway?}` → 201 `{intentId,gatewayRef,redirectUrl}`; 409 `INTENT_EXISTS`/`BAD_STATE` |
| POST `/v1/webhooks/payments/:gateway` | Raw JSON body + `x-webhook-signature` (HMAC-SHA256); 401 `BAD_SIGNATURE`; idempotent by event id |

## Users, customers, devices

| Method & path | Auth | Notes |
| --- | --- | --- |
| POST `/v1/users` | owner | create employee `{email,password,fullName,role: manager\|cashier\|warehouse}` |
| GET/POST `/v1/customers` | any | search `?query=` / quick-create `{fullName,phone?,email?}` |
| GET `/v1/customers/:id/loyalty` | any | `{points, valueMinor, history[]}` |
| GET/POST `/v1/devices` | any | list / register POS device `{kind,name,locationId?}` |

## Catalog

| Method & path | Notes |
| --- | --- |
| GET `/v1/locations` · POST `/v1/locations` | list / create `{kind: store\|warehouse\|virtual, name, code}` |
| GET `/v1/products?query=` | products + variants (name/sku/barcode search) |
| POST `/v1/products` · POST `/v1/products/:id/variants` | create `{name,slug,tracking}` / `{sku,priceMinor,currency,barcode?,costMinor?}` |

## Inventory (ledger)

| Method & path | Notes |
| --- | --- |
| POST `/v1/inventory/movements` | post any movement; actor forced from token. 409 duplicate id, 422 `INSUFFICIENT_STOCK`, 403 `APPROVAL_REQUIRED` |
| GET `/v1/inventory/movements?afterSeq=&limit=` | cursor-paged ledger feed (POS/connector sync) |
| GET `/v1/inventory/availability/:variantId/:locationId` | `{onHand,reserved,available,inTransit,damaged,returnedPending}` |
| GET `/v1/inventory/levels?locationId=` | stock levels joined to catalog |
| POST `/v1/inventory/receipts` | goods receiving; serialized variants take `units:[{imei1,imei2?,serialNo?,unitCostMinor?}]` (Luhn-validated, unique) |
| GET `/v1/stock-units?imei=&serialNo=` | resolve a scanned unit |

## Sales & orders

| Method & path | Notes |
| --- | --- |
| POST `/v1/pos/sales` | atomic sale (order+lines+payments+ledger+loyalty). Serialized lines need `stockUnitId`. Payments: cash/card/loyalty_points. Duplicate id → 200 `{duplicate:true}` |
| GET `/v1/orders?status=&limit=` | order list for ops |
| POST `/v1/orders/:id/fulfill` | reserved → sold; serialized units assigned via `{units:[{variantId,stockUnitId}]}` |
| POST `/v1/orders/:id/cancel` | `{reason}` — releases reservation, voids pending payment |
| GET `/v1/orders/:id/receipt` | tax-invoice JSON (TRN, VAT per line, payments) |
| GET `/v1/orders/:id/einvoice` | PINT-AE-draft UBL: `{model, xml, validation}` (pre-transmission) |
| POST `/v1/orders/:id/refunds` | request refund `{amountMinor,reason,method,restock?}` → pending approval |

## Approvals (two-person controls)

| Method & path | Notes |
| --- | --- |
| GET `/v1/approvals` | pending queue (refunds, stock-count variances) |
| POST `/v1/approvals/:id/decision` | `{approve}` — manager/owner only; self-approval blocked (403) |

## Store operations

| Method & path | Notes |
| --- | --- |
| POST `/v1/cash-sessions` · POST `/v1/cash-sessions/:id/close` | open `{deviceId,openingFloatMinor}` / blind close `{declaredMinor}` → variance |
| POST `/v1/transfers` · POST `/v1/transfers/:id/receive` | dispatch (on_hand→in_transit) / receive (→on_hand) |
| POST `/v1/stock-counts` → PUT `.../lines` → POST `.../submit` | blind cycle count; variance → approval → corrections |

## WMS (owner/manager/warehouse)

| Method & path | Notes |
| --- | --- |
| POST `/v1/wms/zones` · `/v1/wms/bins` · `/v1/wms/bins/:id/assign` | layout + variant→bin directory |
| GET `/v1/wms/locations/:id/layout` | zones→bins→skus |
| POST `/v1/wms/pick-lists` | `{orderId}` → walking-order lines with bin paths |
| PUT `/v1/wms/pick-lists/:id/picks` · POST `.../complete` | record picks / complete (short picks → 422) |

## Shipping

| Method & path | Notes |
| --- | --- |
| POST `/v1/orders/:id/shipments` | fulfilled orders only; `{courier,address,codAmountMinor?}` |
| POST `/v1/shipments/:id/refresh` | poll courier; delivery completes the order |
| GET `/v1/shipments/:id` | shipment + event history |

## Finance (owner/manager)

| Method & path | Notes |
| --- | --- |
| POST `/v1/finance/orders/:id/post` | post sale journal (idempotent); includes COGS when cost data exists |
| POST `/v1/finance/refunds/:id/post` | post refund reversal (idempotent) |
| GET `/v1/finance/trial-balance` | per-account totals; `netMinor` is always 0 |
| GET `/v1/finance/pnl?from=&to=` | ISO datetimes; revenue, refunds, COGS, VAT |

## Analytics & AI

| Method & path | Notes |
| --- | --- |
| GET `/v1/analytics/summary` | today/7-day revenue, top sellers, stock value |
| GET `/v1/ai/reorder-suggestions?windowDays=&leadTimeDays=` | statistical reorder points with confidence labels |
| GET `/v1/ai/dead-stock?thresholdDays=` | stale stock by tied-up value |
| GET `/v1/ai/daily-digest` | manager+; Claude narration (or stub without API key); 429 on budget |
| GET `/v1/reports/exceptions?sinceHours=` | manager+; refund/approval activity digest |

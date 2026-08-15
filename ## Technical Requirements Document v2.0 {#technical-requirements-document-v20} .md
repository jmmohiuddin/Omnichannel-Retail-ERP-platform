# Voltix Commerce OS

## Technical Requirements Document v2.0

**Status:** Draft for engineering review · **Date:** 12 August 2026 · **Companion to:** *Voltix Commerce OS — PRD v2.0* · **Supersedes:** §10 of the 9 Aug 2026 audit and `docs/02-architecture.md`, `docs/03-data-model.md`, `docs/04-api.md`

* * *

## 0\. Scope and stance

This document specifies how to build what PRD v2.0 requires. It is written against a real codebase, not a blank page, so it is organised as **keep / change / add** rather than as a greenfield design.

**What is kept, unchanged, deliberately.** The audit found the correctness foundations unusually strong for a codebase of eleven commits. Those are not re\-litigated here:

- Money as `bigint` minor units everywhere. No float, ever.
- Multi\-tenancy by Postgres row\-level security with `FORCE` plus an `admin_bypass` policy, adversarially tested — not `WHERE tenant_id` by convention.
- Three\-axis order status (lifecycle / payment / fulfilment) with derived status recomputed from the ledger; the column is a cache, the ledger is truth.
- `stock_movements` append\-only with UPDATE and DELETE revoked from the application role.
- Gapless document numbering from a `counters` table rather than Postgres sequences, because `nextval` does not roll back and tax authorities require gapless.
- Immutable price and cost snapshot on `order_items`.
- Argon2id, opaque server\-side sessions, TOTP, `session_epoch` revocation, 27\-permission RBAC checked server\-side per action, session table revoked from the app role.
- Payments behind a port with adapters, retry and a circuit breaker.
- The checkout ordering: idempotency before work, pricing before authorisation, locks before money, notification enqueued in the same transaction as the order.
- Pure domain package with no I/O, fully unit tested.

**The governing constraint.** Everything in §1–§10 is subordinate to one invariant, stated once and enforced in several places:

> A physical unit exists in exactly one place in the ledger at any instant. Selling it on any surface makes it unavailable on every other surface, and a serialised unit can never reach `sold` twice.

* * *

## 1\. Architecture

### 1\.1 Runtime topology — the decision that has to change

**AUDIT:** everything runs as Next.js Server Actions on Vercel, with the only HTTP route being `/api/cron/tick`, driven by GitHub Actions every 5 minutes and Vercel Cron daily. That works for a storefront. It does not work for what the PRD requires, for three independent reasons:

1. Channel sync needs a **long\-lived worker** with backoff, queue depth and per\-channel token buckets. A 5\-minute cron tick cannot carry a stock push that must land in seconds.
2. The POS needs **inbound webhooks and low\-latency writes** that are not Server Actions, because an offline queue replays over HTTP from a client that may not hold a Next.js action reference.
3. Amazon `ORDER_CHANGE` notifications arrive on **SQS**, which requires a consumer that is always running.

**DECISION — hybrid runtime.** This confirms and specifies the decision recorded in Aug 2026.

```
┌──────────────── Vercel (sin1) ─────────────────┐
│  apps/storefront   Next.js 16 RSC              │
│  apps/admin        Next.js 16 RSC              │
│  apps/pos          Next.js 16, client-heavy    │  ← new
│  /api/v1/*         REST, module-routed         │  ← new
│  /api/webhooks/*   gateway + channel inbound   │  ← new
│  /healthz          liveness                    │  ← new
└───────────────┬────────────────────────────────┘
                │  Redis (queues, locks, rate limits, idempotency)
┌───────────────▼──────── Process host ──────────┐
│  worker-sync      channel push / pull           │  ← new
│  worker-jobs      outbox, forecasts, reconcile  │  ← moved off cron
│  worker-events    Amazon SQS consumer           │  ← new
└───────────────┬────────────────────────────────┘
                │
        ┌───────▼────────┐        ┌──────────────────┐
        │ Postgres (RLS) │        │ Object storage   │
        │ + PITR backups │        │ invoices, backups│
        └────────────────┘        └──────────────────┘
```

**Process host options — ADR\-001 summary.** Railway, Fly.io or a Hetzner/DO VM with systemd. Criteria: it must run a Node process indefinitely, hold outbound connections to noon/Amazon/SQS, sit in or near `ap-southeast-1`/`me-south-1` for database latency, and cost under USD 30/month at this scale. **DECISION: Fly.io** in the region nearest the Postgres primary — closest to the existing deployment model, no VM to patch, and machines suspend cleanly. Revisit if egress or cold\-start behaviour disappoints.

**Redis becomes load\-bearing.** **AUDIT:** T\-07 — Redis is provisioned in `.env` and `docker-compose` and used by no code, which the audit correctly called cost plus a false impression of caching. It now carries queues, distributed locks, public rate limiting (T\-05) and idempotency keys. Either it earns its place this way or it is deleted; it does not stay provisioned and unused.

### 1\.2 Module structure — plugin\-per\-module API split

**DECISION**, confirming the Aug 2026 decision. Each domain module owns its own route namespace and its own contract, so a module can be developed, tested, versioned and — eventually — extracted without touching its neighbours.

| Package | Owns | Route namespace | Change |
| --- | --- | --- | --- |
| `@voltix/core` | Money, pricing, tax engine, order state machine, RBAC, UAE rules | — | Extend: tax engine (§5) |
| `@voltix/catalogue` | Products, variants, attributes, media, publication | `/api/v1/catalogue` | **New** — split out of commerce |
| `@voltix/inventory` | Stock ledger, **serial units**, reservations, adjustments, stocktake, transfers | `/api/v1/inventory` | **New** |
| `@voltix/commerce` | Cart, checkout, orders, returns, shipments | `/api/v1/orders` | Keep, narrow |
| `@voltix/pos` | Till sessions, shifts, tenders, parked sales, offline sync | `/api/v1/pos` | **New** |
| `@voltix/tax` | Tax documents, invoice numbering, PINT AE mapping, ASP port | `/api/v1/tax` | **New** |
| `@voltix/channels` | Channel port \+ noon and Amazon adapters, allocation, sync log | `/api/v1/channels` | **New** |
| `@voltix/payments` | Gateway port \+ adapters, webhook verification, terminal port | `/api/v1/payments` | Keep, extend |
| `@voltix/purchasing` | Suppliers, purchase orders, receiving, landed cost | `/api/v1/purchasing` | **New** |
| `@voltix/auth` | Argon2, sessions, TOTP, throttling | — | Keep unchanged |
| `@voltix/notifications` | Outbox, transports, templates | — | Keep, add WhatsApp |
| `@voltix/analytics` | Event ingestion, funnels, report queries | `/api/v1/reports` | **New** |
| `@voltix/db` | Drizzle schema, RLS client, migrations | — | Keep, extend |
| `@voltix/ui` | Tokens, formatters, primitives | — | Extend (Design Doc) |
| `@voltix/ai` | Statistical forecasting, risk scoring, search fusion | — | **Rename to `@voltix/forecasting`; delete the Anthropic client and model registry** |

**Dependency rule, enforced in CI by an import\-boundary lint:** `core` depends on nothing. Domain modules depend on `core` and `db` only. Apps depend on modules. **No module imports another module directly** — cross\-module work goes through an explicitly published contract or a domain event. This is what makes the plugin split real rather than cosmetic.

### 1\.3 ADR index

| ADR | Decision | Status |
| --- | --- | --- |
| ADR\-001 | Hybrid runtime: Vercel apps \+ Fly.io process host \+ Redis | Proposed |
| ADR\-002 | POS is a separate Next.js app, not a route in admin | Proposed — §3.1 |
| ADR\-003 | Offline\-first POS on IndexedDB with server\-side idempotent replay | Proposed — §3.2 |
| ADR\-004 | Local print agent over WebSocket, with ePOS\-Print as the tablet path | Proposed — §3.4 |
| ADR\-005 | Serial units as first\-class stock records with a DB\-enforced uniqueness invariant | Proposed — §4 |
| ADR\-006 | Tax as a pure engine in `core`, documents as immutable rows | Proposed — §5 |
| ADR\-007 | Channel sync: single source of truth, event\-driven push, reconciliation sweep | Proposed — §6 |
| ADR\-008 | REST `/api/v1` per module alongside Server Actions, not replacing them | Proposed — §7 |
| ADR\-009 | Card is an external tender in v1; terminal integration behind a port | Proposed — §3.5 |
| ADR\-010 | Delete pgvector, `product_embeddings` and the Anthropic client | Proposed — §1.2 |

* * *

## 2\. Data model

**AUDIT:** 72 tables, of which roughly 30 have no writer; documentation claimed 45. The remedy is not to add 30 more. §9.1 of the PRD forbids new tables ahead of the workflow that writes to them.

### 2\.1 Table disposition

| Group | Tables | Action |
| --- | --- | --- |
| Serialised stock | `serial_units` | **Rebuild and wire.** The central new object — §2.2 |
| Stock correction | `stock_counts`, `stock_count_lines`, `stock_adjustments` | **Add** — R4.1–4.2 |
| Transfers | `stock_transfers`, `stock_transfer_lines` | **Add** — R4.3 |
| POS | `pos_terminals`, `pos_shifts`, `pos_sales`, `pos_tenders`, `pos_parked_sales`, `pos_cash_movements` | **Add** — §3 |
| Tax | `tax_documents`, `tax_document_lines`, `tax_declarations`, `einvoice_transmissions` | **Add** — §5 |
| Channels | `channels`, `channel_listings`, `channel_stock_pushes`, `channel_orders_raw`, `channel_sync_log` | **Add** — §6 |
| Purchasing | `purchase_orders`, `purchase_order_items`, `suppliers` | **Wire** — exist, unused |
| Shipments | `shipments`, `shipment_items` | **Wire** — exist, unused |
| Discounts | `discounts`, `discount_redemptions` | Engine works; admin UI in Phase 4 |
| Reviews | `reviews`, `review_summaries` | Read\-only display; keep |
| Analytics | `analytics_events`, `search_queries`, `recently_viewed` | **Wire** — R12.1 |
| Audit | `audit_logs` | **Wire** — R14.4. Append\-only, no writer today |
| Retention | `gift_cards`, `store_credit_entries`, `loyalty_transactions` | Keep `store_credit_entries` (POS tender); **drop gift cards and loyalty** until a requirement exists |
| AI | `assistant_conversations`, `ai_jobs`, `ai_usage`, `product_embeddings` | **Drop.** Also drop the pgvector extension — ADR\-010 |
| Pricing intel | `competitor_prices`, `price_recommendations` | **Drop.** No requirement, no writer |
| BNPL | `instalment_plans` | Wire when Tabby ships (R3.14) |

Dropping speculative tables is a migration, not a deletion of history — each is verified empty before its migration runs, and the migration fails loudly if it is not.

### 2\.2 `serial_units` — the spine

```sql
CREATE TYPE serial_state AS ENUM (
  'expected',    -- on a PO, not yet physically received
  'in_stock',    -- received, sellable
  'reserved',    -- held by a cart, an online order, or a POS line
  'sold',        -- terminal for the sale leg
  'returned',    -- came back, awaiting inspection
  'rma',         -- with the supplier
  'written_off'  -- terminal
);

CREATE TABLE serial_units (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  variant_id      uuid NOT NULL REFERENCES variants(id),
  serial          text NOT NULL,               -- IMEI or manufacturer serial
  serial_type     text NOT NULL,               -- 'imei' | 'serial'
  imei2           text,                        -- dual-SIM second IMEI
  state           serial_state NOT NULL DEFAULT 'expected',
  warehouse_id    uuid REFERENCES warehouses(id),
  po_item_id      uuid REFERENCES purchase_order_items(id),
  supplier_id     uuid REFERENCES suppliers(id),
  unit_cost       bigint,                      -- minor units, landed
  received_at     timestamptz,
  order_item_id   uuid REFERENCES order_items(id),
  sold_at         timestamptz,
  warranty_months smallint,
  warranty_starts date,
  grade           text,                        -- 'new' | 'open_box' | 'refurb'
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT serial_unique_per_tenant UNIQUE (tenant_id, serial),
  CONSTRAINT sold_requires_order   CHECK (state <> 'sold'  OR order_item_id IS NOT NULL),
  CONSTRAINT stock_requires_wh     CHECK (state NOT IN ('in_stock','reserved') OR warehouse_id IS NOT NULL),
  CONSTRAINT received_has_date     CHECK (state = 'expected' OR received_at IS NOT NULL)
);

-- The invariant that makes R2.7 true at the database, not in application code.
CREATE UNIQUE INDEX serial_one_sale
  ON serial_units (id)
  WHERE state = 'sold';

CREATE UNIQUE INDEX serial_order_item_unique
  ON serial_units (order_item_id)
  WHERE order_item_id IS NOT NULL AND state = 'sold';

CREATE INDEX serial_lookup ON serial_units (tenant_id, serial);
CREATE INDEX serial_by_variant_state ON serial_units (tenant_id, variant_id, state)
  WHERE state IN ('in_stock','reserved');
```

RLS is applied exactly as on every other tenant\-scoped table, with `FORCE`, and is covered by the existing adversarial cross\-tenant integration test.

**State transitions** are a pure function in `@voltix/core`, mirroring the order state machine that already works:

```
expected  → in_stock                        (receive)
in_stock  → reserved | sold | written_off   (hold / direct counter sale / shrinkage)
reserved  → sold | in_stock                 (complete / release)
sold      → returned                        (customer return)
returned  → in_stock | rma | written_off    (inspection outcome)
rma       → in_stock | written_off          (supplier outcome)
```

`sold → in_stock` is deliberately not a legal transition. A returned unit passes through `returned` and an inspection decision. Restocking without inspection is how grey stock and warranty fraud enter a system.

**Serial movements.** Every transition appends to `serial_movements` — the same append\-only, revoked\-UPDATE/DELETE treatment as `stock_movements` — carrying the actor, the surface, the reason and the two states. This table is what makes R2.6 a query rather than an investigation.

### 2\.3 Aggregate stock and serialised stock

Two representations, one truth. `stock_levels` remains the fast aggregate the storefront and channels read. For a serialised variant it is **derived, not authoritative**\:

```
stock_levels.available = COUNT(serial_units WHERE state = 'in_stock')
```

It is recomputed inside the same transaction as any serial state change, by a trigger, so it can never drift. A nightly job asserts the equality across all serialised variants and raises an exception if it ever fails — this is the assertion that catches a bug before a customer does.

### 2\.4 Documented index strategy

**AUDIT:** no documented index strategy existed and indexes were never validated against real plans. Each of these is added with an `EXPLAIN` captured in the migration's comment.

| Query | Index |
| --- | --- |
| POS product search by SKU/barcode prefix | `(tenant_id, sku text_pattern_ops)`, `(tenant_id, barcode)` |
| IMEI lookup | `serial_lookup` above |
| Available serials for a variant | `serial_by_variant_state` partial |
| Order list by channel and date | `(tenant_id, channel, created_at DESC)` |
| Dashboard aggregates | Covering index on `(tenant_id, created_at, status)` incl. totals — **AUDIT:** currently multiple unindexed aggregates |
| Product list with stock and 30\-day sales | Replace 3 correlated subqueries per row with a materialised view refreshed by the jobs worker — **AUDIT:** T\-06 hot spot |
| Channel sync log by SKU | `(tenant_id, sku, created_at DESC)` |
| Analytics events | BRIN on `created_at`; partition monthly once volume warrants |

* * *

## 3\. Point of sale

### 3\.1 Why a separate app — ADR\-002

The POS is a separate Next.js application, not a route inside admin. **AUDIT:** the admin is desktop\-first, server\-rendered and collapses below 900px. The POS has the opposite requirements: client\-heavy, offline\-capable, touch\-first, a service worker, a completely different keyboard model and a hostile performance budget. Sharing a shell would compromise both. They share `@voltix/ui`, `@voltix/core` and the session cookie; nothing else.

### 3\.2 Offline architecture — ADR\-003

```
┌─────────────── POS client ───────────────┐
│  React UI                                 │
│      │                                    │
│  Sale engine (pure, from @voltix/core)    │  ← same pricing/tax code as the server
│      │                                    │
│  Local store (IndexedDB via idb)          │
│    · catalogue snapshot (products,        │
│      variants, prices, tax codes)         │
│    · serial index for scanned lookups     │
│    · outbox: queued sales                 │
│    · claims: locally held serial units    │
│    · shift state                          │
│      │                                    │
│  Sync engine ── online? ──► POST /api/v1/pos/sales
│      │                       (idempotent, batched)
│  Service worker (app shell + assets)      │
└───────────────────────────────────────────┘
```

**Why the pricing and tax engine must be the same code.** An offline sale computes its own totals and VAT. If the client used a different implementation from the server, a replayed sale would disagree with its own receipt. `@voltix/core` is already pure with no I/O — it compiles to the client unchanged. The server recomputes on replay and treats any disagreement as a reconciliation exception rather than silently overwriting; the printed receipt is a document the customer holds.

**Catalogue snapshot.** Pulled at shift open and refreshed by delta every 60 seconds while online, keyed by a monotonic `catalogue_version`. Cap: the full catalogue for a shop at this scale is a few thousand variants — well within IndexedDB. Prices, tax codes and warranty terms travel with it. Stock counts travel too but are marked stale in the UI after 60 seconds offline.

**Serial claims.** When a cashier scans an IMEI offline, the client writes a local claim `{serial, till_id, claimed_at, sale_uuid}`. On sync the server attempts the state transition. If the unit is already `sold`, the server **accepts the sale** — the customer has walked out with the handset; refusing it would create a phantom — and raises a `duplicate_serial_claim` exception naming both tills, both cashiers and both timestamps, blocking the day from closing until a human resolves it. Losing money quietly is worse than an alarm.

**Replay protocol.**

```
POST /api/v1/pos/sales
Idempotency-Key: <client sale uuid>
{
  sale_uuid, till_id, shift_id, sequence_no,       // monotonic per till
  created_at_client, lines[], tenders[],
  customer?, tax_context, computed_totals,
  serial_claims[]
}

→ 201 { sale_id, invoice_number, totals, exceptions[] }
→ 200 { ... }   // already applied; returns the original result verbatim
→ 409 { conflict: 'shift_closed' | 'catalogue_version_too_old', ... }
```

Idempotency keys live in Redis for 72 hours and in Postgres permanently on the sale row. A replayed key returns the original response byte for byte — it never re\-executes.

**Storage discipline.** IndexedDB only. Never `localStorage` (5MB, synchronous, cleared by "clear browsing data" more readily). Never memory. **RESEARCH:** the documented failure mode in Odoo POS is exactly this — orders in browser storage lost to a cleared cache or a different profile. Mitigations: a persistent\-storage request (`navigator.storage.persist()`), a visible unsynced badge, sign\-out and shift\-close blocked while the outbox is non\-empty (Loyverse's rule), and a daily automatic export of the outbox to the local filesystem as a last resort.

### 3\.3 Till hardware — the decision that gates the architecture

**OPEN — PRD Q5, and it is genuinely blocking.** **RESEARCH:** WebUSB and Web Serial are unsupported in Safari and on iPad, permanently, and WebKit's position is opposed. That single fact partitions the design:

| Till platform | Printing | Drawer | Scanner | Verdict |
| --- | --- | --- | --- | --- |
| **Windows PC / mini\-PC** | Local print agent (recommended) or ePOS\-Print | Via printer kick | USB keyboard\-wedge | **Recommended.** Cheapest hardware, every path open |
| Android tablet | ePOS\-Print over network, or Bluetooth ESC/POS | Via printer kick | Bluetooth HID wedge | Workable |
| **iPad** | ePOS\-Print / Server Direct Print **only** | Via printer kick | Bluetooth HID wedge | Constrained. No local agent |
| Chromebook | WebUSB or local agent | Via printer kick | USB wedge | Workable |

**DECISION pending Q5, default recommendation: a Windows mini\-PC with an Epson TM\-m30III (\~AED 1,150), a cash drawer on the printer's RJ\-11 kick port, and a USB 2D imager.** The 2D imager matters — **RESEARCH:** it reads Data Matrix and QR, which appear on newer IMEI labels, and it reads barcodes off a phone screen, which the BNPL QR flows need.

### 3\.4 Printing — ADR\-004

**Primary: a local print agent.** A small signed Node binary on the till, listening on `localhost` over **WebSocket**, speaking raw ESC/POS to the printer over USB or TCP:9100.

Why WebSocket rather than HTTP: **RESEARCH** — Chrome 142 shipped Local Network Access, gating requests from a public\-origin page to loopback and private IPv4 ranges behind a user permission prompt. WebSocket, WebTransport and WebRTC are **not yet gated**. That makes a WebSocket agent the path of least friction today. Plan for it to change: handle a denied permission gracefully and document the enterprise\-policy pre\-grant for managed tills.

Why not `window.print()`\: it cannot emit raw bytes, therefore it cannot kick the drawer, cannot control the cutter, and puts a print dialog in front of every sale. It stays only as the always\-works escape hatch.

Why not WebUSB: Safari and iPad, permanently, plus a WinUSB driver\-binding tax on Windows.

**Secondary: Epson ePOS\-Print.** For iPad and mixed\-device sites. The browser POSTs XML to the printer's own web service. **RESEARCH caveat:** an HTTPS page cannot call `http://192.168.1.50`, so each printer needs a self\-signed certificate installed and trusted per device and per browser — the documented number\-one source of "the printer stopped working" tickets in web POS. **Server Direct Print**, where the printer polls our server for jobs, inverts the connection and sidesteps every browser networking restriction; prefer it where the printer supports it.

**Drawer kick.** `ESC p m t1 t2` — bytes `27,112,0,25,250` for drawer 1 / pin 2, `27,112,1,25,250` for pin 5. Fired through the printer as part of the receipt job on cash tender and on a permissioned no\-sale. **No printer means no drawer** — the print transport is the drawer transport.

**Receipt content** is generated server\-side as a structured document and rendered to ESC/POS by the agent, so the same document renders identically to PDF for email and WhatsApp. This is what stops the printed and emailed tax documents from drifting apart.

### 3\.5 Scanner input

A global `keydown` listener on the POS shell, always attached, never dependent on focus. Detection: inter\-keystroke interval under 50ms sustained across a run, terminated by Enter or a configured suffix. **RESEARCH:** "the cashier scanned into the wrong box" is the number one usability failure in web POS, and focus\-based handling is the cause.

Routing: if the decoded string is 15 digits and passes the Luhn check, treat it as an IMEI and route to serial binding. If it matches EAN\-13/UPC\-A/Code128 patterns, route to product lookup. Otherwise show a disambiguation prompt rather than guessing. Guard against Caps Lock and non\-Latin keyboard layouts — **RESEARCH:** an Arabic layout remaps characters and silently corrupts scans.

Camera fallback for stocktake and receiving on phones: `zxing-wasm` (actively maintained; `@zxing/library` is in maintenance mode and `html5-qrcode` is unmaintained), with `BarcodeDetector` used opportunistically where present. **RESEARCH:** `BarcodeDetector` is unavailable on Chrome for Windows and Linux, so it cannot be the primary path on a till.

### 3\.6 Payment terminal port — ADR\-009

```ts
interface TerminalDriver {
  readonly provider: string;
  requestPayment(input: {
    amountMinor: bigint; currency: 'AED';
    reference: string; timeoutMs: number;
  }): Promise<TerminalOutcome>;
  cancel(reference: string): Promise<void>;
  requestRefund(input: { amountMinor: bigint; originalReference: string }): Promise<TerminalOutcome>;
  getStatus(reference: string): Promise<TerminalOutcome>;
}

type TerminalOutcome =
  | { status: 'approved'; authCode: string; last4?: string; scheme?: string; rrn?: string }
  | { status: 'declined'; reason: string }
  | { status: 'cancelled' }
  | { status: 'timeout' }
  | { status: 'unknown'; needsReconciliation: true };
```

**v1 ships exactly one driver: `manual`.** The cashier runs the standalone terminal and types the approval code; the POS records an external tender. **RESEARCH:** no UAE acquirer publishes a terminal API. Network International's own marketing confirms wired, cloud and app\-to\-app integrations exist, but every spec is contract\-gated behind sales and an NDA, and Magnati and Geidea publish nothing at all. Blocking launch on this would be blocking on someone else's relationship manager.

The `unknown` outcome exists deliberately. Cloud and semi\-integrated flows are asynchronous and can genuinely leave the POS not knowing; the sale moves to a pending state with an explicit reconcile action rather than guessing.

**Async tender state machine**, shared by Tabby, Tamara and any future semi\-integrated card driver, because they are the same shape:

```
idle → requested → pending(external) → approved | declined | cancelled | timeout | unknown
                        │
                    poll or webhook, with a hard cashier-visible countdown
```

The cashier always has a cancel button, and cancelling always attempts the provider\-side cancel (`POST /api/v2/checkout/{id}/cancel` for Tabby) before releasing the sale.

* * *

## 4\. Inventory and serialisation

### 4\.1 Reservation model

**AUDIT:** the existing checkout reserves stock under `SELECT … FOR UPDATE` before creating the payment intent — locks before money — and this is tested under 8\-way concurrency. That ordering is preserved exactly. Serialisation extends it rather than replacing it.

**Non\-serialised variant:** unchanged. Decrement `stock_levels.available`, insert a reservation row, commit or release.

**Serialised variant:** reserve a *count* at checkout, bind *specific units* at fulfilment or at the counter.

```
Online:  cart → reserve N units (state: in_stock → reserved, chosen FIFO by received_at)
              → order confirmed, units stay reserved
              → picker scans the actual IMEIs at packing
              → bound units → sold; any reserved-but-not-picked unit → in_stock
POS:     scan IMEI at the line → that exact unit reserved immediately (row lock)
              → tender complete → sold, inside the same transaction as the sale
              → sale abandoned or line removed → released
```

Reserving FIFO by `received_at` rather than letting the picker choose keeps cost accounting honest and stops the oldest stock ageing into dead capital.

**Reservation expiry.** A cart reservation expires after 30 minutes; the jobs worker releases them. A POS line reservation expires when the parked sale expires (default 4 hours, cleared at shift close). Leaked reservations are the second most common cause of phantom stockouts, after the Amazon `Pending` trap.

### 4\.2 Stocktake

A count session is not a bulk update. It is: open a session scoped to a location and optional filter → count lines accumulate by scan or keyed entry, with duplicates surfaced immediately → submit → a variance report showing every SKU where counted ≠ expected with the value of the difference → post, which writes one `stock_adjustment` per varying SKU **inside a single transaction**, each carrying the session id, the counter's user id and reason `stocktake`.

Serialised units get a stricter treatment: a scanned unit the system believed was `sold` is raised as an exception and is **never silently reinstated**. A unit the system expected and that was not scanned is proposed as `written_off`, requiring explicit confirmation. Reinstating a sold unit silently is how a system starts lying about what it has.

### 4\.3 Landed cost

Freight, duty and clearing charges on a purchase order distribute across received lines by value (default) or by weight, updating `serial_units.unit_cost` for serialised lines and the moving\-average cost for the rest. Because `order_items` snapshots cost immutably at sale time — **AUDIT:** already correct — historical margin never moves when a later landed\-cost allocation changes the current cost.

* * *

## 5\. Tax engine — ADR\-006

**RESEARCH\-heavy.** This is the module that makes the product UAE\-specific, and it must be a pure, exhaustively tested function, not conditionals scattered through checkout.

### 5\.1 Shape

```ts
// Pure. No I/O. In @voltix/core. Property-tested.
function resolveTaxTreatment(ctx: {
  sellerTrn: string;
  buyer: { type: 'consumer' | 'business';
           trn?: string;
           resaleDeclarationOnFile?: boolean };
  lines: Array<{ productCategory: string;
                 isElectronicDevice: boolean;   // CD 91/2023 scope
                 amountMinor: bigint }>;
  supplyType: 'domestic' | 'export' | 'designated_zone';
  emirate: Emirate;
  totalMinor: bigint;
}): TaxResult;

type TaxResult = {
  documentType: 'simplified_tax_invoice' | 'full_tax_invoice';
  lines: Array<{ taxCategory: 'S' | 'Z' | 'AE'; // standard | zero | reverse charge
                 ratePct: number;
                 taxMinor: bigint;
                 note?: string }>;
  statements: string[];      // e.g. the mandatory reverse-charge statement
  priceDisplay: 'inclusive' | 'exclusive';
  requiresBuyerTrn: boolean;
  requiresDeclaration: boolean;
};
```

### 5\.2 The rules it encodes

Verified 12 Aug 2026 against primary sources. Every row is a property\-test case.

| Condition | Treatment | Source |
| --- | --- | --- |
| Consumer (non\-registrant), **any value** | Simplified tax invoice, 5% standard, prices displayed VAT\-inclusive | VAT Law Art. 65–67; Exec. Reg. Art. 59(5) |
| Business registrant, ≤ AED 10,000, no resale intent | Simplified permitted, 5% | Exec. Reg. Art. 59(5)(b) |
| Business registrant, \> AED 10,000 | **Full tax invoice required** — buyer name, address, TRN, sequential number, per\-line rate and amount, gross in AED | Exec. Reg. Art. 59(1) |
| Both registrants \+ electronic device \+ written declaration of **resale/manufacture intent AND buyer's FTA registration**, with supplier\-side verification of that registration | **Reverse charge.** No VAT charged, category `AE`, mandatory statement, prices exclusive | CD 91/2023 (in force 30 Oct 2023); MD 262/2023; VATP034 |
| Registrant buying electronic devices for **its own business use** | **Not** reverse charge — standard 5%. The FTA's own example is handsets issued to employees | VATP034 |
| Device line that is also a zero\-rated export | **Zero\-rating wins.** RCM does not apply to a supply zero\-rated under Art. 45 | CD 91/2023 |
| Direct export with evidence within 90 days | Zero\-rated | VAT Law Art. 45(1); Exec. Reg. Art. 30 |
| Walk\-in sale to a departing tourist | **Standard\-rated 5%.** Not an export. Relief only via the Planet scheme | FTA tourist refund guidance |
| Merchant onboarded to e\-invoicing, in\-scope B2B | **Simplified invoice no longer permitted**, including under AED 10,000. Zero\-rated supplies also lose the record\-only concession | Cabinet Decision 100/2025 (disapplies Art. 59(2),(3),(5),(7)) |
| Merchant onboarded to e\-invoicing, **B2C** | Simplified invoice still applies — B2C is out of scope of the mandate | MD 243/2025 |

**Three rules that are easy to get wrong and expensive when you do.**

**First, the reverse charge needs verification, not just paperwork.** The supplier must obtain the declaration, **verify the buyer's registration by a means approved by the FTA**, and retain both — without that, the supplier stays liable for the VAT. The engine therefore refuses to apply RCM unless a stored declaration *and* a recorded verification exist, and says so in one sentence rather than failing silently.

**Second, price display direction is opposite for the two audiences, and only one of them is a choice.** Consumer\-facing prices must be VAT\-inclusive under Art. 27 of the Executive Regulations — **full stop**; labelling an exclusive price "excl. VAT" does not make it compliant, and the penalty is AED 5,000 (CD 40/2017 Table 3 as amended by CD 49/2021). Exclusive display is lawful only in the listed exceptions: exports, supplies to VAT\-registered recipients, and the Art. 48 concerned\-goods and hydrocarbon cases. The pricing layer takes `priceDisplay` from the tax result rather than deciding for itself.

**Third, once e\-invoicing onboarding happens the merchant runs two regimes at once** — simplified for B2C, full e\-invoices for in\-scope B2B. `resolveTaxTreatment` must therefore take the tenant's onboarding state as an input and select per transaction, never per tenant.

### 5\.3 Tax documents

`tax_documents` rows are **immutable once issued**. A correction is a credit note with its own gapless sequence, linked to the original. Numbering uses the existing `counters` table per document type per tenant per year.

The row carries every PINT AE field from day one (R7.9), whether or not an ASP is connected: seller and buyer legal name, address and TRN, UUID, issue timestamp in UTC, supply date, per\-line description, quantity, unit price, tax category code and rate, tax subtotals, discounts, currency plus AED equivalent, supply\-type indicators, and the **emirate** (R7.6 — required for both the FTA Audit File and VAT return Box 1, and painful to backfill).

### 5\.4 ASP port

```ts
interface EInvoiceProvider {
  transmit(doc: TaxDocument): Promise<{ transmissionId: string; status: 'accepted' | 'rejected'; errors?: string[] }>;
  getStatus(transmissionId: string): Promise<TransmissionStatus>;
  verifyCallback(req: Request): Promise<CallbackEvent>;
}
```

**RESEARCH, verified.** The UAE model is a decentralised 5\-corner Peppol CTC arrangement (DCTCE) carrying **PINT AE expressed as UBL 2.1 XML**. ASPs may ingest other syntaxes but must convert; a PDF, scan or spreadsheet is not an e\-invoice. **Both** supplier and buyer must each appoint an MoF/FTA\-accredited ASP under MD 64/2025 — self\-connection and self\-accreditation are not permitted, and accreditation requires Peppol certification, OpenPeppol conformance, two years' experience, ISO/IEC 27001, ISO 22301 and professional indemnity insurance. There is **no pre\-issuance clearance gate**\: corner five is the FTA receiving a Tax Data Document from the ASP in near\-real\-time *after* exchange, not before it.

**Retention, stated precisely.** Records must be retained in\-State and retrievable by the FTA; MoF guidance (v1.1, June 2026) permits offshore or cloud hosting provided the FTA can retrieve them. "Must be physically inside the UAE" is too strong a reading. Liability for retention stays with the taxpayer even where the ASP archives on their behalf — so Voltix keeps its own copy of every transmitted document regardless of what the provider offers.

Transmissions are queued through the outbox pattern already in the codebase, with the same at\-least\-once and retry semantics as notifications. `einvoice_transmissions` records every attempt and outcome. **OPEN — Q1:** which accredited provider, and whether their API accepts our document shape without a translation layer.

## 6\. Channel sync — ADR\-007

### 6\.1 Port

```ts
interface ChannelAdapter {
  readonly channel: 'noon' | 'amazon_ae' | 'mirakl';
  pushStock(items: Array<{ sku: string; warehouseCode: string; qty: number }>): Promise<PushResult>;
  pushPrice(items: Array<{ sku: string; priceMinor: bigint; msrpMinor?: bigint }>): Promise<PushResult>;
  pullOrders(since: Date, cursor?: string): Promise<{ orders: RawChannelOrder[]; nextCursor?: string }>;
  pullOrderPii(externalId: string): Promise<ChannelCustomerData>;   // deliberately separate
  confirmShipment(input: ShipmentConfirmation): Promise<void>;
  cancelLines(externalId: string, lines: string[], reason: string): Promise<void>;
}
```

`pullOrderPii` is a separate method because both platforms deliberately separate order data from customer data — noon via `GetFbpiOrderCustomerData`, Amazon via `getOrderAddress`/`getOrderBuyerInfo` behind a Restricted Data Token. We mirror that split internally: separate table, separate encryption key, separate access role, and a **30\-day post\-fulfilment purge job** to satisfy Amazon's Data Protection Policy.

### 6\.2 Allocation

```
channel_qty = min( max(0, on_hand − reserved − buffer), channel_limit )
```

Buffer first, then limit — **RESEARCH:** the order matters and is ChannelEngine's documented behaviour. Buffer is absolute for low\-velocity SKUs, percentage for fast movers, sized against **units sold per SKU in one sync window** rather than a magic constant.

An important subtlety to design around: allocating stock to one channel does **not** reserve the remainder from the others. Allocation bounds exposure; it does not prevent overselling. What prevents overselling is reservation at order receipt plus a buffer sized to sync latency.

**DECISION:** hard per\-channel allocation for scarce serialised items (one unit of a specific handset must not be visible on three channels), shared pool with buffer for the accessory long tail.

### 6\.3 Push pipeline

Three priority classes on the Redis queue:

| Class | Trigger | Target latency |
| --- | --- | --- |
| **Critical** | Quantity reaching zero | Under 30 s |
| Normal | Any quantity change | Under 5 min p95 |
| Sweep | Full\-catalogue reconciliation | Every 4 h |

**Circuit breaker.** Any outbound batch that would zero more than a configured share of SKUs (default 50%) is rejected and alerts instead of executing. **RESEARCH:** ChannelEngine ships exactly this guard, and the failure it prevents — a bad feed silently de\-listing an entire catalogue — is the kind that is discovered by a revenue drop days later.

Every push appends to `channel_sync_log`\: timestamp, SKU, prior qty, new qty, channel, reason code, request id, outcome. Every oversell post\-mortem starts here.

**Anti\-pattern, explicitly rejected:** per\-product manual stock overrides. **RESEARCH:** once enabled, updates from every other route are ignored, which is a silent\-failure generator. If an override is ever built it must be time\-boxed and loudly visible.

### 6\.4 Order ingestion

Two\-phase, and the first phase must never fail:

```
Phase 1  → INSERT INTO channel_orders_raw (channel, external_order_id, payload, received_at)
           ON CONFLICT (channel, external_order_id) DO UPDATE
             SET payload = EXCLUDED.payload
             WHERE channel_orders_raw.last_updated_at < EXCLUDED.last_updated_at
Phase 2  → worker maps to the domain model; failures go to a dead-letter queue and are replayable
```

Why the split: **RESEARCH** — Amazon `getOrders` is throttled to roughly **one request per minute steady state**. Re\-fetching a lost order is genuinely expensive, so durability at the edge is not optional. A mapping bug (unknown SKU, new currency, unmapped state) must never cause order loss.

Never dedupe on a payload hash — marketplaces mutate order objects for address corrections and buyer cancellation requests, and hashing would drop legitimate updates. Dedupe on `(channel, external_order_id)`; apply updates only when `last_updated_at` is newer, because SQS delivery is at\-least\-once and out of order.

**The `Pending` trap, stated explicitly because it is the classic bug:** Amazon `Pending` means payment has not cleared and the address is masked. Ingest it, show it, **allocate nothing and bind no serial unit** until it moves to `Unshipped`.

### 6\.5 Adapter facts to build against

**noon.** RS256 JWT signed with a service\-account key, exchanged at `POST /identity/public/v1/api/login` for a session cookie; a `User-Agent` header is mandatory on every request; limits observed at 1,500 requests per 60s per project code with a stricter burst window; `stock-update` sets absolute quantity per warehouse (not a delta); FBPI order list paginates at 50 with a `next_token` and filters must stay constant across pages; event notifications are HTTPS destinations only, no queue destination; the sandbox validates schemas and auth but has no persistence or business logic and never returns 5xx. Constraint to plan around: **one service account per partner, maximum five keys**, which squeezes multi\-environment setups.

**Amazon.ae.** Marketplace `A2VIGQ35RCS4UG`; Europe endpoint `sellingpartnerapi-eu.amazon.com`, region `eu-west-1` — which also fixes where the SQS queue must live. The legacy XML and flat\-file listing feeds were **removed on 31 July 2025**, so any tutorial or connector referencing `POST_INVENTORY_AVAILABILITY_DATA` is stale; use `patchListingsItem` (5 rps, burst 5) for single\-SKU updates and `JSON_LISTINGS_FEED` for bulk. Validate against the Product Type Definitions JSON Schema client\-side before submitting. Subscribe `ORDER_CHANGE` to SQS for latency and keep a 15–30 minute `getOrders` sweep on `LastUpdatedAfter` as the safety net. Read `x-amzn-RateLimit-Limit` from responses and drive throttling from it — some operations use dynamic usage plans, so hardcoded timers will be wrong.

**Developer access is a lead time, not a task.** Amazon's developer profile review runs 1–2 weeks for standard roles and materially longer for restricted PII roles. **Avoid requesting restricted roles unless buyer PII is genuinely needed** — it roughly halves approval time and removes the Data Protection Policy audit burden.

* * *

## 7\. API — ADR\-008

**AUDIT:** `docs/04-api.md` fully specified a REST API under `/api/v1` with API keys, versioning, pagination and webhooks. None of it exists; the only HTTP route in either app is `/api/cron/tick`. This is the largest documentation\-to\-reality gap in the codebase and it now has a functional consequence, because the POS offline queue and inbound webhooks both need real HTTP.

**DECISION.** Add REST **alongside** Server Actions, not replacing them. Server Actions remain correct for admin and storefront form flows — they are typed, colocated and have CSRF protection built in. REST exists for the three things Server Actions cannot serve:

| Namespace | Consumer | Auth |
| --- | --- | --- |
| `/api/v1/pos/*` | POS client, including offline replay | Session cookie \+ till token |
| `/api/webhooks/{provider}` | Payment gateways, noon | Provider signature verification |
| `/api/v1/{module}/*` | Future integrations, the merchant's own tooling | API key, scoped to permissions |
| `/healthz` | Uptime monitor | None |

Conventions: cursor pagination (never offset), `Idempotency-Key` required on every unsafe method, RFC 7807 problem responses, `X-Request-Id` propagated into logs and Sentry, versioning in the path with an explicit deprecation policy of six months' notice.

### 7\.1 Webhook handling — the highest\-value single fix

**AUDIT:** adapters implement `verifyWebhook` and nothing routes to it, so card and BNPL payments cannot reach a terminal state. Only COD works end to end today.

```
POST /api/webhooks/{provider}
  1. Read the raw body BEFORE any parsing — signature verification needs exact bytes
  2. Verify the signature in constant time against the provider secret
  3. Persist to payment_webhook_events (exists, unused) keyed on (provider, event_id) UNIQUE
  4. Return 200 immediately — acknowledge fast, process asynchronously
  5. Worker applies the effect idempotently; a duplicate is a no-op
  6. Unverifiable signature → 401 + alert. Never process an unverified body
```

The existing `payments.reconcile` job stays as the safety net, but is upgraded from flagging to **repairing** — a payment that a webhook confirmed while our transaction failed is completed by reconciliation rather than surfaced as a stuck row for a human.

* * *

## 8\. Security

**AUDIT:** the auth subsystem is production\-grade and is the strongest part of the codebase. It is not modified. What follows are the gaps.

| \# | Gap | Fix | Priority |
| --- | --- | --- | --- |
| S1 | **No backups.** Neon free tier, no PITR, no dumps. "A dropped table ends the business" | Enable PITR or scheduled `pg_dump` to object storage, encrypted, with a **quarterly documented restore drill**. An untested backup is not a backup | P0 |
| S2 | **Shared plaintext DB owner credential, unrotated** | Rotate; move to a secret manager; create a least\-privilege app role distinct from the owner | P0 |
| S3 | **No rate limiting on public routes.** `/orders?number=X&phone=Y` is a two\-factor lookup with no throttle — brute\-forcing the phone against a known order number is feasible | Redis sliding\-window limiter in middleware: order lookup 5/min/IP and 20/hour/order\-number; checkout 10/min/IP; search 60/min/IP. Constant\-time comparison on the tracking pair | P0 |
| S4 | **`audit_logs` has no writer.** No staff action is audited anywhere | Every privileged mutation writes `{actor, role, action, entity, before, after, ip, request_id}`. Non\-negotiable for price changes, refunds, stock adjustments, permission changes, price overrides and no\-sale drawer opens | P0 |
| S5 | Payment adapters never tested against sandbox | Obtain sandbox credentials; adapter contract tests in CI against recorded fixtures, plus a manual sandbox run before enabling any provider | P0 |
| S6 | New POS attack surface | Till token bound to a `pos_terminals` row, revocable; shift\-scoped; offline replay accepted only for the till's own shift; sale amount ceiling per role | P0 |
| S7 | Channel credentials | Encrypted at rest with a separate key; never logged; rotation runbook; noon's five\-key limit documented in the runbook so a rotation does not lock us out | P0 |
| S8 | Marketplace PII | Separate table, separate key, 30\-day post\-fulfilment purge, no PII in logs — Amazon DPP requirements | P0 |
| S9 | CSRF on Server Actions never explicitly tested | Add explicit tests. Next.js provides protection; untested protection is an assumption | P1 |
| S10 | No alerting on lockouts, failed logins or 500s | Sentry plus threshold alerts | P1 |
| S11 | No tenant offboarding or deletion path | Build one; RESTRICT constraints currently make it manual, so a data\-deletion request cannot be served | P1 |

**Threat model additions for POS.** A cashier is a semi\-trusted insider. Controls: no cost or margin visibility for the `cashier` role; refunds require a manager PIN above a threshold; every price override carries a reason code and an audit row; the blind cash count means the cashier cannot see expected cash before counting; no\-sale drawer opens are counted and reported per cashier.

* * *

## 9\. Non\-functional requirements

| NFR | Target | How it is measured |
| --- | --- | --- |
| POS add\-line to render | p95 ≤ 100 ms | Client instrumentation, reported per session |
| POS sale completion | p95 ≤ 60 s scan to receipt | POS timing events |
| POS offline endurance | Full 8\-hour shift, cash trading | Manual test, every release |
| POS bundle | ≤ 250 KB JS gzipped for the sale screen | `size-limit` gate in CI |
| Storefront LCP | ≤ 2.5 s, 4G, mid\-range Android | Lighthouse CI on the real PDP |
| Checkout server time | p95 ≤ 500 ms | Server timing header, sampled |
| Channel stock freshness | p95 ≤ 5 min sale → channel | `channel_sync_log` timestamps |
| Availability | 99\.5% monthly on money paths | Uptime monitor on `/healthz` and `/api/cron/tick` |
| RPO / RTO | ≤ 1 h / ≤ 4 h | Quarterly restore drill, timed |
| Concurrency | 8 concurrent till \+ web checkouts, zero oversell | Existing concurrency suite, extended to serials |

**AUDIT:** the previous documentation asserted LCP, INP, CLS and JS\-budget targets and claimed CI failed when they were exceeded. Neither was true. **Every NFR above names its measurement, and any target whose measurement is not implemented is not a target — it is deleted.**

### 9\.1 Scaling analysis

**AUDIT, unchanged and still correct:** at \~100 users the Neon free tier's 0.25 vCPU is the constraint, not the code. At \~10,000 users, serverless instances × `Pool(max: 10)` exhausts Postgres connections; dashboard aggregates are unindexed full scans; the product list runs three correlated subqueries per row.

Additions from this design: the process host holds a **fixed, budgeted** connection pool, which is architecturally better than serverless fan\-out and should carry channel sync well past the storefront's limits. POS reads come from the client snapshot, so a busy shop floor generates almost no read load. The binding constraint at scale becomes the **channel push rate**, capped by noon's 1,500/60s and Amazon's 5 rps, not by our database.

* * *

## 10\. Testing

**AUDIT:** 273 tests pass — roughly 180 unit, 60 integration against real Postgres, 14 adapter — and CI runs typecheck → migrate → seed → test → assert\-nothing\-skipped → build → audit → gitleaks. The skip\-assertion guard has already caught a real regression. That pipeline is kept. The documentation claimed E2E tests existed; they do not.

| Layer | Today | Required | Priority |
| --- | --- | --- | --- |
| Unit (domain) | \~180 | \+ tax engine (property\-based over buyer type × value × device × declaration), serial state machine, allocation formula | P0 |
| Integration (real PG) | \~60 | \+ serial uniqueness under concurrency, stocktake posting atomicity, offline replay idempotency, channel ingest dedupe | P0 |
| Adapter | 14 | \+ noon and Amazon against recorded fixtures; **sandbox runs before enabling any provider** | P0 |
| API contract | 0 | Every `/api/v1` route against its schema | P0 |
| **E2E** | **0** | Three money paths: online purchase, counter sale with IMEI, counter return. Playwright, real Postgres | P0 |
| POS offline | 0 | Scripted: go offline, sell, queue, reconnect, assert exactly\-once and no lost sale | P0 |
| Performance | 0 | Lighthouse CI on the PDP; k6 on checkout at 8\-way concurrency | P1 |
| Accessibility | 0 | axe in CI on storefront and POS; manual keyboard audit per release | P1 |
| Visual regression | 0 | Receipt rendering and tax document layout — these are legal documents | P1 |

**On hand\-written SQL — AUDIT T\-06.** Most queries are hand\-written SQL via `tx.execute`, which loses Drizzle's type safety, and column typos have reached runtime four times. The recommendation is unchanged and pragmatic: **keep the raw SQL** (it was chosen for aggregate control and that reason is still valid) but require an integration smoke test per query, which several already have. Consider generated row types as a follow\-up. Do not rewrite working aggregate SQL into the query builder.

* * *

## 11\. Migration and delivery

### 11\.1 Data migration

The existing tenant has real production orders. Every migration is forward\-only, reversible by a documented compensating migration, and runs in CI against a seeded copy before production.

| Step | Action | Risk |
| --- | --- | --- |
| M1 | Drop AI and pricing\-intelligence tables, drop pgvector | Low — verified empty first, migration fails if not |
| M2 | Add serial, POS, tax, channel and stocktake tables with RLS | Low — additive |
| M3 | Backfill `serial_units` from physical stock via bulk IMEI import (R2.10) | **Medium** — a one\-time operational push. Historical sold units cannot be reconstructed; accept the gap and document its start date |
| M4 | Generate tax documents for historical orders | **Medium** — **OPEN:** whether historical invoices should be issued retroactively is a question for the accountant, not engineering |
| M5 | Add the `cashier` role and its permissions | Low |
| M6 | Move jobs from cron tick to the worker; keep the cron endpoint as a fallback trigger for one release | Low |

### 11\.2 Sequencing

Mirrors PRD §9 with the technical prerequisites made explicit:

**Phase 0 (1–2 wk):** PITR/backups · credential rotation · Sentry \+ uptime \+ `/healthz` · SMTP · **webhook routes** · sandbox verification of adapters · delete stale docs.

**Phase 1 (5–7 wk):** catalogue module \+ product CRUD · `serial_units` \+ receiving \+ lookup · stocktake and adjustments · purchasing · **tax engine and documents** · shipments · enforce the COD gate · rate limiting · `audit_logs` writer · analytics events. *Prerequisite: none beyond Phase 0.*

**Phase 2 (5–7 wk):** POS app · offline engine · print agent · shifts and tenders · counter returns and warranty · `cashier` role · reporting core. *Prerequisite: Q5 answered (till hardware). Do not start the print path before it.*

**Phase 3 (4–5 wk):** process host \+ Redis queues · channel port · noon adapter · Amazon adapter \+ SQS consumer · allocation and circuit breaker · unified order list. *Prerequisite: Q6 answered (seller accounts exist); Amazon developer review started at the beginning of Phase 2, not Phase 3, because it takes 1–2 weeks of calendar time we can spend in parallel.*

**Phase 4 (ongoing, hard date Q1 2027):** ASP integration and PINT AE · FAF export · terminal driver · Tabby in\-store · connection budgeting and caching · E2E and a11y · admin mobile · Arabic product content · catalogue extraction · second tenant.

### 11\.3 Definition of done, per feature

No feature is done until: unit tests on the domain logic · an integration test against real Postgres · analytics events firing · error paths reaching Sentry · loading, empty and error states implemented · permissions enforced server\-side · an audit log entry for any privileged mutation · Arabic strings present · a keyboard path that works · and the documentation updated in the same pull request.

**AUDIT:** the previous documentation drifted from the code within eleven commits. Docs updated in the same PR is the only mechanism that has ever prevented that.

* * *

## 12\. Technical debt disposition

Every item from the audit's register, with a decision.

| \# | Item | Disposition |
| --- | --- | --- |
| T\-01 | No payment webhook route | **Fixed in Phase 0** — §7.1 |
| T\-02 | No backups | **Fixed in Phase 0** — S1 |
| T\-03 | No error tracking | **Fixed in Phase 0** — `SENTRY_DSN` already in the env schema |
| T\-04 | Shared unrotated credential | **Fixed in Phase 0** — S2 |
| T\-05 | No rate limiting | **Fixed in Phase 1** — S3, using Redis |
| T\-06 | Hand\-written SQL bypasses types | **Accepted with mitigation** — integration smoke test per query — §10 |
| T\-07 | Redis provisioned, unused | **Resolved by use** — queues, locks, limits, idempotency |
| T\-08 | \~30 tables with no writer | **Resolved by deletion and by §9.1 of the PRD** — no new table ahead of its writer |
| T\-09 | Admin recomputes forecasts per request | **Fixed in Phase 2** — read persisted `demand_forecasts` |
| T\-10 | No serverless connection budget | **Fixed in Phase 4** — documented pool maths; the process host is budgeted from day one |
| T\-11 | `audit_logs` has no writer | **Fixed in Phase 1** — S4 |
| T\-12 | Two 1,000\-line `globals.css` files | **Fixed in Phase 2** — see Design Document |
| T\-13 | No loading skeletons in admin | **Fixed in Phase 2** — `loading.tsx` per route |
| T\-14 | Adapters never tested against sandbox | **Fixed in Phase 0** — S5 |

* * *

## 13\. Open technical questions

| \# | Question | Blocks |
| --- | --- | --- |
| TQ1 | Till platform — Windows, Android or iPad? Decides printing architecture irreversibly | **Phase 2 start** |
| TQ2 | Which accredited ASP, and does its API accept our document shape without a translation layer? | Phase 4 |
| TQ3 | Will the acquirer release the ECR/POS integration spec under NDA? | R3.6 only |
| TQ4 | Process host — confirm Fly.io region latency to the Postgres primary before committing | Phase 3 |
| TQ5 | Does noon's five\-key service\-account limit accommodate dev, staging and production plus rotation headroom? | Phase 3 |
| TQ6 | Should historical orders get retroactive tax documents? Accounting decision, not engineering | M4 |
| TQ7 | Neon plan: does the paid tier's PITR meet RPO ≤ 1 h, or do we self\-manage dumps? | Phase 0 |
| TQ8 | WhatsApp Business API provider and approval lead time | R13.2 |

* * *

*Companion documents: PRD v2.0 (requirements and traceability), Wireframe Document v1.0 (screen specifications), Design Document v1.0 (design system and interaction). Research sources are listed in PRD §14 and are not duplicated here.*

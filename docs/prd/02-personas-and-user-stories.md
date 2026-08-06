# OmniRetail OS — Personas & User Stories

| | |
|---|---|
| **Document** | 02 — Personas & User Stories |
| **Owner** | Chief Product Officer |
| **Status** | Approved for engineering planning |
| **Last updated** | 2026-08-06 |
| **Related docs** | [01 — Product Requirements](./01-product-requirements.md), [03 — Information Architecture](./03-information-architecture.md) |

Personas are composites from design-partner interviews in the mobile/electronics retail segment. Story IDs (`US-<EPIC>-<NN>`) trace to requirement IDs from document 01.

---

## 1. Personas

### P1 — Rafiq, the Owner (single store → small chain)
**Age 38. Owns two mobile-phone shops. Works the counter himself on busy days.**

- **Goals:** know exactly what stock he has and what it's worth without visiting both shops; stop the slow leak of missing accessories and "discounted" phones; grow to a third store without hiring an ops manager.
- **Frustrations:** current POS lets staff edit stock with no trace; his monthly "count day" always finds 40–60 units of variance; he can't tell whether a missing phone was stolen, transferred, or never delivered; every marketplace order means retyping into another system.
- **Behavior:** phone-first outside the shop, desktop in the back office; checks numbers at 11 pm; trusts reports only after he's spot-checked them twice.
- **Success looks like:** opens the mobile app, sees yesterday's sales, margin, cash position, and any fraud flags for both stores in under a minute — and believes the numbers.

### P2 — Shirin, the Store Manager
**Age 29. Runs the flagship store: 4 staff, 2 registers, ~120 walk-ins/day.**

- **Goals:** hit the store's monthly target; keep shelves stocked from the warehouse before stockouts; approve exceptions (discounts, refunds) quickly without leaving the floor; keep count variance near zero so she isn't blamed for shrinkage.
- **Frustrations:** approval requests interrupt her mid-customer; transfers arrive short and it becomes her word against the warehouse's; end-of-day close takes 40 minutes of manual tallying.
- **Behavior:** lives on the shop floor with a phone; sits at the desktop only for weekly ordering and rosters.
- **Success looks like:** approves a refund from her phone in 10 seconds with full context; receipt of a transfer auto-flags the two missing units against the dispatcher, not her.

### P3 — Arif, the Cashier / Salesperson
**Age 22. Six months on the job. Paid base + commission on accessories and phones.**

- **Goals:** serve customers fast (queue pressure is real); make commission; never get blamed for a drawer shortage or a mistake he didn't make.
- **Frustrations:** current POS freezes mid-sale; finding a specific used phone's price means calling the manager; return process is a 10-minute ordeal that angers customers.
- **Behavior:** learns by doing, not manuals; uses keyboard + scanner, rarely the mouse; will work around any flow that takes more than a few seconds.
- **Success looks like:** scans an IMEI, sees price/warranty/condition instantly, completes sale in under a minute; his blind drawer close matches and it's on record.

### P4 — Kamal, Warehouse Staff
**Age 34. Runs the central back-warehouse serving 5 stores. One assistant.**

- **Goals:** receive shipments accurately (supplier cartons are often short); pick store transfer orders fast; get through cycle counts without shutting down operations.
- **Frustrations:** stores claim transfers arrive short and it lands on him; supplier invoices don't match what was in the boxes; paper pick lists get lost or reordered.
- **Behavior:** hands full — needs scanner-first mobile flows, big buttons, minimal typing; low tolerance for apps that need two hands and perfect Wi-Fi.
- **Success looks like:** scans every serial at the dock; a short carton becomes a supplier claim in three taps; when a store disputes a transfer, the dispatch scan record settles it.

### P5 — Nadia, E-commerce Manager
**Age 27. Runs the webstore and two marketplace accounts for a 8-store chain.**

- **Goals:** never oversell; keep listings, prices, and content in sync across channels; hit marketplace ship-by SLAs to protect seller ratings; grow online share of revenue.
- **Frustrations:** currently updates three stock silos by hand; a phone sold in-store at 6 pm gets ordered online at 6:20; unmapped SKUs silently drop marketplace orders; channel P&L is a quarterly spreadsheet archaeology project.
- **Behavior:** desktop power user; keyboard shortcuts, bulk edits, saved filters; watches connector dashboards like a trader.
- **Success looks like:** oversell incidents near zero; a marketplace order lands as a routed OMS order with stock already reserved before she even sees it.

### P6 — Tanvir, the Accountant (external, part-time)
**Age 45. Handles books for several retail clients, including Rafiq's shops.**

- **Goals:** get clean, summarized journals into the accounting system monthly; trust COGS and inventory valuation; answer the tax authority quickly at filing time.
- **Frustrations:** clients hand him shoeboxes of Z-reports; inventory valuation is a guess; he can't tie a stock write-off to an authorization.
- **Behavior:** logs in twice a month; wants exports, valuation-as-of-date, and an audit trail he can cite; will never learn the POS.
- **Success looks like:** Read-only Auditor role, one-click monthly journal export to the accounting system, and every adjustment he questions has a name, date, and reason attached.

### P7 — Rina, Support Agent (OmniRetail's own CS team)
**Age 26. Handles tenant support tickets: sync issues, permission questions, "my numbers look wrong."**

- **Goals:** resolve tickets on first contact; see what the tenant sees (with consent) without being able to alter their data; escalate real bugs with reproducible evidence.
- **Frustrations (with typical platforms):** support tooling that lets agents mutate customer data invisibly (a liability), no per-tenant health view, "numbers look wrong" tickets with no way to replay history.
- **Behavior:** works from an internal admin console; needs ledger replay and connector-health views per tenant.
- **Success looks like:** for a "stock is wrong" ticket, she replays the item's ledger, finds the unapproved adjustment at 21:34 by user X, and answers with evidence in 10 minutes. Her access session is logged and visible to the tenant (NFR-SEC-005).

### P8 — Faisal, Wholesale Customer (B2B buyer)
**Age 41. Owns three small phone shops; buys weekly from a distributor running OmniRetail (S4 segment).**

- **Goals:** see real-time distributor stock and his negotiated prices; order in bulk with specific quantities per model/color/storage; track his credit balance and dues.
- **Frustrations:** ordering via WhatsApp messages and price-list PDFs that are out of date; disputed invoices ("I ordered 10, you shipped 8, billed 10").
- **Behavior:** mobile-first; orders at night; pays partially on credit terms.
- **Success looks like:** B2B portal shows live availability at his price tier; the serials shipped to him are listed on the invoice, ending disputes.

### P9 — Maya, the End Shopper
**Age 31. Buying a mid-range phone; researched online, wants it today.**

- **Goals:** confirm the exact model/color is in stock at a nearby store before traveling; pay online or in-store; get a real warranty she can prove later; return painlessly if the phone is defective.
- **Frustrations:** "in stock" online but not in store; paper warranty cards that fade; returns refused because "the receipt is with head office."
- **Behavior:** browses on mobile, buys wherever friction is lowest; will screenshot everything.
- **Success looks like:** reserves online for store pickup, shows the pickup code, walks out in 5 minutes; a year later, warranty status is retrievable from her phone number at any of the chain's stores.

---

## 2. User Stories by Epic

Priorities and traceability reference document 01. Acceptance criteria are the contract for "done" — engineering and QA test against them verbatim.

---

### Epic E1 — Serialized Selling at POS
*Primary personas: P3 Arif, P9 Maya. Traces: POS-003, POS-004, POS-005, POS-007, POS-012, CAT-002, CAT-003, INV-002.*

#### US-E1-01 — Sell a phone by IMEI scan
**As a** cashier, **I want** to scan a phone's IMEI barcode and have that exact unit added to the cart with its price, condition, and warranty terms, **so that** the sale is fast and the right physical unit is recorded as sold.

**Acceptance criteria**

- **Given** an in-stock serialized unit with IMEI `356938035643809` at the cashier's store, **when** the cashier scans its serial label, **then** a cart line is added within 100 ms (p95) showing model, variant, condition grade, price, and warranty duration, bound to that specific IMEI.
- **Given** an IMEI that is not in stock at this store (sold, in transit, or at another location), **when** it is scanned, **then** the POS blocks the add, states the unit's current state and location, and offers valid next actions (e.g., "create ship-from-Store-2 order") — it never adds an unsellable unit.
- **Given** a serialized product added via product search instead of a serial scan, **when** the cashier attempts tender, **then** the POS requires selecting/scanning a specific in-stock serial before tender can begin (POS-004).
- **Given** a completed cash sale of a serialized unit, **when** the transaction posts, **then** exactly one stock-ledger entry records the unit leaving stock — attributed to the authenticated cashier, register, receipt number, and timestamp — and the unit's lifecycle state becomes `sold` with a link to the receipt (INV-002, CAT-003).
- **Given** the completed sale, **when** the receipt prints, **then** it lists the IMEI and warranty end date, and the customer's owned-device list (if a customer was attached) includes the unit.
- **Given** a scan of a valid EAN accessory barcode mid-flow, **when** scanned after the phone, **then** it appends as a normal quantity line — mixed serialized/non-serialized carts require no mode switching.

#### US-E1-02 — Block a duplicate/suspicious IMEI at receiving
**As a** store manager, **I want** the system to block receiving an IMEI that already exists in the system, **so that** cloned labels, double-entry, and re-intake of sold stock are caught at the door.

**Acceptance criteria**

- **Given** an IMEI currently in stock anywhere in the tenant, **when** goods receipt attempts to add it, **then** the receipt line is blocked with the existing unit's location and history shown (CAT-004).
- **Given** an IMEI that was previously sold and not returned, **when** received again (e.g., trade-in intake), **then** the system requires the trade-in flow (CAT-009) — including customer capture — and links the unit's new lifecycle segment to its prior history rather than creating a duplicate record.
- **Given** a manager override of a duplicate warning, **when** the override is confirmed with the manager's PIN and a reason code, **then** the override, reason, and both user identities are written to the audit trail (EMP-002, EMP-003).
- **Given** a 15-digit numeric IMEI failing the Luhn check digit, **when** entered manually, **then** the field warns before accepting, and acceptance requires explicit confirmation (guards against typos, CAT-002).

---

### Epic E2 — Offline POS Resilience
*Primary personas: P3 Arif, P2 Shirin. Traces: POS-010, POS-011, POS-012, NFR-PERF-004, NFR-AVL-002.*

#### US-E2-01 — Complete sales during an internet outage
**As a** cashier, **I want** the POS to keep selling when the internet dies, **so that** the queue keeps moving and no revenue is lost.

**Acceptance criteria**

- **Given** the register loses connectivity mid-shift, **when** the cashier starts a new sale, **then** the POS continues in offline mode with a visible (non-blocking) offline indicator; catalog search, pricing, cash tender, discounts within the cashier's own authority, and receipt printing all function from the local store (POS-010).
- **Given** offline mode, **when** a serialized unit is scanned, **then** availability is validated against the local unit cache, and a successful sale marks the unit locally sold so the same register cannot sell it twice offline.
- **Given** offline mode, **when** the cashier selects card tender on a terminal that requires connectivity, **then** the POS states card is unavailable and offers cash/other tenders — it does not error opaquely or pretend the payment succeeded.
- **Given** an action requiring remote manager approval (e.g., refund above threshold) while offline, **when** no manager PIN is available locally on that register, **then** the action is blocked (not queued) with a clear message — approvals are never auto-granted by connectivity loss.
- **Given** offline receipts, **when** printed, **then** receipt numbers come from the register-prefixed offline-safe sequence with no gaps or collisions after sync (POS-012).

#### US-E2-02 — Sync offline sales and surface conflicts
**As a** store manager, **I want** offline transactions to sync automatically and any conflicts flagged to me — never silently resolved — **so that** the ledger stays true even after an outage.

**Acceptance criteria**

- **Given** connectivity is restored after an outage with queued transactions, **when** the register reconnects, **then** all queued transactions post to the cloud ledger in original order, attributed to their original cashier and original (offline) timestamps, and 500 queued sales complete syncing in under 5 minutes on a 10 Mbps link (NFR-PERF-004).
- **Given** the same serialized unit was sold offline at two different locations, **when** the second sale syncs, **then** both sales remain on the ledger, a conflict task appears in the manager work queue within 60 seconds identifying both transactions, and stock is not silently "fixed" (POS-011).
- **Given** the conflict task, **when** a manager resolves it (e.g., refund one sale, arrange substitute unit), **then** the resolution actions are themselves ledgered, attributed to the resolving manager, and the task closes with a disposition record.
- **Given** a sync failure of any single transaction, **when** retries are exhausted, **then** the transaction enters a visible per-register exceptions list — the system never drops a transaction, and the register shows a persistent badge until the list is empty.

---

### Epic E3 — Stock Transfers (Store ↔ Warehouse)
*Primary personas: P4 Kamal, P2 Shirin. Traces: INV-010, INV-006, WHS-003, WHS-004, EMP-003.*

#### US-E3-01 — Dispatch and receive a transfer with in-transit accountability
**As a** warehouse operator, **I want** transfers to be scanned out by me and scanned in by the receiving store, **so that** shortages are pinned to the correct leg of the journey instead of landing on me.

**Acceptance criteria**

- **Given** an approved transfer order of 20 phones (serialized) and 50 cases (quantity), **when** Kamal dispatches by scanning each serial and confirming case counts on the mobile app, **then** stock moves `on hand → in transit` with one ledger entry per movement attributed to Kamal, and the manifest lists exactly the scanned serials (INV-010).
- **Given** a serial on the transfer order that Kamal cannot find, **when** he dispatches short, **then** the missing serial stays at the warehouse as `on hand`, the transfer records a short-dispatch exception, and the replenishment gap is visible to the requesting store — no silent quantity edit (WHS-003 short-pick principle).
- **Given** the shipment arrives at the store, **when** Shirin's staff receive by scanning, **then** each matched serial moves `in transit → on hand (store)` attributed to the receiver; the receiving screen is blind to quantities not yet scanned until the receiver declares "receiving complete."
- **Given** 2 of 20 serials were never scanned at receipt, **when** receiving completes, **then** the transfer closes with a discrepancy record naming the exact missing serials, the units remain `in transit — disputed`, and a variance task is assigned per tenant policy; resolution (found / written off with reason / returned to warehouse) posts compensating ledger entries with approver identity (INV-005, EMP-002).
- **Given** any completed transfer, **when** anyone views a transferred serial's history, **then** the dispatch scan, transit period, and receipt scan each appear as separate attributed events (CAT-003).

---

### Epic E4 — Marketplace Order Import
*Primary persona: P5 Nadia. Traces: MKT-001, MKT-002, MKT-003, OMS-001, OMS-002, OMS-003.*

#### US-E4-01 — Import a marketplace order into unified OMS with stock reservation
**As an** e-commerce manager, **I want** marketplace orders to flow in automatically, reserve real stock, and route to a fulfillment location, **so that** I never oversell and never hand-key an order.

**Acceptance criteria**

- **Given** a new paid order on a connected marketplace, **when** the connector polls/receives it, **then** a unified OMS order exists in OmniRetail within 5 minutes (p95) carrying channel, marketplace order ID, buyer shipping data, fees if provided, and line-level SKU mapping (MKT-001, OMS-001).
- **Given** order confirmation, **when** the order is created, **then** stock is atomically reserved at the location chosen by the routing rules, ATP decreases accordingly, and the reduced ATP propagates to all other channels within 60 s p95 (OMS-002, MKT-002).
- **Given** a marketplace line whose SKU has no mapping, **when** the order imports, **then** the order is created in an `attention` state with a mapping task for Nadia; completing the mapping retro-links the line and reserves stock — the order is never dropped and the failure is visible on the connector dashboard (MKT-003).
- **Given** insufficient stock to reserve (race with an in-store sale), **when** reservation fails, **then** an oversell exception task is raised immediately with recommended actions (transfer, substitute, cancel with marketplace-compliant messaging), and the incident is counted in the oversell KPI — no silent backorder.
- **Given** the order ships, **when** the warehouse confirms fulfillment with tracking (and serials for serialized lines), **then** tracking pushes back to the marketplace within 10 minutes and the sold serials are recorded on the order (OMS-007, MKT-001).
- **Given** a duplicate delivery of the same marketplace order event (retry), **when** processed, **then** idempotency keys prevent duplicate orders or double reservations (MKT-004).

---

### Epic E5 — Cycle Count with Variance Approval
*Primary personas: P4 Kamal, P2 Shirin, P1 Rafiq. Traces: INV-011, INV-005, WHS-005, EMP-002, ANL-002.*

#### US-E5-01 — Blind cycle count with approval-gated posting
**As a** store manager, **I want** counts to be blind and variances to require explicit approval before stock changes, **so that** counts fix reality without becoming a shrinkage laundering tool.

**Acceptance criteria**

- **Given** a scheduled cycle count for the "Accessories — Aisle 2" zone, **when** the counter opens the count task on mobile, **then** they see the item list without expected quantities (blind count), and count by scanning items/bins (INV-011).
- **Given** the counter submits the count, **when** variance is computed, **then** each line shows expected vs. counted vs. delta (units and value) to the approver only, and no ledger entry has yet been posted.
- **Given** variances within the tenant's auto-approve threshold (e.g., ≤ 2 units and ≤ $20 per line — configurable), **when** the count is submitted, **then** those lines post automatically as `count correction` adjustments attributed to the counter with the count reference.
- **Given** a line variance exceeding the threshold, **when** the approver reviews, **then** they must choose: approve (posts adjustment with their identity as approver + reason code), order a recount (new blind task), or escalate; approving all large variances in one un-reviewed bulk action is not offered (INV-005, EMP-002).
- **Given** serialized items in scope, **when** counting, **then** the count operates at serial level: unexpected serials found (in system but at wrong location, or unknown) and missing serials are each itemized — a serialized variance is never just a number.
- **Given** a completed count, **when** viewed later, **then** the shrinkage report shows the count event, counter, approver, per-line dispositions, and links to every posted adjustment (ANL-002).

---

### Epic E6 — High-Value Refund with Manager Approval
*Primary personas: P3 Arif, P2 Shirin. Traces: POS-008, EMP-002, EMP-004, EMP-005, CRM-004.*

#### US-E6-01 — Refund a phone with dual-control approval
**As a** cashier, **I want** a clear, fast approval path for high-value refunds, **so that** legitimate customers aren't stuck waiting while controls still hold.

**Acceptance criteria**

- **Given** a customer returning a phone purchased 6 days ago, **when** the cashier looks up the original receipt (by receipt #, customer phone, or by scanning the phone's IMEI), **then** the original transaction loads with its lines, tenders, and the sold IMEI.
- **Given** the return line is added, **when** the returned device's IMEI is scanned, **then** the POS verifies it matches the sold IMEI on that receipt; a mismatch blocks the refund with an explicit mismatch message (POS-008).
- **Given** the refund value exceeds the manager-approval threshold, **when** the cashier proceeds to tender, **then** the POS requires approval: either manager PIN at the register, or a push request to the manager's mobile app showing cashier, customer, item, IMEI, amount, and reason — approvable/deniable in one tap (EMP-004).
- **Given** manager approval, **when** the refund completes, **then** the refund goes to the original tender by default (card refund via terminal reference; cash requires the drawer to have sufficient float or triggers a paid-in), and the transaction record stores both the acting cashier and the approving manager identities (EMP-002).
- **Given** the completed return, **when** it posts, **then** the unit re-enters stock as `returned — pending inspection` (not sellable) with a ledger entry, and an inspection task routes it to sellable / quarantine / repair with attributed disposition (OMS-005 semantics at POS).
- **Given** a denial, **when** the manager denies with a reason, **then** the cashier sees the denial reason, the attempt is recorded, and repeated denied-refund attempts feed the fraud-flag rules (EMP-005).
- **Given** any no-receipt return attempt, **when** initiated, **then** manager approval is required regardless of value, and the customer identity capture is mandatory (POS-008).

---

### Epic E7 — AI Reorder Suggestion Review
*Primary personas: P1 Rafiq, P2 Shirin. Traces: AI-001, AI-002, AI-007, INV-013, FIN-006.*

#### US-E7-01 — Review, edit, and act on an AI reorder suggestion
**As an** owner, **I want** AI purchase suggestions I can interrogate and edit before committing money, **so that** I stock what will sell without surrendering judgment to a black box.

**Acceptance criteria**

- **Given** the weekly suggestion run completes, **when** Rafiq opens the Reorder Suggestions queue, **then** each suggestion shows: item, location, suggested qty, projected stockout date, forecast basis (recent velocity, seasonality note, stockout-corrected history), supplier, unit cost, and total cash required (AI-002).
- **Given** a suggestion, **when** Rafiq taps "why", **then** an explanation panel shows the inputs behind the number (e.g., "sold 41/month avg last 3 months; 12 days cover left; Eid uplift factor applied") with a link to the underlying sales report — no unexplained numbers (AI-001, AI-007 explainability).
- **Given** Rafiq edits the quantity or supplier on suggestion lines, **when** he accepts the batch, **then** a **draft** purchase order is created (not sent), attributed to Rafiq as the actor; nothing is ordered or moved by the AI itself (AI-007).
- **Given** a rejected suggestion, **when** Rafiq rejects with an optional reason ("supplier out", "discontinuing model"), **then** the disposition is logged and the suggestion engine suppresses/adjusts that item per the reason (AI-002 feedback loop).
- **Given** a tenant with under 90 days of sales history, **when** suggestions are shown, **then** they are labeled "rule-based (min/max)" — the system never dresses rules up as ML forecasts (AI-002 cold start).
- **Given** the forecast module, **when** Rafiq opens forecast settings, **then** last quarter's forecast accuracy (WAPE) per category is displayed — trust is earned with disclosed accuracy (AI-001).

---

## 3. Story backlog index (for sprint planning)

| Story | Epic | Release | Primary requirement IDs |
|---|---|---|---|
| US-E1-01 | Serialized POS sale | MVP | POS-003/004/005, CAT-002/003, INV-002 |
| US-E1-02 | Duplicate IMEI guard | MVP | CAT-004, CAT-009, EMP-002/003 |
| US-E2-01 | Offline selling | MVP | POS-010, POS-012, NFR-AVL-002 |
| US-E2-02 | Offline sync + conflicts | MVP | POS-011, NFR-PERF-004 |
| US-E3-01 | Transfer dispatch/receive | v1.0 | INV-010, WHS-003/004, INV-005 |
| US-E4-01 | Marketplace order import | v1.0 | MKT-001/002/003, OMS-001/002/003 |
| US-E5-01 | Cycle count + variance approval | v1.0 | INV-011, INV-005, WHS-005 |
| US-E6-01 | High-value refund approval | MVP (register-PIN) / v1.0 (remote approval) | POS-008, EMP-002/004/005 |
| US-E7-01 | AI reorder review | v2.0 | AI-001/002/007 |

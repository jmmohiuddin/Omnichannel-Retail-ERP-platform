# OmniRetail OS — Information Architecture

| | |
|---|---|
| **Document** | 03 — Information Architecture |
| **Owner** | Chief Product Officer |
| **Status** | Approved for design & engineering planning |
| **Last updated** | 2026-08-06 |
| **Related docs** | [01 — Product Requirements](./01-product-requirements.md), [02 — Personas & User Stories](./02-personas-and-user-stories.md) |

Four applications share one platform, one identity system, and one RBAC model (EMP-001/002). This document defines each app's sitemap, screen inventory with primary actions, navigation model, key wireframe descriptions (annotated text — visual design comes later), and role-based visibility.

**Cross-app IA principles**

1. **One entity, one canonical screen.** A product, order, customer, or serial has exactly one detail screen per app; everything else deep-links to it. No duplicate "views of the same thing" with different numbers (ANL-006).
2. **Serial/IMEI is a first-class search key everywhere.** Global search in every app resolves an IMEI to the unit lifecycle screen (CAT-003).
3. **Exceptions surface as queues, not buried states.** Sync conflicts, unmapped SKUs, variance approvals, fraud flags — each is a work-queue with badge counts, never something a user must "go check."
4. **Attribution is visible in the UI, not just the database.** Detail screens show "created by / last action by" inline (INV-015).
5. **Role-based visibility subtracts; it never rearranges.** A cashier sees fewer items in the same structure a manager sees — muscle memory transfers on promotion.

---

## 1. Web Admin Portal

**Audience:** Owner, Admin, Store Manager, E-commerce Manager, Accountant, Warehouse lead (desk work), Read-only Auditor.
**Platform:** Responsive web app, desktop-first (1280 px+ primary), tablet-usable, not phone-optimized (the mobile app covers phone use).

### 1.1 Navigation model

- **Persistent left sidebar** with 10 top-level sections (below), collapsible to icons. Sections show badge counts for their exception queues.
- **Global header:** tenant/location switcher (scopes every screen; "All locations" available per permission), global search (⌘K — products, serials/IMEI, orders, customers, receipts, POs, transfers), notifications bell (approvals, alerts), user menu.
- **Breadcrumbs** within sections; list → detail is the universal pattern; detail screens use tabs, not nested pages.
- **Approvals** are reachable both from the bell and from a dedicated "Tasks & Approvals" queue — approvals are never only-in-context.

### 1.2 Sitemap and screen inventory

```
Dashboard
Sales
├── Orders (all channels)          ├── Order detail
├── POS transactions / receipts    ├── Receipt detail
├── Returns & RMAs                 └── RMA detail
Inventory
├── Stock on hand                  ├── Item stock detail (per location, per state)
├── Stock ledger (movement log)    ├── Serial / IMEI lifecycle
├── Transfers                      ├── Transfer detail
├── Adjustments                    ├── Cycle counts → Count detail / Variance review
└── Replenishment (v1) / AI Suggestions (v2)
Catalog
├── Products                       ├── Product detail (variants, serials, channels)
├── Categories & attributes        ├── Price lists & scheduled changes
├── Labels & barcodes              └── Import / bulk jobs
Purchasing
├── Purchase orders                ├── PO detail
├── Suppliers                      ├── Supplier detail (ledger, claims)
└── Goods receipts                 └── Receipt-vs-invoice matching (v1)
Channels
├── Storefront (settings, theme, pages, publish flags)
├── Marketplace connectors        ├── Connector health & sync journal
└── SKU mapping queue
Customers
├── Customer list                  ├── Customer detail (history, devices, credit, consent)
├── Loyalty program config         └── Segments & campaigns (v1/v2)
Team
├── Users & roles                  ├── Role/permission editor
├── Shifts & timesheets (v1)       ├── Commissions (v1)
└── Fraud flags queue (v1)         └── Flag detail (evidence drill-down)
Finance
├── Daily close / Z-reports        ├── Cash office (v1)
├── Tax reports                    ├── P&L by store/channel (v1)
├── Inventory valuation            └── Accounting export (v1)
Reports
├── Report library (canned)        ├── Saved views & subscriptions (v1)
└── Ask OmniRetail (v2, NL query)
Settings
├── Locations & registers          ├── Payment & hardware integrations
├── Tax & receipt config           ├── Reason codes & approval thresholds
├── API & webhooks (v1)            └── Data import/export, audit trail viewer
Tasks & Approvals (global queue, pinned above sections)
```

### 1.3 Key screens — annotated wireframe descriptions

**Dashboard (ANL-001).** Top row: four KPI tiles (Net sales today vs. same weekday last week, Margin %, Transactions, Average basket), each with sparkline and a data-freshness stamp (ANL-005). Second row: per-location performance table (sortable; each row links to that location's filtered dashboard) alongside a "Needs attention" panel — the union of exception queues (sync conflicts, oversell exceptions, pending approvals, fraud flags) with counts and one-line summaries, each deep-linking to its queue. Third row: top items by revenue/margin toggle, and hourly sales curve. *Role notes:* Accountant/Auditor see finance tiles but not fraud flags; Store Manager's dashboard is auto-scoped to their location(s); cost/margin tiles render only with cost-visibility permission (CAT-006).

**Serial / IMEI lifecycle screen (CAT-003) — the platform's signature screen.** Reached from any IMEI search. Header: model, variant, condition grade, current state (color-coded: in stock / reserved / in transit / sold / in repair / written off), current location and bin, per-unit cost (permission-gated) and warranty window. Body: a vertical event timeline rendered directly from the stock ledger — received on PO-1042 by Kamal (with dock-scan timestamp), transferred on TR-88 (dispatch scan / receipt scan as separate events), sold on receipt R-2-004913 by Arif to customer M. Rahman, returned, inspected, resold. Every event shows actor, register/device, reference document link, and reason code where applicable. Side panel: linked customer(s), linked warranty, linked repair jobs (v2). Primary actions (permission-gated): print unit label, start transfer, write off (approval-gated), open linked receipt. *This screen is the answer to "who touched this unit, when, and why" and is demo-critical.*

**Stock ledger (INV-002).** A filterable, append-only log view: time, item/serial, delta, from→to location/state, movement type, reference, actor, reason. Filters: date range, location, movement type, user, item/category. Row click opens the reference document. A "verify integrity" indicator shows last hash-chain check status (INV-003). Export is permission-gated and audit-logged (ANL-002). *No edit affordances exist on this screen by design — corrections happen on source documents and appear as new entries.*

**Cycle count variance review (INV-011, US-E5-01).** Left: count metadata (scope, counter, blind-count start/end, method). Center table: per-line expected / counted / delta units / delta value, with serialized lines expanding to named missing/unexpected serials. Lines within auto-approve threshold shown as already-posted (grey, with reference). Lines requiring approval carry three explicit actions each: Approve (requires reason code), Recount (spawns new blind task), Escalate. A summary footer totals variance value by category. Deliberately absent: "approve all." *Role notes:* only users with `count.approve` see action buttons; counters can view their own submitted counts read-only.

**Connector health (MKT-001, MKT-004).** Per connector: status, last successful sync per sync type (listings/price/stock/orders/tracking), error-rate sparkline, queue depth, and the sync journal — each entry with direction, payload summary, result, retry state. The SKU mapping queue is surfaced here and in Tasks. Primary actions: pause/resume connector, re-run failed batch, open mapping queue.

**Fraud flags queue (EMP-005).** Table of flags: severity score, rule/model that fired, subject (user/register/store), window, headline stat vs. baseline ("refund rate 9.1% vs store baseline 2.3%"). Flag detail: evidence list of the underlying ledgered events (each linking to receipts/adjustments), involved-party timeline, disposition actions (Confirm — with follow-up note, Dismiss — with reason). Dispositions are recorded and feed model precision metrics. *Role notes:* visible only to Owner/Admin and roles granted `fraud.review`; a Store Manager sees flags for their store's staff but not for themselves (conflict-of-interest rule — own-subject flags route up one level).

**Role/permission editor (EMP-001).** Roles listed left; permission tree right, grouped by module, with search. Each permission shows a plain-language description and the screens/actions it unlocks. Threshold-type permissions (discount %, refund value) take numeric limits inline. A "compare roles" view diffs two roles. Changes require confirmation and are audit-logged with before/after.

### 1.4 Role-based visibility matrix (Web Admin, summary)

| Section | Owner/Admin | Store Manager | E-com Manager | Accountant | Warehouse lead | Auditor (RO) |
|---|---|---|---|---|---|---|
| Dashboard | All locations | Own location(s) | Channel-scoped | Finance tiles | Warehouse ops tiles | Read-only |
| Sales | Full | Own location | Online channels | Read | — | Read |
| Inventory | Full | Own location | Read (ATP) | Valuation reports | Full (warehouse) | Read |
| Catalog | Full | Propose edits* | Full (channel content) | Read | Read | Read |
| Purchasing | Full | Request POs* | — | Invoice matching | Receiving | Read |
| Channels | Full | — | Full | — | — | Read |
| Customers | Full | Own-store view | Full | Credit/liability | — | Read |
| Team | Full | Own staff | — | — | Own staff | Read (audit trail) |
| Finance | Full | Own daily close | Channel P&L | Full | — | Read |
| Settings | Full | Limited (printers etc.) | Channel settings | Export config | — | — |

\* "Propose" = creates a draft requiring approval, per tenant configuration.

---

## 2. Desktop POS

**Audience:** Cashier, Salesperson, Store Manager (approvals/close). **Platform:** installed desktop app (Windows/macOS), keyboard-and-scanner-first, touch-friendly (≥ 44 px targets, NFR-OPS-004), fully functional offline (POS-010).

### 2.1 Navigation model

POS is **modal-minimal and single-surface**: one primary Sell screen; everything else is an overlay or a drawer, so the cashier never "navigates away" from a sale in progress. A thin top bar holds: register/store identity, connectivity/sync status (always visible — count of unsynced transactions when > 0), current cashier (tap to lock/switch, 60 s auto-lock), and the menu. Manager functions live behind a PIN-gated Manager drawer on the same surface. Every function has a keyboard shortcut; scanning works from any state (scanner input is globally captured).

### 2.2 Screen inventory

| Screen/overlay | Purpose | Primary actions | Visibility |
|---|---|---|---|
| **Lock / PIN screen** | Cashier auth per session (POS-002) | Enter PIN, badge scan | All |
| **Sell (home)** | Build and tender carts | Scan; search; category grid; qty/price/discount per line; park/resume; customer attach; tender | All authenticated |
| **Serial picker overlay** | Choose exact unit when item added without serial scan (POS-004) | Scan serial; pick from in-stock unit list (condition, price per unit) | All |
| **Tender overlay** | Payment (POS-007) | Cash (change calc), card (terminal), split, store credit, loyalty redeem | All; store-credit issue is manager-gated |
| **Returns overlay** | Receipt lookup + refund (POS-008) | Find by receipt #/customer/IMEI/card ref; scan returned IMEI to verify; refund to tender | All; thresholds trigger approval flow |
| **Approval overlay** | Dual control (EMP-004) | Manager PIN here, or "send to manager phone" with live status | Appears contextually |
| **Park / resume drawer** | Held carts (POS-013) | Park with note; resume; parked-by shown | All |
| **Customer quick panel** | Attach/create customer (POS-016) | Search by phone; 4-field quick create; view warranty/devices | All |
| **Cash management drawer** | Session ops (POS-009) | Open session/float, paid-in/out with reasons, no-sale (reason required, POS-014) | Paid-out and no-sale per permission |
| **Session close screen** | Blind close (POS-009) | Declare counted cash by denomination → then see expected, over/short, sign-off | Cashier declares; manager countersigns per config |
| **Manager drawer** | PIN-gated store functions | Approvals queue, void after tender, price override, X-report, sync exceptions list (POS-011), reprint | Manager permissions only |
| **Transactions journal** | Local receipt history | Find/reprint/email receipt; start return | All (own register); managers see all registers |
| **Remote sell overlay (v1)** | Sell stock from another location (POS-015) | Check chain-wide ATP, create ship/transfer order, take payment | Per permission |
| **Settings (device)** | Hardware & register config | Printer/scanner/terminal setup, test print, update channel | Manager/Admin |

### 2.3 Key wireframe descriptions

**Sell screen.** Left 60%: cart — one row per line with item name, serial (when serialized, shown prominently under the name), qty, unit price, line discount chip (shows approver initials if it required approval), line total. Running totals footer: subtotal, discounts, tax, total — large. Right 40%: context stack — top: search box (always focused when cart idle; scanner writes here too); middle: results / category quick-grid (top-40 sellers configurable per store); bottom: customer panel chip (attached customer name, loyalty points) and action row (Park, Returns, Cash mgmt, Tender — Tender is the largest target, also F12). Offline state: a slim amber banner "Offline — sales continue, will sync" with queued count; nothing else changes (US-E2-01). *Design intent: the cashier's eyes stay on one vertical axis; no full-screen context switches during a sale.*

**Serial picker overlay.** Invoked automatically at tender if a serialized line lacks a unit (POS-004). Shows in-stock units at this store for that product: serial, condition grade, unit price (can differ per unit), warranty, age-in-stock. One-tap select or scan-to-select. If zero units locally: shows chain-wide availability with "sell from Store N" action (v1, POS-015). *The overlay is a hard gate — no path to tender leaves it unresolved.*

**Blind close screen.** Step 1: denomination-grid cash count entry (bills × count), running declared total; expected figures are **not** rendered anywhere in step 1 (POS-009). Step 2 (after declaration is committed): expected vs. declared, over/short highlighted, per-tender breakdown, discount/refund/no-sale counts for the session. Step 3: cashier sign-off (PIN) and optional manager countersign; prints Z-slip. Committed declarations are immutable; a recount is a new attributed event.

**Approval overlay (US-E6-01).** Shows exactly what is being approved: action type, amount, item + IMEI, customer, cashier, reason picklist. Two paths side by side: "Manager PIN here" and "Send to manager's phone" (shows manager avatars on shift; live pending/approved/denied status). Denial reason is displayed to the cashier verbatim. All identities recorded (EMP-002).

### 2.4 Role-based visibility (POS)

- **Cashier:** Sell, tender, returns within thresholds, park, customer attach, own-session cash ops, own-register journal. Cost and margin are never rendered for cashiers.
- **Salesperson (non-cashier):** can build carts and attach themselves for commission (POS-017); cannot tender or open drawer.
- **Store Manager:** everything above + Manager drawer (approvals, voids, overrides, X/Z reports, sync exceptions, all-register journal), close countersign.
- **Configuration principle:** thresholds (discount %, refund value, no-receipt returns) come from the role editor (EMP-002); the POS renders identical flows and inserts the approval gate exactly where the acting user's authority ends.

---

## 3. Mobile Companion App (iOS/Android)

**Audience:** Owner (P1), Store Manager (P2), Warehouse staff (P4). One app, role-shaped home. **Not** a phone POS at v1.0 (deliberate: selling stays on controlled registers for cash/fraud discipline; revisit for v2.0 line-busting).

### 3.1 Navigation model

Bottom tab bar, 4 tabs + role-shaped Home. Push notifications are a first-class entry point (approvals, fraud flags, conflict tasks, transfer receipts) — every notification deep-links to an actionable screen. Camera barcode scanning available from every inventory screen via a persistent scan FAB; Bluetooth scanner support for warehouse roles (WHS-004).

```
Tabs: Home · Tasks · Inventory · Insights · (More)
```

### 3.2 Screen inventory

| Screen | Purpose | Primary actions | Roles |
|---|---|---|---|
| **Home (Owner shape)** | The 11 pm check (P1) | Today's sales/margin/cash per store; needs-attention list; store switcher | Owner/Admin |
| **Home (Manager shape)** | Floor command | My store today; pending approvals (count badge); staff on shift; low-stock alerts | Store Manager |
| **Home (Warehouse shape)** | Work queue | Today's receiving / picks / counts / transfers as task cards | Warehouse |
| **Tasks & Approvals** | Unified queue | Approve/deny with full context (EMP-004); count tasks; conflict resolutions (POS-011); mapping tasks | Per role |
| **Approval detail** | One decision, full context | Approve / Deny + reason; shows actor, amount, item/IMEI, customer, history flags | Approvers |
| **Inventory lookup** | Scan-or-search anything | Scan item/serial → stock by location/state, price; serial → lifecycle timeline (CAT-003 mobile view) | All (cost gated) |
| **Transfer — dispatch** | Scan-out flow (US-E3-01) | Scan serials/quantities against transfer order; short-dispatch exception; confirm manifest | Warehouse, Manager |
| **Transfer — receive** | Scan-in flow | Blind receive by scan; declare complete; discrepancy capture | Warehouse, Manager |
| **Receiving (PO)** | Dock check-in (WHS-002) | Scan against PO; per-unit serial capture; short/over/damage claims; putaway to bin | Warehouse |
| **Picking** | Pick list execution (WHS-003) | Bin-sequenced list; scan bin + item/serial to confirm; short-pick exception | Warehouse |
| **Cycle count** | Blind counting (US-E5-01) | Count by scan; serialized scan-each mode; submit (no expected shown) | Counter roles |
| **Variance review** | Approve counts on the go | Per-line approve/recount/escalate with reasons | Managers with `count.approve` |
| **Fraud flag detail** | Review evidence (EMP-005) | Evidence list → receipts; confirm/dismiss | Owner, permitted managers |
| **Insights** | Mobile reports | Sales, top items, stock cover, staff performance; date/store filters; Ask OmniRetail (v2) | Per role scope |
| **More** | Profile, notifications config, register-help | Manage sessions, biometric lock | All |

### 3.3 Key wireframe descriptions

**Owner Home.** Store cards (one per location): today's net sales vs. same weekday last week (delta arrow), transactions, margin (if permitted), cash-in-drawer estimate, tiny hourly sparkline. Above the cards, a "Needs attention" strip: horizontally scrollable chips (e.g., "2 approvals", "1 sync conflict", "Fraud flag — Store 2") — tap goes straight to the item, not to a list-of-lists. Pull-to-refresh shows data freshness stamp. *Design intent: the whole business in one thumb-scroll, matching P1's success criterion.*

**Approval detail.** Full-screen card: what (Refund — $412), who's asking (Arif, Register 2, Store 1), item (Model X, IMEI, condition), customer (name, prior return count), reason code, and any risk annotations (e.g., "3rd refund this shift"). Approve (green, bottom-right) / Deny (requires reason). Decision writes back within 2 s and the POS overlay updates live (EMP-004). *No approval without context; no context requiring a phone call.*

**Transfer receive.** Header: transfer ID, origin, dispatched-by, expected package count only (blind to line detail until scanning starts, per US-E3-01). Big scan viewfinder; each successful scan ticks a progress counter ("14 of 20 serials"). "Complete receiving" triggers the discrepancy summary if short: missing serials named explicitly, with photo-attachment option for damaged items; submission creates the dispute record. Works offline in the warehouse dead-zone; queues events with the same attribution rules.

**Cycle count.** Zone header and item scope; scan-first UI where each scan increments (non-serialized) or checks off a serial (serialized); manual qty entry allowed but flagged as manual in the count record. No expected quantities anywhere in the counter's flow (INV-011). Submit shows only "Count submitted for review."

### 3.4 Role-based visibility (Mobile)

- Home shape is selected by primary role; users with multiple roles can switch shapes.
- Warehouse roles get no Insights financials; cost visibility follows the same permission as everywhere (CAT-006).
- Approvals appear only for users holding the relevant approval permission and scope (own store vs. all).
- Fraud flag screens follow the same own-subject exclusion as Web Admin (a manager never reviews flags about themselves).

---

## 4. Customer-Facing Storefront

**Audience:** End shopper (P9 Maya); v2.0 adds authenticated B2B portal shape for wholesale buyers (P8 Faisal). **Platform:** hosted responsive web (ECOM-001), mobile-first (LCP < 2.5 s p75 mobile, ECOM-004).

### 4.1 Navigation model

Standard retail e-commerce IA — deliberately conventional; the differentiators live in inventory truth (live per-store availability) and post-purchase (warranty, unified returns), not in exotic navigation. Header: logo, category mega-menu, search (with model-number and spec-aware autocomplete), store selector ("Your store: Gulshan — change"), cart, account. Footer: policies, store locator, warranty check.

### 4.2 Screen inventory

| Screen | Purpose | Primary actions | Notes |
|---|---|---|---|
| **Home** | Merchandising | Featured collections, category tiles, promos | CMS-managed (ECOM-007, v2 for full CMS) |
| **Category / listing** | Browse + filter | Filter by brand, price, storage, condition grade, availability at my store; sort | Condition grades (New/Used A/B…) are filterable facets (ECOM-002) |
| **Product detail (PDP)** | Decide + buy | Select variant + condition; Add to cart; **"Available now at: [stores with live count band]"**; pickup vs. delivery choice; warranty terms per condition | Availability from live ATP with buffer rules (ECOM-001/006); for used units, each grade shows per-unit availability |
| **Search results** | Find fast | Query by name, model number, or even IMEI (resolves for the owner's own registered device → warranty page) | |
| **Cart** | Review | Edit qty, see per-line fulfillment (pickup store vs. ship), promo code | Mixed fulfillment carts split visibly into shipments |
| **Checkout** | Pay | Guest or account; address or store pickup; tokenized payment (hosted fields/redirect — ECOM-003); COD where enabled | Our servers never see PAN (NFR-SEC-001); no card fields rendered by our origin |
| **Order confirmation** | Reassure | Order number, pickup code + QR (for C&C), status link | Pickup code is the verification credential (OMS-004) |
| **Order status / tracking** | Post-purchase | Live status from OMS states; tracking; cancel window | Serial(s) shown once allocated — customer knows the exact unit's IMEI before pickup |
| **Store pickup page** | C&C instructions | Store address/hours, what to bring (code + ID for serialized goods), hold-until date | Auto-cancel policy stated up front (OMS-004) |
| **Account — overview** | Self-service | Orders, addresses, consent preferences (GDPR, NFR-CMP-001) | Unified with in-store CRM record (ECOM-005) |
| **Account — My devices & warranty** | The retention screen | Every device bought (any channel): model, IMEI, purchase date, warranty end, receipt reprint; "book repair" (v2) | Directly serves Maya's "prove my warranty" need; strongest repeat-visit driver |
| **Returns portal** | Start RMA | Select order/line, reason, choose refund/exchange, pick drop-off store or ship-back | Creates OMS-005 RMA; in-store return honored for online orders |
| **Warranty check (public)** | Trust utility | Enter phone number + OTP → device/warranty list (no account needed) | Low-friction version of "My devices" for offline-bought customers |
| **Store locator** | Route to store | Map/list, hours, per-store phone | |
| **B2B portal shape (v2)** | Wholesale ordering (FIN-008) | Tier-priced catalog, bulk order grid (qty per variant), credit balance & terms, order history with shipped-serial lists, statements | Login-gated; prices never public; credit-limit warnings at checkout (Faisal's flow) |

### 4.3 Key wireframe descriptions

**PDP availability module (the storefront's signature element).** Below the price/variant selector: a bordered module titled "Get it today." Row 1: the shopper's selected store with a truthful availability band ("In stock — 3+ available" / "Only 1 left" / "Not at this store") — bands, not raw counts, per configured buffer rules (ECOM-006). Row 2: "Other nearby stores" expandable list with the same bands. Row 3: delivery option with honest promise date from OMS routing. Selecting "Pickup at Gulshan" pins fulfillment for that line into the cart. *Rule: this module reads live ATP (ECOM-001); it is never cached beyond 30 s and shows a subtle refreshed-time on tap-and-hold — truth is the brand.*

**Used-device buying on PDP (ECOM-002).** Condition grades render as selectable chips next to variants (New · Open box · Grade A · Grade B), each with its own price and availability; selecting a used grade reveals grade definition ("Grade A: minimal wear, battery ≥ 90%") and that the exact IMEI + remaining warranty will be shown at allocation. *No stock-photo bait-and-switch: condition definitions are standardized per tenant catalog config.*

**Checkout.** Single-page, two columns on desktop / stacked mobile: left — contact, fulfillment (per-line pickup/ship already decided in cart, editable), payment via provider-hosted fields (visually seamless, different origin); right — sticky order summary with per-shipment grouping. Guest checkout is default-forward; account creation is a post-purchase one-tap offer, never a wall. Consent checkboxes are unticked by default (NFR-CMP-001).

**My devices & warranty.** Card per device: image, model, IMEI (tap to copy), purchase channel/date, warranty progress bar with end date, buttons: receipt (PDF), start return (if in window), book repair (v2). Empty state teaches the phone-number warranty check for past in-store purchases. *This screen converts a transaction into a relationship and is the storefront's retention centerpiece.*

### 4.4 Visibility notes (storefront)

- Anonymous shoppers: catalog honoring channel publish flags and channel price list only (CAT-007); no wholesale prices ever leak to the public shape.
- Authenticated shoppers: personal data strictly scoped to their own record; IMEI search resolves only devices they own.
- B2B users (v2): see tier pricing and credit data for their own account only; B2B shape is a separate authenticated experience on the same storefront infrastructure.
- Tenant staff have no special powers on the storefront — staff operations live in Admin/POS/Mobile; the storefront has exactly one privilege level per audience by design.

---

## 5. Cross-app journey stitching (reference)

| Journey | Apps touched | IA seams |
|---|---|---|
| Maya reserves online, picks up in store | Storefront → (OMS) → POS + Mobile | Pickup code from Order confirmation is scanned at POS pickup flow; manager sees pending pickups aging in Tasks |
| Refund approval while manager is off-floor | POS → Mobile | POS Approval overlay ↔ Mobile Approval detail, live status both ways (EMP-004) |
| Transfer dispute | Mobile (dispatch/receive) → Web Admin | Discrepancy record created on Mobile lands in Web Admin Tasks & the transfer detail; serial timeline shows both scans |
| Marketplace order to shipped | Connector → Web Admin (Channels, Orders) → Mobile (pick) | Unmapped SKU task appears in both Web Tasks and connector page; pick task lands on Warehouse Home |
| Fraud flag to disposition | Platform rules → Mobile push → Web Admin flag detail | Push deep-links to flag; full evidence drill-down is Web-first, quick confirm/dismiss available on Mobile |

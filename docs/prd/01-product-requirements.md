# OmniRetail OS — Product Requirements Document

| | |
|---|---|
| **Document** | 01 — Product Requirements |
| **Owner** | Chief Product Officer |
| **Status** | Approved for engineering planning |
| **Last updated** | 2026-08-06 |
| **Related docs** | [02 — Personas & User Stories](./02-personas-and-user-stories.md), [03 — Information Architecture](./03-information-architecture.md) |

---

## 1. Vision

**OmniRetail OS is the single source of truth for a retailer's inventory, sales, and money — across every channel, with every movement traceable to a person and a reason.**

Retailers today run their business on a patchwork: a POS that doesn't know what the warehouse has, a spreadsheet that "reconciles" the two, a marketplace account that oversells what was sold in-store an hour ago, and an accountant who discovers the shrinkage three months later. OmniRetail OS replaces the patchwork with one centralized inventory database and an **immutable stock ledger**: every unit that enters, moves, or leaves the business is a signed, timestamped, attributable event. There are no silent inventory changes — not by a cashier, not by a sync job, not by an admin.

On top of that ledger we build the operational surface (POS, OMS, warehouse, e-commerce, marketplace sync) and an AI layer (demand forecasting, reorder suggestions, anomaly/fraud detection, natural-language analytics) that turns the ledger from a record of the past into a decision engine for the future.

**First beachhead:** electronics and mobile-phone retailers — a segment with high-value serialized stock (IMEI), high shrinkage risk, thin margins, active trade-in/repair flows, and chronically underserved by generic POS products. **Second wave:** general retail (fashion, grocery-adjacent, home goods) via the same core with category packs.

## 2. Problem Statement

Small-to-mid retailers (1–50 locations) face five compounding problems that no single existing product solves well:

1. **Fragmented inventory truth.** Stock counts diverge across POS, e-commerce, marketplaces, and warehouses. Overselling and phantom stock are routine; reconciliation is manual and monthly at best.
2. **Untraceable shrinkage and fraud.** In cash-heavy, high-value-SKU retail (phones especially), 2–4% of revenue is lost to theft, "no-sale" drawer opens, fake refunds, and unrecorded discounts. Owners can't answer "who touched this unit, when, and why?"
3. **Serialized inventory is an afterthought.** Generic POS systems treat a phone like a t-shirt. Retailers need per-unit IMEI/serial tracking through purchase → stock → transfer → sale → return → repair → resale, including warranty and blacklist status.
4. **Channel operations don't scale.** Adding a marketplace or webstore means another login, another stock silo, another nightly CSV. Order routing, channel-specific pricing, and buffer stock rules are manual.
5. **Decisions are made blind.** Reordering is gut-feel; dead stock accumulates; promotions run without margin math. Owners get a P&L from their accountant 45 days after the month closes.

**Consequence:** owners spend 10–20 hours/week on reconciliation and firefighting, carry 20–35% excess inventory in slow movers while stocking out of fast movers, and lose margin they never see.

## 3. Target Market & Segments

### 3.1 Segment ladder (expansion path, in order)

| Segment | Profile | Locations | Key needs | Why we win |
|---|---|---|---|---|
| **S1 — Single-store mobile/electronics shop** | Owner-operated phone shop; new + used devices, accessories, repairs, trade-ins | 1 | IMEI tracking, fast POS, cash control, simple accounting, WhatsApp-friendly receipts | Serialized-first design; fraud controls; affordable entry tier |
| **S2 — Multi-store electronics chain** | 2–15 stores + small central warehouse; regional brand | 2–15 | Inter-store transfers, centralized pricing/purchasing, per-store P&L, role hierarchy, franchise-style controls | Central inventory DB + immutable ledger + transfer workflows; per-store analytics |
| **S3 — Omnichannel retailer** | Chain + webstore + 1–3 marketplaces | 2–50 | Real-time channel sync, OMS routing, click-and-collect, returns across channels | Native storefront + marketplace connectors on one stock pool |
| **S4 — Wholesale / distribution** | Distributor selling to S1/S2 shops; B2B price lists, credit terms | 1–5 warehouses | B2B ordering portal, tiered pricing, credit limits, van sales, batch/serial at scale | Same core ledger; wholesale module is additive, not a fork |

### 3.2 Initial geography and go-to-market

- **Launch markets:** South & Southeast Asia and MENA first (dense independent mobile-retail markets, high smartphone GMV, weak incumbent penetration), with US/EU-ready compliance from day one so we do not rebuild for expansion.
- **GTM:** direct + local reseller/implementation partners; free data-migration tooling from spreadsheets, Odoo, and legacy local POS products is a launch requirement (see MIG requirements).

## 4. Competitive Landscape — Honest Positioning

| Competitor | Strengths | Weaknesses vs. us | Our position |
|---|---|---|---|
| **Odoo** | Enormous module breadth; open source; huge partner network; cheap entry | Jack-of-all-trades UX; serialized retail flows require heavy customization; POS offline mode is fragile; implementation partner quality varies wildly; multi-tenant SaaS story is weak | We are vertical-depth where Odoo is horizontal-breadth. We will not out-feature Odoo across ERP; we will beat it decisively on retail/POS UX, serialized inventory, and time-to-value (days, not months) |
| **ERPNext** | Open source; solid accounting core; strong in our launch geographies; free tier | Self-hosting burden; dated POS; no native marketplace connectors; AI absent; UX built for ERP admins, not cashiers | Same trade as Odoo: we win on POS speed, IMEI flows, connectors, and managed SaaS. We lose users who require full open-source self-hosting — accepted |
| **Lightspeed Retail** | Excellent POS UX; strong in NA/EU; good ecosystem | Expensive per-register; serialized/IMEI support shallow; weak in emerging markets; ERP depth (purchasing, accounting) thin; no meaningful AI ops layer | Closest UX benchmark. We match POS quality, add ERP depth + serialized rigor + AI, and price for emerging markets |
| **Square** | Frictionless onboarding; free entry; payments-led | Inventory is basic; no serialization; multi-location weak beyond ~5 stores; locked to Square payments in core markets | We concede the micro-merchant who wants a free card reader. We win the moment they need real inventory |
| **Zoho Inventory** | Cheap; good marketplace/shipping integrations; Zoho suite pull | Not a POS; no ledger-grade traceability; serialization is list-based, not lifecycle-based; fraud controls absent | We overlap on channel sync only. We are an operating system; Zoho Inventory is a stock list with integrations |
| **Cin7 (Core/Omni)** | Deep B2B/EDI and 3PL connectivity; strong for product brands | Priced and designed for brands/distributors, not store retail; POS is an afterthought; complex onboarding; no fraud/attribution focus | Cin7 owns brand-to-3PL; we own store-first omnichannel. In S4 wholesale we will meet them — differentiating on ledger traceability and POS-native retail |

**Positioning statement:** *For electronics and mobile retailers who live or die by serialized, high-value stock, OmniRetail OS is the only platform that combines Lightspeed-class POS speed, ERP-class purchasing and accounting, and audit-grade inventory traceability — with an AI layer that tells you what to buy, what to move, and who to watch.*

**What we deliberately do not claim:** we are not cheaper than Square at the low end, not more customizable than Odoo/ERPNext for bespoke ERP, and not deeper than Cin7 in EDI. See Non-Goals (§8).

## 5. Business Model

Multi-tenant SaaS, priced per location + register, with usage-based add-ons. Annual billing default; monthly at +20%.

| Tier | Target | Price anchor (USD, launch-market adjusted) | Includes |
|---|---|---|---|
| **Starter** | S1 single store | $29/mo per location | 1 register, 2 users, core inventory + POS + serialized tracking, basic reports, 5k SKUs, community support |
| **Growth** | S2 chains | $79/mo per location + $15/mo per extra register | Unlimited users, transfers, purchasing, storefront, 1 marketplace connector, loyalty, fraud controls, email support |
| **Scale** | S3 omnichannel | $199/mo per location + registers | All connectors, OMS routing, warehouse module (bins/waves), AI forecasting & anomaly detection, API access, SSO, priority support |
| **Enterprise / Wholesale** | S4 + 15+ locations | Custom (floor $1,500/mo) | B2B portal, credit terms, dedicated environment options, SLA 99.95%, onboarding services, TAM |

**Add-ons (all tiers):** e-commerce transaction fee 0% (we monetize software, not GMV — deliberate contrast with Shopify/Square); SMS/WhatsApp messaging at cost + margin; AI credits beyond included quota; additional marketplace connectors on Growth.

**Payments:** we never process card payments ourselves. Terminal integrations (Stripe Terminal, Adyen, local processors per market) keep us out of PCI-DSS scope (see NFR-SEC). No payments revenue at launch; payments referral revenue is a v2.0 commercial exploration, never a lock-in.

## 6. Success Metrics / KPIs

### North star
**Weekly Active Selling Locations (WASL):** locations completing ≥ 25 POS transactions/week on the platform.

### Product KPIs (targets at 12 months post-GA)

| Area | Metric | Target |
|---|---|---|
| Activation | Signup → first live sale | ≤ 3 days median (S1), ≤ 21 days (S2/S3) |
| Retention | Gross logo churn (annual) | < 8% Starter, < 4% Growth+ |
| Inventory truth | Cycle-count variance rate on managed SKUs | < 1.5% of units, trending down per tenant |
| Omnichannel | Oversell incidents per 1,000 marketplace orders | < 2 |
| POS reliability | Sales completed during connectivity loss (offline mode success) | > 99.5% of attempted offline sales sync cleanly |
| AI adoption | Tenants acting on ≥ 1 reorder suggestion/week | > 40% of Scale tier |
| Fraud value | Flagged-and-confirmed incidents per tenant per quarter | Tracked; target is detection precision > 70% (confirmed/flagged) |
| Business | Net revenue retention | > 115% |
| Business | CAC payback | < 14 months blended |

### Guardrail metrics
POS p95 latency (see NFR-PERF), sync-conflict rate < 0.1% of offline transactions, support tickets per active location per month < 0.4.

## 7. Scope by Release

### MVP (Months 0–6) — "One store, perfect truth"
Ship to design-partner S1 shops. Everything on the immutable ledger from day one.

- Core inventory (single location + optional back-room sub-location), immutable stock ledger, adjustments with mandatory reason codes
- Product catalog with serialized (IMEI) and non-serialized items, barcode/label printing
- Desktop POS: sell, return, hold, discounts with permission gates, **offline mode**, cash-drawer sessions with blind close
- Purchasing lite: purchase orders, goods receipt with per-unit serial capture
- Customers lite: profile, purchase history, warranty lookup by IMEI
- Users, roles, PIN-based POS auth, full audit trail
- Reports: daily sales (Z-report), stock on hand, stock movement, shrinkage
- Tenant onboarding + CSV/spreadsheet migration importer
- Payments: 2 tokenized terminal integrations (per launch market) + cash + manual "other tender"

**MVP explicitly excludes:** e-commerce, marketplaces, multi-store transfers, AI, loyalty, accounting integrations.

### v1.0 (Months 7–12) — "Chain + channels"
- Multi-location: stores + warehouses, stock transfers with in-transit state, inter-store visibility
- Warehouse: bin locations, receiving/putaway, pick lists, cycle counts with variance approval workflow
- OMS: unified order objects across channels, click-and-collect, ship-from-store, returns (RMA) across channels
- E-commerce storefront (hosted, themeable) on the same stock pool
- Marketplace connectors: 2 at GA (per-market selection, e.g., Daraz/Noon/Amazon marketplace per region), with buffer-stock rules
- CRM & loyalty: points, tiers, store credit; SMS/WhatsApp receipts and campaigns (transactional first)
- Employee module: shifts, commissions, and the full fraud-control suite (approval workflows, anomaly flags v1 — rules-based)
- Finance: tax engine (VAT/GST configurable), COGS (FIFO with per-serial actual cost), P&L by store, accounting export (QuickBooks/Xero + generic journal CSV)
- Mobile companion app (manager + warehouse roles)

### v2.0 (Months 13–20) — "The AI operating layer"
- AI demand forecasting + reorder suggestions with explainations and one-click PO draft
- AI anomaly/fraud detection (ML-based, on top of v1 rules): refund abuse, discount abuse, void patterns, IMEI velocity anomalies
- Natural-language analytics ("Ask OmniRetail") over tenant's own data
- Dynamic pricing suggestions (used-device pricing engine for phones — trade-in valuation assistant)
- Wholesale/B2B: customer-specific price lists, credit limits & terms, B2B ordering portal, bulk serialized allocation
- Repairs/service module (job cards, parts consumption from inventory, technician attribution)
- Open API GA + webhooks + app marketplace foundations
- Additional marketplace and 3PL connectors

## 8. Non-Goals (explicit)

1. **We do not build a payments processor or handle raw PAN data.** Tokenized terminal integrations only, permanently.
2. **No manufacturing/MRP module.** Kitting/bundles yes; BOM-based production no.
3. **No full general-ledger accounting suite.** We compute retail-side financials (sales, COGS, margins, tax collected) and export to accounting systems. We are not replacing QuickBooks/Xero/Tally.
4. **No self-hosted/on-prem edition** through v2.0. Multi-tenant SaaS only (single-tenant cloud isolation available at Enterprise, but same codebase).
5. **No bespoke per-tenant code customization.** Configuration, custom fields, and API — never forked logic.
6. **No general marketplace/aggregator business.** We will not become a channel that competes with our customers.
7. **No hardware manufacturing.** Certified third-party hardware list (scanners, printers, drawers, terminals) only.
8. **No blockchain.** "Immutable ledger" means append-only, hash-chained audit records in our database — not a distributed ledger.

## 9. Functional Requirements

Requirement IDs are stable and traceable: `<MODULE>-<NNN>`. Priority: **M** = MVP, **1** = v1.0, **2** = v2.0.

### 9.1 Inventory Core (INV)

| ID | Pri | Requirement |
|---|---|---|
| INV-001 | M | The system SHALL maintain a single centralized inventory database per tenant; all channels and locations read/write the same stock records. No channel-local stock copies except explicitly declared read caches. |
| INV-002 | M | Every inventory quantity change SHALL be recorded as an append-only stock-ledger entry containing: item, serial (if serialized), quantity delta, source/destination location, movement type, reference document, acting authenticated user, device/register ID, timestamp (UTC + local), and reason code. Ledger entries SHALL never be updated or deleted; corrections are compensating entries. |
| INV-003 | M | Ledger entries SHALL be hash-chained per location-stream so that tampering with historical entries is detectable; a nightly integrity check SHALL verify chains and alert on mismatch. |
| INV-004 | M | Stock on hand SHALL be derivable at any timestamp by replaying the ledger; the materialized on-hand view SHALL reconcile with ledger replay in automated daily checks (tolerance: zero). |
| INV-005 | M | Manual stock adjustments SHALL require a reason code from a tenant-configurable list (damage, theft, count correction, data-entry error, etc.), an optional note, and SHALL be permission-gated; adjustments above a configurable value threshold SHALL require second-person approval. |
| INV-006 | M | The system SHALL track distinct stock states per item/location: on hand, reserved (allocated to orders), in transit, in repair, damaged/quarantine, demo/display. Available-to-promise = on hand − reserved − quarantine − demo. |
| INV-007 | M | Negative on-hand SHALL be blocked by default; a tenant setting MAY allow it per location with mandatory reason capture and an exceptions report. |
| INV-010 | 1 | Stock transfers between locations SHALL use a two-step protocol: dispatch (stock → in-transit) and receipt (in-transit → destination), each attributable, with discrepancy capture at receipt (short/over/damaged) feeding a variance workflow. |
| INV-011 | 1 | Cycle counts SHALL support scoped counts (by zone, category, ABC class, or serial list), blind counting (counter cannot see expected qty), variance computation, and approval before ledger posting. Variances above configurable thresholds (value or %) SHALL require manager approval with reason codes. |
| INV-012 | 1 | The system SHALL support batch/lot tracking (expiry, batch cost) for non-serialized goods, in addition to per-unit serials. |
| INV-013 | 1 | Reorder points and min/max per item-location SHALL be settable manually; breach SHALL raise a replenishment task. |
| INV-014 | 2 | Dead-stock detection SHALL flag items with zero sales over configurable windows per location and estimate carrying cost. |
| INV-015 | M | Every stock-affecting screen SHALL display who performed the last movement and when ("last touched by"); there SHALL be no code path that changes stock without a ledger entry (enforced at data-access layer, verified by automated tests). |

### 9.2 Product & Catalog (CAT)

| ID | Pri | Requirement |
|---|---|---|
| CAT-001 | M | Products SHALL support: simple, variant (matrix, e.g., color/storage), serialized, batch-tracked, service (non-stock), and bundle/kit types. |
| CAT-002 | M | Serialized products SHALL carry per-unit records: serial/IMEI (with IMEI Luhn check-digit validation for phone category), condition grade (New/Open-box/Used A/B/C/Refurbished), per-unit cost, per-unit purchase source (supplier or trade-in customer), warranty start/end, and current lifecycle state (in stock, sold, returned, in repair, transferred, written off). |
| CAT-003 | M | The full lifecycle history of any serial SHALL be viewable on one screen from a single IMEI/serial search, sourced from the ledger. |
| CAT-004 | M | Duplicate serial entry SHALL be blocked tenant-wide; attempting to receive an IMEI that is currently in stock or was previously sold-and-not-returned SHALL raise a blocking warning with override requiring manager permission and reason. |
| CAT-005 | M | Barcode support: scan-to-find by EAN/UPC, internal SKU barcodes, and per-unit serial barcodes; label printing templates for shelf labels and per-unit serial labels (including price, SKU, serial). |
| CAT-006 | M | Pricing: base price, cost, tax class, per-location price overrides; margin display on price edit (permission-gated visibility of cost). |
| CAT-007 | 1 | Channel-specific pricing and content: per-channel price lists, titles, images, and publish flags (an item can be POS-only, web-only, etc.). |
| CAT-008 | 1 | Bulk operations: CSV import/update with dry-run diff preview, bulk price change with scheduled effective date, category-level tax reassignment. |
| CAT-009 | 1 | Trade-in intake: create a used-device unit with condition grading checklist, IMEI capture, customer ID capture (configurable per jurisdiction), and trade-in value applied as tender on the purchase transaction. |
| CAT-010 | 2 | Used-phone pricing assistant SHALL suggest buy/sell prices from tenant's own sales history and configurable depreciation curves (no external scraped data at launch). |

### 9.3 POS (POS)

| ID | Pri | Requirement |
|---|---|---|
| POS-001 | M | POS SHALL run as a desktop app (Windows/macOS) with a local datastore enabling full selling capability offline (see POS-010). |
| POS-002 | M | Cashier authentication SHALL be per-transaction-session via PIN or badge scan; every cart action is attributed to the authenticated cashier, not the register. |
| POS-003 | M | Add-to-cart by scan (barcode/serial), search (name/SKU/IMEI, fuzzy), or category grid; scanning a serialized product's unit barcode SHALL attach that exact unit to the line. |
| POS-004 | M | Selling a serialized product without scanning/selecting a specific serial SHALL be blocked (no "generic phone" sales). |
| POS-005 | M | Performance: add-to-cart p95 < 100 ms local; product search results p95 < 200 ms local; cash sale completion (tender → receipt print start) p95 < 1 s. |
| POS-006 | M | Discounts: line and cart level, amount or %; discounts beyond a per-role threshold SHALL require manager PIN approval captured in the transaction record; every discount carries a reason code. |
| POS-007 | M | Tenders: cash (with change calc), integrated card terminal (tokenized — POS never sees PAN), split tender, store credit; tender records include terminal reference IDs. |
| POS-008 | M | Returns/refunds SHALL require original receipt lookup (by receipt #, card ref, customer, or serial); serialized returns SHALL verify the returned IMEI matches the sold IMEI. Refund over configurable value, or any no-receipt refund, SHALL require manager approval (dual-PIN). Refund to original tender by default. |
| POS-009 | M | Cash management: register sessions with opening float, paid-in/paid-out with reasons, blind close (cashier declares counted cash before seeing expected), over/short recorded per session per cashier. |
| POS-010 | M | **Offline mode:** on connectivity loss the POS SHALL continue sales, returns (with local receipt data), and cash ops using last-synced catalog/stock; queued transactions sync automatically on reconnect with conflict resolution (see POS-011). Offline serialized sales check the local unit cache and mark the unit locally sold to prevent double-sale on the same register. Card tenders may be unavailable offline if the terminal requires connectivity; POS SHALL degrade to cash/other gracefully and say so. |
| POS-011 | M | Sync conflicts (e.g., same serial sold at two locations while offline) SHALL never be silently resolved: both transactions post to the ledger, the conflict is flagged to a manager work queue within 1 minute of sync, and the resolution (cancel/refund one side) is itself a ledgered, attributed action. |
| POS-012 | M | Receipts: print (ESC/POS), email, SMS/WhatsApp link; receipt includes serials, warranty end date, and return-policy footer; receipt numbering is gapless per register and offline-safe (register-prefixed sequences). |
| POS-013 | M | Park/resume carts; a parked cart SHALL record who parked it; unattended parked carts expire per policy with a ledgered release of any reservations. |
| POS-014 | M | No-sale drawer opens SHALL require a reason code and are reported per cashier; voiding a line or cart after tender initiation SHALL require manager approval. |
| POS-015 | 1 | Sell-from-anywhere: POS can sell stock located at another store/warehouse as a ship-to-customer or transfer-to-store order (creates OMS order, reserves remote stock). |
| POS-016 | 1 | Customer attach: search/create customer at POS in < 10 s flow; loyalty accrual/redemption at tender. |
| POS-017 | 1 | Shift-aware commissions: sales attribute to cashier and optional salesperson (can differ), feeding commission reports. |
| POS-018 | 2 | Quote → invoice flow for B2B walk-ins (print pro-forma, convert later). |

### 9.4 Orders / OMS (OMS)

| ID | Pri | Requirement |
|---|---|---|
| OMS-001 | 1 | All orders — POS, storefront, marketplace, B2B, phone/manual — SHALL be represented as one unified order object with channel metadata, single lifecycle state machine (draft → confirmed → allocated → fulfilled → completed / cancelled / partially-returned). |
| OMS-002 | 1 | Order confirmation SHALL atomically reserve stock (ATP decrement); reservation failure produces an exception task, never a silent oversell. |
| OMS-003 | 1 | Routing rules engine: fulfill from nearest location with stock, from designated warehouse per channel, or manual; rules are ordered and testable against sample orders. |
| OMS-004 | 1 | Click-and-collect: order online, reserve at chosen store, pickup verification (order code + optional ID check for serialized goods), auto-cancel + restock after configurable hold period with customer notification. |
| OMS-005 | 1 | RMA: cross-channel returns (buy online, return in store); RMA states (requested, approved, received, inspected, refunded/exchanged/rejected); inspection outcome routes unit to sellable / quarantine / repair, each a ledgered movement. |
| OMS-006 | 1 | Partial fulfillment, partial refund, and order editing pre-allocation SHALL be supported; every edit is attributed and journaled on the order timeline. |
| OMS-007 | 1 | Shipping: label generation via carrier integrations (per launch market) or manual tracking-number entry; fulfillment SHALL record which serials shipped in which parcel. |
| OMS-008 | 2 | SLA timers per channel (e.g., marketplace ship-by deadlines) with breach warnings on the order queue. |

### 9.5 Warehouse (WHS)

| ID | Pri | Requirement |
|---|---|---|
| WHS-001 | 1 | Locations SHALL support hierarchy: warehouse → zone → aisle → bin; every stocked unit/quantity resolves to a bin. |
| WHS-002 | 1 | Receiving against PO: scan-driven check-in, per-unit serial capture at the dock, discrepancy capture (short/over/damaged/wrong item) creating supplier claim records; putaway tasks with suggested bins. |
| WHS-003 | 1 | Picking: single-order and batch (wave) pick lists optimized by bin walk sequence; pick confirmation by scan (bin + item/serial); short-pick handling creates exception, never a silent quantity edit. |
| WHS-004 | 1 | Mobile companion app SHALL support receiving, putaway, picking, transfers, and cycle counting with camera or bluetooth scanner input. |
| WHS-005 | 1 | Cycle counting per INV-011, schedulable by ABC class (A monthly, B quarterly, C biannually — defaults, configurable). |
| WHS-006 | 2 | 3PL connector framework: push stock/orders to, and consume fulfillment events from, third-party logistics providers as ledgered movements at a virtual 3PL location. |

### 9.6 E-commerce Storefront (ECOM)

| ID | Pri | Requirement |
|---|---|---|
| ECOM-001 | 1 | Hosted, themeable storefront per tenant (custom domain, TLS managed) reading live ATP from the central stock pool; no separately maintained web stock. |
| ECOM-002 | 1 | Product pages honor channel publish flags and channel pricing (CAT-007); serialized condition grades (e.g., "Used — Grade A") displayable as buyable variants with per-unit availability. |
| ECOM-003 | 1 | Checkout via tokenized payment providers (hosted fields / redirect — our servers never touch PAN); guest checkout; COD as configurable tender in supported markets. |
| ECOM-004 | 1 | Storefront performance: LCP < 2.5 s p75 mobile; catalog updates (price/stock) visible on storefront within 30 s of change. |
| ECOM-005 | 1 | Customer accounts unified with CRM: same customer record across store and web; web users see in-store purchase history and warranty status. |
| ECOM-006 | 2 | Configurable buffer stock and "display but not buyable below N units" rules per item for the web channel. |
| ECOM-007 | 2 | SEO/basic CMS: editable pages, redirects, sitemaps, structured data for products. |

### 9.7 Marketplace Connectors (MKT)

| ID | Pri | Requirement |
|---|---|---|
| MKT-001 | 1 | Connector framework SHALL sync: listings (push), price (push), stock (push, with per-channel buffer rules), orders (pull), and order status/tracking (push). All syncs are journaled with per-item success/failure visible to the tenant. |
| MKT-002 | 1 | Stock updates to marketplaces SHALL propagate within 60 s p95 of a stock-affecting event; oversell window is measured and reported (KPI §6). |
| MKT-003 | 1 | Imported marketplace orders become OMS orders (OMS-001) with automatic SKU mapping; unmapped SKUs create a mapping task, never a dropped order. |
| MKT-004 | 1 | Two connectors at v1.0 GA per launch market; connector selection is a market decision, framework is generic (auth, rate-limit handling, retry with idempotency keys, per-connector health dashboard). |
| MKT-005 | 2 | Marketplace fee capture per order (commission, shipping) into channel P&L. |
| MKT-006 | 2 | Repricing rules (min/max guardrails, match-to-margin-floor) per channel; no automated repricing without tenant-set floors. |

### 9.8 CRM & Loyalty (CRM)

| ID | Pri | Requirement |
|---|---|---|
| CRM-001 | M | Customer records: contact info, tax/business IDs (for B2B invoices), consent flags (marketing, per-channel), merged purchase history across all channels, owned-device list (serials bought, warranty status). |
| CRM-002 | M | Duplicate detection on phone/email at creation with merge tool (merge is journaled, reversible within 30 days). |
| CRM-003 | 1 | Loyalty: configurable earn rate (per currency unit, per category multipliers), tiers with thresholds, redemption as tender at POS and web; points ledger is append-only and attributable like stock. |
| CRM-004 | 1 | Store credit: issued from refunds or manually (permission-gated + reason), redeemable across channels, with expiry policy and liability report. |
| CRM-005 | 1 | Messaging: transactional (receipt, order status, pickup-ready, warranty expiring) via SMS/WhatsApp/email with per-market provider abstraction; campaign sends (bulk) gated on consent flags. |
| CRM-006 | 2 | Segments: rule-based (spend, recency, category, device owned) usable for campaigns and reporting; e.g., "bought phone 22–26 months ago" upgrade-cycle segment. |

### 9.9 Employees & Fraud Controls (EMP)

| ID | Pri | Requirement |
|---|---|---|
| EMP-001 | M | RBAC with tenant-configurable roles built on granular permissions (≈120 permission points at v1.0); default roles: Owner, Admin, Store Manager, Cashier, Warehouse, Accountant, Read-only Auditor. |
| EMP-002 | M | Every privileged action (price override, discount above threshold, refund above threshold, no-receipt return, stock adjustment, void after tender, negative-stock override, cost visibility) SHALL be individually permission-gated and SHALL record the approving user when approval differs from the actor. |
| EMP-003 | M | Immutable audit trail of all user actions (not just stock): logins, permission changes, price changes, report exports, setting changes; searchable by user, action type, entity, and time range; retained ≥ 7 years. |
| EMP-004 | M | Manager-approval flows SHALL work in-person (manager PIN on the same register) and remote (push approval to manager's mobile app, v1.0) with the full context of what is being approved. |
| EMP-005 | 1 | Rules-based fraud flags v1: refund rate per cashier vs. store baseline, discount % per cashier, no-sale drawer opens per shift, void-after-tender frequency, sales voided then re-rung lower, cash over/short patterns, after-hours activity. Flags land in an owner/manager review queue with drill-down to underlying ledgered events; flag dispositions (confirmed/dismissed) are recorded. |
| EMP-006 | 1 | Shift scheduling lite: clock-in/out at register (PIN), shift reports, timesheet export. Not a full workforce-management product (see Non-Goals spirit — no forecast-driven scheduling until demand proven). |
| EMP-007 | 1 | Commission rules: % of sale/margin by category, per salesperson, with statement report; margin-based commissions respect cost-visibility permissions. |
| EMP-008 | 2 | ML anomaly detection augmenting EMP-005 (see AI-004). |

### 9.10 Finance & Reporting (FIN)

| ID | Pri | Requirement |
|---|---|---|
| FIN-001 | M | Tax engine: configurable VAT/GST/sales-tax per jurisdiction, tax-inclusive and tax-exclusive pricing modes, per-category rates, tax lines on every document, tax collected report by period/jurisdiction. |
| FIN-002 | M | COGS: FIFO for quantity-tracked goods; serialized units use actual per-unit cost. Margin available per transaction, item, category, store, channel, and salesperson. |
| FIN-003 | M | Daily close: Z-report per register (sales by tender, tax, discounts, refunds, over/short), store daily summary emailed to configured recipients. |
| FIN-004 | 1 | P&L by store and channel (revenue, COGS, marketplace fees, discounts as contra-revenue); inventory valuation report at any as-of date (from the ledger, INV-004). |
| FIN-005 | 1 | Accounting export: QuickBooks Online and Xero connectors (daily summarized journals: sales, tax, tender clearing, COGS, inventory) + generic journal CSV. We do not post individual transactions to GL by default. |
| FIN-006 | 1 | Supplier ledger: PO → receipt → supplier invoice matching (3-way lite: qty received vs. invoiced, price vs. PO), payables aging report. (Payment execution stays in the accounting system.) |
| FIN-007 | 1 | Cash-office view: per-store cash position across registers, bank-deposit records with attributable deposit entries reconciling drawer closes. |
| FIN-008 | 2 | B2B invoicing with credit terms, statements, receivables aging, credit-limit enforcement at order confirmation (blocks with override permission). |

### 9.11 AI Module (AI)

Principles: every AI output is (a) explainable — shows its inputs and reasoning summary, (b) advisory — a human confirms any action that moves stock or money, (c) tenant-scoped — no cross-tenant data leakage into models or outputs.

| ID | Pri | Requirement |
|---|---|---|
| AI-001 | 2 | Demand forecasting per item-location (weekly horizon 1–12 weeks) using tenant sales history, seasonality, and stockout-corrected demand; accuracy reported to the tenant (e.g., WAPE) so trust is earned, not asserted. |
| AI-002 | 2 | Reorder suggestions: proposed PO lines (item, qty, supplier, expected stockout date, reasoning summary); one-click convert to draft PO; every accepted/edited/rejected suggestion is logged to improve ranking. Cold-start tenants (< 90 days data) get rules-based min/max suggestions clearly labeled as such. |
| AI-003 | 2 | Transfer suggestions: rebalance stock across locations when one store's forecast outstrips its stock while another holds excess; converts to draft transfer order. |
| AI-004 | 2 | ML fraud/anomaly detection on the event ledger (refund/discount/void/no-sale/IMEI velocity patterns), surfacing scored flags into the EMP-005 queue with "why flagged" evidence lists. Precision target per §6. |
| AI-005 | 2 | "Ask OmniRetail": natural-language questions over the tenant's own data ("top 10 models by margin last Eid vs this Eid", "which cashier had the most no-receipt returns in July") returning tables/charts with the generated query inspectable. Read-only; respects the asking user's RBAC scope. |
| AI-006 | 2 | Dead-stock and markdown suggestions: identifies slow movers (INV-014) and proposes markdown ladders with margin impact preview; execution requires explicit approval and posts as scheduled price changes (CAT-008). |
| AI-007 | 2 | AI actions never write directly: all AI-originated changes materialize as drafts/suggestions requiring human confirmation, and the confirming user is the attributed actor. |

### 9.12 Analytics & Dashboards (ANL)

| ID | Pri | Requirement |
|---|---|---|
| ANL-001 | M | Owner dashboard: today/WTD/MTD sales vs. prior period, margin, transactions, average basket, top items, per-store tiles; loads p95 < 3 s. |
| ANL-002 | M | Canned reports (MVP set): sales by item/category/hour/cashier, stock on hand & valuation, stock movement log, shrinkage/adjustments, Z-report history. All exportable CSV; exports are audit-logged (EMP-003). |
| ANL-003 | 1 | v1.0 report set adds: sell-through rate, stock cover (days), transfer history, channel performance, loyalty liability, commission statements, fraud-flag summaries, aging inventory by condition grade. |
| ANL-004 | 1 | Scheduled report subscriptions (email, per-role) and saved report views with filters. |
| ANL-005 | 1 | Data freshness: operational reports ≤ 60 s lag from source events; the lag is displayed on-screen, never hidden. |
| ANL-006 | 2 | Metric definitions documented in-product (one canonical definition of "margin", "sell-through", etc.) — same numbers on every screen or it's a bug. |

### 9.13 Platform, Tenancy & Migration (PLT / MIG)

| ID | Pri | Requirement |
|---|---|---|
| PLT-001 | M | Multi-tenant isolation: all data access is tenant-scoped at the persistence layer; cross-tenant access is structurally impossible from application code paths (enforced + tested). |
| PLT-002 | M | Authentication: email+password with mandatory 2FA for Owner/Admin roles; POS PIN auth is subordinate to a device-level registered session. SSO (OIDC/SAML) at Scale tier (v1.0). |
| PLT-003 | 1 | Public REST API (read GA at v1.0, write GA at v2.0) with OAuth2 client credentials, per-tenant rate limits, and webhooks for order/stock/customer events. |
| PLT-004 | M | Tenant data export: full data export (CSV/JSON) self-service at any time — no lock-in by data hostage. |
| MIG-001 | M | Guided importer for products, customers, suppliers, and opening stock (with serials) from CSV/XLSX with validation preview; opening stock posts as ledgered "opening balance" entries attributed to the importing user. |
| MIG-002 | 1 | Migration assistants for Odoo and ERPNext exports (mapping templates), and a generic legacy-POS mapping toolkit for partners. |

## 10. Non-Functional Requirements

### 10.1 Performance (NFR-PERF)

| ID | Requirement |
|---|---|
| NFR-PERF-001 | POS local interactions per POS-005: add-to-cart p95 < 100 ms, search p95 < 200 ms, cash-sale completion p95 < 1 s — measured on reference hardware (mid-range x86, 8 GB RAM) with 100k-SKU catalog and 200k-serial local cache. |
| NFR-PERF-002 | Web Admin: page-load p95 < 2 s, in-app navigation p95 < 500 ms, for tenants up to 50 locations / 250 registers / 1M ledger entries per month. |
| NFR-PERF-003 | Stock event propagation: change → all online channels' ATP updated p95 < 60 s (MKT-002), storefront < 30 s (ECOM-004). |
| NFR-PERF-004 | Offline sync: 8 hours of queued offline transactions (≈ 500 sales) SHALL sync in < 5 minutes on a 10 Mbps link. |
| NFR-PERF-005 | Reports over 3 years of tenant history return p95 < 10 s; longer analyses run async with notification. |

### 10.2 Availability & Resilience (NFR-AVL)

| ID | Requirement |
|---|---|
| NFR-AVL-001 | Cloud platform availability: 99.9% monthly (Starter–Scale), 99.95% (Enterprise SLA). Measured on API + Admin + storefront serving. |
| NFR-AVL-002 | POS selling availability is decoupled from cloud availability via offline mode (POS-010); target: a cloud outage of any duration causes zero lost in-store cash sales. |
| NFR-AVL-003 | **RPO ≤ 5 minutes** (continuous replication + point-in-time recovery); **RTO ≤ 4 hours** for full-region failure (warm standby in second region). Disaster-recovery restore is exercised quarterly with results recorded. |
| NFR-AVL-004 | Zero-downtime deploys for the cloud platform; POS desktop auto-updates outside tenant business hours (tenant-configurable window) with staged rollout and rollback. |
| NFR-AVL-005 | Marketplace/storefront connector failures degrade gracefully: queued with retry + idempotency, tenant-visible health status, alerting at 15 minutes of sustained failure. |

### 10.3 Security (NFR-SEC)

| ID | Requirement |
|---|---|
| NFR-SEC-001 | **PCI-DSS scope avoidance by architecture:** all card payments via tokenized terminal/hosted-field integrations; PAN, CVV, or track data never transits or rests on OmniRetail systems (targeting SAQ-A posture for the e-commerce flow). Any design introducing card data into our scope is rejected at review. |
| NFR-SEC-002 | Encryption in transit (TLS 1.2+) everywhere including POS↔cloud; encryption at rest for all datastores and backups; POS local datastore encrypted at rest with device-bound keys. |
| NFR-SEC-003 | Secrets in a managed vault; no credentials in code or config files; connector tokens encrypted per tenant. |
| NFR-SEC-004 | RBAC per EMP-001/002; session policies (idle timeout configurable per tenant; POS cashier-lock timeout default 60 s). |
| NFR-SEC-005 | Audit logging per EMP-003 is itself append-only and internally access-controlled (support staff access to tenant data is logged and surfaced to the tenant). |
| NFR-SEC-006 | Annual third-party penetration test; SOC 2 Type I by GA + 12 months, Type II by GA + 24 months; vulnerability SLAs: critical patched < 72 h, high < 14 days. |
| NFR-SEC-007 | Tenant-facing security features: login history, active-session management, IP allowlisting for Admin (Enterprise), export watermarking of who exported what. |

### 10.4 Compliance & Privacy (NFR-CMP)

| ID | Requirement |
|---|---|
| NFR-CMP-001 | **GDPR**: lawful-basis tracking for marketing consent (CRM-001), data subject access/export/erasure workflows (erasure anonymizes customer PII while preserving financially required transaction records — documented legal basis), DPAs with subprocessors, EU data residency option at Enterprise. |
| NFR-CMP-002 | Data residency: tenant data pinned to selected region; cross-region replication only within the tenant's residency choice. |
| NFR-CMP-003 | Fiscal compliance per launch market is a market-entry checklist item (e.g., e-invoicing mandates, fiscal receipt rules); the tax engine (FIN-001) and receipt templates (POS-012) are extensible per jurisdiction without code forks. |
| NFR-CMP-004 | KYC-adjacent flows (trade-in ID capture, CAT-009) are configurable per jurisdiction and stored under the same PII protection regime. |
| NFR-CMP-005 | Retention: transactional and audit records ≥ 7 years (or longer per jurisdiction); customer PII minimized and separable from transactional skeleton for erasure requests. |

### 10.5 Scalability & Operability (NFR-OPS)

| ID | Requirement |
|---|---|
| NFR-OPS-001 | Design targets at 24 months: 10,000 tenants, 40,000 locations, 3,000 POS transactions/minute platform-wide peak, 500M ledger entries/year, with horizontal scaling paths identified for each hot path. |
| NFR-OPS-002 | Full observability: per-tenant request tracing, sync-queue depth metrics, connector health, POS crash reporting; on-call runbooks for the top 10 failure modes before GA. |
| NFR-OPS-003 | Localization-ready: all UI strings externalized; RTL support; multi-currency display (single operating currency per tenant at v1.0; multi-currency B2B at v2.0); local date/number formats. English + 2 launch-market languages at GA. |
| NFR-OPS-004 | Accessibility: Web Admin and storefront WCAG 2.1 AA; POS touch targets ≥ 44 px, full keyboard operability for scanning-heavy workflows. |

---

## Appendix A — Traceability conventions

- Requirement IDs are permanent; superseded requirements are marked `[SUPERSEDED by X]`, never renumbered.
- Engineering tickets, test cases, and release notes MUST reference requirement IDs.
- Acceptance criteria for the highest-value flows live in [02 — Personas & User Stories](./02-personas-and-user-stories.md) and are the contract for "done."

# Voltix Commerce OS

## Product Requirements Document v2.0

**Status:** Draft for approval · **Date:** 12 August 2026 · **Supersedes:** the reconstructed PRD in §7 of *Voltix Commerce — Product & Technical Master Document* (audit, commit `dcd7947`, 9 Aug 2026)

**Author:** Product · **Owner:** SEMUL MIAH ELECTRONICS TRADING L.L.C · **Reviewers:** Engineering, Design, Finance

* * *

## 0\. How to read this document

The audit that preceded this PRD was written *backwards from code*. This document is written *forwards from intent*. Where the two disagree, this document wins — but every claim about the existing system is carried over from the audit with its original label so you can tell reconstruction from research from decision.

| Label | Meaning |
| --- | --- |
| **AUDIT** | Fact about the software as it exists today, verified in the 9 Aug 2026 audit |
| **RESEARCH** | Established from external sources during PRD research (12 Aug 2026); sources listed in §14 |
| **DECISION** | A product decision made in this document. It did not exist before |
| **OPEN** | Genuinely undetermined. Listed in §12. Do not guess |

Three things changed between the audit and this document, and they change everything downstream:

1. **The product is not an online store.** It is a retail operating system whose online store is one of four selling surfaces. The audit measured an e\-commerce platform against e\-commerce goals and found it late\-prototype. Measured against the real intent — run the shop — it is roughly one third built, and the missing third is the part the owner touches every day.
2. **The differentiator is serialised stock, not AI.** The audit correctly flagged that `serial_units` exists, is promised on the homepage, and is never written to. **RESEARCH** confirms this is also the single widest gap in the competitive market (§3). The unused table is not debt; it is the product.
3. **There is a dated compliance forcing function.** **RESEARCH:** UAE e\-invoicing becomes mandatory for businesses under AED 50m revenue on **1 July 2027**, with an Accredited Service Provider appointed by **31 March 2027**. That is a fixed external deadline roughly 11 months out that will force every UAE retailer to change software. It is both a requirement and the best commercial wedge this product has.

* * *

## 1\. Executive summary

Voltix Commerce OS is a single\-database retail operating system for UAE electronics and mobile\-phone retailers. One catalogue, one stock ledger, one customer record and one tax engine serve four surfaces: a **point of sale** at the shop counter, a **back office** for the owner, an **online storefront**, and **marketplace channels** (noon, Amazon.ae).

The wedge is narrow and specific: **IMEI\-native stock and UAE\-tax\-native invoicing in one product, at a price a single\-branch shop will pay.** **RESEARCH** shows the market splits cleanly in two and nobody bridges it — the systems with real per\-unit serial traceability (CellStore, CellSmart, Odoo, GOFRUGAL) have no UAE VAT/TRN invoicing, no Arabic, no AED; the systems with UAE tax compliance (Zoho Books UAE, Wafeq, TallyPrime) have no counter with serialised stock. The local UAE POS vendors that advertise both are quote\-only, storefront\-less and marketplace\-less.

The engineering foundations to build this on are unusually strong and are being kept, not rewritten. **AUDIT:** money is integer minor units throughout; multi\-tenancy is enforced by Postgres row\-level security rather than by convention; order status is derived from a ledger; `stock_movements` is append\-only with UPDATE/DELETE revoked; auth is Argon2id \+ TOTP \+ revocable server\-side sessions; 273 tests pass including adversarial RLS and 8\-way concurrency tests. That is the platform this PRD builds on top of.

**What v1.0 means.** A shop manager with no developer can add a product, receive stock by scanning IMEIs, sell it at the counter or online, take cash, card or Tabby, print a compliant VAT receipt, ship it with a tracking number, take it back under warranty against its IMEI, and see at the end of the month what was actually sold and what it earned — with the same stock pool visible on noon and Amazon.ae. Nothing in this document matters more than that sentence.

* * *

## 2\. Problem statement

A UAE electronics retailer with one to three branches operates today across four disconnected systems: a spreadsheet for stock, WhatsApp for orders, a standalone card terminal for payment, and a marketplace seller portal typed into by hand. **AUDIT:** the current Voltix build replaced none of them — its admin cannot create a product, so the catalogue can only be populated by `npm run db:seed` or direct SQL.

The cost is three\-fold and each part scales faster than revenue:

**Stock is unknowable.** With no counter system and no serial capture, the shop cannot answer "do we have this in stock", "which IMEI did we sell to this customer", or "is this handset under warranty" without physical search and memory. **AUDIT:** stock levels exist in the database, but no stock adjustment or stocktake path exists at all, so any drift between the system and the shelf is permanent.

**Money leaks at the edges.** **RESEARCH:** 71.2% of UAE retailers use cash on delivery; refused COD deliveries carry a round\-trip freight charge and returned stock. **AUDIT:** Voltix scores COD risk and displays it, but the advance\-payment gate that the configuration defines is *read and never enforced anywhere in checkout*. The single stated business problem is unmitigated in code.

**Compliance is manual and about to get harder.** **RESEARCH:** a retail sale to a consumer needs a simplified tax invoice; a sale to a VAT\-registered business above AED 10,000 needs a full tax invoice with the buyer's TRN; and sales of mobile phones, computers and tablets *between two UAE VAT registrants for resale* fall under the domestic reverse charge (Cabinet Decision 91/2023) requiring a written declaration from the buyer, zero VAT charged, and a reverse\-charge statement on the invoice. **AUDIT:** Voltix generates no invoice of any kind, while the contact page promises TRN tax invoices.

**Who experiences this.** One owner, two to four staff, several hundred transactions a month across counter and online, with a catalogue in the low thousands of SKUs of which a few hundred are serialised handsets.

**Cost of not solving it.** The shop keeps paying the three costs above. The software keeps being a well\-engineered storefront that the business cannot run on. And the 1 July 2027 e\-invoicing deadline arrives with the shop on a spreadsheet.

* * *

## 3\. Market and competitive context

**RESEARCH.** Full sources in §14. This section is the competitive analysis the audit correctly flagged as never performed.

### 3\.1 Where the market splits

| Category | Products | Serial/IMEI as real stock records | UAE VAT \+ TRN invoicing | POS at a counter | Online store | Marketplace sync |
| --- | --- | --- | --- | --- | --- | --- |
| Global unified | Shopify \+ POS Pro, Lightspeed X\-Series | No / weak | No | Yes | Yes | Add\-on |
| Global open ERP | Odoo | **Yes, native** | Third\-party module | Yes | Yes | No |
| UAE accounting | Zoho Books UAE, Wafeq, TallyPrime | Partial (Zoho Premium) | **Yes** | No | No | No |
| Mobile\-shop specific | CellStore, CellSmart POS, RepairDesk, GOFRUGAL | **Yes** | No | Yes | No | No |
| UAE local POS | POS GCC, OptaPOS, Bizmodo | Advertised | Advertised | Yes | No | No |
| Free baseline | Loyverse | No | No | Yes | No | No |

**The vacant square is the intersection of columns three and four.** No product found in research does audit\-grade per\-unit IMEI traceability *and* UAE tax\-native invoicing *and* counter selling in one system.

### 3\.2 Specific competitor weaknesses that are exploitable

**Shopify \+ POS Pro** — **RESEARCH:** serialised stock is not native and is served only by third\-party apps that attach a serial to an order line rather than making each unit a stock record; Shopify card readers are not sold in the UAE, so a UAE shop runs an unintegrated terminal beside the till anyway; Shopify Payments in the UAE is early\-access only; RTL support is limited and theme\-dependent. List price Basic $39/mo \+ POS Pro $89/mo per location \\\\\\\= \\\\\\\*\\\\\\\*$128/mo (\~AED 470)\*\* with none of the above solved.

**Lightspeed X\-Series** — **RESEARCH:** serial numbers are a pre\-recorded list with a "Sold On" column, cashiers can free\-type unmatched serials, and deletion is irreversible. This will not survive a warranty dispute or an audit. Multi\-location pricing is quote\-only.

**Odoo** — the real threat. **RESEARCH:** native lot/serial tracking enforced through POS across purchase → stock → sale → return on one database, plus a deep Dubai partner channel. Its gap is UAE e\-invoicing (third\-party modules only), no noon/Amazon.ae connectors, and implementation cost that dwarfs the $24.90/user/month licence. **This is the competitor to watch; a Dubai partner shipping a PINT AE module plus a noon connector closes most of our gap.**

**Square** — **RESEARCH:** not available in the UAE. Exclude.

**Loyverse** — free, therefore the true "do nothing" baseline in small UAE shops. No serials, no online store, no VAT filing.

### 3\.3 Pricing envelope

**RESEARCH**, list prices checked 12 Aug 2026: Zoho Books UAE AED 69–349/mo · Wafeq AED 69–249/mo · TallyPrime Silver AED 2,340 perpetual · Salla Plus/Pro SAR 990–2,990/yr (≈AED 81–244/mo, POS included) · Zid Launch/Growth SAR 99–299/mo · Shopify Basic \+ POS Pro ≈AED 470/mo · CellStore $39/mo/store · RepairDesk $79–149/store/mo.

**DECISION — target price envelope: AED 150–400 per store per month.** Above roughly AED 500 the product competes with Shopify \+ POS Pro and loses on brand; above roughly AED 1,000 it competes with an Odoo partner build and loses on capability breadth.

### 3\.4 What is *not* a differentiator

Do not build strategy on these. **RESEARCH:** Salla and Zid are Arabic\-native, already serve the UAE, include POS, and will out\-execute us on storefront — **do not compete on the online store as such**. Basic VAT/TRN invoicing is commoditised at AED 69/mo. Multi\-location inventory is table stakes across every product in §3.1. Repair ticketing is mature and cheap at RepairDesk/RepairShopr prices. Payment rates cannot be beaten; be gateway\-agnostic and treat payments as partnership, not margin.

### 3\.5 Market sizing

**OPEN.** No official published count of UAE electronics/mobile retail outlets was found from FCSC, Dubai Statistics Centre, DET or Dubai Chambers. Available proxies are weak: 557,000 SMEs in the UAE at end\-2022 (official, stale); 151,875 SMEs in Dubai of which 47% trading (Dubai SME, 2017–18 data); 1,666 mobile phone shops listed in a Dubai directory (scrape, order\-of\-magnitude only). **No TAM figure is asserted in this document.** The audit's criticism that opportunity sizing was skipped stands and is only partially closed here — the honest position is that the beachhead is one shop, and the second customer is a hypothesis to be tested, not a number to be projected.

* * *

## 4\. Product strategy

### 4\.1 One platform, four surfaces

**DECISION.** Voltix is one application with one database and four rendered surfaces, not four products that integrate.

```
                    ┌─────────────────────────────┐
                    │      ONE DOMAIN CORE        │
                    │  catalogue · stock ledger   │
                    │  serial units · orders      │
                    │  tax engine · customers     │
                    └──────────────┬──────────────┘
        ┌──────────────┬───────────┼───────────┬──────────────┐
        │              │           │           │              │
   ┌────▼────┐   ┌─────▼─────┐ ┌───▼────┐ ┌────▼─────┐  ┌─────▼─────┐
   │   POS   │   │Back office│ │Storefr.│ │ Channels │  │  Public   │
   │ counter │   │  owner    │ │ online │ │noon·AMZN │  │    API    │
   └─────────┘   └───────────┘ └────────┘ └──────────┘  └───────────┘
```

The test of "one platform" is behavioural, not architectural: **a unit sold at the counter must disappear from the storefront and from noon without a human doing anything, and the same IMEI must never be sellable twice.** Every requirement in §7 is subordinate to that.

### 4\.2 Positioning

**For** a UAE electronics or mobile retailer with one to three branches,
**who** runs stock on memory and spreadsheets and cannot answer where a handset came from or where it went,
**Voltix Commerce OS** is a retail operating system
**that** tracks every serialised unit from purchase order to warranty claim, sells it at the counter or on four channels from one stock pool, and issues a UAE\-compliant tax invoice for every sale,
**unlike** Shopify or Loyverse, which treat a serial number as a note on an order line and a tax invoice as a PDF template,
**and unlike** Zoho or Tally, which get the tax right but have no counter.

### 4\.3 The AI question — resolved

**AUDIT:** the repository is named `AI-powered-e-commerce-platform` and ships an `@voltix/ai` package with an Anthropic client, a model registry and a task catalogue; no language model is invoked anywhere in the running product; the apps import four pure functions — `forecastDemand`, `recommendReplenishment`, `classifyQuery`, `reciprocalRankFusion`. What ships is statistical (Croston's method, Holt's smoothing), heuristic (rule\-based risk scoring) and lexical (Postgres `tsvector`).

**DECISION.** Close the gap in the honest direction. The product is renamed and repositioned around **correctness and traceability**, not AI. The forecasting stays and keeps its accurate name — statistical demand forecasting. The Anthropic client is deleted as dead code. `product_embeddings` and the pgvector dependency are removed until there is evidence of need.

**DECISION.** One AI capability is admitted to the roadmap, deferred to Phase 4, and it is the one with real value: **catalogue extraction from supplier price sheets and invoices** — turning a PDF or spreadsheet from a Deira distributor into draft products with attributes. It is deferred because it is worthless until product CRUD exists to receive its output. No LLM feature is positioned or marketed before it ships.

### 4\.4 Business model

**DECISION** (from the scope answers, 12 Aug 2026): build for SEMUL MIAH ELECTRONICS TRADING L.L.C as tenant zero, keep the multi\-tenant architecture, do not build onboarding or billing in v1. **AUDIT:** multi\-tenancy is enforced by RLS with `FORCE` and an `admin_bypass` policy and is adversarially tested — that property is preserved, it is cheap to keep and expensive to retrofit. Self\-serve signup, plan limits, billing and support tooling are explicit non\-goals for v1 (§6.2) and become P2 once a second merchant is a real conversation, not a hypothesis.

* * *

## 5\. Users

**AUDIT:** all personas in the previous document were inferred from the RBAC model. No merchant was ever interviewed. That is still true. These personas are refined from the shop's own operation and from research into UAE retail practice; they remain hypotheses and are marked accordingly.

### 5\.1 Primary — Amal, owner\-manager

|  |  |
| --- | --- |
| **Role** | Owns a 1–3 branch electronics shop in Dubai or Sharjah; maps to the `owner` role |
| **Context** | On the shop floor with a phone; at a laptop after closing; on WhatsApp with distributors mid\-morning |
| **Goals** | Know what needs attention today · never run out of a fast mover · never lose money on a refused COD · know the real margin on a handset after the distributor's price moved |
| **Pain points** | Discovers a stockout when a customer asks · capital frozen in dead accessories · retypes WhatsApp orders · cannot prove which IMEI went to which customer when a warranty claim arrives |
| **Technical comfort** | Confident with WhatsApp, Excel, Instagram. Not with SQL, CSV imports or webhooks |
| **Non\-negotiables** | Works on a phone · Arabic where it matters · prices include VAT because that is the law |
| **Security** | **AUDIT:** MFA is mandatory for this role, enforced at session creation in `roleRequiresMfa()`. This is now a stated requirement, not an implicit decision |

### 5\.2 Primary — Kabir, counter cashier *(new persona; the audit had none)*

|  |  |
| --- | --- |
| **Role** | Serves walk\-in customers at the till; maps to a new `cashier` role |
| **Context** | Standing, at a 15" touchscreen or a laptop, customer waiting, sometimes a queue of three |
| **Goals** | Ring a sale in under 60 seconds · find a product by scanning it or typing three characters · take cash and give correct change · print the receipt |
| **Pain points** | Cannot leave the sale screen to look something up · needs to hold a sale while a customer fetches their card · cannot be trusted with cost prices or refunds |
| **Technical comfort** | Low. Trained in one shift. May be more comfortable in Arabic than English |
| **Non\-negotiables** | Never blocks on the network · scanner input always lands in the right place · every destructive action is one confirmation away, not zero |

### 5\.3 Secondary — Rashid, fulfilment and support staff

**AUDIT:** maps to `staff`; the `customer:read_pii` and `finance:read` permission separations exist specifically for this persona, are enforced in the UI, and are a genuinely good design decision that is preserved unchanged. Goals: clear the queue, find an order from a phone number, one\-click state changes. Must not see costs, margins or be able to issue refunds.

### 5\.4 Secondary — Fatima, the online shopper

**AUDIT:** guest checkout is the default and there is no customer account system; order tracking is two\-factor (order number \+ phone). Both are correct for this market and both are now stated requirements rather than implicit decisions. Needs: real stock counts, honest delivery dates, COD or Tabby, VAT\-inclusive prices, no postcode field, Arabic.

### 5\.5 Secondary — Yusuf, the business buyer *(new persona)*

**AUDIT** flagged B2B as an unknown: the contact page promises TRN tax invoices while no B2B pricing, quotes or credit terms exist. **DECISION: B2B is in scope, minimally, because the tax law forces it.** Yusuf buys five handsets for his company or for resale. **RESEARCH:** if he is a VAT registrant buying for resale, Cabinet Decision 91/2023 makes the sale reverse\-charged — the shop charges no VAT, must obtain and retain his written declaration, and must print the reverse\-charge statement. Getting this wrong leaves the shop liable for the VAT. He needs: a full tax invoice with his TRN, VAT\-exclusive pricing where RCM applies, and a PDF he can hand to his accountant.

### 5\.6 Not served — explicit

Consumers building a relationship with an account (guest\-only by design) · marketplace/multi\-vendor sellers · warehouse operations with bin and pick paths · anyone needing a native mobile app · repair\-shop workflow beyond a simple job ticket (§6.2).

* * *

## 6\. Goals and non\-goals

### 6\.1 Goals

| \# | Goal | How we know it succeeded | Type |
| --- | --- | --- | --- |
| G1 | The shop runs its whole day in Voltix — counter, online, stock, returns | Zero sales recorded outside Voltix in a 30\-day window | User |
| G2 | Every serialised unit is traceable from PO to warranty claim | 100% of handsets sold have an IMEI recorded and resolvable to a supplier and an invoice | User |
| G3 | Stock is trustworthy | Stocktake variance under 2% of units counted, measured monthly | User |
| G4 | Every sale produces a compliant tax document | 100% of sales produce a VAT receipt; 100% of B2B sales over AED 10,000 produce a full tax invoice with buyer TRN | Business |
| G5 | COD losses fall | COD refusal rate under 8%, measured on delivered vs refused | Business |
| G6 | One stock pool, four channels, no overselling | Fewer than 1 oversell per 1,000 units sold across all channels | Business |
| G7 | The business is measurable at all | Every goal above has live instrumentation. **AUDIT:** today none do | Business |

**G7 is the meta\-goal.** The audit's sharpest finding was that every business goal was unmeasurable because no analytics existed. A goal without instrumentation is a wish. No feature in §7 is complete until its events fire.

### 6\.2 Non\-goals for v1.0

| Non\-goal | Why |
| --- | --- |
| Customer accounts and logins | Guest checkout plus two\-factor tracking covers the market's behaviour; accounts add PII risk and support burden for little gain |
| Self\-serve tenant onboarding, billing, plan limits | Premature. One tenant. Revisit when a second merchant is a conversation, not a hypothesis |
| Full repair\-shop workflow | **RESEARCH:** RepairDesk and RepairShopr are mature at $59–149/store/mo. A minimal job ticket (§7.10) covers warranty intake; anything deeper is a losing fight |
| Warehouse management — bins, pick paths, wave picking | The merchant has a stockroom, not a distribution centre |
| Native mobile apps | Responsive web plus a well\-built POS surface is sufficient at this scale |
| Marketplace listing *creation* on noon/Amazon | Scope locked to inventory and order sync both directions. Listing creation is a different, larger problem |
| Own payment processing | Regulated. Adapters to licensed gateways are correct |
| Becoming an Accredited Service Provider ourselves | **RESEARCH:** ASP accreditation requires Peppol certification, ISO 27001, ISO 22301 and professional indemnity insurance. Integrate with one of the 40\+ accredited providers instead. Revisit only if a real ASP business case appears |
| Semantic search and embeddings | **AUDIT:** `product_embeddings` has zero rows; lexical search is adequate. Cost with no evidence of need |
| Real\-time chat support | WhatsApp already is the channel |

* * *

## 7\. Requirements

Priority uses MoSCoW. **P0 \= v1.0 cannot ship without it.** Every P0 requirement carries acceptance criteria. Requirement IDs are used by the TRD, the wireframe document and the traceability matrix in §13.

### 7\.1 E1 — Catalogue and product master

**AUDIT:** the most serious product gap. A commerce admin that cannot create a product is not a commerce admin. The catalogue can currently only be populated by `npm run db:seed` or direct SQL.

| ID | Requirement | Priority |
| --- | --- | --- |
| R1.1 | Create, edit, duplicate and archive a product with title, description, category, brand, images, and per\-emirate publication status | **Must** |
| R1.2 | Variant matrix by option (colour, storage, grade) with per\-variant SKU, barcode, cost, price and stock tracking mode | **Must** |
| R1.3 | Mark a product as **serialised** — every unit of it must carry an IMEI or serial before it can be sold | **Must** |
| R1.4 | Bilingual product content: title, description and attributes in English and Arabic, with a fallback rule | **Should** |
| R1.5 | Draft → published lifecycle; a product cannot publish without price \> 0 and at least one variant with a stock mode set | **Must** |
| R1.6 | Bulk edit price and stock for a filtered selection | **Should** |
| R1.7 | CSV import for catalogue seeding with a dry\-run diff before commit | **Should** |
| R1.8 | Product\-level warranty terms (months, provider: manufacturer / shop / none) shown at POS and on the receipt | **Must** |
| R1.9 | Extract draft products from a supplier price sheet (PDF/XLSX) | **Won't (Phase 4)** |

**Acceptance — R1.1 / R1.5**

```
Given   I am signed in as owner or manager with product:write
When    I create a product with a title, category, brand and one variant with SKU and price
Then    it saves as `draft`, is not visible on any selling surface,
        and appears in the admin product list immediately
And     publishing requires a price > 0 and at least one variant with a stock mode configured
And     archiving a product with stock on hand warns and requires confirmation, but never deletes history
```

**Acceptance — R1.3**

```
Given   a product is marked serialised
When    a cashier or an online order attempts to sell a unit of it
Then    the sale cannot complete until a specific serial unit is bound to the order line
And     the bound unit's state moves from `in_stock` to `sold` inside the same transaction
```

### 7\.2 E2 — Serialised inventory (IMEI) — *the differentiator*

**AUDIT:** `serial_units` exists in the schema, has no writer, and the homepage promises "the IMEI recorded against your order". That is a marketing claim the software does not honour — a product and legal risk, not merely missing scope. This epic closes it and makes it the product's spine.

| ID | Requirement | Priority |
| --- | --- | --- |
| R2.1 | Every serialised unit is a stock record with a lifecycle: `expected → in_stock → reserved → sold → returned → rma → written_off` | **Must** |
| R2.2 | Receive stock by scanning each IMEI against a purchase order line; the line is not complete until counts match | **Must** |
| R2.3 | Validate IMEI format on entry: 15 digits, Luhn check digit. **RESEARCH:** IMEI \= TAC(8) \+ serial(6) \+ Luhn(1); validating the check digit is the cheapest defence against mis\-scans and also disambiguates which barcode on a box label is the IMEI | **Must** |
| R2.4 | Handle multi\-barcode box labels — IMEI1, IMEI2 for dual\-SIM, plus S/N and part number — without silently taking the first read | **Must** |
| R2.5 | Bind a specific unit to an order line at the moment of sale (counter or online pick) | **Must** |
| R2.6 | Look up any IMEI and see its full history: supplier, PO, cost, receipt date, sale date, customer, invoice, warranty expiry, returns | **Must** |
| R2.7 | An IMEI can never be in `sold` state twice. Enforced by a database constraint, not application logic | **Must** |
| R2.8 | Print the IMEI on the receipt and the tax invoice | **Must** |
| R2.9 | Warranty status resolved from the unit, not the receipt — a customer with no receipt but the handset can be served | **Must** |
| R2.10 | Bulk IMEI import (CSV) for opening\-stock migration | **Should** |
| R2.11 | Flag units received whose IMEI was already seen in this tenant — the cheapest duplicate/grey\-stock detector available | **Should** |

**Acceptance — R2.6 / R2.9**

```
Given   a handset was received on PO-1042 from a supplier at a recorded cost
And     sold on 3 March 2026 on invoice INV-2026-00871 with a 12-month shop warranty
When    a staff member scans or types that IMEI into the unit lookup
Then    the full chain is shown: supplier, PO, cost (hidden unless finance:read), receipt date,
        sale date, invoice link, customer, warranty expiry date and remaining days,
        and any prior return or RMA against that unit
And     the lookup works with no receipt, no order number and no customer name
```

**Acceptance — R2.7**

```
Given   IMEI 356938035643809 is bound to order line A and its unit state is `sold`
When    any surface — POS, storefront, marketplace order ingest — attempts to bind it to order line B
Then    the write is rejected at the database level with a unique-constraint violation
And     the calling surface shows "this unit is already sold" naming the earlier invoice
```

### 7\.3 E3 — Point of sale

**AUDIT:** no POS surface exists. Warehouses are modelled. This is the largest single addition in this PRD.

| ID | Requirement | Priority |
| --- | --- | --- |
| R3.1 | Ring a sale: search or scan to add lines, adjust quantity, apply a line or cart discount within permission, take payment, print | **Must** |
| R3.2 | Scanner\-first input — a global key listener detects scanner input by inter\-keystroke timing and terminator, so a scan lands correctly regardless of focus. **RESEARCH:** "the cashier scanned into the wrong box" is the number one usability failure in web POS | **Must** |
| R3.3 | Serialised line flow: adding a serialised product prompts for the IMEI scan and binds that unit | **Must** |
| R3.4 | Tenders: cash (with change calculation and denomination helper), card (external terminal — see R3.5), Tabby, store credit, split across two tenders | **Must** |
| R3.5 | Card is recorded as an **external tender** in v1: the cashier runs the standalone terminal and enters the approval code. **RESEARCH:** no UAE acquirer publishes a terminal API; Network International confirms wired, cloud and app\-to\-app integrations exist but all are contract\-gated behind an NDA. Do not block launch on terminal integration | **Must** |
| R3.6 | Semi\-integrated terminal support behind a pluggable driver interface, one driver per acquirer, added once a merchant contract and spec exist | **Should** |
| R3.7 | Park and resume a sale (customer fetching a card, second customer served meanwhile) | **Must** |
| R3.8 | Print an 80mm ESC/POS receipt with the correct tax document type (§7.7), IMEI lines and warranty terms, bilingual AR/EN | **Must** |
| R3.9 | Open the cash drawer via the printer's drawer\-kick command; drawer opens on cash tender and on a permissioned no\-sale | **Must** |
| R3.10 | Shift management: open with a float, blind cash count at close, variance recorded and attributed to the cashier | **Must** |
| R3.11 | Offline mode — see §7.3.1 | **Must** |
| R3.12 | Returns and exchanges at the counter against an IMEI or a receipt, within permission | **Must** |
| R3.13 | Customer lookup by phone; attach to sale; capture TRN for a business buyer | **Must** |
| R3.14 | Tabby in\-store via payment link or QR. **RESEARCH:** Tabby documents `POST /api/v2/checkout` then `send_hpp_link` with SMS delivery and a documented QR fallback; the POS needs an async pending\-payment state with cancel and timeout | **Should** |
| R3.15 | Price override with a reason code, permissioned, always audited | **Should** |
| R3.16 | Customer\-facing display showing the running total and the Tabby/Tamara QR | **Could** |

#### 7\.3.1 Offline behaviour — R3.11

**RESEARCH.** The commercial consensus across Shopify POS, Square, Loyverse and Odoo POS is consistent, and Voltix adopts it with one deliberate divergence.

| Offline | Voltix behaviour | Rationale |
| --- | --- | --- |
| Cash sale | **Allowed** | Cash needs no authorisation |
| Card via external terminal | **Allowed**, recorded with the approval code | The terminal has its own connectivity; the POS is only recording the outcome |
| **Stored\-and\-forwarded card authorisation** | **Never** | **DECISION, diverging from Square.** A stored offline card auth is an unsecured loan from merchant to customer. On an AED 4,000 handset the merchant carries all the risk of an expired or declined payment with no decline notification. Not offered |
| Tabby / BNPL | **Blocked** | Requires an out\-of\-band authorisation the POS cannot fake |
| Refunds and exchanges | **Blocked** | Needs authoritative server state; a refund against an unknown order is fraud surface |
| Serialised sale of a specific IMEI | **Allowed with a hard local claim** | The unit is pinned to this till at scan time; duplicate claims across tills surface loudly on sync as a reconciliation exception |
| Sign\-out / shift close | **Blocked while unsynced sales exist** | Loyverse's rule, and the correct one — it is the only thing standing between a queued sale and permanent data loss |
| Price and stock lookups | **Allowed from local cache**, visibly marked stale | Better a stale number with a warning than a spinner |

Queued sales persist to IndexedDB — never memory, never `localStorage`. Each carries a client\-generated UUID and a monotonic per\-till counter; the server dedupes on replay. A visible unsynced\-count badge is always on screen when the count is non\-zero.

**Acceptance — R3.11**

```
Given   the internet connection drops mid-shift
When    the cashier rings a cash sale for a serialised handset and scans its IMEI
Then    the sale completes, the receipt prints, the drawer opens,
        the unit is locally claimed to this till, and an "unsynced: 1" badge appears
And     attempting a refund shows "needs connection" rather than failing silently
And     attempting to close the shift is blocked while the badge is non-zero
When    connectivity returns
Then    the sale posts idempotently, the badge clears,
        and any duplicate IMEI claim from another till raises a reconciliation exception
        naming both tills, both cashiers and both timestamps
```

**Acceptance — R3.1 (speed)**

```
Given   a cashier at an opened shift
When    they scan one barcoded item and take exact cash
Then    the sale is complete and the receipt is printing within 15 seconds of the first scan
And     no step requires the mouse
```

### 7\.4 E4 — Stock and multi\-location

**AUDIT:** stock levels, warehouses and reservations are modelled and `stock_movements` is append\-only with UPDATE/DELETE revoked — an excellent foundation. But there is no stock adjustment path at all, so drift is permanent, and the audit rated this the highest\-probability failure ("will happen in week one").

| ID | Requirement | Priority |
| --- | --- | --- |
| R4.1 | Stock adjustment with a mandatory reason code (damage, theft, found, correction, sample, write\-off), permissioned and audited | **Must** |
| R4.2 | Stocktake: create a count session scoped to a location or category, count by scanning, review the variance, post it as adjustments in one transaction | **Must** |
| R4.3 | Multi\-location stock with transfers between branches, in\-transit state, and receive\-confirmation at the destination | **Must** |
| R4.4 | Stock movement history per variant and per serial unit, queryable and exportable | **Must** |
| R4.5 | Reorder point and days\-of\-cover per variant, from the existing statistical forecaster | **Must** (exists — **AUDIT**) |
| R4.6 | Low\-stock and dead\-stock alerts on the dashboard and by notification | **Should** |
| R4.7 | Read persisted forecasts rather than recomputing per request. **AUDIT:** debt item T\-09 — the admin currently recomputes a 90\-day history scan per variant per page load | **Should** |
| R4.8 | Channel stock allocation: buffer and per\-channel cap — see §7.8 | **Must** |

**Acceptance — R4.2**

```
Given   a stocktake session open for the Sharjah branch
When    staff scan 240 units and the session is submitted for review
Then    a variance report shows every SKU where counted ≠ expected, with the value of the variance
And     posting the count writes one adjustment per varying SKU inside a single transaction,
        each carrying the session id, the counter's user id and the reason `stocktake`
And     serialised units counted that the system believed were sold are raised as exceptions,
        not silently reinstated
```

### 7\.5 E5 — Orders and fulfilment

**AUDIT:** the online purchase flow is the strongest part of the existing product and was verified end to end in production. Idempotency before work, pricing before authorisation, locks before money, notification enqueued in the same transaction as the order. It is preserved unchanged. What is missing is everything after the order is confirmed.

| ID | Requirement | Priority |
| --- | --- | --- |
| R5.1 | Unified order list across all channels — POS, storefront, noon, Amazon — with channel as a filter, not a separate screen | **Must** |
| R5.2 | Shipments: create a shipment, allocate order lines and serial units to it, record carrier and tracking number, mark dispatched. **AUDIT:** orders currently jump `confirmed → fulfilled` with no tracking number | **Must** |
| R5.3 | Tracking number surfaced to the customer on the tracking page and in the confirmation notification | **Must** |
| R5.4 | COD collection recorded at delivery with the amount collected and any discrepancy | **Must** (exists — **AUDIT**) |
| R5.5 | **Enforce** the COD advance\-payment gate. **AUDIT:** `COD_MAX_ORDER_AMOUNT` and the advance\-payment config are read and never enforced anywhere in checkout. Above the threshold, or above a risk score, COD requires a partial advance paid by card or Tabby before the order confirms | **Must** |
| R5.6 | RTO (return to origin) as a first\-class flow: failed COD delivery returns stock to sellable or to inspection, and records the freight cost against the order | **Must** |
| R5.7 | Order timeline showing every state change with actor and timestamp | **Must** (exists — **AUDIT**) |
| R5.8 | Split shipments and partial fulfilment | **Should** |
| R5.9 | Click and collect — buy online, pick up at a branch, released against a code at the POS | **Could** |

**Acceptance — R5.5**

```
Given   the COD advance threshold is AED 1,500 and a cart totals AED 4,299
When    the shopper selects cash on delivery
Then    checkout requires an advance payment of the configured amount or percentage
        by card or Tabby before the order can be placed
And     the order records the advance as a separate transaction against the same order
And     a customer whose COD risk score exceeds the configured ceiling
        is not offered COD at all, with honest copy explaining that card or Tabby is required
```

### 7\.6 E6 — Payments and tenders

**AUDIT:** payments sit behind a port with four adapters, retry and a circuit breaker — a strong design. But **no webhook route exists in either application**. The adapters implement `verifyWebhook` and nothing routes to it. Consequence: card and BNPL payments cannot reach a terminal state, because Stripe, N\-Genius and Tabby all confirm asynchronously. **Only COD works end to end today.**

| ID | Requirement | Priority |
| --- | --- | --- |
| R6.1 | Inbound webhook routes per provider with signature verification, replay protection and idempotent handling | **Must** |
| R6.2 | Payment reconciliation job continues as the safety net, and now *repairs* rather than only flagging | **Must** |
| R6.3 | Tender types: cash, card (external), card (gateway), Tabby, store credit, bank transfer, mixed | **Must** |
| R6.4 | Refunds to original tender where possible; store credit where not; refund never exceeds capture. **AUDIT:** enforced in domain and by a DB CHECK — preserved | **Must** |
| R6.5 | Gateway sandbox verification before enabling any provider in production. **AUDIT:** the Tabby and N\-Genius adapters have never been run against a live or sandbox account | **Must** |
| R6.6 | Daily settlement reconciliation: gateway payouts vs recorded transactions vs cash counted | **Should** |

**Acceptance — R6.1**

```
Given   a card payment intent is created and the shopper completes 3-D Secure at the gateway
When    the gateway posts its webhook to /api/webhooks/{provider}
Then    the signature is verified against the provider secret before the body is parsed
And     a replayed or duplicate delivery is acknowledged 200 without re-applying the effect
And     the order reaches a terminal paid state and the confirmation is enqueued
And     an unverifiable signature is rejected 401 and recorded for alerting
```

### 7\.7 E7 — Tax, invoicing and compliance

**RESEARCH, verified 12 Aug 2026 against primary sources.** This epic is where a UAE\-specific product earns its price, and it is entirely absent from the current build.

| ID | Requirement | Priority |
| --- | --- | --- |
| R7.1 | **Simplified tax invoice** for consumer sales: the words "Tax Invoice", supplier name, address **and supplier TRN**, date of issue, description of goods, total consideration and total VAT charged | **Must** |
| R7.2 | **Full tax invoice** when the buyer is VAT\-registered and consideration exceeds AED 10,000, or on request: adds buyer name, address and TRN, unique sequential number, date of supply if different, per\-line unit price, quantity, VAT rate and amount, discounts, gross amount payable in AED, and a reverse\-charge statement where applicable | **Must** |
| R7.3 | **Domestic reverse charge for electronic devices (CD 91/2023, in force 30 Oct 2023).** Where buyer and seller are both UAE registrants and the buyer declares in writing both (a) intent to resell or to use the devices to produce or manufacture such devices, and (b) that it is registered with the FTA: charge no VAT, apply the RCM tax code, print the reverse\-charge statement, capture and retain the declaration | **Must** |
| R7.3a | **The supplier must verify the buyer's registration** by a means approved by the FTA — retaining the declaration alone is not sufficient. RCM does **not** apply where the supply is zero\-rated (e.g. export under Art. 45) or where the buyer is purchasing for its own business use rather than resale | **Must** |
| R7.4 | Price display: **consumer\-facing prices must be VAT\-inclusive, full stop** — this cannot be cured by a "prices exclude VAT" label. VAT\-exclusive display is permitted only within the Art. 27 exceptions: exports, supplies to VAT\-registered recipients, and the Art. 48 concerned\-goods and hydrocarbon cases | **Must** |
| R7.5 | Gapless sequential invoice numbering per document type per tenant. **AUDIT:** the existing `counters` table rather than Postgres sequences is exactly right — `nextval` does not roll back and tax authorities require gapless. Preserved and extended to invoices | **Must** |
| R7.6 | **Emirate captured on every sales and purchase line.** Default rule: the emirate of the **fixed establishment most closely connected to the supply** — for retail, the branch making the sale, *not* the customer's address. Needed for the FTA Audit File and VAT return Box 1 (1a–1g), and painful to backfill | **Must** |
| R7.7 | Bilingual AR/EN invoices, receipts, warranty terms and return policy. **RESEARCH:** Arabic is mandatory on a consumer invoice under **Federal Decree\-Law 15/2020 Art. 8(4)** — "the Invoice shall be in Arabic, and the Supplier may add any other language" — reinforced by Cabinet Decision 66/2023, whose Annex (2) carries a penalty for failing to issue in Arabic. **An English\-only till receipt is non\-compliant; bilingual is fine** | **Must** |
| R7.8 | Credit notes with their own gapless sequence, linked to the original invoice | **Must** |
| R7.9 | **PINT AE readiness:** the invoice data model carries every field the UAE Peppol specialisation requires — structured lines, buyer and seller TRN, tax category codes per line, supply\-type indicators, currency plus AED equivalent, UUID — even before an ASP is connected | **Must** |
| R7.10 | ASP integration adapter: emit PINT AE XML and receive acknowledgements, behind a port with one adapter per accredited provider | **Should** (P0 by Q1 2027) |
| R7.11 | FTA Audit File export (CSV) covering sales and purchase lines with counterparty, emirate, TRN, invoice number, date, taxable amount and VAT | **Should** |
| R7.12 | Record retention: **5 years general, 10 years for capital\-asset\-scheme records**, extensible by up to 4 further years while an audit or dispute is open (and \+1 year where a voluntary disclosure is filed in year 5). Records must be retained in\-State and retrievable by the FTA; offshore or cloud hosting is permitted provided retrievability | **Must** |
| R7.13 | Tourist VAT refund (Planet Tax Free) integration at the till | **Won't (v1)** — requires a merchant agreement with Planet, a good credit rating and refundable collateral. Revisit when tourist volume justifies it |

**Acceptance — R7.3 / R7.3a**

```
Given   a walk-in buyer presents a TRN and states the handsets are for resale
When    the cashier marks the sale as business-to-business with intent to resell
Then    the POS requires the buyer's TRN, legal name and address,
        and requires a declaration capturing BOTH resale/manufacture intent
        AND the buyer's confirmation that it is registered with the FTA,
        before the sale can be tendered
And     the supplier-side registration verification step is recorded against the sale
And     the sale is priced VAT-exclusive with a 0%-RCM tax code on qualifying device lines only
And     accessory lines and any zero-rated export lines stay outside the RCM treatment
And     the printed and PDF invoice is a full tax invoice carrying the reverse-charge statement
        and a reference to Cabinet Decision 91/2023
And     without a captured and verified declaration, the sale falls back to a standard 5% VAT sale
        and the cashier is told why, in one sentence
```

**Timeline — R7.9 / R7.10.** **RESEARCH, from Ministerial Decision 244/2025 and Ministerial Decision 66/2026:**

| Cohort | Appoint an ASP by | Mandatory go\-live |
| --- | --- | --- |
| Revenue ≥ AED 50m | 30 Oct 2026 *(extended from 31 Jul 2026 by MD 66/2026)* | 1 Jan 2027 |
| **Revenue \< AED 50m — this business** | **31 Mar 2027** | **1 Jul 2027** |
| Government entities | 31 Mar 2027 | 1 Oct 2027 |

Voluntary pilot ran from 1 Jul 2026. Revenue is gross income for the most recent accounting period per the financial statements. **B2C is expressly out of scope** until a later ministerial decision, so the counter's consumer receipts are not directly affected — but every B2B sale is, and **Cabinet Decision 100/2025 disapplies the simplified\-invoice provisions of Art. 59 once a business is required or opts to issue e\-invoices**, including for transactions under AED 10,000. Simplified invoices survive for out\-of\-scope (B2C) supplies, so **the shop will run both regimes in parallel** and the tax engine must select per transaction, not per tenant. Zero\-rated supplies also lose the record\-only concession and require full e\-invoices.

**Note on a widely\-circulated error:** at least one prominent secondary source gives 1 Oct 2027 as the sub\-AED\-50m go\-live. That is the *government\-entity* date. Verify against MD 244/2025 before planning a quarter around it.

### 7\.8 E8 — Channels: noon and Amazon.ae

**RESEARCH.** The build\-versus\-buy answer changed in 2026: noon now ships a real, documented, versioned seller API. Both legs are buildable directly.

| ID | Requirement | Priority |
| --- | --- | --- |
| R8.1 | Single source of truth: Voltix owns available quantity per SKU per location. Channels are projections and never write back into the master | **Must** |
| R8.2 | Stock push on every sale, immediately and event\-driven, plus a slower full\-catalogue reconciliation sweep | **Must** |
| R8.3 | Per\-channel buffer (safety stock) and per\-channel cap, computed as `min(max(0, on_hand − reserved − buffer), channel_limit)` | **Must** |
| R8.4 | Zero\-push jumps the queue. De\-listing costs nothing; cancelling an order costs a defect metric | **Must** |
| R8.5 | Circuit breaker: reject any outbound batch that would zero more than a configured share of SKUs (default 50%) and alert instead. **RESEARCH:** ChannelEngine ships exactly this guard against a bad feed wiping a catalogue | **Must** |
| R8.6 | Order ingestion, two\-phase: persist the raw envelope keyed on `(channel, external_order_id)` with a unique constraint and never fail; map to the domain model in a separate worker with a dead\-letter queue | **Must** |
| R8.7 | Amazon `Pending` orders are ingested but never allocated. **RESEARCH:** treating Pending as a real allocation is the classic phantom\-stock\-depletion bug | **Must** |
| R8.8 | Ship confirmation back to the channel with carrier and tracking; Amazon `confirmShipment` carries `codCollectionMethod`, which matters here | **Must** |
| R8.9 | Marketplace cancellations always win; seller\-initiated cancellation is expensive and requires confirmation | **Must** |
| R8.10 | Append\-only stock sync log per SKU: timestamp, prior qty, new qty, target channel, reason. Every oversell post\-mortem needs it | **Must** |
| R8.11 | Three\-way reconciliation: master vs last pushed vs what the channel reports. Alert on drift; never auto\-heal silently | **Must** |
| R8.12 | Hard per\-channel allocation for scarce serialised items; shared pool with buffer for the accessory long tail | **Should** |
| R8.13 | Carrefour UAE via a generic Mirakl adapter | **Could** |
| R8.14 | Listing creation on any channel | **Won't (v1)** |

**Integration facts to design against — RESEARCH.** noon: RS256 JWT service account from the Access App, session cookie, mandatory `User-Agent`, 1,500 requests per 60 seconds on the endpoints sampled, `stock-update` sets absolute quantity per warehouse, FBPI order list paginates at 50 with a cursor, customer PII behind a separate call, HTTPS webhook destinations only, free schema\-validating sandbox. Amazon.ae: marketplace `A2VIGQ35RCS4UG` on the Europe endpoint `sellingpartnerapi-eu.amazon.com`, region `eu-west-1`; legacy XML/flat\-file listing feeds were removed on 31 July 2025 so use Listings Items `patchListingsItem` at 5 rps or `JSON_LISTINGS_FEED` in bulk; `getOrders` is throttled to roughly one request per minute steady state, so subscribe `ORDER_CHANGE` to SQS and keep polling only as a reconciliation net.

**Acceptance — R8.2 / R8.7**

```
Given   one unit of SKU X remains and it is listed on the storefront, noon and Amazon
When    that unit is sold at the counter
Then    the storefront reflects zero immediately (same database)
And     a zero-quantity push is enqueued for noon and Amazon ahead of any other pending push
And     the stock sync log records the prior and new quantity per channel with the reason `sale`
When    an Amazon order arrives in `Pending`
Then    it is persisted and shown in the order list as pending payment
And     no stock is reserved and no serial unit is bound until it moves to `Unshipped`
```

### 7\.9 E9 — Customers

| ID | Requirement | Priority |
| --- | --- | --- |
| R9.1 | Unified customer record keyed on phone number across POS, storefront and channels | **Must** |
| R9.2 | Purchase history including every serialised unit the customer owns | **Must** |
| R9.3 | Business customer fields: legal name, TRN, address, resale declaration on file with its date | **Must** |
| R9.4 | PII behind `customer:read_pii`. **AUDIT:** exists and is enforced — preserved | **Must** |
| R9.5 | COD reliability history per customer feeding the risk score — the compounding data asset | **Should** |
| R9.6 | Store credit and gift cards. **AUDIT:** tables exist with no writer | **Could** |
| R9.7 | Loyalty programme | **Won't (v1)** |

### 7\.10 E10 — Returns, warranty and RMA

**AUDIT:** the returns lifecycle is fully built with a proper state machine and 7 tests. What is missing is customer initiation, warranty resolution and the supplier\-facing RMA leg.

| ID | Requirement | Priority |
| --- | --- | --- |
| R10.1 | Counter return and exchange against an IMEI or a receipt, with the restock decision recorded | **Must** |
| R10.2 | Warranty check by IMEI showing provider, expiry, days remaining and prior claims | **Must** |
| R10.3 | Minimal job ticket for a unit sent for repair: intake, status, customer notification, return to customer. Not a repair\-shop product (§6.2) | **Should** |
| R10.4 | RMA to supplier: link the unit to a supplier claim, track credit or replacement received | **Should** |
| R10.5 | Customer\-initiated online return request. **AUDIT:** currently staff\-only; `/returns` says "contact us" | **Should** |
| R10.6 | **Repair over 7 days → free loan unit.** CD 66/2023 Art. 17: the provider must state the maintenance period **in writing** at intake, and where repair of a good under warranty exceeds 7 days must supply a **similar** good for the customer to use **free of charge for the period they cannot use their own**. This is a loaner for the repair window, not a permanent replacement. The job ticket surfaces day 7 as an alert and tracks the loan unit as its own serial movement | **Should** |
| R10.7 | **Warranty clock extends by downtime.** CD 66/2023 Art. 19: warranty runs from receipt of the original *or replacement* good and is extended by any period the customer could not use it. The warranty expiry on a unit must be recomputed after every repair, not left static | **Must** |
| R10.8 | **Three\-strikes replacement.** Federal Law 15/2020 Art. 13: where the same malfunction recurs three times within the first year, the customer is entitled to a free replacement with a new item of the same type, or a refund. The unit history already holds the evidence — the third claim against one IMEI must raise this to the staff member, not leave them to notice | **Should** |
| R10.9 | **Repair intake and hand\-back records.** CD 66/2023 Art. 26: document the condition of the goods at intake, obtain the customer's approval of cost and duration before starting, issue an itemised invoice stating whether parts fitted are new, used or refurbished, and give a minimum **15\-day guarantee on the repair work** itself | **Should** |

**RESEARCH note — warranty duration, corrected.** There is **no blanket statutory two\-year warranty on tangible goods** in the UAE — that claim appears in several law\-firm summaries and does not survive checking. The "commensurate with the nature… or the agreed period, whichever is longer" formula that is often quoted applies to **services** (CD 66/2023 Art. 13; FL 15/2020 Art. 10), not goods. For goods, warranty follows the contract or the manufacturer's or commercial agent's stated period (CD 66/2023 Arts. 12 and 19), with the statutory backstops in R10.7–R10.8 on top. **Do not hard\-code any warranty period.** Warranty terms are per product (R1.8) with a tenant default.

### 7\.11 E11 — Purchasing and suppliers

**AUDIT:** `purchase_orders`, `purchase_order_items` and `suppliers` tables exist; suppliers are used only for a lead\-time lookup; there is no UI for any of it.

| ID | Requirement | Priority |
| --- | --- | --- |
| R11.1 | Create a purchase order from replenishment recommendations or manually; send it as a PDF | **Must** |
| R11.2 | Receive against a PO, partially or fully, scanning IMEIs for serialised lines (R2.2) | **Must** |
| R11.3 | Landed cost: distribute freight, duty and other charges across received lines to give a true unit cost | **Should** |
| R11.4 | Supplier record with lead time, payment terms, TRN and contact | **Must** |
| R11.5 | Supplier bill matched to the PO, feeding payables | **Could** |

### 7\.12 E12 — Reporting and analytics

**AUDIT:** the sharpest single finding — no analytics of any kind, so every business goal is unmeasurable. `analytics_events`, `search_queries` and `recently_viewed` exist and nothing writes to them.

| ID | Requirement | Priority |
| --- | --- | --- |
| R12.1 | Product event instrumentation writing to `analytics_events`\: `product_viewed`, `add_to_cart`, `checkout_started`, `checkout_failed`, `order_placed`, `search_performed`, `cod_refused`, `pos_sale`, `admin_action` | **Must** |
| R12.2 | Three instrumented funnels: home→PDP→cart→checkout→order; search→click→cart; order placed→confirmation delivered→tracked | **Must** |
| R12.3 | Sales report by day, channel, branch, category and staff member | **Must** |
| R12.4 | Margin report per product, variant and serial unit using the immutable cost snapshot. **AUDIT:** the price/cost snapshot on `order_items` already exists and is correct | **Must** |
| R12.5 | VAT summary supporting the return, split by emirate | **Must** |
| R12.6 | Stock valuation at cost and at retail, per location | **Must** |
| R12.7 | Cashier and shift report with variance | **Must** |
| R12.8 | COD performance: sent, delivered, refused, cost of refusal, by area and by customer | **Must** |
| R12.9 | Every report exportable to XLSX and CSV | **Should** |
| R12.10 | Error tracking and uptime monitoring. **AUDIT:** `SENTRY_DSN` is already in the env schema and unused | **Must** |

### 7\.13 E13 — Notifications

**AUDIT:** the outbox pattern is properly built with draft approval, resend and failure visibility, and the notification is enqueued inside the same transaction as the order — genuinely good. But **no SMTP is configured, so nothing has ever been delivered.** Customers hear nothing after paying.

| ID | Requirement | Priority |
| --- | --- | --- |
| R13.1 | Configure SMTP and deliver. Bounce handling marks the row failed and surfaces it on the Messages screen | **Must** |
| R13.2 | WhatsApp Business API as a channel — **DECISION:** in this market WhatsApp is the primary channel, not a fallback | **Should** |
| R13.3 | Templates: order confirmation, dispatch with tracking, COD reminder, return received, warranty expiring, low stock (internal) | **Must** |
| R13.4 | Bilingual templates chosen by customer language preference. **AUDIT:** bilingual templates already exist | **Must** |
| R13.5 | Deterministic templated content only. **DECISION** carried forward from the OmniRetail decisions of Aug 2026: no model\-generated customer\-facing text in v1 | **Must** |

### 7\.14 E14 — Platform, security and operations

**AUDIT:** auth is the strongest subsystem in the codebase and is preserved unchanged — Argon2id at OWASP parameters, opaque 32\-byte sessions stored as SHA\-256 with an 8\-hour slide, `session_epoch` revocation, TOTP verified against RFC 6238 test vectors, AES\-256\-GCM secret storage, dual\-factor login throttling, 27 permissions across 4 role templates checked server\-side per action, and the session table revoked from the application role entirely.

| ID | Requirement | Priority |
| --- | --- | --- |
| R14.1 | **Database backups — PITR or scheduled dumps to object storage.** **AUDIT:** none exist. Rated the single highest operational risk: a dropped table ends the business | **Must** |
| R14.2 | **Rotate the shared Neon owner credential** shared in plaintext during development and unrotated at the time of the audit; move to a secret manager | **Must** |
| R14.3 | **Rate limiting on public routes.** **AUDIT:** none. Order tracking (`/orders?number=X&phone=Y`) is a two\-factor lookup with no throttle — brute\-forcing the phone for a known order number is feasible | **Must** |
| R14.4 | **Wire `audit_logs`.** **AUDIT:** the table exists, is append\-only, and has no writer at all — no staff action is audited. Every privileged mutation writes to it: price changes, refunds, stock adjustments, permission changes, price overrides, no\-sale drawer opens | **Must** |
| R14.5 | New `cashier` role with till permissions, no cost visibility, no refunds without approval | **Must** |
| R14.6 | Error tracking, uptime monitoring, `/healthz` | **Must** |
| R14.7 | Runbook and on\-call basics | **Should** |
| R14.8 | Tenant offboarding and data deletion path. **AUDIT:** no path exists; RESTRICT constraints make it manual, so a GDPR\-style request cannot be served | **Should** |

* * *

## 8\. Success metrics

Every metric below names its instrumentation. **AUDIT:** none of it exists today, which is why G7 exists.

### 8\.1 Leading indicators — weeks

| Metric | Target | Instrumentation |
| --- | --- | --- |
| Counter sale completion time, scan to receipt | p50 under 30 s, p95 under 60 s | POS timing events |
| Share of shop revenue transacted in Voltix | \> 95% within 30 days of POS go\-live | `pos_sale` \+ order events vs the owner's own daily count |
| Serialised sales carrying a valid IMEI | 100% | Serial binding events |
| Products created in the admin, first 30 days | \> 200 | `admin_action` events |
| Checkout completion rate, carts with items | \> 55% | Funnel events |
| Order confirmation delivered under 5 minutes | \> 99% | Outbox latency metric |
| Offline sales lost or duplicated | 0 | Sync reconciliation exceptions |

### 8\.2 Lagging indicators — months

| Metric | Target | Instrumentation |
| --- | --- | --- |
| Stocktake variance | \< 2% of units counted | Stocktake sessions |
| COD refusal rate | \< 8% | Delivery outcome capture |
| Cross\-channel oversells | \< 1 per 1,000 units sold | Sync log \+ cancellation reasons |
| Warranty claims resolved without a receipt | \> 90% | Unit lookup events |
| Time to close the month | \< 2 hours | Owner\-reported, then report timing |
| Second merchant onboarded | 1, by end of Phase 4 | Tenant count |

### 8\.3 Counter\-metrics — watch for harm

Average transaction time trending up after a release · manual price overrides per 100 sales (a proxy for the catalogue being wrong) · reconciliation exceptions per 1,000 offline sales · staff falling back to WhatsApp or paper.

* * *

## 9\. Release plan

Phases are ordered by risk retired per week, not by feature appeal. Durations assume the same single\-developer capacity that produced the current build.

### Phase 0 — Stabilise (1–2 weeks) · *nothing in production can silently lose data, money or messages*

Backups (R14.1) · rotate credentials (R14.2) · error tracking and uptime (R14.6, R12.10) · configure SMTP so confirmations actually send (R13.1) · payment webhook routes (R6.1) · reconcile or delete the stale `docs/`.

**Definition of done:** a data\-loss event is recoverable; a production error reaches a human; a customer who orders receives an email; a card payment can complete.

### Phase 1 — The merchant can run the shop (5–7 weeks) · *the vertical slice*

Product create/edit/publish (E1) · serialised units, receiving and lookup (E2) · stock adjustment and stocktake (E4.1–4.2) · purchase orders and receiving (E11.1–11.2, 11.4) · tax documents including RCM (E7.1–7.8) · shipments and tracking (E5.2–5.3) · enforce the COD gate (R5.5) · rate limiting (R14.3) · wire `audit_logs` (R14.4) · analytics events (R12.1–12.2).

**Definition of done:** the owner lists a product, receives it by scanning IMEIs, sells it online, ships it with a tracking number, issues a compliant invoice, and can look up the unit by IMEI a month later. No developer, no SQL.

### Phase 2 — The counter (5–7 weeks)

POS surface end to end (E3) including offline (§7.3.1), receipt and drawer, shifts, counter returns · `cashier` role (R14.5) · warranty lookup (R10.1–10.2) · reporting core (R12.3–12.8).

**Definition of done:** the shop closes its spreadsheet. A full trading day runs through the till, including a network outage, and the shift reconciles.

### Phase 3 — Channels (4–5 weeks)

noon inventory and order sync · Amazon.ae inventory and order sync · allocation, buffers and the circuit breaker (E8) · unified cross\-channel order list (R5.1).

**Definition of done:** a counter sale removes stock from noon and Amazon without a human, and a noon order appears in the same order list as a walk\-in sale.

### Phase 4 — Compliance and scale (ongoing, hard date Q1 2027)

ASP integration and PINT AE emission (R7.10) — **must be live before 1 July 2027** · FTA Audit File export (R7.11) · semi\-integrated terminal driver (R3.6) · Tabby in\-store (R3.14) · connection budgeting, caching, index validation · E2E tests on the three money paths · accessibility audit · admin mobile layout · Arabic product content · catalogue extraction from supplier sheets (R1.9) · second\-tenant onboarding and billing.

### 9\.1 Sequencing rule

**DECISION.** The audit's most consequential process failure was that scope was breadth\-first: 72 tables and 11 packages before one merchant workflow was complete. The rule for this build is the inverse and it is not negotiable: **no new table, package or channel is added until the current phase's vertical slice works end to end for one merchant.** A schema without a writer is not an asset.

* * *

## 10\. Edge cases

Carried forward from the audit and extended for POS and channels.

| Edge case | Required behaviour | Priority |
| --- | --- | --- |
| Stock drifts from physical reality | Stocktake and adjustment path (R4.1–4.2) | P0 — **AUDIT:** "will happen in week one" |
| Same IMEI sold at two tills while offline | Local claim at scan; loud reconciliation exception naming both tills on sync | P0 |
| Product deleted while in an active cart | **AUDIT: UNKNOWN.** Must be determined and tested. Proposed: archive never deletes; carts holding an archived variant show it as unavailable at checkout | P0 |
| Customer changes phone after ordering | Staff can amend the tracking phone with an audit entry | P1 |
| Two staff process the same return simultaneously | Row locks — **AUDIT: resolved and tested** | Done |
| Gateway succeeds but our transaction fails | Reconcile job now repairs, not only flags (R6.2) | P0 |
| Refund exceeds capture | Blocked in domain and by DB CHECK — **AUDIT: resolved** | Done |
| Price changes between cart and checkout | `expectedTotal` comparison rejects — **AUDIT: resolved** | Done |
| Order placed while a channel is mid\-sync | Reservation wins; the channel push carries the post\-sale number | P0 |
| Marketplace order for an IMEI already sold at the counter | Cancel on the channel immediately; record as an oversell with its cause | P0 |
| Cashier closes the browser mid\-sale | Parked sale recovered from IndexedDB on reopen | P0 |
| Receipt printer offline | Sale completes; receipt queues and reprints; the customer is offered SMS or WhatsApp | P0 |
| Buyer claims resale intent but supplies no declaration | Sale proceeds at standard 5% VAT with a one\-sentence explanation (R7.3) | P0 |
| Return of a serialised unit sold under RCM | Credit note mirrors the original tax treatment | P1 |
| Tenant offboarding / data deletion | No path exists — **AUDIT** | P1 |
| Timezone at month boundary | `Asia/Dubai` used explicitly — **AUDIT: resolved** | Done |

* * *

## 11\. Non\-functional requirements

**AUDIT:** the previous documentation stated LCP, INP, CLS and JS\-budget targets and asserted that CI failed when they were exceeded. Neither was true — nothing was ever measured. Targets below are only listed where a measurement method is named.

| NFR | Target | Measured by |
| --- | --- | --- |
| POS sale completion | p95 under 60 s, scan to receipt | POS timing events |
| POS interaction latency | p95 under 100 ms for add\-line and tender | Client instrumentation |
| POS offline tolerance | Full shift (8 h) of cash trading offline | Manual test per release |
| Storefront LCP | ≤ 2.5 s on 4G, mid\-range Android | Lighthouse CI, real device sample |
| Checkout server time | p95 ≤ 500 ms | Server timing |
| Availability | 99\.5% monthly on the money paths | Uptime monitor on `/healthz` and `/api/cron/tick` |
| Data durability | RPO ≤ 1 hour, RTO ≤ 4 hours | Documented restore drill, quarterly |
| Channel stock freshness | ≤ 5 min p95 from sale to channel reflecting it | Sync log timestamps |
| Accessibility | WCAG 2.2 AA on storefront and POS | Automated axe run in CI plus a manual keyboard audit |
| Localisation | Full AR/EN including product content and documents | Coverage check in CI |
| Security | No high or critical CVEs; no secret in the repo | `npm audit` gate and gitleaks — **AUDIT: already in CI** |

* * *

## 12\. Open questions

| \# | Question | Owner | Blocking? |
| --- | --- | --- | --- |
| Q1 | Which accredited ASP do we integrate with, and does their API accept our invoice shape without a translation layer? 40\+ are on the MoF list, jointly accredited by MoF/FTA under MD 64/2025 | Finance \+ Eng | Blocks R7.10 — not Phase 1 |
| Q2 | Which acquirer holds the shop's merchant agreement, and will they release the ECR/POS integration spec under NDA? No UAE acquirer publishes one | Owner | Blocks R3.6 only. R3.5 unblocks launch |
| Q3 | Is the trade licence's activity list being extended to cover online trading, and is a TDRA NOC genuinely required? **RESEARCH:** consultancies assert both; neither was verifiable against DET's own text | Owner | Blocks nothing technical |
| Q4 | ~~Confirm the e\-invoicing dates~~ **Resolved 12 Aug 2026.** MD 244/2025 as amended by MD 66/2026: our cohort appoints an ASP by **31 Mar 2027** and goes live **1 Jul 2027**. Remaining question is only *which* ASP — see Q1 | — | Closed |
| Q5 | Till hardware: Windows PC, Android tablet, or iPad? **RESEARCH:** this is decisive — WebUSB and Web Serial are unsupported on Safari and iPad *permanently*, so an iPad forces network printing or Epson ePOS\-Print and rules out a local print agent | Owner \+ Eng | **Blocks Phase 2 architecture** |
| Q6 | Does the shop have a noon seller account and an Amazon.ae seller account today? Amazon developer profile review takes 1–2 weeks, longer for PII roles | Owner | Blocks Phase 3 start |
| Q7 | Default warranty period and provider by product category. **RESEARCH:** no blanket statutory two\-year warranty exists — see §7.10. This is a commercial decision, not a legal one | Owner | Blocks R1.8 default |
| Q8 | Product name and repository name — the audit flags `AI-powered-e-commerce-platform` as a claim the software does not meet | Owner | Blocks nothing; do it before any external mention |
| Q9 | Second\-merchant hypothesis: is there a named prospect, and would they pay AED 150–400/month? | Owner | Blocks the business model, not the build |
| Q10 | What means of **verifying** a buyer's FTA registration is available to a retailer at the counter (R7.3a)? If there is no lookup service, what evidence do we retain instead? | Finance | Blocks R7.3a implementation detail, not Phase 1 |

## 13\. Traceability — audit gap to requirement

Every P0 gap the audit identified maps to a requirement here. Nothing is dropped silently.

| Audit ID | Gap | Requirement | Phase |
| --- | --- | --- | --- |
| P\-01 | Cannot create or edit a product | R1.1–R1.5 | 1 |
| P\-02 | Order confirmations never delivered | R13.1 | 0 |
| P\-03 | Homepage promises IMEI; `serial_units` never written | R2.1–R2.8 | 1 |
| P\-04 | Contact page promises TRN invoices; none generated | R7.1–R7.2 | 1 |
| P\-05 | No stock adjustment or stocktake | R4.1–R4.2 | 1 |
| P\-06 | No analytics; every goal unmeasurable | R12.1–R12.2 | 1 |
| P\-07 | No onboarding for a new merchant | Deferred — §6.2 | 4 |
| P\-08 | No customer\-initiated returns | R10.5 | 4 |
| P\-09 | Arabic UI, English product content | R1.4 | 4 |
| P\-10 | No shipment or tracking number | R5.2–R5.3 | 1 |
| P\-11 | Discount engine with no admin UI | Backlog | 4 |
| P\-12 | No feedback mechanism | R12.1 (proxy) | 1 |
| P\-13 | Admin not usable on a phone | Design doc §responsive | 4 |
| P\-14 | Reviews displayed but not collectable | Backlog | 4 |
| P\-15 | COD advance gating configured, never enforced | R5.5 | 1 |
| P\-16 | No audit trail of staff actions | R14.4 | 1 |
| T\-01 | No payment webhook route | R6.1 | 0 |
| T\-02 | No backups | R14.1 | 0 |
| T\-03 | No error tracking | R14.6 | 0 |
| T\-04 | Shared unrotated DB credential | R14.2 | 0 |
| T\-05 | No rate limiting | R14.3 | 1 |
| T\-06 | Hand\-written SQL bypasses ORM types | TRD §testing | ongoing |
| T\-07 | Redis provisioned, never used | R14.3 uses it | 1 |
| T\-08 | \~30 tables with no writer | §9.1 rule; prune in Phase 1 | 1 |
| T\-09 | Admin recomputes forecasts per request | R4.7 | 2 |
| T\-10 | No connection budget for serverless | TRD | 4 |
| T\-11 | `audit_logs` has no writer | R14.4 | 1 |
| T\-14 | Payment adapters never tested against sandbox | R6.5 | 0 |

* * *

## 14\. Sources

Research conducted 12 August 2026. Where sources conflicted, the conflict is noted in the body rather than resolved silently.

**UAE tax and e\-invoicing** — UAE Ministry of Finance eInvoicing programme and accredited\-provider list · KPMG UAE on Ministerial Decisions 243 and 244 of 2025 · Gulf News, 26 Jun 2026, on the pilot phase and deadlines · Avalara on PINT AE readiness · ClearTax UAE e\-invoicing · Grant Thornton UAE · VATupdate on Cabinet Decision 100 of 2025 and Ministerial Resolutions 56 and 66 of 2026 · Federal Tax Authority public clarification on the reverse charge for electronic devices · KPMG UAE on Cabinet Decision 91 of 2023 · FTA Requirements Document for Tax Accounting Software (FAF) · Article 59 of the VAT Executive Regulations.

**Consumer protection and licensing** — CMS and Pinsent Masons on Cabinet Decision 66 of 2023 · K&L Gates on UAE consumer protection and e\-commerce · Federal Decree\-Law 14 of 2023 on Trading by Modern Technological Means · TDRA type approval · PwC on Cabinet Decision 99 of 2022 and emirate\-wise e\-commerce VAT reporting.

**POS hardware and payments** — Network International integrated payments and N\-Genius documentation · Adyen Terminal API (nexo Retailer Protocol) · Pine Labs cloud, app\-to\-app and wired integration docs · Epson ePOS\-Print and ePOS SDK for JavaScript · Chrome Local Network Access permission, Chrome 142 · caniuse for WebUSB, Web Serial and BarcodeDetector · Mozilla Hacks on Web Serial in Firefox 151 · ESC/POS drawer\-kick command references · Shopify, Square, Loyverse and Odoo offline\-mode documentation · Tabby in\-store and custom payment link docs · Tamara POS integration docs.

**Marketplace integration** — noon API Platform documentation (authentication, rate limiting, sandbox, Stock, FBPI, Event Notifications) · noon Seller Help Centre FBP guides · Amazon SP\-API documentation (marketplace IDs, endpoints, usage plans and rate limits, feed type values, Listings Items v2021\-08\-01, Orders v0, Notifications v1, developer profile and Data Protection Policy) · ChannelEngine documentation on stock buffers, allocation and its noon connector · Mirakl Shop API seller guide.

**Competitive landscape** — Shopify pricing, POS pricing, UAE payments availability and card\-reader country list · Lightspeed Retail pricing and serial\-number documentation · Square supported countries · Odoo pricing and POS serial\-number documentation · Zoho Inventory, Zoho Commerce and Zoho Books UAE pricing · Loyverse pricing · Salla and Zid plans · Wafeq and Qoyod pricing · Ginesys pricing · TallyPrime UAE reseller pricing · RepairDesk and RepairShopr pricing · CellStore and CellSmart POS · GOFRUGAL mobile\-shop billing · POS GCC, OptaPOS and Bizmodo UAE product pages.

**Market context** — WAM on UAE SME counts · Dubai SME State of SMEs in Dubai · Dubai Chambers member registrations · UAE e\-commerce statistics aggregations (secondary, flagged in §3.5).

* * *

*This document supersedes §7 of the 9 August 2026 audit. It does not supersede the audit's findings about the existing code, which remain the best available description of what is built.*

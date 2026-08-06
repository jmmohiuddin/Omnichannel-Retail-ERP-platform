# Delivery Roadmap

Phases are cumulative; each ends with a releasable increment, updated docs, and tests.

> **Status (2026-08-06, end of day):** Phases 0–3 delivered. Core platform:
> auth/RBAC/MFA-ready sessions, catalog, ledger inventory with serialized IMEI
> lifecycle, POS web app (offline queue, IMEI scan, loyalty tender), admin
> portal (catalog/stock/audit/approvals/orders/finance/AI digest), storefront,
> OMS (reservations→fulfillment/cancel/expiry), refunds & count corrections
> behind two-person approvals, cash sessions with blind reconciliation,
> transfers, WMS v1 (zones/bins/guided picking), CRM loyalty (earn/redeem
> ledger), double-entry finance journals + trial balance/P&L, connector SDK +
> Noon skeleton, marketplace order import, outbox relay + channel sync + jobs,
> statistical AI (forecast/reorder/dead-stock) with Claude narration gateway.
>
> **Phase 5 additions:** payment capture via gateway port + HMAC-verified
> webhooks (mock gateway; Network Intl/Telr/Stripe AE adapters slot in with
> merchant credentials), shipping via courier port (mock courier; Aramex/
> SMSA/Quiqup adapters later), UAE e-invoice generation (PINT-AE-draft UBL
> with explicit pre-transmission disclaimer), COGS journal postings, and the
> Expo mobile companion (typecheck+unit-verified; no native toolchain here).
>
> **Phase 6 additions:** hourly ledger drift-check job, storefront pay-now,
> API reference / deployment guide / testing strategy docs, and the **Tauri 2
> desktop POS shell** (built and verified: 5.8 MB native binary; Rust
> installed via rustup on the dev machine). Hardware plugins (ESC/POS
> printer, cash drawer, SQLite offline store) attach to the Rust side next.
>
> **Still requires external accounts to activate:** real gateway + courier +
> marketplace credentials, e-invoice transmission via an accredited provider,
> app-store builds of the mobile app, per-bin stock quantities (WMS v2).

## Phase 0 — Foundations (this repo state)
Architecture + ADRs, PRD, integration & security design, core database schema,
`@omniretail/domain` inventory ledger engine with unit tests, API skeleton.

## Phase 1 — Core platform (MVP for a single store)
- Auth (JWT + refresh, TOTP MFA), tenants, users, RBAC, device registration
- Catalog: products/variants/brands/categories, barcodes, price lists
- Inventory: receiving, adjustments (approval-gated), transfers, serialized units (IMEI),
  stock levels + drift-check job
- Desktop POS v1 (Tauri): scan, cart, cash/tokenized-card sale, receipts, cash sessions,
  offline command log + replay
- Admin portal v1: catalog, stock, sales, users, audit trail viewer
- Migration + seed tooling, docker-compose dev env, CI (lint, typecheck, test, migration
  check), staging deploy
- **Exit criteria:** a phone shop can run a day's trade offline-capable with full ledger
  audit; isolation test-suite green.

## Phase 2 — Omnichannel
- OMS: unified orders, reservations, fulfillment, returns/refunds with approval workflows
- E-commerce storefront v1 (catalog, cart, checkout with UAE gateways — Network
  International/Telr/Stripe AE, Tabby/Tamara BNPL — tokenized, order tracking, accounts)
- Connector SDK + first connectors: Noon, Amazon.ae (SP-API), Shopify; sync health dashboard
- CRM v1: customers, purchase history, loyalty points; digital receipts
- Notifications (email/SMS/WhatsApp templates), courier/shipping integration interface
- **Exit criteria:** an online order and a POS sale contend safely for the last unit;
  channel drift < 0.1% in reconciliation.

## Phase 3 — Depth
- WMS: zones/bins, guided picking/packing, cycle counts with variance approvals
- Finance: journals, tax config, P&L/margin reports, cash reconciliation reports
- AI module v1: demand forecast + reorder suggestions, dead-stock detection,
  description/SEO generation, daily executive digest, exception-report summarizer
- Analytics dashboards; employee performance; fraud exception reports
- Marketplace wave 2: Dubizzle (used devices), WooCommerce, eBay, TikTok Shop (per capability matrix)
- **Exit criteria:** measurable forecast MAPE reporting; fraud exception digest in daily use.

## Phase 4 — Scale & enterprise
- Mobile companion GA; POS-lite mobile
- Wholesale/B2B price tiers & credit; multi-warehouse allocation strategies
- Read-replica analytics, search service (Meilisearch) at catalog scale
- SSO (SAML/OIDC) for enterprise tenants; per-tenant database escape hatch
- Marketplace app-store style connector certification for third parties

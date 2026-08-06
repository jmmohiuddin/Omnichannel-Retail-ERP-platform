# Delivery Roadmap

Phases are cumulative; each ends with a releasable increment, updated docs, and tests.

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

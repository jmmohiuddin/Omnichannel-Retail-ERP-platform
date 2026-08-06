# OmniRetail OS

An AI-powered omnichannel retail operating system: ERP, POS, inventory, warehouse,
e-commerce, and marketplace synchronization on a single centralized inventory database.

**Core philosophy:** every inventory movement is a ledger entry. Nothing changes stock
without an immutable, user-attributable audit trail.

## Repository layout

```
docs/                        Product, architecture, integration, and security documentation
  adr/                       Architecture Decision Records (the "why" behind every choice)
  prd/                       Product requirements, personas, user stories, IA
  integrations/              Connector SDK + marketplace integration architecture
  security/                  Security architecture + fraud-prevention controls
packages/
  domain/                    @omniretail/domain — pure TS domain core: inventory ledger,
                             VAT math, serialized-stock (IMEI) rules. No I/O.
  pos-core/                  @omniretail/pos-core — offline-first POS command log +
                             sync engine (storage-agnostic; Tauri plugs SQLite in later)
  db/                        @omniretail/db — SQL-first migrations + checksum-verified runner
  connector-sdk/             @omniretail/connector-sdk — marketplace connector contract,
                             token-bucket rate limiting, retry/backoff, registry
  connector-noon/            @omniretail/connector-noon — Noon connector (tested mapping
                             layer; endpoint paths flagged UNVERIFIED pending API docs)
apps/
  api/                       @omniretail/api — Fastify HTTP API: auth/RBAC, catalog,
                             ledger inventory (serialized IMEI), POS sales + VAT receipts,
                             OMS fulfillment, approvals (refunds/counts), cash sessions,
                             transfers, WMS picking, loyalty, finance journals, analytics
                             + AI narration gateway
  worker/                    @omniretail/worker — outbox relay → BullMQ + channel-sync
                             event consumer (connector fan-out)
  pos/                       @omniretail/pos — POS web app (Vite/React)
  pos-desktop/               @omniretail/pos-desktop — Tauri 2 native shell around the
                             POS app (5.8 MB binary; `pnpm --filter @omniretail/pos-desktop
                             dev` — needs Rust, installed via rustup)
  admin/                     @omniretail/admin — admin portal (dashboard, catalog,
                             stock levels, audit ledger)
  storefront/                @omniretail/storefront — customer store: catalog, cart,
                             checkout, pay-now via gateway hosted checkout
  mobile/                    @omniretail/mobile — Expo owner companion (dashboard,
                             approvals, stock lookup; run via Expo Go)
```

Remaining roadmap (see [docs/07-roadmap.md](docs/07-roadmap.md) status note): payment
gateway capture, marketplace order-import loop, WMS depth, finance journals, LLM
narration over the statistical AI baseline, mobile companion, Tauri POS shell.

## Getting started

```bash
npx -y pnpm install
npx -y pnpm test        # builds, then runs all test suites
```

The API expects PostgreSQL 16+; apply migrations in `packages/db/sql/` in order.

## Documentation map

| Doc | Contents |
| --- | --- |
| [docs/01-executive-summary.md](docs/01-executive-summary.md) | What we're building and why |
| [docs/02-architecture.md](docs/02-architecture.md) | System architecture, deployment, data flow |
| [docs/03-database-schema.md](docs/03-database-schema.md) | Schema design narrative + ER description |
| [docs/04-api-reference.md](docs/04-api-reference.md) | Endpoint catalog for every module |
| [docs/05-deployment-guide.md](docs/05-deployment-guide.md) | Production topology, roles, env, go-live checklist |
| [docs/06-testing-strategy.md](docs/06-testing-strategy.md) | Test layers, conventions, bugs they caught |
| [docs/adr/](docs/adr) | Individual decision records |
| [docs/prd/](docs/prd) | PRD, personas, user stories, information architecture |
| [docs/integrations/](docs/integrations) | Connector SDK, marketplace APIs, sync policies |
| [docs/security/](docs/security) | Threat model, RBAC/RLS, fraud-prevention controls |
| [docs/07-roadmap.md](docs/07-roadmap.md) | Phased delivery plan |
| [docs/08-uae-localization.md](docs/08-uae-localization.md) | UAE/Dubai market spec: VAT+TRN, AED, Arabic/RTL, gateways, Noon/Amazon.ae |

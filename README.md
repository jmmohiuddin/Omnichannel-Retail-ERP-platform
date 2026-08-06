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
  domain/                    @omniretail/domain — pure TypeScript domain core:
                             inventory ledger, availability math, serialized-stock
                             (IMEI) rules, movement posting invariants. No I/O.
  db/                        @omniretail/db — PostgreSQL DDL migrations (SQL-first)
apps/
  api/                       @omniretail/api — Fastify HTTP API (modular monolith host)
```

Planned (see [docs/07-roadmap.md](docs/07-roadmap.md)): `apps/admin` (Next.js),
`apps/pos` (Tauri desktop), `apps/storefront` (Next.js), `apps/mobile` (Expo),
`packages/connector-sdk` + `connectors/*`.

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
| [docs/adr/](docs/adr) | Individual decision records |
| [docs/prd/](docs/prd) | PRD, personas, user stories, information architecture |
| [docs/integrations/](docs/integrations) | Connector SDK, marketplace APIs, sync policies |
| [docs/security/](docs/security) | Threat model, RBAC/RLS, fraud-prevention controls |
| [docs/07-roadmap.md](docs/07-roadmap.md) | Phased delivery plan |

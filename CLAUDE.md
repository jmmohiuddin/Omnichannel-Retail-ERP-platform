# OmniRetail OS — engineering conventions

- pnpm workspace (Turborepo added when app count grows). TypeScript strict everywhere; ESM only.
- pnpm is not globally installed on this machine — use `npx -y pnpm <cmd>`.
- Rust is installed user-space via rustup (`~/.cargo/bin`); `apps/pos-desktop` (Tauri)
  needs it on PATH: `export PATH="$HOME/.cargo/bin:$PATH"`.
- Build before test: `apps/api` resolves `@omniretail/domain` from its `dist/` output.
- `packages/domain` is a **pure** domain core: no I/O, no framework imports, 100% unit-testable.
  All inventory math and invariants live here — never re-implement them in apps.
- Inventory is a **ledger**: stock levels are derived from `stock_movement` entries, never
  mutated directly. Any code that writes a quantity column without a movement row is a bug.
- Database is SQL-first: schema lives in `packages/db/sql/NNN_*.sql`, applied in order.
  Never edit an already-numbered migration; add a new one.
- Every table carrying tenant data has `tenant_id` and an RLS policy keyed on
  `current_setting('app.tenant_id')`.
- Money is stored as `BIGINT` minor units + currency code. Quantities are `NUMERIC(14,3)`.
  Never use floats for money or stock.
- Tests: vitest. Domain rules require tests before merge; test files sit next to source
  as `*.test.ts`. Postgres integration tests (`*.integration.test.ts`) auto-skip unless
  `ADMIN_DATABASE_URL` (schema owner) and `DATABASE_URL` (omniretail_app role) are set;
  locally: `createdb omniretail_test` then run the api test script with both URLs.
- Target market is UAE/Dubai: AED default currency, 5% VAT with TRN invoices, bilingual
  EN/AR + RTL UI, Noon/Amazon.ae connectors first — see docs/08-uae-localization.md.
- Requirement IDs from `docs/prd/01-product-requirements.md` (e.g. `INV-003`) are cited in
  commit messages and doc cross-references when implementing them.

# @omniretail/db

SQL-first migrations for PostgreSQL 16+. Apply `sql/*.sql` in filename order:

```bash
for f in sql/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
```

Rules (see root CLAUDE.md): never edit an applied migration — add a new numbered file.
The application connects as a non-superuser role without BYPASSRLS; every tenant table
forces row-level security keyed on the `app.tenant_id` GUC.

A proper migration runner (tracking applied versions, CI drift check against a shadow DB)
lands in Phase 1; the SQL files are already runner-agnostic.

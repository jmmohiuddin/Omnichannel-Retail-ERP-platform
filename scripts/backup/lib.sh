#!/usr/bin/env bash
#
# Shared helpers for the R14.1 backup/restore tooling.
# Sourced by pg-backup.sh, verify-dump.sh and restore-drill.sh — not executable
# on its own.
#
# Bash rather than TypeScript deliberately: every primitive here is a CLI
# (pg_dump, pg_restore, pg_dumpall, aws, sha256sum). A Node wrapper would add a
# build step (tsc) and a workspace package to a tool whose entire job is to run
# correctly on a bare scheduled runner *while the app is broken* — the one
# moment you do not want the recovery path to depend on the app's toolchain.

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

log()  { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
warn() { printf '%s  WARN: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die()  { printf '%s  FATAL: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# The tables the backup is judged against.
#
# NEVER assert an exact total table count here: migrations land continuously
# (032_notifications.sql is being added as this is written) and a hard-coded
# count turns every schema change into a false backup failure — the fastest way
# to train an operator to ignore the alarm. Assert a floor plus a required set.
# ---------------------------------------------------------------------------

# Tables whose absence means the dump is structurally wrong.
REQUIRED_TABLES=(
  tenant location product variant stock_level stock_movement
  sales_order sales_order_line payment payment_intent refund
  journal_entry journal_line cash_session outbox app_user role
  customer supplier purchase_order schema_migrations
)

# Money/ledger tables. These are append-only by design (ADR-002: stock levels
# are derived from movements, never mutated; financial records are never
# deleted), so a dump containing FEWER rows than the source held before the
# dump began is proof the dump was filtered — not proof of a concurrent delete.
#
# Each of these must be non-empty INDIVIDUALLY. Checking their sum is not
# enough, and this is not hypothetical: the first version of this check summed
# row counts across all critical tables, and a dump taken as omniretail_app
# with --enable-row-security passed it with sales_order=0, payment=0 and
# stock_movement=0, because `tenant` is not force-RLS and contributed 1195 rows
# to the total. Every sale, payment and stock movement in the business was
# missing and the check said VERIFIED.
MONEY_TABLES=(sales_order payment stock_movement)

# Compared against the pre-dump baseline. Superset of MONEY_TABLES.
CRITICAL_DATA_TABLES=(sales_order payment stock_movement tenant)

# Floor on the public-schema table count. Well under the current 59 so ordinary
# schema growth never trips it, high enough that an empty or partial dump does.
MIN_TABLE_COUNT="${BACKUP_MIN_TABLE_COUNT:-40}"

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

require_cmd() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "required command not found on PATH: $c"
  done
}

# pg_dump refuses to dump a server newer than itself, and a pg_restore older
# than the archive cannot read it. Production is managed Postgres whose major
# version is upgraded by the provider on their schedule, so the client version
# is a moving target that WILL drift out from under this script. Check it
# rather than assume it.
assert_client_version_ok() {
  local url="$1" server_major client_major
  server_major="$(psql "$url" -tAX -c 'SHOW server_version_num' | cut -c1-2 | sed 's/^0//')"
  [ -n "$server_major" ] || die "could not read server_version_num from the target"
  client_major="$(pg_dump --version | sed -E 's/.* ([0-9]+).*/\1/')"
  log "server major=$server_major, pg_dump major=$client_major"
  if [ "$client_major" -lt "$server_major" ]; then
    die "pg_dump $client_major cannot dump a Postgres $server_major server.
     Install matching client tools (see docs/runbooks/backup-restore.md §Client versions)."
  fi
}

# ---------------------------------------------------------------------------
# THE correctness check: is this connection able to see the whole database?
#
# A dump taken as `omniretail_app` succeeds, exits 0, produces a well-formed
# archive — and contains zero rows for every tenant table, because RLS is
# FORCED on the app role and current_tenant_id() fails CLOSED when no
# app.tenant_id GUC is set (migration 016 made the unset GUC match no rows
# instead of raising). Nothing anywhere in that pipeline errors. This is the
# single failure mode most likely to end the business while the dashboard is
# green, so it is checked before the dump, not after.
#
# A role sees everything only if it is superuser, has BYPASSRLS, or owns the
# table AND the table is not FORCE ROW LEVEL SECURITY.
# ---------------------------------------------------------------------------

assert_dump_role_sees_everything() {
  local url="$1" role blinded

  role="$(psql "$url" -tAX -c 'SELECT current_user')" \
    || die "cannot connect to the backup source"

  case "$role" in
    omniretail_app|omniretail_worker)
      die "refusing to back up as '$role'. This role is subject to forced RLS and
     would produce a well-formed dump containing ZERO tenant rows. Use the
     schema-owner connection (ADMIN_DATABASE_URL / BACKUP_DATABASE_URL)."
      ;;
  esac

  blinded="$(psql "$url" -tAX -c "
    SELECT count(*)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity
      AND NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
      AND (c.relforcerowsecurity OR NOT pg_has_role(current_user, c.relowner, 'MEMBER'));
  ")"

  if [ "${blinded:-1}" -ne 0 ]; then
    die "role '$role' is filtered by row-level security on $blinded table(s).
     A dump taken with it would be SILENTLY INCOMPLETE (well-formed, exit 0,
     no rows). Refusing. Use the schema owner."
  fi

  log "role check OK: '$role' is not filtered by RLS on any public table"
}

# ---------------------------------------------------------------------------
# Reading a custom-format archive
# ---------------------------------------------------------------------------

# Count data rows for one table inside a .dump, without restoring it.
# Keys on the exact `COPY public.<table> (` header so that asking for `payment`
# never accidentally counts `payment_intent`.
dump_row_count() {
  local dump="$1" table="$2"
  pg_restore --data-only --table="$table" -f - "$dump" 2>/dev/null \
    | awk -v t="$table" '
        $0 ~ "^COPY public\\." t " \\(" { inblock = 1; next }
        inblock && $0 == "\\."          { inblock = 0; next }
        inblock                         { n++ }
        END { print n + 0 }
      '
}

# The archive's table of contents, read once and cached. Reading it per-table
# is not just slow (one pg_restore per lookup); piping it straight into
# `grep -q` makes grep exit on the first match, pg_restore die of SIGPIPE, and
# `set -o pipefail` report a failure for what was actually a successful match.
TOC_CACHE=""
dump_toc() {
  if [ -z "$TOC_CACHE" ]; then
    TOC_CACHE="$(mktemp "${TMPDIR:-/tmp}/omniretail-toc.XXXXXX")"
    pg_restore --list "$1" > "$TOC_CACHE"
  fi
  cat "$TOC_CACHE"
}

# TOC lines look like: `256; 1259 241605 TABLE public account mohiuddin`
dump_table_count()  { dump_toc "$1" | grep -c ' TABLE public '  || true; }
dump_policy_count() { dump_toc "$1" | grep -c ' POLICY public ' || true; }
dump_has_table()    { dump_toc "$1" | grep -Fq " TABLE public $2 "; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

file_size_of() {
  if stat -f%z "$1" >/dev/null 2>&1; then stat -f%z "$1"; else stat -c%s "$1"; fi
}

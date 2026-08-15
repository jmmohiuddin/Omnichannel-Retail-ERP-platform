#!/usr/bin/env bash
#
# Content check for a custom-format dump. Answers one question: "if the office
# burned down and this file were all that survived, would the business be in
# it?" — WITHOUT restoring anything.
#
#   ./scripts/backup/verify-dump.sh <dump-file> [baseline-counts-file]
#
# The baseline file (optional, TSV `table<TAB>rowcount`) is written by
# pg-backup.sh from the live database immediately BEFORE the dump starts. When
# supplied, the check becomes an assertion against reality rather than against
# a guess: the ledger tables are append-only, so the dump must contain at least
# as many rows as the source held moments earlier.
#
# Exit 0 = safe to upload/trust. Any other exit = do not trust this file.
set -euo pipefail

cd "$(dirname "$0")"
. ./lib.sh

DUMP="${1:-}"
BASELINE="${2:-}"
[ -n "$DUMP" ] || die "usage: verify-dump.sh <dump-file> [baseline-counts-file]"
[ -f "$DUMP" ] || die "no such dump file: $DUMP"

require_cmd pg_restore awk grep

failures=0
fail() { printf '  FAIL  %s\n' "$*"; failures=$((failures + 1)); }
pass() { printf '  ok    %s\n' "$*"; }

log "verifying $DUMP ($(file_size_of "$DUMP") bytes)"

# 1. Readable archive ------------------------------------------------------
# A truncated or half-written file fails here, before anything else is trusted.
if ! pg_restore --list "$DUMP" >/dev/null 2>&1; then
  die "pg_restore cannot read this archive — it is truncated or corrupt"
fi
pass "archive is readable by pg_restore"

# 2. Structure -------------------------------------------------------------
tables="$(dump_table_count "$DUMP")"
if [ "$tables" -lt "$MIN_TABLE_COUNT" ]; then
  fail "only $tables tables in the dump (floor is $MIN_TABLE_COUNT)"
else
  pass "$tables tables present (floor $MIN_TABLE_COUNT)"
fi

missing=""
for t in "${REQUIRED_TABLES[@]}"; do
  dump_has_table "$DUMP" "$t" || missing="$missing $t"
done
if [ -n "$missing" ]; then
  fail "required tables missing from the dump:$missing"
else
  pass "all ${#REQUIRED_TABLES[@]} required tables present"
fi

# 3. RLS policies ----------------------------------------------------------
# Multi-tenancy IS the row-level security policies (ADR-008). An archive that
# restores tables without them silently produces a database where every tenant
# can read every other tenant — a data breach dressed up as a recovery.
policies="$(dump_policy_count "$DUMP")"
if [ "$policies" -lt 1 ]; then
  fail "no RLS policies in the dump — a restore would drop tenant isolation"
else
  pass "$policies RLS policies present"
fi

# 4. Data ------------------------------------------------------------------
# The check that catches the silent RLS-filtered dump: well-formed, every table
# present, every policy present — and no business in it.
# Counts go to a TSV rather than an associative array: macOS still ships bash
# 3.2, which has no `declare -A`, and the operator running this at 2am during
# an incident is as likely to be on a laptop as on a CI runner.
COUNTS="$(mktemp "${TMPDIR:-/tmp}/omniretail-counts.XXXXXX")"
trap 'rm -f "$TOC_CACHE" "$COUNTS"' EXIT

for t in "${CRITICAL_DATA_TABLES[@]}"; do
  printf '%s\t%s\n' "$t" "$(dump_row_count "$DUMP" "$t")" >> "$COUNTS"
done
rows_of() { awk -v t="$1" -F'\t' '$1 == t { print $2 }' "$COUNTS"; }

# 4a. Against the live source, when pg-backup.sh supplied a baseline.
if [ -n "$BASELINE" ] && [ -f "$BASELINE" ]; then
  for t in "${CRITICAL_DATA_TABLES[@]}"; do
    n="$(rows_of "$t")"
    want="$(awk -v t="$t" -F'\t' '$1 == t { print $2 }' "$BASELINE")"
    [ -n "$want" ] || continue
    if [ "$n" -lt "$want" ]; then
      fail "$t: dump has $n rows, source held $want before the dump started"
    else
      pass "$t: $n rows (source baseline $want)"
    fi
  done
fi

# 4b. Per-table floor. Applies with or without a baseline, and is what stops a
# dump in which the money tables are individually empty — see MONEY_TABLES in
# lib.sh for why the sum is not good enough.
empty=""
for t in "${MONEY_TABLES[@]}"; do
  [ "$(rows_of "$t")" -eq 0 ] && empty="$empty $t"
done

if [ -n "$empty" ]; then
  if [ "${BACKUP_ALLOW_EMPTY:-0}" = "1" ]; then
    warn "no rows in:$empty — BACKUP_ALLOW_EMPTY=1 so continuing"
    pass "empty money tables explicitly allowed"
  else
    fail "ZERO rows in:$empty
        Either the source is not the production database, or the dump was
        taken with a role that RLS filtered to nothing (a dump taken as
        omniretail_app with --enable-row-security looks exactly like this).
        Set BACKUP_ALLOW_EMPTY=1 only for a genuinely fresh install."
  fi
else
  for t in "${MONEY_TABLES[@]}"; do pass "$t: $(rows_of "$t") rows (non-empty)"; done
fi

total_rows="$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$COUNTS")"

# -------------------------------------------------------------------------
echo
if [ "$failures" -ne 0 ]; then
  die "$failures check(s) failed — this dump must NOT be treated as a backup"
fi
log "VERIFIED — $tables tables, $policies policies, $total_rows rows in ledger tables"

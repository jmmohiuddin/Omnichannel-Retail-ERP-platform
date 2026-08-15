#!/usr/bin/env bash
#
# R14.1 — restore drill. An untested backup is not a backup; this script is the
# only thing that makes the claim "we have backups" true.
#
# It restores a backup set into a throwaway database and then proves the result
# is actually usable: the schema is there, the money is there, tenant isolation
# is there, and the application roles can connect. Then it drops the scratch
# database and prints the wall-clock restore time — which is the measured RTO
# evidence the quarterly drill records.
#
#   ./scripts/backup/restore-drill.sh --from <local-set-dir|s3://bucket/key/dir>
#
# Options:
#   --from <path>    backup set directory (contains db.dump, manifest.json)
#   --db <name>      scratch database name (default omniretail_restore_drill)
#   --keep           do not drop the scratch database at the end
#
# Environment:
#   RESTORE_ADMIN_URL   maintenance connection used to CREATE/DROP the scratch
#                       database, e.g. postgresql://user@localhost:5432/postgres
set -euo pipefail

INVOKED_FROM="$PWD"
cd "$(dirname "$0")"
. ./lib.sh

FROM=""
SCRATCH_DB="omniretail_restore_drill"
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="${2:-}"; shift 2 ;;
    --db)   SCRATCH_DB="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$FROM" ] || die "usage: restore-drill.sh --from <set-dir|s3://...> [--db name] [--keep]"

# This script cd's to its own directory, so resolve a relative --from against
# where the operator actually typed it.
case "$FROM" in
  /*|s3://*) : ;;
  *) FROM="$INVOKED_FROM/$FROM" ;;
esac

ADMIN_URL="${RESTORE_ADMIN_URL:-}"
[ -n "$ADMIN_URL" ] || die "RESTORE_ADMIN_URL is required (maintenance connection, e.g. .../postgres)"

require_cmd pg_restore psql createdb dropdb awk

# --- refuse to destroy anything real --------------------------------------
# This script drops and recreates its target. Everything below exists so that
# a mistyped --db can never take out a database someone is using: the shared
# integration-test database and anything that looks like production are hard
# denials, not warnings.
case "$SCRATCH_DB" in
  omniretail_test|omniretail_dev|postgres|template0|template1|*prod*|*neondb*)
    die "refusing to use '$SCRATCH_DB' as a restore target. This script DROPS its
     target database. Pick a scratch name, e.g. omniretail_restore_drill."
    ;;
esac
case "$SCRATCH_DB" in
  *restore*|*drill*|*scratch*) : ;;
  *) die "restore target '$SCRATCH_DB' must contain 'restore', 'drill' or 'scratch'
     so it cannot be confused with a real database." ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/omniretail-restore.XXXXXX")"
cleanup() {
  if [ "$KEEP" -eq 0 ] && [ "${SCRATCH_CREATED:-0}" -eq 1 ]; then
    log "dropping scratch database $SCRATCH_DB"
    dropdb --if-exists --force --maintenance-db="$ADMIN_URL" "$SCRATCH_DB" 2>/dev/null \
      || warn "could not drop $SCRATCH_DB — drop it by hand"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- fetch the set --------------------------------------------------------

SET_DIR="$FROM"
case "$FROM" in
  s3://*)
    require_cmd aws
    log "downloading backup set from $FROM"
    aws s3 cp "$FROM" "$WORK/set" --recursive --only-show-errors \
      || die "could not download the backup set"
    SET_DIR="$WORK/set"
    ;;
esac

[ -d "$SET_DIR" ]                 || die "not a directory: $SET_DIR"
[ -f "$SET_DIR/db.dump" ]         || die "no db.dump in $SET_DIR"
# A set with no manifest is a partial upload — pg-backup.sh writes the manifest
# last precisely so this check is meaningful.
[ -f "$SET_DIR/manifest.json" ]   || die "no manifest.json in $SET_DIR — this is a PARTIAL backup set, do not trust it"

log "restoring set: $(sed -n 's/.*"set": "\([^"]*\)".*/\1/p' "$SET_DIR/manifest.json")"

# --- integrity ------------------------------------------------------------

if [ -f "$SET_DIR/SHA256SUMS" ]; then
  want="$(awk '$2 == "db.dump" { print $1 }' "$SET_DIR/SHA256SUMS")"
  got="$(sha256_of "$SET_DIR/db.dump")"
  [ "$want" = "$got" ] || die "CHECKSUM MISMATCH on db.dump
     expected $want
     actual   $got
     The archive was corrupted in transit or at rest. Use an older set."
  log "checksum OK ($got)"
else
  warn "no SHA256SUMS in the set — cannot verify integrity"
fi

# --- content check before spending time on a restore ----------------------

./verify-dump.sh "$SET_DIR/db.dump" || die "the dump failed its content check"

# --- restore --------------------------------------------------------------

restore_started="$(date -u +%s)"

log "creating scratch database $SCRATCH_DB"
dropdb --if-exists --force --maintenance-db="$ADMIN_URL" "$SCRATCH_DB"
createdb --maintenance-db="$ADMIN_URL" "$SCRATCH_DB" || die "could not create $SCRATCH_DB"
SCRATCH_CREATED=1

# Roles are cluster-scoped: on a fresh disaster-recovery cluster they do not
# exist and every GRANT in the dump would fail. Applying roles.sql first is
# what makes the restore produce a database the application can actually log
# into. On a cluster where they already exist the CREATE ROLE lines error
# harmlessly, so this is not fatal.
if [ -f "$SET_DIR/roles.sql" ]; then
  log "applying roles.sql"
  psql -d "$ADMIN_URL" -v ON_ERROR_STOP=0 -q -f "$SET_DIR/roles.sql" >/dev/null 2>&1 || true
fi

SCRATCH_URL="$(printf '%s' "$ADMIN_URL" | sed -E "s#/[^/?]+(\?|$)#/$SCRATCH_DB\1#")"

log "pg_restore into $SCRATCH_DB"
# Non-fatal errors are expected (ownership/ACL of roles the local cluster maps
# differently); the assertions below, not pg_restore's exit code, decide
# whether the restore is good.
pg_restore --dbname="$SCRATCH_URL" --no-owner --jobs=4 "$SET_DIR/db.dump" \
  > "$WORK/restore.log" 2>&1 || warn "pg_restore reported $(grep -c 'error' "$WORK/restore.log" || echo 0) error line(s) — see below"

restore_seconds=$(( $(date -u +%s) - restore_started ))
log "restore finished in ${restore_seconds}s"

# --- assertions: is the restored database actually usable? ----------------

failures=0
fail() { printf '  FAIL  %s\n' "$*"; failures=$((failures + 1)); }
pass() { printf '  ok    %s\n' "$*"; }

echo
log "verifying the restored database"

# Schema
tables="$(psql "$SCRATCH_URL" -tAX -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")"
if [ "$tables" -lt "$MIN_TABLE_COUNT" ]; then
  fail "restored database has only $tables tables (floor $MIN_TABLE_COUNT)"
else
  pass "$tables tables restored"
fi

missing=""
for t in "${REQUIRED_TABLES[@]}"; do
  psql "$SCRATCH_URL" -tAX -c "SELECT to_regclass('public.$t')" | grep -q . \
    || missing="$missing $t"
done
[ -n "$missing" ] && fail "missing tables:$missing" || pass "all required tables exist"

# Money. Compared against the manifest's baseline — the counts taken from the
# live production database at the moment the dump began.
for t in "${CRITICAL_DATA_TABLES[@]}"; do
  got="$(psql "$SCRATCH_URL" -tAX -c "SELECT count(*) FROM public.$t")"
  want="$(sed -n 's/.*"'"$t"'": \([0-9]*\).*/\1/p' "$SET_DIR/manifest.json" | head -1)"
  if [ -n "$want" ] && [ "$got" != "$want" ]; then
    fail "$t: restored $got rows, manifest recorded $want"
  elif [ -n "$want" ]; then
    pass "$t: $got rows (matches manifest)"
  else
    pass "$t: $got rows"
  fi
done

# Tenant isolation. A restore that loses the RLS policies produces a database
# where every tenant reads every other tenant's data (ADR-008) — worse than no
# restore, because it looks like a success.
policies="$(psql "$SCRATCH_URL" -tAX -c "SELECT count(*) FROM pg_policies WHERE schemaname='public'")"
if [ "$policies" -lt 1 ]; then
  fail "no RLS policies in the restored database — tenant isolation is GONE"
else
  pass "$policies RLS policies restored"
fi

forced="$(psql "$SCRATCH_URL" -tAX -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relforcerowsecurity")"
if [ "$forced" -lt 1 ]; then
  fail "no table has FORCE ROW LEVEL SECURITY — the app role would bypass RLS"
else
  pass "$forced tables have FORCE ROW LEVEL SECURITY"
fi

# Roles
for r in omniretail_app omniretail_worker; do
  if psql "$SCRATCH_URL" -tAX -c "SELECT 1 FROM pg_roles WHERE rolname='$r'" | grep -q 1; then
    pass "role $r exists"
  else
    fail "role $r missing — the application cannot connect to this restore"
  fi
done

# ...and that the app role was actually granted something. A restored database
# where omniretail_app exists but holds no privileges is not a working restore.
grants="$(psql "$SCRATCH_URL" -tAX -c "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='omniretail_app' AND table_schema='public'")"
if [ "$grants" -lt 1 ]; then
  fail "omniretail_app has no table grants in the restore"
else
  pass "omniretail_app holds $grants table grants"
fi

# Migration bookkeeping — a restore the migrator refuses to run against is not
# a restore you can deploy onto.
applied="$(psql "$SCRATCH_URL" -tAX -c "SELECT count(*) FROM public.schema_migrations" 2>/dev/null || echo 0)"
if [ "$applied" -lt 1 ]; then
  fail "schema_migrations is empty — the migrator would try to re-apply everything"
else
  pass "schema_migrations has $applied applied migrations"
fi

# --- verdict --------------------------------------------------------------

echo
if [ "$failures" -ne 0 ]; then
  die "RESTORE DRILL FAILED — $failures assertion(s) failed. This backup set is NOT recoverable."
fi

log "RESTORE DRILL PASSED"
log "  restore wall-clock: ${restore_seconds}s for $tables tables"
log "  record this in docs/runbooks/backup-restore.md §Drill log"
[ "$KEEP" -eq 1 ] && log "  scratch database $SCRATCH_DB kept (--keep)"
exit 0

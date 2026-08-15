#!/usr/bin/env bash
#
# R14.1 — scheduled logical backup of the production database to object storage.
#
#   BACKUP_DATABASE_URL=<schema-owner, DIRECT endpoint> \
#   BACKUP_S3_BUCKET=voltix-backups BACKUP_S3_PREFIX=omniretail_prod \
#   BACKUP_RETENTION_DAYS=35 ./scripts/backup/pg-backup.sh
#
# Produces, per run, one immutable set under
#   s3://$BUCKET/$PREFIX/YYYY/MM/omniretail-<UTC timestamp>/
#     db.dump       pg_dump custom format (compressed, restorable selectively)
#     roles.sql     cluster roles — NOT in db.dump, and without them the
#                   restore's GRANTs fail and the app cannot log in
#     SHA256SUMS    checksums of both
#     manifest.json written LAST; its presence is what marks the set complete
#
# Exits non-zero on any failure, including a partial upload. It will not upload
# a dump that fails the content check — see verify-dump.sh.
set -euo pipefail

cd "$(dirname "$0")"
. ./lib.sh

# --- configuration --------------------------------------------------------

SRC_URL="${BACKUP_DATABASE_URL:-${ADMIN_DATABASE_URL:-}}"
[ -n "$SRC_URL" ] || die "BACKUP_DATABASE_URL (or ADMIN_DATABASE_URL) is required — schema-owner connection"

BUCKET="${BACKUP_S3_BUCKET:-}"
PREFIX="${BACKUP_S3_PREFIX:-omniretail_prod}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-35}"
LOCAL_DIR="${BACKUP_LOCAL_DIR:-}"       # test/dev destination instead of S3
MIN_KEEP="${BACKUP_MIN_KEEP:-3}"        # never prune below this many sets

if [ -z "$BUCKET" ] && [ -z "$LOCAL_DIR" ]; then
  die "set BACKUP_S3_BUCKET (production) or BACKUP_LOCAL_DIR (local drill)"
fi

require_cmd pg_dump pg_dumpall pg_restore psql awk
[ -n "$BUCKET" ] && require_cmd aws

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SET_NAME="omniretail-$STAMP"
KEY_DIR="$PREFIX/$(date -u +%Y/%m)/$SET_NAME"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/omniretail-backup.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

DUMP="$WORK/db.dump"
ROLES="$WORK/roles.sql"
BASELINE="$WORK/baseline.tsv"
MANIFEST="$WORK/manifest.json"
SUMS="$WORK/SHA256SUMS"

log "backup set $SET_NAME -> ${BUCKET:+s3://$BUCKET/}${LOCAL_DIR:+$LOCAL_DIR/}$KEY_DIR"

# --- preflight ------------------------------------------------------------
# Both of these must happen BEFORE the dump: there is no point spending ten
# minutes dumping with a role that cannot see the data.

assert_client_version_ok "$SRC_URL"
assert_dump_role_sees_everything "$SRC_URL"

# --- baseline -------------------------------------------------------------
# Row counts from the live database, taken now, so the content check can
# compare the dump against what the source actually held rather than against a
# hard-coded guess.

log "reading baseline row counts from the source"
: > "$BASELINE"
for t in "${CRITICAL_DATA_TABLES[@]}"; do
  n="$(psql "$SRC_URL" -tAX -c "SELECT count(*) FROM public.$t")" \
    || die "could not count public.$t on the source"
  printf '%s\t%s\n' "$t" "$n" >> "$BASELINE"
done
log "baseline: $(tr '\n' ' ' < "$BASELINE" | tr '\t' '=')"

# --- dump -----------------------------------------------------------------

log "pg_dump (custom format, compressed)"
dump_started="$(date -u +%s)"
pg_dump "$SRC_URL" \
  --format=custom \
  --compress=6 \
  --file="$DUMP" \
  || die "pg_dump failed"
dump_seconds=$(( $(date -u +%s) - dump_started ))
log "pg_dump finished in ${dump_seconds}s ($(file_size_of "$DUMP") bytes)"

# Roles live in the cluster, not the database, so pg_dump does not contain
# them. Restoring db.dump into a fresh cluster without them fails on every
# GRANT to omniretail_app/omniretail_worker and leaves an app that cannot
# connect. --no-role-passwords keeps this working as a non-superuser (managed
# Postgres never gives you superuser) — passwords are set by hand on restore.
log "pg_dumpall --roles-only"
pg_dumpall --dbname="$SRC_URL" --roles-only --no-role-passwords > "$ROLES" \
  || die "pg_dumpall --roles-only failed"

for r in omniretail_app omniretail_worker; do
  grep -qE "CREATE ROLE $r\b" "$ROLES" \
    || warn "roles.sql does not create '$r' — check the source cluster's roles"
done
log "roles.sql captured ($(grep -c 'CREATE ROLE' "$ROLES") roles)"

# --- content check --------------------------------------------------------
# The gate. Nothing is uploaded until this passes.

log "content check"
./verify-dump.sh "$DUMP" "$BASELINE" || die "content check failed — NOT uploading"

# --- checksums + manifest -------------------------------------------------

dump_sha="$(sha256_of "$DUMP")"
roles_sha="$(sha256_of "$ROLES")"
printf '%s  db.dump\n%s  roles.sql\n' "$dump_sha" "$roles_sha" > "$SUMS"

cat > "$MANIFEST" <<JSON
{
  "set": "$SET_NAME",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_role": "$(psql "$SRC_URL" -tAX -c 'SELECT current_user')",
  "source_database": "$(psql "$SRC_URL" -tAX -c 'SELECT current_database()')",
  "server_version": "$(psql "$SRC_URL" -tAX -c 'SHOW server_version')",
  "pg_dump_version": "$(pg_dump --version | sed -E 's/.* ([0-9.]+).*/\1/')",
  "dump_seconds": $dump_seconds,
  "dump_bytes": $(file_size_of "$DUMP"),
  "dump_sha256": "$dump_sha",
  "roles_sha256": "$roles_sha",
  "tables": $(dump_table_count "$DUMP"),
  "policies": $(dump_policy_count "$DUMP"),
  "baseline_counts": {$(awk -F'\t' 'NR>1{printf ", "} {printf "\"%s\": %s", $1, $2}' "$BASELINE")},
  "retention_days": $RETENTION_DAYS
}
JSON
log "manifest written"

# --- upload ---------------------------------------------------------------
# manifest.json goes LAST and is the completion marker: a set without one is a
# partial upload and restore tooling must ignore it. Every object is verified
# against its local size after transfer, because `aws s3 cp` exiting 0 is not
# by itself proof the bytes landed.

put() {
  local file="$1" name="$2" local_size remote_size
  local_size="$(file_size_of "$file")"

  if [ -n "$BUCKET" ]; then
    aws s3 cp "$file" "s3://$BUCKET/$KEY_DIR/$name" --only-show-errors \
      || die "upload failed: $name"
    remote_size="$(aws s3api head-object --bucket "$BUCKET" --key "$KEY_DIR/$name" \
      --query ContentLength --output text)" \
      || die "uploaded $name but could not read it back — treat as partial"
  else
    mkdir -p "$LOCAL_DIR/$KEY_DIR"
    cp "$file" "$LOCAL_DIR/$KEY_DIR/$name" || die "copy failed: $name"
    remote_size="$(file_size_of "$LOCAL_DIR/$KEY_DIR/$name")"
  fi

  [ "$remote_size" = "$local_size" ] \
    || die "PARTIAL UPLOAD of $name: local $local_size bytes, stored $remote_size"
  log "uploaded $name ($local_size bytes, verified)"
}

put "$DUMP"     db.dump
put "$ROLES"    roles.sql
put "$SUMS"     SHA256SUMS
put "$MANIFEST" manifest.json      # completion marker — must stay last

# --- retention ------------------------------------------------------------
# Disaster-recovery rotation ONLY. This is NOT the UAE statutory record
# retention control (R7.12: 5 years general / 10 years capital-asset-scheme) —
# see docs/runbooks/backup-restore.md §Retention. Deleting a backup set is
# destructive and irreversible, so it refuses to drop below MIN_KEEP sets.

if [ -n "$BUCKET" ] && [ "$RETENTION_DAYS" -gt 0 ]; then
  log "retention: pruning sets older than ${RETENTION_DAYS}d (keeping >= $MIN_KEEP)"

  cutoff="$(date -u -d "-${RETENTION_DAYS} days" +%Y%m%dT%H%M%SZ 2>/dev/null \
    || date -u -v-"${RETENTION_DAYS}"d +%Y%m%dT%H%M%SZ)"

  all_sets="$(aws s3 ls "s3://$BUCKET/$PREFIX/" --recursive \
    | awk '{print $4}' | grep '/manifest\.json$' | sed 's#/manifest\.json$##' \
    | sed 's#.*/##' | sort -u || true)"
  total="$(printf '%s\n' "$all_sets" | grep -c . || true)"
  old="$(printf '%s\n' "$all_sets" | awk -v c="omniretail-$cutoff" '$0 < c && NF')"
  old_count="$(printf '%s\n' "$old" | grep -c . || true)"

  if [ "$old_count" -eq 0 ]; then
    log "retention: nothing older than the cutoff"
  elif [ $((total - old_count)) -lt "$MIN_KEEP" ]; then
    warn "retention: pruning $old_count of $total sets would leave fewer than
     $MIN_KEEP — refusing to prune. Investigate why backups stopped."
  else
    while read -r s; do
      [ -n "$s" ] || continue
      key="$(aws s3 ls "s3://$BUCKET/$PREFIX/" --recursive \
        | awk '{print $4}' | grep "/$s/manifest\.json$" | sed 's#/manifest\.json$##' | head -1)"
      [ -n "$key" ] || continue
      aws s3 rm "s3://$BUCKET/$key" --recursive --only-show-errors \
        || warn "could not prune $key"
      log "pruned $key"
    done <<< "$old"
  fi
fi

echo
log "BACKUP OK — $SET_NAME"
log "  dump   $(file_size_of "$DUMP") bytes, sha256 $dump_sha"
log "  where  ${BUCKET:+s3://$BUCKET/}${LOCAL_DIR:+$LOCAL_DIR/}$KEY_DIR"
log "  restore: ./scripts/backup/restore-drill.sh --from <that path>"

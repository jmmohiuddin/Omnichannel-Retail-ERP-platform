#!/usr/bin/env bash
#
# Print the S3 URI of the most recent COMPLETE backup set.
#
#   BACKUP_S3_BUCKET=voltix-backups BACKUP_S3_PREFIX=omniretail_prod \
#     ./scripts/backup/latest-set.sh
#
# "Complete" means the set has a manifest.json — pg-backup.sh uploads that last,
# so a set without one is a backup that died mid-upload. Restoring the newest
# directory name without this distinction is how an incident turns into a
# second incident.
#
#   ./scripts/backup/restore-drill.sh --from "$(./scripts/backup/latest-set.sh)"
set -euo pipefail

cd "$(dirname "$0")"
. ./lib.sh

BUCKET="${BACKUP_S3_BUCKET:-}"
PREFIX="${BACKUP_S3_PREFIX:-omniretail_prod}"
[ -n "$BUCKET" ] || die "BACKUP_S3_BUCKET is required"

require_cmd aws

# Set names are omniretail-<UTC timestamp>, so lexical sort == chronological.
latest="$(aws s3 ls "s3://$BUCKET/$PREFIX/" --recursive \
  | awk '{print $4}' \
  | grep '/manifest\.json$' \
  | sed 's#/manifest\.json$##' \
  | sort \
  | tail -1)"

[ -n "$latest" ] || die "no complete backup set found under s3://$BUCKET/$PREFIX/
     (sets without a manifest.json are partial uploads and are ignored)"

printf 's3://%s/%s\n' "$BUCKET" "$latest"

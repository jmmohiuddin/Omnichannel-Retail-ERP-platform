#!/usr/bin/env bash
#
# Pre-deploy gate. Run this BEFORE `vercel deploy --prod` for the API.
# It refuses to pass if the target database is missing any migration the
# committed code will reference — the exact drift that once broke production.
#
#   ADMIN_DATABASE_URL=<direct, non-pooler Neon URL> ./scripts/deploy-check.sh
#
# Use the DIRECT endpoint (not the pooler) so the migrator's session advisory
# lock holds — the pooler runs PgBouncer in transaction mode.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${ADMIN_DATABASE_URL:-}" ]; then
  echo "ADMIN_DATABASE_URL (schema-owner, direct endpoint) is required" >&2
  exit 1
fi

echo "1/4 building db package"
npx -y pnpm --filter @omniretail/db build >/dev/null

echo "2/4 static migration file check"
node packages/db/dist/verify.js

echo "3/4 applying any pending migrations to the target"
DATABASE_URL="$ADMIN_DATABASE_URL" node packages/db/dist/migrate.js

echo "4/4 asserting the target is in sync with sql/ (no drift)"
DATABASE_URL="$ADMIN_DATABASE_URL" node packages/db/dist/verify.js --applied

echo ""
echo "OK — database is in sync with the committed migrations. Safe to deploy."

# Runbook: database backup & restore (R14.1)

**Audience:** whoever is awake when it breaks. This assumes you did not write any
of it. Follow it top to bottom; do not improvise.

**Requirement:** R14.1 — *"Database backups — PITR or scheduled dumps to object
storage. **AUDIT:** none exist. Rated the single highest operational risk: a
dropped table ends the business."*
**Targets (PRD §11):** RPO ≤ 1 hour, RTO ≤ 4 hours, restore drill quarterly.

> **Status of this document.** It describes what is actually in the repository
> and what has actually been run. Where something is unverified or must be done
> by hand in a dashboard, it says so. `docs/security/01-security-architecture.md`
> §10 describes a much richer DR design (pgBackRest/WAL-G, cross-region WAL,
> streaming replica promotion, monthly automated drills). **None of that exists.**
> Treat §10 as the target architecture and this runbook as the current reality.

---

## 1. In an emergency, start here

```bash
# 1. Find the newest complete backup set.
export BACKUP_S3_BUCKET=<bucket> BACKUP_S3_PREFIX=omniretail_prod
./scripts/backup/latest-set.sh
# -> s3://<bucket>/omniretail_prod/2026/08/omniretail-20260814T0300Z

# 2. Prove it is restorable BEFORE you touch anything in production.
export RESTORE_ADMIN_URL=postgresql://<superuser>@<scratch-host>:5432/postgres
./scripts/backup/restore-drill.sh --from "$(./scripts/backup/latest-set.sh)"
```

If step 2 prints `RESTORE DRILL PASSED`, that backup is good and you can plan the
real restore (§6). If it fails, **do not delete or overwrite anything** — go to
§6.4 and try Neon PITR instead, which is usually both faster and fresher.

**Do not** restore over the live database as a first move. Restore into a new
database, verify it, then cut over.

---

## 2. The one thing that must not go wrong

A backup that looks fine and restores an empty database is worse than no backup,
because it stops you looking for a real one.

This database is multi-tenant via row-level security (ADR-008). The runtime role
`omniretail_app` is under **FORCE ROW LEVEL SECURITY**, and `current_tenant_id()`
fails **closed** — migration 016 deliberately made an unset `app.tenant_id` match
*no rows* rather than raise an error. Measured on the test database, as the app
role:

```
blinded tables: 56 of 59
sales_order    0 rows
payment        0 rows
stock_movement 0 rows
```

Zero rows, no error. That is the correct behaviour for the application and a
catastrophe for a backup.

Modern `pg_dump` partly protects you: run as `omniretail_app` it *errors* with
`query would be affected by row-level security policy for table "account"`. The
trap is the obvious-looking fix — someone hits that error, searches, finds
`--enable-row-security`, adds it, and gets **exit code 0 and a well-formed dump
containing none of the business**. That has been reproduced here; it is not
theoretical.

Three independent defences, all in `scripts/backup/`:

1. **Role name deny-list** — `pg-backup.sh` refuses to run as `omniretail_app`
   or `omniretail_worker` at all.
2. **RLS exposure check** — it asks the catalog whether the connected role is
   filtered by RLS on *any* public table (accounting for superuser, `BYPASSRLS`,
   ownership and `FORCE`), and refuses if the answer is anything but zero. This
   catches a badly-configured role that isn't on the deny-list by name.
3. **Content check** — `verify-dump.sh` reads the finished archive and requires
   `sales_order`, `payment` and `stock_movement` each to be non-empty
   *individually*, plus a comparison against row counts taken from the live
   database moments before the dump began. Nothing is uploaded until this passes.

> Defence 3 is checked per-table for a reason. The first version of this check
> summed rows across the critical tables, and the deliberately-broken dump passed
> it: all three money tables were empty, but `tenant` (not force-RLS) contributed
> 1195 rows to the total and the check printed `VERIFIED`. Every sale, payment and
> stock movement in the business was missing. **Never aggregate this check.**

`BACKUP_ALLOW_EMPTY=1` overrides defence 3. Set it only for a genuinely fresh
install, never on a hunch that "the check is being flaky".

---

## 3. What runs, when, and where it lands

| | |
|---|---|
| **What** | `.github/workflows/backup.yml` → `scripts/backup/pg-backup.sh` |
| **When** | Hourly, on the hour (UTC) |
| **Source** | Production Neon, **schema-owner** role, **direct** (non-pooler) endpoint |
| **Destination** | `s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/YYYY/MM/omniretail-<UTC>/` |
| **Retention** | `BACKUP_RETENTION_DAYS` (default 35) — **disaster recovery only**, see §8 |

Each run produces one immutable set:

| Object | What it is | Why it matters |
|---|---|---|
| `db.dump` | `pg_dump --format=custom --compress=6` | The data and schema |
| `roles.sql` | `pg_dumpall --roles-only --no-role-passwords` | **Roles are cluster-scoped and are NOT in `db.dump`.** Restore without them and every `GRANT` fails and the app cannot log in |
| `SHA256SUMS` | checksums of both | Detects rot and truncation |
| `manifest.json` | set name, timestamps, source role/db/version, sizes, table & policy counts, pre-dump row counts | The restore asserts against these counts |

**`manifest.json` is uploaded last, deliberately.** Its presence is the marker
that the set is complete. A set without one is a backup that died mid-upload;
`latest-set.sh` ignores such sets and `restore-drill.sh` refuses them.

### Why GitHub Actions and not Vercel Cron

The repo already has a scheduler (`vercel.json` `crons` → `api/cron/*`). It is
the wrong tool here, for three independent reasons:

- Vercel's Node runtime has no `pg_dump` binary and cannot be given one — the
  dump is a native client, not an npm package.
- Those functions cap at 30–60s (`vercel.json`). A full logical dump of a growing
  retail database will not fit in that budget, and a backup that times out at 3am
  is a backup you do not have.
- Hobby plan cron is capped at once per day (`docs/05-deployment-guide.md` §5),
  which cannot meet RPO ≤ 1h at all.

GitHub Actions has none of those limits, ships Postgres client tooling, and —
the real point — keeps the recovery path **independent of the platform hosting
the thing that just broke**.

---

## 4. RPO and RTO: what is actually met

| Target | Met? | By what |
|---|---|---|
| **RPO ≤ 1 h** | **Yes — by Neon PITR, not by the dumps** | See §5 |
| **RTO ≤ 4 h** | **Yes, with large margin, at current data volume** | Measured below |
| Quarterly drill | Yes | `.github/workflows/restore-drill.yml`, §10 |

**Be precise about which control meets RPO.** GitHub's scheduled events are
best-effort: runs can be delayed by tens of minutes under load, and can be
dropped entirely. Hourly dumps therefore give an RPO of *roughly* one hour but
cannot be relied on at the boundary. **Neon's PITR is what meets RPO ≤ 1h.** The
dumps exist to survive the failure PITR cannot: loss of the Neon project itself
(account compromise, billing lapse, an errant project delete, provider-side
loss). Two controls, two different disasters — you need both.

### Measured, 2026-08-14

Against the local `omniretail_test` database (Postgres 16, 33 MB, 62 tables,
1195 tenants, 9,872 rows across the ledger tables):

| Phase | Wall clock |
|---|---|
| `pg_dump` (custom, `-Z6`) → 3,910,716 bytes | < 1 s |
| Content check on the archive | ~1 s |
| Full `restore-drill.sh` (checksum → verify → createdb → roles → `pg_restore -j4` → 12 assertions → drop) | **1 s** |

**These numbers are honest but small.** A 33 MB database says nothing reliable
about a 33 GB one, and this ran over a local Unix socket, not across the public
internet to Neon in `ap-southeast-2`. The RTO ≤ 4h claim is credible at current
volume with enormous headroom, but the number that matters is the one the
**quarterly drill measures against the real production set** (§10). Record it.

---

## 5. Neon point-in-time restore

Verified from Neon's documentation on 2026-08-14
(<https://neon.com/docs/introduction/point-in-time-restore>):

| Plan | History window (PITR reach) |
|---|---|
| Free | 6 hours |
| Paid plans, default | 1 day |
| Launch, maximum | 7 days |
| Scale, maximum | 30 days |

Neon retains a change history for the project and lets you either roll a branch
back in place ("instant restore") or open a **new branch** at a past timestamp.
The window is a project-wide setting; widening it increases storage cost.

**What this gives us:** restore to any second within the window, in minutes,
with effectively zero data loss. That is what satisfies RPO ≤ 1h — and it
comfortably satisfies it on *every* tier, since even the Free tier's 6-hour
window is six times the required RPO.

**What it does not give us:** anything at all if the Neon project, organisation
or account is gone. PITR lives inside the thing you are trying to recover from.
Hence §3.

> **OPEN — must be confirmed by the account owner.** Which Neon plan this project
> is on, and what its history window is actually set to, cannot be determined
> from the repository. If it is on Free, the PITR reach is **6 hours** and any
> incident discovered on a Monday morning after a Friday-night corruption is
> outside the window — the S3 dumps would be the only recourse. See §9 step 1.

---

## 6. Restoring

### 6.0 Before anything

- Announce it. A restore is not a silent operation.
- Decide the target: **never** the live database as a first move.
- Note the time you are restoring *to*. Write it down.

### 6.1 Choose the tool

| Situation | Use |
|---|---|
| Bad migration, bad bulk import, dropped table, discovered **within the PITR window** | **Neon PITR (§6.4)** — faster, fresher, no data loss |
| Corruption discovered **outside** the PITR window | S3 dump (§6.2) |
| Neon project/account gone, or you need the data somewhere else entirely | S3 dump (§6.2) |
| One tenant's data damaged, everyone else fine | §6.5 |

### 6.2 Restore an S3 dump into a fresh database

```bash
export BACKUP_S3_BUCKET=<bucket> BACKUP_S3_PREFIX=omniretail_prod
export RESTORE_ADMIN_URL=postgresql://<owner>@<host>:5432/postgres

SET="$(./scripts/backup/latest-set.sh)"        # or paste an older set URI
./scripts/backup/restore-drill.sh --from "$SET" --keep --db omniretail_restore_prod
```

`--keep` leaves the restored database in place instead of dropping it. The script
refuses any target that is not obviously a scratch name, and hard-refuses
`omniretail_test`, `omniretail_dev`, `postgres` and anything matching `*prod*` or
`*neondb*` — it **drops its target**, so this guard is load-bearing.

It will not proceed unless: the checksum matches, the archive passes the content
check, and — after restoring — the schema, the money row counts, the RLS policies,
`FORCE ROW LEVEL SECURITY`, both application roles, `omniretail_app`'s grants and
`schema_migrations` all check out. Twelve assertions; any failure is fatal.

Then, before cutting over:

1. Set the runtime role passwords — `roles.sql` is captured with
   `--no-role-passwords` (the schema owner is not a superuser on managed
   Postgres, so it cannot read `pg_authid`):
   ```bash
   psql "$RESTORE_URL" -c "ALTER ROLE omniretail_app PASSWORD '<strong>';"
   psql "$RESTORE_URL" -c "ALTER ROLE omniretail_worker PASSWORD '<strong>';"
   ```
2. Run the drift guard against the restored database:
   ```bash
   ADMIN_DATABASE_URL=<restored, direct endpoint> ./scripts/deploy-check.sh
   ```
3. **Isolation smoke test** — two tenants, cross-read must be empty. A restore
   that lost the RLS policies is a data breach wearing a recovery's clothes. The
   drill asserts the policies exist; this confirms they *work*.
4. Repoint `DATABASE_URL` / `WORKER_DATABASE_URL` and redeploy.

### 6.3 Restoring a single table

You do not need the whole database back to recover one dropped table:

```bash
aws s3 cp "$SET/db.dump" ./db.dump
pg_restore --data-only --table=sales_order -d "$TARGET_URL" ./db.dump
```

Restore into a scratch database first and copy the rows across. Never
`--clean` against production.

### 6.4 Neon PITR

Dashboard only; there is nothing in this repo that can do it.

1. Neon console → the project → **Branches**.
2. Create a **new branch** from the production branch at the chosen timestamp.
   Prefer a new branch over an in-place restore: it is non-destructive and lets
   you inspect before committing.
3. Take its connection string, point a staging API at it, verify the data.
4. Cut over by repointing `DATABASE_URL`, or copy the specific rows back.

Reach is bounded by the history window (§5). **Check the window before promising
anyone a recovery point.**

### 6.5 One tenant only

Restore to a scratch database (§6.2), then extract just that tenant. Every table
carrying tenant data has `tenant_id`:

```sql
-- run as the schema OWNER on the scratch database; the app role cannot see
-- across tenants, which is the entire point of the design
\copy (SELECT * FROM sales_order WHERE tenant_id = '<uuid>') TO 'so.csv' CSV HEADER
```

Reinsert in FK dependency order, and remember that inventory is a ledger
(ADR-002): re-insert `stock_movement` rows and let stock levels derive. Never
write a quantity column directly.

---

## 7. Client versions

`pg_dump` refuses to dump a server newer than itself; `pg_restore` cannot read an
archive from a newer major. Managed Postgres is upgraded on the provider's
schedule, so this **will** drift out from under you.

- `pg-backup.sh` reads `server_version_num` and aborts with a clear message if
  the client is too old. It does not guess.
- The workflows install `postgresql-client-${{ vars.PG_MAJOR }}` from PGDG, and
  the drill's Postgres service container uses the same variable so the two
  cannot diverge.
- **When Neon upgrades the major version, update the `PG_MAJOR` repo variable.**
  That is the single thing to change.

`docs/00-product-technical-master-document.md` records production as **Neon
PostgreSQL 18 (ap-southeast-2)**, so `PG_MAJOR` should be `18` (the workflow
default). *I could not connect to production to confirm this — treat it as
documented, not verified, and check `pg_dump --version` against the first
workflow run's log.*

---

## 8. Retention: two different clocks

**Do not confuse these. They are not the same control and one does not satisfy
the other.**

### 8a. Disaster-recovery rotation — `BACKUP_RETENTION_DAYS`, default 35

Operational only: how far back you can roll to escape corruption. 35 days is
sensible and is what `pg-backup.sh` prunes to. Pruning refuses to drop below
`BACKUP_MIN_KEEP` (default 3) sets, so a run of failed backups cannot combine
with retention to leave you holding nothing.

### 8b. Statutory record retention — PRD R7.12 — **not satisfied by 8a**

> Record retention: **5 years general, 10 years for capital-asset-scheme
> records**, extensible by up to 4 further years while an audit or dispute is
> open (+1 year where a voluntary disclosure is filed in year 5). Records must be
> retained and retrievable by the FTA; offshore or cloud hosting is permitted
> provided retrievability.

A 35-day rotation deletes the evidence roughly 1,790 days early. **Nothing in
this repository satisfies R7.12.** Anyone reading "we have backups with 35-day
retention" and concluding the FTA obligation is handled would be wrong.

What R7.12 needs, and does not have (**OPEN**):

- A separate archival tier — e.g. monthly/annual sets to a bucket with a 10-year
  lifecycle and Object Lock (WORM), so a compromised key cannot erase them.
- Retrievability for the whole period, which means the *readability* of a
  10-year-old `pg_dump` custom archive is itself a risk (`pg_restore` from a
  Postgres major a decade newer is not guaranteed). A plain-SQL or CSV export
  alongside the binary archive is the usual answer.
- A documented owner and an FTA retrieval procedure.

This is a real Phase-1 work item, not a footnote. Track it separately from R14.1.

> **OPEN — data residency.** Production is in Neon `ap-southeast-2` (Sydney),
> while `docs/08-uae-localization.md` §6 and `docs/05-deployment-guide.md` call
> for UAE residency (AWS `me-central-1` / Azure UAE North). The backup bucket
> region (`BACKUP_AWS_REGION`, defaulted to `me-central-1` in the workflows)
> should be chosen deliberately against that requirement, and the discrepancy
> between the stated requirement and the actual production region needs a
> decision from the owner. R7.12 permits offshore hosting given retrievability,
> so this may be acceptable — but it should be an explicit choice, recorded.

---

## 9. Owner setup checklist — must be done by hand

**None of this can be done from the repository.** Until every step is complete,
the hourly workflow will run and fail, and there are no backups.

1. **Confirm the Neon plan and history window.** Neon console → project →
   Settings → *History retention* (or *Restore window*). Record the value in §11
   below. If it is 6 hours (Free), decide whether that is acceptable and, if not,
   upgrade. This determines the PITR half of the RPO claim.
2. **Create the S3 bucket** (region per §8's residency note). Enable:
   - **Versioning** — so an overwrite is recoverable.
   - **Default encryption** (SSE-KMS with a customer-managed key; the security
     architecture asks for a key distinct from the application's).
   - **Block all public access.**
   - A **lifecycle rule** matching `BACKUP_RETENTION_DAYS`. Server-side lifecycle
     is the primary retention control — it cannot be broken by a bug in the
     script.
   - Consider **Object Lock (compliance mode)** for the archival tier in §8b.
3. **Create an IAM principal** limited to `s3:PutObject`, `s3:GetObject`,
   `s3:ListBucket`, `s3:DeleteObject` on that bucket **and nothing else**.
   Prefer a GitHub OIDC role over long-lived keys; if using keys, plan rotation.
4. **Create a dedicated backup database role** in Neon. It must be able to read
   every table — practically, the schema owner or a role that owns the tables.
   It must **not** be `omniretail_app` or `omniretail_worker` (§2). Use the
   **direct**, non-pooler endpoint.
5. **Set GitHub repository secrets** (Settings → Secrets and variables → Actions):
   - `BACKUP_DATABASE_URL` — the §9.4 role, direct endpoint
   - `BACKUP_AWS_ACCESS_KEY_ID`, `BACKUP_AWS_SECRET_ACCESS_KEY`
6. **Set GitHub repository variables:**
   - `BACKUP_S3_BUCKET`, `BACKUP_S3_PREFIX` (e.g. `omniretail_prod`)
   - `BACKUP_AWS_REGION`, `BACKUP_RETENTION_DAYS`
   - `PG_MAJOR` — production's Postgres major (§7)
7. **Run `Database backup (R14.1)` manually** (Actions → Run workflow) and read
   the log. Confirm the client version line, the role check line, and that the
   row counts are non-zero and plausible.
8. **Run `Restore drill (R14.1)` manually.** Do not consider R14.1 done until
   this passes against a real production set. Record the result in §11.
9. **Set up failure alerting.** Scheduled-workflow failures email the repo owner
   by default, which is weak. Route it somewhere someone actually watches — the
   same place `inventory.drift.detected` goes (`docs/05` §4).
10. **Add a "no recent backup" alarm.** A workflow that stops being scheduled
    fails *silently* — there is no failure to notify anyone about. Alert if the
    newest object under the prefix is more than ~3 hours old. This is the gap
    most likely to bite; treat it as required, not optional.

---

## 10. The quarterly drill

Automated: `.github/workflows/restore-drill.yml`, 04:00 UTC on the 1st of
January, April, July and October, plus manual dispatch. It pulls the newest
complete production set, restores it into a throwaway Postgres, runs all twelve
assertions and prints the wall-clock time to the job summary.

To run it by hand:

```
Actions → "Restore drill (R14.1)" → Run workflow
```

Or locally against a scratch database:

```bash
export RESTORE_ADMIN_URL=postgresql://<superuser>@localhost:5432/postgres
export BACKUP_S3_BUCKET=<bucket> BACKUP_S3_PREFIX=omniretail_prod
./scripts/backup/restore-drill.sh --from "$(./scripts/backup/latest-set.sh)"
```

**A drill is only finished when the result is written down.** Record it below —
an unrecorded drill does not satisfy PRD §11, and the trend in restore time is
the early warning that RTO is drifting.

### Drill log

| Date | Backup set | Source | Dump size | Restore time | Result | Run by | Notes |
|---|---|---|---|---|---|---|---|
| 2026-08-14 | `omniretail-20260814T030357Z` | **local `omniretail_test`, not production** | 4.0 MB | **< 1 s** | PASS — 62 tables, 70 policies, 2219/2229/5052 rows, both roles, 248 grants, 33 migrations | Agent C (R14.1 build) | Tooling validation only. **Does not count as the quarterly drill** — that requires a real production set, after §9. Source was being written to concurrently by other test runs; the restored counts still matched the manifest exactly, which is what the pre-dump baseline is for. |
| | | | | | | | |
| | | | | | | | |

---

## 11. Facts to fill in

These cannot be determined from the repository. Fill them in and keep them current
— at 2am nobody wants to discover this table is empty.

| | |
|---|---|
| Neon plan | **OPEN** — §9.1 |
| Neon history window (PITR reach) | **OPEN** — §9.1 |
| Neon project / branch | **OPEN** |
| Production Postgres major | Documented as **18**; unverified — §7 |
| Backup bucket + region | **OPEN** — §9.2 |
| Primary on-call | **OPEN** |
| Escalation (DB owner) | **OPEN** |
| Neon support channel / plan tier | **OPEN** |
| Last successful production backup | **OPEN** — none yet; §9 is not done |
| Last quarterly drill | **None against production** — see §10 |

---

## 12. Known gaps

Stated plainly, because a runbook that overstates its coverage is worse than one
that admits a gap.

1. **Nothing is running yet.** The workflows are committed but the secrets and
   variables in §9 are not set. **There are currently no production backups.**
   R14.1 is not closed until §9 is done and §9.7–9.8 have passed.
2. **A silently unscheduled workflow is undetected** until §9.10 exists. This is
   the most likely way this system quietly stops working.
3. **Statutory retention (R7.12) is unsatisfied.** §8b.
4. **Logical dumps only.** No WAL archiving of our own; between hourly dumps we
   depend entirely on Neon's PITR. The §10 design in the security architecture
   (pgBackRest/WAL-G, cross-region) is not built.
5. **RTO is measured at 33 MB**, not at production scale. §4.
6. **Redis is not backed up** — by design; jobs are re-enqueued from the `outbox`
   table (`docs/security` §10). Worth re-confirming when the worker is deployed.
7. **POS offline queues are not covered here.** A till holding unsynced sales is
   its own data-loss surface (ADR-007) and is out of scope for R14.1.
8. **The backup is not restore-tested against a *different* Postgres major**,
   which is the scenario after a Neon upgrade. The drill uses `PG_MAJOR` for both
   sides.

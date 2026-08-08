/**
 * Migration verification — the guard against the failure class where committed
 * code references a table that never got migrated onto a target database (which
 * is exactly what silently broke a live deployment once).
 *
 * Two modes:
 *   verifyMigrationFiles(dir)  — STATIC. No DB. Checks the sql/ directory is a
 *     clean, gap-free, uniquely-numbered sequence. Runs in CI on every push.
 *   verifyMigrationsApplied(url, dir) — DYNAMIC. Compares files on disk to the
 *     schema_migrations table on a target DB and reports drift in BOTH
 *     directions (a file not applied → "behind"; an applied row with no file →
 *     "unknown"). Run this against staging/prod BEFORE a deploy.
 *
 * Usage:
 *   node dist/verify.js                       # static check of the bundled sql/
 *   DATABASE_URL=... node dist/verify.js --applied
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const defaultDir = () => join(here, "..", "sql");

const MIGRATION_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;

export interface FileCheck {
  ok: boolean;
  files: string[];
  problems: string[];
}

/** Static structural check — no database needed. */
export function verifyMigrationFiles(sqlDir = defaultDir()): FileCheck {
  const all = readdirSync(sqlDir);
  const migrations = all.filter((f) => f.endsWith(".sql")).sort();
  const problems: string[] = [];

  const numbers: number[] = [];
  for (const file of migrations) {
    const m = MIGRATION_RE.exec(file);
    if (!m) {
      problems.push(
        `'${file}' does not match NNN_snake_case.sql — migrations must be strictly named`,
      );
      continue;
    }
    numbers.push(Number(m[1]));
  }

  // Gaps and duplicates. The runner applies in lexical order; a gap usually
  // means a file was renamed or lost, a dup means two features grabbed the
  // same number in parallel branches (the connector agents nearly did this).
  const seen = new Set<number>();
  for (let i = 0; i < numbers.length; i++) {
    const n = numbers[i]!;
    if (seen.has(n)) problems.push(`duplicate migration number ${String(n).padStart(3, "0")}`);
    seen.add(n);
  }
  const sorted = [...numbers].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! !== sorted[i - 1]! + 1 && sorted[i]! !== sorted[i - 1]!) {
      problems.push(
        `gap in migration sequence: ${String(sorted[i - 1]).padStart(3, "0")} → ${String(sorted[i]).padStart(3, "0")}`,
      );
    }
  }
  if (sorted.length > 0 && sorted[0] !== 1) {
    problems.push(`migrations must start at 001, found ${String(sorted[0]).padStart(3, "0")}`);
  }

  return { ok: problems.length === 0, files: migrations, problems };
}

export interface DriftReport {
  ok: boolean;
  applied: string[];
  onDisk: string[];
  behind: string[]; // on disk, not applied — deploy would break
  unknown: string[]; // applied, no file — DB ahead of code, or wrong DB
  checksumMismatches: string[]; // applied file edited after the fact
}

/** Dynamic drift check against a live database. */
export async function verifyMigrationsApplied(
  databaseUrl: string,
  sqlDir = defaultDir(),
): Promise<DriftReport> {
  const files = readdirSync(sqlDir)
    .filter((f) => MIGRATION_RE.test(f))
    .sort();
  const checksums = new Map(
    files.map((f) => [f, createHash("sha256").update(readFileSync(join(sqlDir, f), "utf8")).digest("hex")]),
  );

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let appliedRows: { filename: string; checksum: string }[] = [];
  try {
    const exists = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
    );
    if (exists.rows[0]?.exists) {
      const res = await client.query<{ filename: string; checksum: string }>(
        "SELECT filename, checksum FROM schema_migrations",
      );
      appliedRows = res.rows;
    }
  } finally {
    await client.end();
  }

  const appliedSet = new Map(appliedRows.map((r) => [r.filename, r.checksum]));
  const onDisk = files;
  const behind = onDisk.filter((f) => !appliedSet.has(f));
  const unknown = [...appliedSet.keys()].filter((f) => !checksums.has(f));
  const checksumMismatches = onDisk.filter(
    (f) => appliedSet.has(f) && appliedSet.get(f) !== checksums.get(f),
  );

  return {
    ok: behind.length === 0 && unknown.length === 0 && checksumMismatches.length === 0,
    applied: appliedRows.map((r) => r.filename).sort(),
    onDisk,
    behind,
    unknown,
    checksumMismatches,
  };
}

const isMain = process.argv[1]?.endsWith("verify.js") || process.argv[1]?.endsWith("verify.ts");
if (isMain) {
  const applied = process.argv.includes("--applied");
  if (applied) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error("DATABASE_URL is required for --applied");
      process.exit(1);
    }
    verifyMigrationsApplied(url)
      .then((r) => {
        if (r.ok) {
          console.log(`migrations in sync: ${r.applied.length} applied, ${r.onDisk.length} on disk`);
          return;
        }
        console.error("MIGRATION DRIFT DETECTED — do not deploy:");
        if (r.behind.length) console.error(`  behind (not applied): ${r.behind.join(", ")}`);
        if (r.unknown.length) console.error(`  unknown (DB ahead / wrong DB): ${r.unknown.join(", ")}`);
        if (r.checksumMismatches.length) console.error(`  checksum mismatch: ${r.checksumMismatches.join(", ")}`);
        process.exit(1);
      })
      .catch((err) => {
        console.error(err.message);
        process.exit(1);
      });
  } else {
    const r = verifyMigrationFiles();
    if (r.ok) {
      console.log(`migration files OK: ${r.files.length} in a clean 001..${String(r.files.length).padStart(3, "0")} sequence`);
    } else {
      console.error("migration file problems:");
      for (const p of r.problems) console.error(`  - ${p}`);
      process.exit(1);
    }
  }
}

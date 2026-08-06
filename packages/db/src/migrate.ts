/**
 * Minimal SQL-first migration runner.
 *
 * Applies packages/db/sql/NNN_*.sql in filename order, tracking applied files in
 * schema_migrations. Each migration runs in its own transaction. Never edits or
 * re-runs an applied file; a changed checksum for an applied file aborts loudly.
 *
 * Usage: DATABASE_URL=postgres://... node dist/migrate.js [--dir <sqlDir>]
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(databaseUrl: string, sqlDir?: string): Promise<string[]> {
  const dir = sqlDir ?? join(here, "..", "sql");
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ filename: string; checksum: string }>(
      "SELECT filename, checksum FROM schema_migrations",
    );
    const seen = new Map(rows.map((r) => [r.filename, r.checksum]));

    for (const file of files) {
      const sql = readFileSync(join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = seen.get(file);
      if (prior !== undefined) {
        if (prior !== checksum) {
          throw new Error(
            `${file} was modified after being applied (checksum mismatch). ` +
              "Add a new migration instead of editing an applied one.",
          );
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [file, checksum],
        );
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

const isMain = process.argv[1]?.endsWith("migrate.js") || process.argv[1]?.endsWith("migrate.ts");
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const dirFlag = process.argv.indexOf("--dir");
  migrate(url, dirFlag > -1 ? process.argv[dirFlag + 1] : undefined)
    .then((applied) => {
      console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

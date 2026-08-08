import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyMigrationFiles } from "./verify.js";

/**
 * The static drift guard is DB-free, so it runs everywhere. It is the cheap
 * gate that would have caught the two connector agents nearly grabbing the
 * same migration number, and any renamed/lost file.
 */
function fixture(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "omni-mig-"));
  for (const n of names) writeFileSync(join(dir, n), "-- test\n");
  return dir;
}

describe("verifyMigrationFiles", () => {
  const dirs: string[] = [];
  const make = (names: string[]) => {
    const d = fixture(names);
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("accepts a clean 001..00N sequence", () => {
    const r = verifyMigrationFiles(make(["001_a.sql", "002_b.sql", "003_c.sql"]));
    expect(r.ok).toBe(true);
    expect(r.files).toHaveLength(3);
  });

  it("flags a duplicate number", () => {
    const r = verifyMigrationFiles(make(["001_a.sql", "002_b.sql", "002_c.sql"]));
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes("duplicate migration number 002"))).toBe(true);
  });

  it("flags a gap", () => {
    const r = verifyMigrationFiles(make(["001_a.sql", "003_c.sql"]));
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes("gap"))).toBe(true);
  });

  it("flags a malformed filename", () => {
    const r = verifyMigrationFiles(make(["001_a.sql", "2_bad.sql"]));
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes("does not match"))).toBe(true);
  });

  it("flags a sequence not starting at 001", () => {
    const r = verifyMigrationFiles(make(["002_a.sql", "003_b.sql"]));
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes("must start at 001"))).toBe(true);
  });

  it("rejects uppercase / non-snake names", () => {
    const r = verifyMigrationFiles(make(["001_Good.sql"]));
    expect(r.ok).toBe(false);
  });

  it("the REAL repo migrations are a clean sequence", () => {
    // No dir arg → checks the bundled packages/db/sql. This is the assertion
    // that runs in CI and catches a bad add before it ever reaches a database.
    const r = verifyMigrationFiles();
    if (!r.ok) throw new Error(`repo migrations invalid:\n${r.problems.join("\n")}`);
    expect(r.ok).toBe(true);
    expect(r.files.length).toBeGreaterThanOrEqual(25);
  });
});

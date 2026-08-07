/**
 * Deep health check on real PostgreSQL — proves the app role has the exact
 * privileges the system's security model rests on (RLS enforcement).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { Db } from "../db.js";
import { deepHealth } from "./deepHealth.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("deepHealth", () => {
  let db: Db;

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    db = new Db(APP_URL!);
  }, 30_000);

  afterAll(async () => {
    await db?.close();
  });

  it("reports healthy against a fresh, migrated database", async () => {
    const result = await deepHealth(db);
    expect(result.status).toBe("healthy");
    expect(result.checks.dbRole?.ok).toBe(true);
    expect(result.checks.dbRole?.detail).toContain("superuser=false");
    expect(result.checks.dbRole?.detail).toContain("bypassrls=false");
    expect(result.checks.migrations?.ok).toBe(true);
    expect(result.checks.migrations?.detail).toMatch(/\d+ applied/);
  });

  it("degrades cleanly when the database is unreachable (bad URL)", async () => {
    const dead = new Db("postgres://nobody:nowhere@127.0.0.1:1/nowhere");
    try {
      const result = await deepHealth(dead);
      expect(result.status).toBe("degraded");
      expect(result.checks.database?.ok).toBe(false);
    } finally {
      await dead.close();
    }
  }, 15_000);
});

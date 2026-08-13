/**
 * The webhook_lookup tenant-bypass policy is scoped to the API role only.
 *
 * It is the sole RLS policy in the schema that was granted to PUBLIC. The
 * mechanism was sound — SELECT-only, GUC-gated, transaction-local, one call
 * site — but the scope meant any role, including the worker and anything added
 * later, could read every tenant's payment intents by setting the flag.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { Db } from "../db.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("webhook_lookup policy scope", () => {
  let db: Db;

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    db = new Db(APP_URL!);
  }, 30_000);

  afterAll(async () => {
    await db?.close();
  });

  it("is granted to omniretail_app, not to PUBLIC", async () => {
    const roles = await db.withPlatform(async (c) => {
      const { rows } = await c.query<{ applies_to: string | null }>(
        `SELECT CASE WHEN pol.polroles = '{0}' THEN 'PUBLIC'
                     ELSE (SELECT string_agg(r.rolname, ',')
                             FROM pg_roles r WHERE r.oid = ANY(pol.polroles)) END AS applies_to
           FROM pg_policy pol
           JOIN pg_class c2 ON c2.oid = pol.polrelid
          WHERE c2.relname = 'payment_intent' AND pol.polname = 'webhook_lookup'`,
      );
      return rows[0]?.applies_to;
    });
    expect(roles).toBe("omniretail_app");
    expect(roles).not.toBe("PUBLIC");
  });

  it("stays SELECT-only, so it can never become a write bypass", async () => {
    const cmd = await db.withPlatform(async (c) => {
      const { rows } = await c.query<{ polcmd: string }>(
        `SELECT pol.polcmd FROM pg_policy pol
           JOIN pg_class c2 ON c2.oid = pol.polrelid
          WHERE c2.relname = 'payment_intent' AND pol.polname = 'webhook_lookup'`,
      );
      return rows[0]?.polcmd;
    });
    expect(cmd).toBe("r"); // r = SELECT
  });

  it("is the only policy in the schema still granted to PUBLIC-with-bypass", async () => {
    // Guards the property the audit checked by hand: every other tenant-bypass
    // policy is scoped to a named role.
    const publicBypass = await db.withPlatform(async (c) => {
      const { rows } = await c.query<{ relname: string; polname: string }>(
        `SELECT c2.relname, pol.polname
           FROM pg_policy pol
           JOIN pg_class c2 ON c2.oid = pol.polrelid
           JOIN pg_namespace n ON n.oid = c2.relnamespace AND n.nspname = 'public'
          WHERE pol.polroles = '{0}'
            AND pg_get_expr(pol.polqual, pol.polrelid) NOT LIKE '%current_tenant_id%'`,
      );
      return rows;
    });
    expect(publicBypass).toEqual([]);
  });
});

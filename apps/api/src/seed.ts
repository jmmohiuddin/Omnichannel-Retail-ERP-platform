/**
 * Dev seed: a Dubai demo tenant with locations, phones, and opening stock.
 * Goes through the real services (auth, catalog SQL, ledger poster) so seeded
 * data is indistinguishable from production-shaped data.
 *
 * Usage:
 *   ADMIN_DATABASE_URL=... DATABASE_URL=... JWT_SECRET=... node dist/seed.js
 */
import { randomUUID } from "node:crypto";
import { migrate } from "@omniretail/db";
import { Db } from "./db.js";
import { AuthService } from "./auth/service.js";
import { TokenService } from "./auth/tokens.js";
import { PgInventoryService } from "./inventory/pgInventory.js";
import { ReceivingService } from "./inventory/receivingService.js";

const adminUrl = process.env.ADMIN_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET ?? "dev-only-secret-dev-only-secret-dev";
if (!adminUrl || !appUrl) {
  console.error("ADMIN_DATABASE_URL and DATABASE_URL are required");
  process.exit(1);
}

await migrate(adminUrl);

const db = new Db(appUrl);
const auth = new AuthService(db, new TokenService(jwtSecret), jwtSecret);
const inventory = new PgInventoryService(db);
const receiving = new ReceivingService(db, inventory);

const owner = await auth.registerTenant({
  tenantName: "Deira Mobile Trading LLC",
  slug: "deira-mobile",
  currency: "AED",
  fullName: "Demo Owner",
  email: "owner@deira-mobile.example",
  password: "demo-password-123",
});
console.log(`tenant deira-mobile created (owner login: owner@deira-mobile.example / demo-password-123)`);

const { tenantId, userId } = owner;

const ids = {
  shop: randomUUID(),
  warehouse: randomUUID(),
  products: [] as { variantId: string; sku: string; qty: number }[],
};

await db.withTenant(tenantId, async (c) => {
  await c.query(
    `INSERT INTO location (id, tenant_id, kind, name, code) VALUES
     ($1,$3,'store','Deira Souk Shop','DXB1'), ($2,$3,'warehouse','Al Ras Warehouse','WH1')`,
    [ids.shop, ids.warehouse, tenantId],
  );

  const catalog: Array<{ name: string; slug: string; sku: string; priceAedFils: number; qty: number }> = [
    { name: "Phone Pro 256GB", slug: "phone-pro-256", sku: "PP-256", priceAedFils: 4_199_00, qty: 12 },
    { name: "Phone Lite 128GB", slug: "phone-lite-128", sku: "PL-128", priceAedFils: 1_499_00, qty: 25 },
    { name: "Charger 30W", slug: "charger-30w", sku: "CH-30W", priceAedFils: 89_00, qty: 60 },
  ];
  for (const item of catalog) {
    const productId = randomUUID();
    const variantId = randomUUID();
    const serialized = item.sku.startsWith("P");
    await c.query(
      // Seeded products are already-published stock, so `published_at` is set
      // alongside the status — the lifecycle timestamps (031) exist so
      // "when did this leave or reach the storefront" is answerable without
      // walking the audit chain, and a live product with a null timestamp
      // would be a hole in that history from day one.
      `INSERT INTO product (id, tenant_id, name, slug, tracking, status, published_at)
       VALUES ($1,$2,$3,$4,$5,'active', now())`,
      [productId, tenantId, item.name, item.slug, serialized ? "serialized" : "none"],
    );
    await c.query(
      // `stock_mode` is set explicitly, not left to the 031 backfill: that
      // backfill runs during migration, so it only reaches rows that already
      // exist. Seed rows are inserted afterwards and would land with a NULL
      // stock_mode — which R1.5 treats as "not configured" and refuses to
      // publish, leaving the demo catalogue unpublishable.
      `INSERT INTO variant (id, tenant_id, product_id, sku, price_minor, currency, stock_mode)
       VALUES ($1,$2,$3,$4,$5,'AED',$6)`,
      [variantId, tenantId, productId, item.sku, item.priceAedFils,
       serialized ? "serialized" : "none"],
    );
    ids.products.push({ variantId, sku: item.sku, qty: item.qty });
  }
});

/**
 * IMEI with a correct Luhn check digit, derived from a 14-digit body.
 *
 * Receiving validates every IMEI, so the seed has to mint real ones rather than
 * arbitrary digits.
 */
function imeiFrom(body14: string): string {
  let sum = 0;
  // Luhn over the 14-digit body: double every second digit from the right.
  for (let i = 0; i < body14.length; i++) {
    const digit = Number(body14[body14.length - 1 - i]);
    const weighted = i % 2 === 0 ? digit * 2 : digit;
    sum += weighted > 9 ? weighted - 9 : weighted;
  }
  return body14 + String((10 - (sum % 10)) % 10);
}

/**
 * Opening stock through ReceivingService, not a raw ledger post.
 *
 * A serialized variant's stock IS its units — that is the product's core
 * invariant. Posting bulk quantity for one (as this previously did, going
 * straight to `postMovement` and bypassing the service that forbids it) left
 * the demo tenant with 37 phones on hand and zero stock units, so neither phone
 * could ever be sold: the sale path demands a unit to bind and there were none.
 * The header's claim that seeded data is production-shaped was false for
 * exactly the feature the product is built around.
 */
let imeiSeq = 0;
for (const p of ids.products) {
  const serialized = p.sku.startsWith("P");
  await receiving.receive(tenantId, userId, {
    locationId: ids.shop,
    reference: `seed opening stock ${p.sku}`,
    lines: [
      serialized
        ? {
            variantId: p.variantId,
            units: Array.from({ length: p.qty }, () => ({
              // 35-prefixed TAC, then a per-seed sequence.
              imei1: imeiFrom(`35${String(1_000_000_000_00 + imeiSeq++).padStart(12, "0")}`),
            })),
          }
        : { variantId: p.variantId, quantity: p.qty },
    ],
  });
  console.log(
    `  stocked ${p.qty} × ${p.sku} at DXB1${serialized ? " (as individually scanned units)" : ""}`,
  );
}

await db.close();
console.log("seed complete");

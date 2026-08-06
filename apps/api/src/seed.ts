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
      `INSERT INTO product (id, tenant_id, name, slug, tracking, status)
       VALUES ($1,$2,$3,$4,$5,'active')`,
      [productId, tenantId, item.name, item.slug, serialized ? "serialized" : "none"],
    );
    await c.query(
      `INSERT INTO variant (id, tenant_id, product_id, sku, price_minor, currency)
       VALUES ($1,$2,$3,$4,$5,'AED')`,
      [variantId, tenantId, productId, item.sku, item.priceAedFils],
    );
    ids.products.push({ variantId, sku: item.sku, qty: item.qty });
  }
});

for (const p of ids.products) {
  await inventory.postMovement(tenantId, {
    id: randomUUID(),
    movementType: "receipt",
    variantId: p.variantId,
    quantity: p.qty,
    to: { locationId: ids.shop, state: "on_hand" },
    actorUserId: userId,
    reference: { type: "grn", id: randomUUID() },
    occurredAt: new Date(),
    note: `seed opening stock ${p.sku}`,
  });
  console.log(`  stocked ${p.qty} × ${p.sku} at DXB1`);
}

await db.close();
console.log("seed complete");

/**
 * Product lifecycle — R1.1 (create / edit / duplicate / archive) and R1.5
 * (draft → published), against real PostgreSQL.
 *
 * One test per clause of the PRD §7.1 acceptance block:
 *
 *   Given   I am signed in as owner or manager with product:write
 *   When    I create a product with a title, category, brand and one variant
 *           with SKU and price
 *   Then    it saves as `draft`, is not visible on any selling surface,
 *           and appears in the admin product list immediately
 *   And     publishing requires a price > 0 and at least one variant with a
 *           stock mode configured
 *   And     archiving a product with stock on hand warns and requires
 *           confirmation, but never deletes history
 *
 * ProductService is exercised directly rather than through HTTP: the routes
 * live in pgApp.ts, which this change does not own. `POST /v1/products` still
 * hard-codes status 'active' until those routes are wired to this service.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { AuditService } from "../audit/auditService.js";
import { Db } from "../db.js";
import { buildPgApp } from "../pgApp.js";
import { ProductError, ProductService } from "./productService.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

/** The register response only carries tokens; the claims carry the ids
 *  (tokens.ts encodes them as `ten` and the JWT subject). */
const claims = (accessToken: string): { tenantId: string; userId: string } => {
  const payload = JSON.parse(
    Buffer.from(accessToken.split(".")[1]!, "base64url").toString("utf8"),
  ) as { ten: string; sub: string };
  return { tenantId: payload.ten, userId: payload.sub };
};

describe.skipIf(!run)("product lifecycle (R1.1 / R1.5)", () => {
  let app: ReturnType<typeof buildPgApp>;
  let db: Db;
  let products: ProductService;
  let tenantId = "";
  let userId = "";
  let token = "";
  let locationId = "";
  const suffix = randomUUID().slice(0, 8);
  const shopSlug = `lifecycle-shop-${suffix}`;

  const authed = () => ({ authorization: `Bearer ${token}` });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });
  const get = (url: string) => app.inject({ method: "GET", url, headers: authed() });

  /** A draft product with one priced variant whose stock mode is configured. */
  const seedProduct = async (
    key: string,
    options: { priceMinor?: number; stockMode?: "none" | "batch" | "serialized" | null;
               tracking?: "none" | "batch" | "serialized" } = {},
  ) => {
    const { id } = await products.create(tenantId, userId, {
      name: `Product ${key}`,
      slug: `product-${key}-${suffix}`,
      tracking: options.tracking ?? "none",
      description: `${key} description`,
    });
    const variantId = (await post(`/v1/products/${id}/variants`, {
      sku: `SKU-${key}-${suffix}`.toUpperCase(),
      priceMinor: options.priceMinor ?? 199_00,
      currency: "AED",
    })).json().id as string;
    // The POST /v1/products/:id/variants route predates stock_mode, so a fresh
    // variant arrives unconfigured (NULL) — exactly the R1.5 gate's subject.
    if (options.stockMode !== null && options.stockMode !== undefined) {
      await products.setVariantStockMode(tenantId, userId, id, variantId, options.stockMode);
    }
    return { productId: id, variantId };
  };

  const receiveStock = async (variantId: string, quantity: number) =>
    post("/v1/inventory/movements", {
      id: randomUUID(), movementType: "receipt", variantId, quantity,
      to: { locationId, state: "on_hand" },
      reference: { type: "grn", id: randomUUID() },
    });

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    db = new Db(APP_URL!);
    products = new ProductService(db, new AuditService(db));

    const reg = await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: { tenantName: "Lifecycle Shop", slug: shopSlug, fullName: "Owner",
                 email: `owner@${shopSlug}.test`, password: "correct-horse-battery" },
    });
    token = reg.json().accessToken;
    ({ tenantId, userId } = claims(token));
    locationId = (await post("/v1/locations", { kind: "store", name: "Deira", code: "DXB1" }))
      .json().id;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  // -------------------------------------------------------------------------
  // "it saves as draft, is not visible on any selling surface, and appears in
  //  the admin product list immediately"
  // -------------------------------------------------------------------------

  it("a newly created product lands as a draft", async () => {
    const { productId } = await seedProduct("new");
    const checklist = await products.publishChecklist(tenantId, productId);
    expect(checklist.status).toBe("draft");
  });

  it("a draft is invisible in the public storefront catalogue", async () => {
    const { productId } = await seedProduct("hidden");
    const res = await app.inject({ method: "GET", url: `/v1/public/${shopSlug}/catalog` });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().items as { productId: string }[]).map((i) => i.productId);
    expect(ids).not.toContain(productId);
  });

  it("a draft's variant cannot be bought through the storefront", async () => {
    const { variantId } = await seedProduct("unbuyable");
    await receiveStock(variantId, 5);
    const res = await app.inject({
      method: "POST", url: `/v1/public/${shopSlug}/orders`,
      payload: {
        customer: { name: "Shopper", email: `shopper-${suffix}@test.ae` },
        lines: [{ variantId, quantity: 1 }],
      },
    });
    // webOrderService resolves variants with `p.status = 'active'`, so a draft
    // variant is simply not a thing that can be ordered.
    expect(res.json().error).toBe("UNKNOWN_VARIANT");
  });

  it("a draft appears in the admin product list immediately", async () => {
    const { productId } = await seedProduct("admin-visible");
    const res = await get("/v1/products");
    const ids = (res.json().items as { id: string; status: string }[]);
    const row = ids.find((i) => i.id === productId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("draft");
  });

  // -------------------------------------------------------------------------
  // "publishing requires a price > 0 and at least one variant with a stock
  //  mode configured"
  // -------------------------------------------------------------------------

  it("publish is refused when no variant is priced above zero", async () => {
    const { productId } = await seedProduct("unpriced", { priceMinor: 0, stockMode: "none" });
    await expect(products.publish(tenantId, userId, productId)).rejects.toMatchObject({
      code: "PUBLISH_BLOCKED",
    });
    const checklist = await products.publishChecklist(tenantId, productId);
    expect(checklist.canPublish).toBe(false);
    expect(checklist.items.find((i) => i.key === "price")!.ok).toBe(false);
    expect(checklist.items.find((i) => i.key === "stockMode")!.ok).toBe(true);
    expect(checklist.status).toBe("draft");
  });

  it("publish is refused when no variant has a stock mode configured", async () => {
    const { productId } = await seedProduct("no-stock-mode", { stockMode: null });
    await expect(products.publish(tenantId, userId, productId)).rejects.toMatchObject({
      code: "PUBLISH_BLOCKED",
    });
    const checklist = await products.publishChecklist(tenantId, productId);
    expect(checklist.items.find((i) => i.key === "price")!.ok).toBe(true);
    expect(checklist.items.find((i) => i.key === "stockMode")!.ok).toBe(false);
  });

  it("the blocked publish returns the whole checklist, not the first failure", async () => {
    const { productId } = await seedProduct("nothing-set", { priceMinor: 0, stockMode: null });
    const err = await products.publish(tenantId, userId, productId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProductError);
    const items = (err as ProductError).details!.checklist as { key: string; ok: boolean }[];
    expect(items.map((i) => i.key)).toEqual(["price", "stockMode", "arabicTitle"]);
    expect(items.filter((i) => !i.ok).length).toBe(3);
  });

  it("a missing Arabic title is shown but never blocks publication", async () => {
    const { productId } = await seedProduct("no-arabic", { stockMode: "none" });
    const checklist = await products.publishChecklist(tenantId, productId);
    expect(checklist.items.find((i) => i.key === "arabicTitle")).toMatchObject({
      ok: false, blocking: false,
    });
    expect(checklist.canPublish).toBe(true);
  });

  it("publish succeeds once a price and a stock mode both hold", async () => {
    const { productId } = await seedProduct("publishable", { stockMode: "batch" });
    const result = await products.publish(tenantId, userId, productId);
    expect(result.status).toBe("active");
    expect(result.publishedAt).toBeTruthy();

    const res = await app.inject({ method: "GET", url: `/v1/public/${shopSlug}/catalog` });
    const ids = (res.json().items as { productId: string }[]).map((i) => i.productId);
    expect(ids).toContain(productId);
  });

  it("unpublish pulls a live product back out of the storefront", async () => {
    const { productId } = await seedProduct("retractable", { stockMode: "none" });
    await products.publish(tenantId, userId, productId);
    await products.unpublish(tenantId, userId, productId);
    const res = await app.inject({ method: "GET", url: `/v1/public/${shopSlug}/catalog` });
    const ids = (res.json().items as { productId: string }[]).map((i) => i.productId);
    expect(ids).not.toContain(productId);
  });

  // -------------------------------------------------------------------------
  // edit (R1.1)
  // -------------------------------------------------------------------------

  it("edit changes name, description, brand, category and tracking", async () => {
    const { productId } = await seedProduct("editable");
    const categoryId = (await post("/v1/categories", {
      name: "Smartphones", slug: `smartphones-${suffix}`,
    })).json().id as string;
    const brandId = randomUUID();
    await db.withTenant(tenantId, (c) =>
      c.query("INSERT INTO brand (id, tenant_id, name, slug) VALUES ($1,$2,$3,$4)",
        [brandId, tenantId, "Apple", `apple-${suffix}`]),
    );

    const after = await products.edit(tenantId, userId, productId, {
      name: "iPhone 15 Pro",
      description: "Titanium",
      brandId,
      categoryId,
      tracking: "serialized",
    });
    expect(after).toMatchObject({
      name: "iPhone 15 Pro", description: "Titanium", brandId, categoryId,
      tracking: "serialized",
    });
  });

  it("an absent key leaves a field alone; an explicit null clears it", async () => {
    const { productId } = await seedProduct("patchy");
    await products.edit(tenantId, userId, productId, { name: "Renamed" });
    const after = await products.edit(tenantId, userId, productId, { description: null });
    expect(after).toMatchObject({ name: "Renamed", description: null });
  });

  it("editing an unknown product is a NOT_FOUND, not a silent no-op", async () => {
    await expect(
      products.edit(tenantId, userId, randomUUID(), { name: "Ghost" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // -------------------------------------------------------------------------
  // the tracking freeze
  // -------------------------------------------------------------------------

  it("tracking cannot change once the product has stock history", async () => {
    const { productId, variantId } = await seedProduct("frozen", { stockMode: "none" });
    await receiveStock(variantId, 3);
    await expect(
      products.edit(tenantId, userId, productId, { tracking: "serialized" }),
    ).rejects.toMatchObject({ code: "TRACKING_LOCKED" });
  });

  it("the tracking freeze survives the stock being sold down to zero", async () => {
    const { productId, variantId } = await seedProduct("sold-out", { stockMode: "none" });
    await receiveStock(variantId, 1);
    await post("/v1/inventory/movements", {
      id: randomUUID(), movementType: "sale", variantId, quantity: 1,
      from: { locationId, state: "on_hand" },
      reference: { type: "order", id: randomUUID() },
    });
    const footprint = await products.stockFootprint(tenantId, productId);
    expect(footprint.onHand).toBe(0);
    // Zero on hand, but the ledger — and any IMEI history behind it — remains.
    await expect(
      products.edit(tenantId, userId, productId, { tracking: "serialized" }),
    ).rejects.toMatchObject({ code: "TRACKING_LOCKED" });
  });

  it("the database refuses a tracking change even when the service is bypassed", async () => {
    const { productId, variantId } = await seedProduct("db-frozen", { stockMode: "none" });
    await receiveStock(variantId, 2);
    await expect(
      db.withTenant(tenantId, (c) =>
        c.query("UPDATE product SET tracking = 'serialized' WHERE id = $1", [productId]),
      ),
    ).rejects.toThrow(/tracking cannot change/);
  });

  it("tracking still changes freely before any stock has moved", async () => {
    const { productId } = await seedProduct("still-fluid");
    const after = await products.edit(tenantId, userId, productId, { tracking: "serialized" });
    expect(after).toMatchObject({ tracking: "serialized" });
  });

  // -------------------------------------------------------------------------
  // duplicate (R1.1)
  // -------------------------------------------------------------------------

  it("duplicate produces an independent draft with its own slug and SKUs", async () => {
    const { productId, variantId } = await seedProduct("original", { stockMode: "serialized" });
    await products.publish(tenantId, userId, productId);
    await receiveStock(variantId, 4);

    const copy = await products.duplicate(tenantId, userId, productId);
    expect(copy.status).toBe("draft");
    expect(copy.slug).toBe(`product-original-${suffix}-copy`);
    expect(copy.variants).toBe(1);
    expect(copy.id).not.toBe(productId);

    const rows = await db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ sku: string; stock_mode: string | null }>(
        "SELECT sku, stock_mode FROM variant WHERE product_id = $1", [copy.id],
      );
      return rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sku).toBe(`SKU-ORIGINAL-${suffix.toUpperCase()}-COPY`);
    expect(rows[0]!.stock_mode).toBe("serialized");

    // Independent: no stock, and no ledger — so the copy's tracking is not
    // frozen even though the source's is. This is the sanctioned route out of
    // the freeze that §3.1 describes as "archiving and recreating".
    const footprint = await products.stockFootprint(tenantId, copy.id);
    expect(footprint.hasStock).toBe(false);
    const editedCopy = await products.edit(tenantId, userId, copy.id, { tracking: "batch" });
    expect(editedCopy).toMatchObject({ tracking: "batch" });
    await expect(
      products.edit(tenantId, userId, productId, { tracking: "batch" }),
    ).rejects.toMatchObject({ code: "TRACKING_LOCKED" });
  });

  it("editing the copy does not touch the original", async () => {
    const { productId } = await seedProduct("untouched", { stockMode: "none" });
    const copy = await products.duplicate(tenantId, userId, productId);
    await products.edit(tenantId, userId, copy.id, { name: "Copy renamed" });
    const original = await db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ name: string; status: string }>(
        "SELECT name, status FROM product WHERE id = $1", [productId],
      );
      return rows[0]!;
    });
    expect(original.name).toBe("Product untouched");
  });

  it("duplicate does not copy barcodes, which are physical GTINs", async () => {
    const { productId } = await seedProduct("barcoded");
    await post(`/v1/products/${productId}/variants`, {
      sku: `SKU-BARCODED-2-${suffix}`.toUpperCase(),
      barcode: `500000${suffix.slice(0, 6)}`, priceMinor: 100_00, currency: "AED",
    });
    const copy = await products.duplicate(tenantId, userId, productId);
    const barcodes = await db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ barcode: string | null }>(
        "SELECT barcode FROM variant WHERE product_id = $1", [copy.id],
      );
      return rows.map((r) => r.barcode);
    });
    expect(barcodes.every((b) => b === null)).toBe(true);
  });

  it("a second duplicate takes the next free slug", async () => {
    const { productId } = await seedProduct("twice");
    const first = await products.duplicate(tenantId, userId, productId);
    const second = await products.duplicate(tenantId, userId, productId);
    expect(first.slug).toBe(`product-twice-${suffix}-copy`);
    expect(second.slug).toBe(`product-twice-${suffix}-copy-2`);
  });

  // -------------------------------------------------------------------------
  // "archiving a product with stock on hand warns and requires confirmation,
  //  but never deletes history"
  // -------------------------------------------------------------------------

  it("archiving a product with stock on hand requires explicit confirmation", async () => {
    const { productId, variantId } = await seedProduct("stocked", { stockMode: "none" });
    await receiveStock(variantId, 6);

    const err = await products.archive(tenantId, userId, productId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProductError);
    expect((err as ProductError).code).toBe("ARCHIVE_CONFIRMATION_REQUIRED");
    expect((err as ProductError).details).toMatchObject({ onHand: 6 });
    // The warning is a warning: the product is untouched until confirmed.
    const checklist = await products.publishChecklist(tenantId, productId);
    expect(checklist.status).toBe("draft");

    const confirmed = await products.archive(tenantId, userId, productId, { confirm: true });
    expect(confirmed.status).toBe("archived");
    expect(confirmed.stock.onHand).toBe(6);
  });

  it("archiving a product with no stock needs no confirmation", async () => {
    const { productId } = await seedProduct("empty");
    const result = await products.archive(tenantId, userId, productId);
    expect(result.status).toBe("archived");
  });

  it("archiving never destroys the product, its variants or its stock", async () => {
    const { productId, variantId } = await seedProduct("preserved", { stockMode: "none" });
    await receiveStock(variantId, 9);
    await products.archive(tenantId, userId, productId, { confirm: true });

    const state = await db.withTenant(tenantId, async (c) => {
      const { rows: p } = await c.query<{ id: string; status: string; archived_at: Date | null }>(
        "SELECT id, status, archived_at FROM product WHERE id = $1", [productId],
      );
      const { rows: v } = await c.query("SELECT id FROM variant WHERE product_id = $1",
        [productId]);
      const { rows: m } = await c.query(
        "SELECT id FROM stock_movement WHERE variant_id = $1", [variantId]);
      return { product: p[0], variants: v.length, movements: m.length };
    });
    expect(state.product).toMatchObject({ id: productId, status: "archived" });
    expect(state.product!.archived_at).not.toBeNull();
    expect(state.variants).toBe(1);
    expect(state.movements).toBeGreaterThan(0);
    // Stock is still counted against the archived product — it did not vanish.
    const footprint = await products.stockFootprint(tenantId, productId);
    expect(footprint.onHand).toBe(9);
  });

  it("past order lines still resolve after the product is archived", async () => {
    const { productId, variantId } = await seedProduct("historic", { stockMode: "none" });
    await products.publish(tenantId, userId, productId);
    await receiveStock(variantId, 5);

    const order = await app.inject({
      method: "POST", url: `/v1/public/${shopSlug}/orders`,
      payload: {
        customer: { name: "Buyer", email: `buyer-${suffix}@test.ae` },
        lines: [{ variantId, quantity: 2 }],
      },
    });
    expect(order.statusCode).toBe(201);
    const orderId = order.json().orderId as string;

    await products.archive(tenantId, userId, productId, { confirm: true });

    const line = await db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{
        description: string; quantity: string; product_name: string; status: string;
      }>(
        `SELECT ol.description, ol.quantity, p.name AS product_name, p.status
           FROM sales_order_line ol
           JOIN variant v  ON v.id = ol.variant_id
           JOIN product p  ON p.id = v.product_id
          WHERE ol.order_id = $1`,
        [orderId],
      );
      return rows[0];
    });
    expect(line).toBeDefined();
    expect(line!.product_name).toBe("Product historic");
    expect(line!.status).toBe("archived");
  });

  it("an archived product leaves the storefront but can be re-published", async () => {
    const { productId } = await seedProduct("relisted", { stockMode: "none" });
    await products.publish(tenantId, userId, productId);
    await products.archive(tenantId, userId, productId);

    let res = await app.inject({ method: "GET", url: `/v1/public/${shopSlug}/catalog` });
    expect((res.json().items as { productId: string }[]).map((i) => i.productId))
      .not.toContain(productId);

    // Re-listing re-runs the R1.5 gate rather than trusting the old state.
    await products.publish(tenantId, userId, productId);
    res = await app.inject({ method: "GET", url: `/v1/public/${shopSlug}/catalog` });
    expect((res.json().items as { productId: string }[]).map((i) => i.productId))
      .toContain(productId);
  });

  it("the archive is written to the tamper-evident audit chain", async () => {
    const { productId } = await seedProduct("audited");
    await products.archive(tenantId, userId, productId, { reason: "discontinued" });
    const entries = (await get("/v1/audit")).json().items as {
      action: string; entityId: string; after: Record<string, unknown>;
    }[];
    const entry = entries.find(
      (e) => e.action === "product.archived" && e.entityId === productId,
    );
    expect(entry).toBeDefined();
    expect(entry!.after).toMatchObject({ status: "archived", reason: "discontinued" });
    expect((await get("/v1/audit/verify")).json().valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // slugs
  // -------------------------------------------------------------------------

  it("a duplicate slug is rejected with SLUG_TAKEN, not a raw constraint error", async () => {
    const slug = `clash-${suffix}`;
    await products.create(tenantId, userId, { name: "First", slug });
    await expect(
      products.create(tenantId, userId, { name: "Second", slug }),
    ).rejects.toMatchObject({ code: "SLUG_TAKEN" });
  });
});

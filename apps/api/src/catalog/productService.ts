import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuditService } from "../audit/auditService.js";
import type { Db } from "../db.js";

export class ProductError extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "SLUG_TAKEN"
      /** tracking cannot change once the ledger has spoken (031 trigger). */
      | "TRACKING_LOCKED"
      /** R1.5 gate failed; `details.checklist` says exactly which clause. */
      | "PUBLISH_BLOCKED"
      /** Archiving a product that still holds stock needs an explicit yes. */
      | "ARCHIVE_CONFIRMATION_REQUIRED"
      | "INVALID_STATE",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProductError";
  }
}

export type ProductStatus = "draft" | "active" | "archived";
export type StockMode = "none" | "batch" | "serialized";
export type Tracking = "none" | "batch" | "serialized";

export interface ProductInput {
  name: string;
  slug: string;
  tracking?: Tracking;
  description?: string;
  categoryId?: string | null;
  brandId?: string | null;
}

/** A patch: an absent key means "leave alone", an explicit null means "clear". */
export interface ProductPatch {
  name?: string;
  description?: string | null;
  brandId?: string | null;
  categoryId?: string | null;
  tracking?: Tracking;
}

export interface ChecklistItem {
  key: "price" | "stockMode" | "arabicTitle";
  label: string;
  ok: boolean;
  /** false = advisory only; the merchant may publish without it. */
  blocking: boolean;
}

export interface PublishChecklist {
  productId: string;
  status: ProductStatus;
  canPublish: boolean;
  items: ChecklistItem[];
}

export interface StockFootprint {
  /** SQL-derived gate: never a float comparison in JS. */
  hasStock: boolean;
  onHand: number;
  reserved: number;
}

interface ProductRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: ProductStatus;
  tracking: Tracking;
  category_id: string | null;
  brand_id: string | null;
}

const PRODUCT_COLUMNS =
  "id, name, slug, description, status, tracking, category_id, brand_id";

/**
 * The product lifecycle (R1.1 create/edit/duplicate/archive, R1.5 draft →
 * published). The audit's finding was blunt: "a commerce admin that cannot
 * create a product is not a commerce admin" — the catalogue could only be
 * populated by `npm run db:seed` or direct SQL, and `archived` was a status
 * nothing ever wrote.
 *
 * Two invariants shape everything here:
 *
 *   - Nothing is ever deleted. Archive is a status change; the product, its
 *     variants, its stock units and every order line that ever referenced them
 *     stay resolvable forever. A phone sold in 2026 must still answer a
 *     warranty question in 2028 (R2.9) whether or not the model is still sold.
 *
 *   - Publication is gated, not merely defaulted. R1.5's two clauses (a price
 *     above zero, and at least one variant whose stock mode is configured) are
 *     checked at the moment of publication, and the failure is returned as the
 *     wireframe's checklist rather than a generic validation error — §3.1 is
 *     explicit that "the checklist IS the error message".
 */
export class ProductService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  private async loadWith(c: pg.PoolClient, productId: string): Promise<ProductRow> {
    const { rows } = await c.query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM product WHERE id = $1`,
      [productId],
    );
    const row = rows[0];
    if (!row) throw new ProductError("NOT_FOUND", `product ${productId} not found`);
    return row;
  }

  private static view(row: ProductRow): Record<string, unknown> {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      status: row.status,
      tracking: row.tracking,
      categoryId: row.category_id,
      brandId: row.brand_id,
    };
  }

  /**
   * The live publish checklist behind the wireframe's STATUS panel. Safe to
   * call on every keystroke-triggered save: three EXISTS probes on indexed
   * columns.
   */
  async publishChecklist(tenantId: string, productId: string): Promise<PublishChecklist> {
    return this.db.withTenant(tenantId, (c) => this.checklistWith(c, productId));
  }

  private async checklistWith(
    c: pg.PoolClient,
    productId: string,
  ): Promise<PublishChecklist> {
    const product = await this.loadWith(c, productId);
    const { rows } = await c.query<{
      has_price: boolean; has_stock_mode: boolean; has_arabic: boolean;
    }>(
      `SELECT
         EXISTS (SELECT 1 FROM variant v
                  WHERE v.product_id = $1 AND v.is_active AND v.price_minor > 0) AS has_price,
         EXISTS (SELECT 1 FROM variant v
                  WHERE v.product_id = $1 AND v.is_active
                    AND v.stock_mode IS NOT NULL)                                AS has_stock_mode,
         EXISTS (SELECT 1 FROM product p
                  WHERE p.id = $1
                    AND coalesce(trim(p.translations->'ar'->>'name'), '') <> '')  AS has_arabic`,
      [productId],
    );
    const probe = rows[0]!;
    const items: ChecklistItem[] = [
      {
        key: "price",
        label: "At least one variant priced above zero",
        ok: probe.has_price,
        blocking: true,
      },
      {
        key: "stockMode",
        label: "At least one variant with a stock mode configured",
        ok: probe.has_stock_mode,
        blocking: true,
      },
      // R1.4 is a Should, and the wireframe shows this unticked while Publish
      // stays available — so it is surfaced but never blocks.
      {
        key: "arabicTitle",
        label: "Arabic title (recommended for the UAE storefront)",
        ok: probe.has_arabic,
        blocking: false,
      },
    ];
    return {
      productId,
      status: product.status,
      canPublish: items.every((i) => !i.blocking || i.ok),
      items,
    };
  }

  /**
   * What stock the product still holds. `hasStock` is computed by PostgreSQL
   * from NUMERIC(14,3) columns, so the archive gate never turns on a JS float
   * comparison; the numbers alongside it are for display only.
   */
  async stockFootprint(tenantId: string, productId: string): Promise<StockFootprint> {
    return this.db.withTenant(tenantId, (c) => this.footprintWith(c, productId));
  }

  private async footprintWith(
    c: pg.PoolClient,
    productId: string,
  ): Promise<StockFootprint> {
    const { rows } = await c.query<{
      on_hand: string; reserved: string; has_stock: boolean;
    }>(
      `SELECT
         coalesce(sum(sl.quantity) FILTER (WHERE sl.state = 'on_hand'), 0)  AS on_hand,
         coalesce(sum(sl.quantity) FILTER (WHERE sl.state = 'reserved'), 0) AS reserved,
         coalesce(sum(sl.quantity)
                    FILTER (WHERE sl.state IN ('on_hand','reserved')), 0) > 0 AS has_stock
         FROM stock_level sl
         JOIN variant v ON v.id = sl.variant_id
        WHERE v.product_id = $1`,
      [productId],
    );
    const row = rows[0]!;
    return {
      hasStock: row.has_stock,
      onHand: Number(row.on_hand),
      reserved: Number(row.reserved),
    };
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  /**
   * R1.1: a newly created product lands as `draft`. It is immediately in the
   * admin list (GET /v1/products filters `status <> 'archived'`) and invisible
   * to the storefront (webOrderService filters `status = 'active'`), which is
   * exactly the acceptance criterion.
   */
  async create(
    tenantId: string,
    actorUserId: string,
    input: ProductInput,
  ): Promise<{ id: string; status: ProductStatus }> {
    const id = randomUUID();
    return this.db.withTenant(tenantId, async (c) => {
      await this.assertSlugFree(c, tenantId, input.slug);
      await c.query(
        `INSERT INTO product (id, tenant_id, name, slug, tracking, description,
                              category_id, brand_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft')`,
        [id, tenantId, input.name, input.slug, input.tracking ?? "none",
         input.description ?? null, input.categoryId ?? null, input.brandId ?? null],
      );
      await this.audit.recordWith(c, tenantId, {
        actorUserId,
        action: "product.created",
        entityType: "product",
        entityId: id,
        after: { name: input.name, slug: input.slug, status: "draft" },
      });
      return { id, status: "draft" as const };
    });
  }

  // -------------------------------------------------------------------------
  // edit
  // -------------------------------------------------------------------------

  /**
   * R1.1 edit. `tracking` is accepted here but is the one field that can be
   * refused: see the freeze rule below and in 031_product_lifecycle.sql.
   */
  async edit(
    tenantId: string,
    actorUserId: string,
    productId: string,
    patch: ProductPatch,
  ): Promise<Record<string, unknown>> {
    return this.db.withTenant(tenantId, async (c) => {
      const before = await this.loadWith(c, productId);

      if (patch.tracking !== undefined && patch.tracking !== before.tracking) {
        await this.assertTrackingChangeAllowed(c, productId, before.tracking, patch.tracking);
      }

      const sets: string[] = [];
      const params: unknown[] = [productId];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (patch.name !== undefined) set("name", patch.name);
      if (patch.description !== undefined) set("description", patch.description);
      if (patch.brandId !== undefined) set("brand_id", patch.brandId);
      if (patch.categoryId !== undefined) set("category_id", patch.categoryId);
      if (patch.tracking !== undefined) set("tracking", patch.tracking);
      if (sets.length === 0) return ProductService.view(before);

      const { rows } = await c.query<ProductRow>(
        `UPDATE product SET ${sets.join(", ")}, updated_at = now()
          WHERE id = $1 RETURNING ${PRODUCT_COLUMNS}`,
        params,
      );
      const after = rows[0]!;
      await this.audit.recordWith(c, tenantId, {
        actorUserId,
        action: "product.edited",
        entityType: "product",
        entityId: productId,
        before: ProductService.view(before),
        after: ProductService.view(after),
      });
      return ProductService.view(after);
    });
  }

  /**
   * THE TRACKING-CHANGE RULE.
   *
   * `tracking` may be changed freely while the product has no ledger history —
   * no stock_movement against any of its variants and no stock_unit rows. Once
   * either exists, the mode is frozen for the life of the product.
   *
   * Why not something softer, like "only when on-hand is zero"? Because the
   * damage is to history, not to the current balance:
   *
   *   'none'/'batch' → 'serialized'
   *       Every unit of a serialised variant must carry an IMEI before it can
   *       be sold (R1.3), and 003_inventory.sql requires stock_unit_id on its
   *       movements. Quantity already received without units behind it becomes
   *       unsellable phantom stock — the shelf says four, and no scan can ever
   *       satisfy a sale of them.
   *
   *   'serialized' → 'none'/'batch'
   *       Orphans the stock_unit chain that R2.6 (full IMEI history) and R2.9
   *       (warranty resolved from the unit, not the receipt) are built on. A
   *       product that sold out still owes those answers to the handsets in
   *       customers' pockets, which is why a zero balance must not reopen the
   *       switch.
   *
   * Inventory is an append-only ledger (ADR-002), so there is no honest
   * retro-fit: we cannot invent units for past receipts or discard the ones we
   * recorded. The wireframe already specifies the escape hatch — §3.1 locks the
   * toggle with "the only path is archiving and recreating" — and `duplicate()`
   * makes that a single click, since the copy starts with no ledger of its own.
   *
   * The same rule is enforced by the `product_tracking_lock` trigger in
   * 031_product_lifecycle.sql. This check exists to produce a useful error, not
   * to be the guarantee: the database is the guarantee.
   */
  private async assertTrackingChangeAllowed(
    c: pg.PoolClient,
    productId: string,
    from: Tracking,
    to: Tracking,
  ): Promise<void> {
    const { rows } = await c.query<{ locked: boolean }>(
      `SELECT (EXISTS (SELECT 1 FROM stock_movement m
                        WHERE m.variant_id IN (SELECT id FROM variant WHERE product_id = $1))
            OR EXISTS (SELECT 1 FROM stock_unit u
                        WHERE u.variant_id IN (SELECT id FROM variant WHERE product_id = $1)))
              AS locked`,
      [productId],
    );
    if (rows[0]?.locked) {
      throw new ProductError(
        "TRACKING_LOCKED",
        `stock history exists for this product, so tracking cannot change from ` +
          `'${from}' to '${to}'. Archive it and create a replacement instead.`,
        { productId, from, to },
      );
    }
  }

  /**
   * Configure a variant's stock mode — the second half of the R1.5 publish
   * gate. NULL is "not decided yet"; 'none' is the merchant deciding this SKU
   * is not stock-tracked. Only the explicit decision satisfies the gate.
   */
  async setVariantStockMode(
    tenantId: string,
    actorUserId: string,
    productId: string,
    variantId: string,
    stockMode: StockMode,
  ): Promise<{ variantId: string; stockMode: StockMode }> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `UPDATE variant SET stock_mode = $3
          WHERE id = $2 AND product_id = $1 RETURNING id`,
        [productId, variantId, stockMode],
      );
      if (!rows[0]) {
        throw new ProductError(
          "NOT_FOUND",
          `variant ${variantId} not found on product ${productId}`,
        );
      }
      await this.audit.recordWith(c, tenantId, {
        actorUserId,
        action: "variant.stock_mode_set",
        entityType: "variant",
        entityId: variantId,
        after: { productId, stockMode },
      });
      return { variantId, stockMode };
    });
  }

  // -------------------------------------------------------------------------
  // duplicate
  // -------------------------------------------------------------------------

  /**
   * R1.1 duplicate: the copy is a fresh DRAFT with its own slug and SKUs, and
   * it carries no stock, no ledger and no publication history. That
   * independence is the point — duplicate is also the sanctioned way to change
   * a serialised product's tracking mode (see assertTrackingChangeAllowed), so
   * the copy must start with a clean ledger or the freeze would inherit.
   *
   * Barcodes are deliberately NOT copied. A barcode is a GTIN printed on a
   * physical box; two variants sharing one would make a counter scan ambiguous
   * about which SKU was just sold.
   */
  async duplicate(
    tenantId: string,
    actorUserId: string,
    productId: string,
    options: { slug?: string; name?: string } = {},
  ): Promise<{ id: string; slug: string; status: ProductStatus; variants: number }> {
    return this.db.withTenant(tenantId, async (c) => {
      const source = await this.loadWith(c, productId);
      const slug = options.slug ?? (await this.freeSlug(c, source.slug));
      if (options.slug) await this.assertSlugFree(c, tenantId, options.slug);

      const newId = randomUUID();
      await c.query(
        `INSERT INTO product (id, tenant_id, category_id, brand_id, name, slug,
                              description, spec, seo, translations, tracking,
                              tax_class, status)
         SELECT $1, tenant_id, category_id, brand_id, $3, $4, description,
                spec, seo, translations, tracking, tax_class, 'draft'
           FROM product WHERE id = $2`,
        [newId, productId, options.name ?? `${source.name} (copy)`, slug],
      );

      const { rows: sourceVariants } = await c.query<{ id: string; sku: string }>(
        "SELECT id, sku FROM variant WHERE product_id = $1 ORDER BY sku",
        [productId],
      );
      // variant id → new variant id, so variant-scoped images follow the copy.
      const variantMap = new Map<string, string>();
      for (const sv of sourceVariants) {
        const newVariantId = randomUUID();
        const sku = await this.freeSku(c, sv.sku);
        await c.query(
          `INSERT INTO variant (id, tenant_id, product_id, sku, barcode, attributes,
                                cost_minor, price_minor, currency, warranty_months,
                                weight_grams, is_active, stock_mode)
           SELECT $1, tenant_id, $3, $4, NULL, attributes, cost_minor, price_minor,
                  currency, warranty_months, weight_grams, is_active, stock_mode
             FROM variant WHERE id = $2`,
          [newVariantId, sv.id, newId, sku],
        );
        variantMap.set(sv.id, newVariantId);
      }

      const { rows: images } = await c.query<{
        url: string; alt: string | null; position: number; variant_id: string | null;
      }>(
        "SELECT url, alt, position, variant_id FROM product_image WHERE product_id = $1",
        [productId],
      );
      for (const img of images) {
        await c.query(
          `INSERT INTO product_image (tenant_id, product_id, variant_id, url, alt, position)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [tenantId, newId,
           img.variant_id ? variantMap.get(img.variant_id) ?? null : null,
           img.url, img.alt, img.position],
        );
      }

      await this.audit.recordWith(c, tenantId, {
        actorUserId,
        action: "product.duplicated",
        entityType: "product",
        entityId: newId,
        before: { sourceProductId: productId, sourceSlug: source.slug },
        after: { slug, status: "draft", variants: sourceVariants.length },
      });
      return {
        id: newId, slug, status: "draft" as const, variants: sourceVariants.length,
      };
    });
  }

  // -------------------------------------------------------------------------
  // archive
  // -------------------------------------------------------------------------

  /**
   * R1.1 archive. Never a delete: the row keeps its id, its variants, its stock
   * units and every order line that ever pointed at them. Both selling surfaces
   * already filter on `status = 'active'`, so archiving is what removes it from
   * sale — and history keeps resolving because nothing was removed.
   *
   * Per the acceptance criteria, archiving a product that still holds stock
   * warns and requires explicit confirmation: the caller must pass
   * `confirm: true` after seeing the quantity. The gate also counts RESERVED
   * stock, which is stock committed to orders that have not shipped —
   * strictly more dangerous to archive silently than stock sitting on a shelf.
   * Callers that want to warn before attempting can read `stockFootprint()`.
   */
  async archive(
    tenantId: string,
    actorUserId: string,
    productId: string,
    options: { confirm?: boolean; reason?: string } = {},
  ): Promise<{ productId: string; status: ProductStatus; stock: StockFootprint }> {
    return this.db.withTenant(tenantId, async (c) => {
      const before = await this.loadWith(c, productId);
      const stock = await this.footprintWith(c, productId);

      if (stock.hasStock && options.confirm !== true) {
        throw new ProductError(
          "ARCHIVE_CONFIRMATION_REQUIRED",
          `${before.name} still holds stock (${stock.onHand} on hand, ` +
            `${stock.reserved} reserved). Archiving hides it from every selling ` +
            `surface without removing that stock or any of its history. ` +
            `Re-send with confirm: true to proceed.`,
          { productId, onHand: stock.onHand, reserved: stock.reserved },
        );
      }

      await c.query(
        `UPDATE product SET status = 'archived', archived_at = now(), updated_at = now()
          WHERE id = $1`,
        [productId],
      );
      await this.audit.recordWith(c, tenantId, {
        actorUserId,
        action: "product.archived",
        entityType: "product",
        entityId: productId,
        before: { status: before.status },
        after: {
          status: "archived",
          onHand: stock.onHand,
          reserved: stock.reserved,
          confirmed: stock.hasStock ? true : undefined,
          reason: options.reason ?? null,
        },
      });
      return { productId, status: "archived" as const, stock };
    });
  }

  // -------------------------------------------------------------------------
  // publish
  // -------------------------------------------------------------------------

  /**
   * R1.5: publication requires a price above zero AND at least one variant with
   * a stock mode configured. A failure returns the whole checklist, not the
   * first missing item — the wireframe's STATUS panel renders every line, and
   * "please fill required fields" is explicitly called out as the wrong answer.
   *
   * Works from `draft` and from `archived` (re-listing a discontinued line),
   * re-running the gate either way.
   */
  async publish(
    tenantId: string,
    actorUserId: string,
    productId: string,
  ): Promise<{ productId: string; status: ProductStatus; publishedAt: string }> {
    return this.db.withTenant(tenantId, async (c) => {
      const before = await this.loadWith(c, productId);
      const checklist = await this.checklistWith(c, productId);
      if (!checklist.canPublish) {
        const missing = checklist.items.filter((i) => i.blocking && !i.ok);
        throw new ProductError(
          "PUBLISH_BLOCKED",
          `cannot publish: ${missing.map((i) => i.label).join("; ")}`,
          { productId, checklist: checklist.items },
        );
      }
      const { rows } = await c.query<{ published_at: Date }>(
        `UPDATE product
            SET status = 'active', published_at = now(), archived_at = NULL,
                updated_at = now()
          WHERE id = $1 RETURNING published_at`,
        [productId],
      );
      await this.audit.recordWith(c, tenantId, {
        actorUserId,
        action: "product.published",
        entityType: "product",
        entityId: productId,
        before: { status: before.status },
        after: { status: "active" },
      });
      return {
        productId,
        status: "active" as const,
        publishedAt: rows[0]!.published_at.toISOString(),
      };
    });
  }

  /** Pull a published product back to draft without archiving it. */
  async unpublish(
    tenantId: string,
    actorUserId: string,
    productId: string,
  ): Promise<{ productId: string; status: ProductStatus }> {
    return this.db.withTenant(tenantId, async (c) => {
      const before = await this.loadWith(c, productId);
      if (before.status !== "active") {
        throw new ProductError(
          "INVALID_STATE",
          `only a published product can be unpublished (status is '${before.status}')`,
          { productId, status: before.status },
        );
      }
      await c.query(
        "UPDATE product SET status = 'draft', updated_at = now() WHERE id = $1",
        [productId],
      );
      await this.audit.recordWith(c, tenantId, {
        actorUserId,
        action: "product.unpublished",
        entityType: "product",
        entityId: productId,
        before: { status: "active" },
        after: { status: "draft" },
      });
      return { productId, status: "draft" as const };
    });
  }

  // -------------------------------------------------------------------------
  // slug / sku helpers
  // -------------------------------------------------------------------------

  private async assertSlugFree(
    c: pg.PoolClient,
    tenantId: string,
    slug: string,
  ): Promise<void> {
    const { rows } = await c.query("SELECT 1 FROM product WHERE slug = $1", [slug]);
    if (rows.length > 0) {
      throw new ProductError("SLUG_TAKEN", `slug '${slug}' is already used`, { slug });
    }
  }

  /**
   * `phone` → `phone-copy`, then `phone-copy-2`, … Predictable beats random:
   * the merchant is about to see this slug in a URL field and edit it.
   * Bounded so a pathological catalogue cannot spin here; the UNIQUE index on
   * (tenant_id, slug) is still the real guarantee against a concurrent copy.
   */
  private async freeSlug(c: pg.PoolClient, base: string): Promise<string> {
    for (let n = 1; n <= 50; n++) {
      const candidate = n === 1 ? `${base}-copy` : `${base}-copy-${n}`;
      const { rows } = await c.query("SELECT 1 FROM product WHERE slug = $1", [candidate]);
      if (rows.length === 0) return candidate;
    }
    return `${base}-copy-${randomUUID().slice(0, 8)}`;
  }

  private async freeSku(c: pg.PoolClient, base: string): Promise<string> {
    for (let n = 1; n <= 50; n++) {
      const candidate = n === 1 ? `${base}-COPY` : `${base}-COPY-${n}`;
      const { rows } = await c.query("SELECT 1 FROM variant WHERE sku = $1", [candidate]);
      if (rows.length === 0) return candidate;
    }
    return `${base}-COPY-${randomUUID().slice(0, 8)}`;
  }
}

/**
 * PostgreSQL-backed application host. This is the real Phase 1 server:
 * JWT auth with rotating refresh sessions, tenant-scoped RLS transactions,
 * catalog CRUD, and the ledger inventory service.
 *
 * (buildServer in server.ts remains the storage-free contract reference used
 * by unit tests; the routes here mirror its shapes.)
 */
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { LedgerError } from "@omniretail/domain";
import { Db } from "./db.js";
import { AuthError, AuthService } from "./auth/service.js";
import { TokenService, type AccessClaims } from "./auth/tokens.js";
import { PgInventoryService } from "./inventory/pgInventory.js";
import { SaleError, SalesService } from "./sales/salesService.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: AccessClaims;
  }
}

const registerSchema = z.object({
  tenantName: z.string().min(2),
  slug: z.string().regex(/^[a-z0-9-]{2,40}$/),
  currency: z.string().length(3).optional(),
  fullName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(10),
});

const loginSchema = z.object({
  slug: z.string(),
  email: z.string().email(),
  password: z.string(),
});

const locationSchema = z.object({
  kind: z.enum(["store", "warehouse", "virtual"]),
  name: z.string().min(1),
  code: z.string().min(1).max(16),
});

const productSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  tracking: z.enum(["none", "batch", "serialized"]).default("none"),
  description: z.string().optional(),
});

const variantSchema = z.object({
  sku: z.string().min(1),
  barcode: z.string().optional(),
  attributes: z.record(z.string()).default({}),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  costMinor: z.number().int().nonnegative().optional(),
  warrantyMonths: z.number().int().positive().optional(),
});

const bucketSchema = z.object({
  locationId: z.string().uuid(),
  state: z.enum(["on_hand", "reserved", "in_transit", "damaged", "returned_pending"]),
});

const movementBodySchema = z.object({
  id: z.string().uuid(),
  movementType: z.enum([
    "receipt", "sale", "return_in", "transfer_out", "transfer_in", "adjustment",
    "reservation", "release", "write_off", "count_correction", "repair_out", "repair_in",
  ]),
  variantId: z.string().uuid(),
  stockUnitId: z.string().uuid().optional(),
  quantity: z.number().positive(),
  from: bucketSchema.optional(),
  to: bucketSchema.optional(),
  deviceId: z.string().uuid().optional(),
  reference: z.object({ type: z.string().min(1), id: z.string().uuid() }),
  approvalId: z.string().uuid().optional(),
  occurredAt: z.coerce.date().default(() => new Date()),
  note: z.string().max(500).optional(),
});

export interface PgAppConfig {
  databaseUrl: string;
  jwtSecret: string;
}

export function buildPgApp(config: PgAppConfig) {
  const app = Fastify({ logger: false });
  const db = new Db(config.databaseUrl);
  const tokens = new TokenService(config.jwtSecret);
  const auth = new AuthService(db, tokens);
  const inventory = new PgInventoryService(db);
  const sales = new SalesService(db, inventory);

  // Browser clients (admin portal, POS webview). Tokens travel in the
  // Authorization header — no cookies — so a permissive dev origin is safe;
  // production pins origins via config.
  app.register(cors, { origin: true });

  app.addHook("onClose", async () => {
    await db.close();
  });

  const sendZodError = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, issues: unknown) =>
    reply.code(400).send({ error: "VALIDATION", issues });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof LedgerError) {
      const status =
        err.code === "DUPLICATE_MOVEMENT" ? 409
        : err.code === "INSUFFICIENT_STOCK" ? 422
        : err.code === "APPROVAL_REQUIRED" ? 403
        : err.code === "DUPLICATE_IMEI" ? 409
        : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof AuthError) {
      const status = err.code === "SLUG_TAKEN" ? 409 : 401;
      return reply.code(status).send({ error: err.code });
    }
    if (err instanceof SaleError) {
      const status =
        err.code === "PAYMENT_MISMATCH" ? 422
        : err.code === "UNKNOWN_VARIANT" ? 404
        : err.code === "DUPLICATE_SALE" ? 409
        : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "INTERNAL" });
  });

  // ---- public ----
  app.get("/health", async () => ({ status: "ok" }));

  app.post("/v1/auth/register", async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return sendZodError(reply, parsed.error.issues);
    const pair = await auth.registerTenant(parsed.data);
    return reply.code(201).send(pair);
  });

  app.post("/v1/auth/login", async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return sendZodError(reply, parsed.error.issues);
    return auth.login(parsed.data.slug, parsed.data.email, parsed.data.password);
  });

  app.post("/v1/auth/refresh", async (req, reply) => {
    const parsed = z
      .object({ tenantId: z.string().uuid(), refreshToken: z.string().min(20) })
      .safeParse(req.body);
    if (!parsed.success) return sendZodError(reply, parsed.error.issues);
    return auth.refreshForTenant(parsed.data.tenantId, parsed.data.refreshToken);
  });

  // ---- authenticated ----
  app.register(async (secured) => {
    secured.addHook("onRequest", async (req, reply) => {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        return reply.code(401).send({ error: "UNAUTHENTICATED" });
      }
      try {
        req.auth = await tokens.verifyAccess(header.slice(7));
      } catch {
        return reply.code(401).send({ error: "UNAUTHENTICATED" });
      }
    });

    secured.post("/v1/locations", async (req, reply) => {
      const parsed = locationSchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const id = randomUUID();
      await db.withTenant(req.auth.tenantId, (c) =>
        c.query(
          "INSERT INTO location (id, tenant_id, kind, name, code) VALUES ($1,$2,$3,$4,$5)",
          [id, req.auth.tenantId, parsed.data.kind, parsed.data.name, parsed.data.code],
        ),
      );
      return reply.code(201).send({ id, ...parsed.data });
    });

    secured.post("/v1/products", async (req, reply) => {
      const parsed = productSchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const id = randomUUID();
      await db.withTenant(req.auth.tenantId, (c) =>
        c.query(
          `INSERT INTO product (id, tenant_id, name, slug, tracking, description, status)
           VALUES ($1,$2,$3,$4,$5,$6,'active')`,
          [id, req.auth.tenantId, parsed.data.name, parsed.data.slug,
           parsed.data.tracking, parsed.data.description ?? null],
        ),
      );
      return reply.code(201).send({ id, ...parsed.data });
    });

    secured.post("/v1/products/:productId/variants", async (req, reply) => {
      const { productId } = req.params as { productId: string };
      const parsed = variantSchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const id = randomUUID();
      await db.withTenant(req.auth.tenantId, (c) =>
        c.query(
          `INSERT INTO variant (id, tenant_id, product_id, sku, barcode, attributes,
                                price_minor, currency, cost_minor, warranty_months)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, req.auth.tenantId, productId, parsed.data.sku, parsed.data.barcode ?? null,
           JSON.stringify(parsed.data.attributes), parsed.data.priceMinor, parsed.data.currency,
           parsed.data.costMinor ?? null, parsed.data.warrantyMonths ?? null],
        ),
      );
      return reply.code(201).send({ id, productId, ...parsed.data });
    });

    secured.get("/v1/locations", async (req) => {
      const rows = await db.withTenant(req.auth.tenantId, async (c) => {
        const { rows } = await c.query(
          "SELECT id, kind, name, code FROM location WHERE is_active ORDER BY name",
        );
        return rows;
      });
      return { items: rows };
    });

    secured.get("/v1/products", async (req) => {
      const q = z.object({ query: z.string().trim().max(100).optional() }).parse(req.query);
      const rows = await db.withTenant(req.auth.tenantId, async (c) => {
        const { rows } = await c.query(
          `SELECT p.id, p.name, p.slug, p.tracking, p.status,
                  coalesce(json_agg(json_build_object(
                    'id', v.id, 'sku', v.sku, 'barcode', v.barcode,
                    'priceMinor', v.price_minor, 'currency', v.currency
                  ) ORDER BY v.sku) FILTER (WHERE v.id IS NOT NULL), '[]') AS variants
             FROM product p
             LEFT JOIN variant v ON v.product_id = p.id AND v.is_active
            WHERE p.status <> 'archived'
              AND ($1::text IS NULL OR p.name ILIKE '%'||$1||'%'
                   OR EXISTS (SELECT 1 FROM variant vs WHERE vs.product_id = p.id
                              AND (vs.sku ILIKE '%'||$1||'%' OR vs.barcode = $1)))
            GROUP BY p.id ORDER BY p.name LIMIT 50`,
          [q.query ?? null],
        );
        return rows;
      });
      return { items: rows };
    });

    secured.get("/v1/inventory/levels", async (req) => {
      const q = z.object({ locationId: z.string().uuid().optional() }).parse(req.query);
      const rows = await db.withTenant(req.auth.tenantId, async (c) => {
        const { rows } = await c.query(
          `SELECT sl.variant_id AS "variantId", v.sku, p.name AS "productName",
                  sl.location_id AS "locationId", sl.state, sl.quantity::float8 AS quantity
             FROM stock_level sl
             JOIN variant v ON v.id = sl.variant_id
             JOIN product p ON p.id = v.product_id
            WHERE ($1::uuid IS NULL OR sl.location_id = $1) AND sl.quantity <> 0
            ORDER BY p.name, v.sku, sl.state`,
          [q.locationId ?? null],
        );
        return rows;
      });
      return { items: rows };
    });

    secured.post("/v1/devices", async (req, reply) => {
      const parsed = z
        .object({
          kind: z.enum(["pos_register", "mobile", "kiosk"]),
          name: z.string().min(1).max(60),
          locationId: z.string().uuid().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const id = randomUUID();
      await db.withTenant(req.auth.tenantId, (c) =>
        c.query(
          `INSERT INTO device (id, tenant_id, kind, name, location_id, status)
           VALUES ($1,$2,$3,$4,$5,'approved')`,
          [id, req.auth.tenantId, parsed.data.kind, parsed.data.name,
           parsed.data.locationId ?? null],
        ),
      );
      return reply.code(201).send({ id, ...parsed.data });
    });

    secured.post("/v1/pos/sales", async (req, reply) => {
      const parsed = z
        .object({
          id: z.string().uuid(),
          deviceId: z.string().uuid(),
          locationId: z.string().uuid(),
          customerName: z.string().max(120).optional(),
          offlineCreated: z.boolean().optional(),
          occurredAt: z.coerce.date().optional(),
          lines: z.array(
            z.object({
              variantId: z.string().uuid(),
              quantity: z.number().positive(),
              unitPriceMinor: z.number().int().nonnegative(),
              stockUnitId: z.string().uuid().optional(),
              discountMinor: z.number().int().nonnegative().optional(),
            }),
          ).min(1),
          payments: z.array(
            z.object({
              method: z.enum(["cash", "card"]),
              amountMinor: z.number().int().positive(),
            }),
          ).min(1),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      try {
        const result = await sales.createPosSale(req.auth.tenantId, req.auth.userId, parsed.data);
        return reply.code(201).send(result);
      } catch (err) {
        // Idempotent replay: the sale already exists → return it as success.
        if (err instanceof SaleError && err.code === "DUPLICATE_SALE") {
          const receipt = await sales.receipt(req.auth.tenantId, parsed.data.id);
          if (receipt) {
            return reply.code(200).send({
              orderId: parsed.data.id,
              orderNo: receipt.orderNo,
              totals: receipt.totals,
              duplicate: true,
            });
          }
        }
        throw err;
      }
    });

    secured.get("/v1/orders/:orderId/receipt", async (req, reply) => {
      const { orderId } = req.params as { orderId: string };
      const receipt = await sales.receipt(req.auth.tenantId, orderId);
      if (!receipt) return reply.code(404).send({ error: "NOT_FOUND" });
      return receipt;
    });

    secured.post("/v1/inventory/movements", async (req, reply) => {
      const parsed = movementBodySchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      // Attribution comes from the verified token, never the request body:
      // an employee cannot post a movement as someone else (FP-001).
      const posted = await inventory.postMovement(req.auth.tenantId, {
        ...parsed.data,
        actorUserId: req.auth.userId,
      });
      return reply.code(201).send(posted);
    });

    secured.get("/v1/inventory/availability/:variantId/:locationId", async (req) => {
      const { variantId, locationId } = req.params as { variantId: string; locationId: string };
      return inventory.availability(req.auth.tenantId, variantId, locationId);
    });

    secured.get("/v1/inventory/movements", async (req) => {
      const q = z
        .object({
          afterSeq: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .parse(req.query);
      return inventory.feed(req.auth.tenantId, q.afterSeq, q.limit);
    });
  });

  return app;
}

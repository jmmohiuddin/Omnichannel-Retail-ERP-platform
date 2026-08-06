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
import { ReceivingService } from "./inventory/receivingService.js";
import { SaleError, SalesService } from "./sales/salesService.js";
import { RefundError, RefundService } from "./sales/refundService.js";
import { WebOrderService } from "./sales/webOrderService.js";
import { FulfillmentError, FulfillmentService } from "./sales/fulfillmentService.js";
import { OpsError, OpsService } from "./inventory/opsService.js";
import { AnalyticsService } from "./analytics/analyticsService.js";
import { FinanceError, FinanceService } from "./finance/financeService.js";
import { LoyaltyError, LoyaltyService } from "./crm/loyaltyService.js";
import { WmsError, WmsService } from "./wms/wmsService.js";
import { MockGateway, WebhookVerificationError } from "./payments/gatewayPort.js";
import { PaymentError, PaymentService } from "./payments/paymentService.js";
import { MockCourier } from "./shipping/courierPort.js";
import { ShippingError, ShippingService } from "./shipping/shippingService.js";
import { EInvoiceService } from "./einvoice/einvoiceService.js";
import { AuditService } from "./audit/auditService.js";
import { UnitService } from "./inventory/unitService.js";
import { PurchasingError, PurchasingService } from "./purchasing/purchasingService.js";
import { PricingService } from "./catalog/pricingService.js";
import { GiftCardError, GiftCardService } from "./crm/giftCardService.js";
import { AiBudgetError, AiGateway, StubProvider } from "./ai/gateway.js";
import { AnthropicProvider } from "./ai/anthropicProvider.js";
import { generateDailyDigest } from "./ai/digest.js";

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
  mfaCode: z.string().regex(/^\d{6}$/).optional(),
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
  categoryId: z.string().uuid().optional(),
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
  /** When absent, AI narration uses the deterministic StubProvider. */
  anthropicApiKey?: string;
  /** HMAC secret for the mock payment gateway's webhooks (dev default). */
  paymentWebhookSecret?: string;
}

export function buildPgApp(config: PgAppConfig) {
  const app = Fastify({ logger: false });
  const db = new Db(config.databaseUrl);
  const tokens = new TokenService(config.jwtSecret);
  const audit = new AuditService(db);
  const auth = new AuthService(db, tokens, config.jwtSecret, audit);
  const inventory = new PgInventoryService(db);
  const loyalty = new LoyaltyService(db);
  const pricing = new PricingService(db);
  const giftCards = new GiftCardService(db);
  const sales = new SalesService(db, inventory, loyalty, pricing, giftCards);
  const receiving = new ReceivingService(db, inventory);
  const units = new UnitService(db, inventory);
  const purchasing = new PurchasingService(db, receiving);
  const refunds = new RefundService(db, inventory, audit);
  const webOrders = new WebOrderService(db, inventory, pricing);
  const fulfillment = new FulfillmentService(db, inventory);
  const ops = new OpsService(db, inventory, audit);
  const analytics = new AnalyticsService(db);
  const finance = new FinanceService(db);
  const wms = new WmsService(db);
  const mockGateway = new MockGateway(
    config.paymentWebhookSecret ?? "dev-mock-webhook-secret",
  );
  const payments = new PaymentService(db, new Map([[mockGateway.key, mockGateway]]));
  const shipping = new ShippingService(db, new Map([["mock", new MockCourier()]]));
  const einvoice = new EInvoiceService(db);
  const aiGateway = new AiGateway(
    config.anthropicApiKey
      ? new AnthropicProvider({ apiKey: config.anthropicApiKey })
      : new StubProvider(),
  );

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
        err.code === "PAYMENT_MISMATCH" || err.code === "PRICE_MISMATCH" ? 422
        : err.code === "UNKNOWN_VARIANT" ? 404
        : err.code === "DUPLICATE_SALE" ? 409
        : err.code === "UNIT_UNAVAILABLE" ? 409
        : err.code === "DISCOUNT_APPROVAL_REQUIRED" ? 403
        : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof FulfillmentError) {
      const status =
        err.code === "ORDER_NOT_FOUND" ? 404
        : err.code === "BAD_STATE" ? 409
        : err.code === "UNIT_UNAVAILABLE" ? 409
        : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof PurchasingError) {
      const status =
        err.code.endsWith("NOT_FOUND") ? 404
        : err.code === "BAD_STATE" ? 409
        : err.code === "OVER_RECEIPT" ? 422
        : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof OpsError) {
      const status =
        err.code === "SESSION_NOT_FOUND" || err.code === "TRANSFER_NOT_FOUND" ||
        err.code === "COUNT_NOT_FOUND" ? 404
        : 409;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof ShippingError) {
      const status =
        err.code.endsWith("NOT_FOUND") ? 404
        : err.code === "BAD_STATE" || err.code === "ALREADY_SHIPPED" ? 409
        : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof PaymentError) {
      const status =
        err.code === "ORDER_NOT_FOUND" ? 404
        : err.code === "BAD_STATE" || err.code === "INTENT_EXISTS" ? 409
        : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof WmsError) {
      const status =
        err.code === "ALREADY_EXISTS" || err.code === "BAD_STATE" ? 409
        : err.code === "SHORT_PICK" ? 422
        : err.code.endsWith("NOT_FOUND") ? 404
        : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof GiftCardError) {
      const status =
        err.code === "CARD_NOT_FOUND" ? 404
        : err.code === "CARD_NOT_ACTIVE" ? 409
        : err.code === "BAD_AMOUNT" ? 400
        : 422; // INSUFFICIENT_BALANCE, CARD_EXPIRED
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof LoyaltyError) {
      const status = err.code === "CUSTOMER_NOT_FOUND" ? 404 : 422;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof FinanceError) {
      const status = err.code.endsWith("NOT_FOUND") ? 404 : 422;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof RefundError) {
      const status =
        err.code === "ORDER_NOT_FOUND" || err.code === "APPROVAL_NOT_FOUND" ? 404
        : err.code === "SELF_APPROVAL" || err.code === "FORBIDDEN_ROLE" ? 403
        : err.code === "ALREADY_DECIDED" ? 409
        : 422;
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
    return auth.login(
      parsed.data.slug, parsed.data.email, parsed.data.password, parsed.data.mfaCode,
    );
  });

  app.post("/v1/auth/refresh", async (req, reply) => {
    const parsed = z
      .object({ tenantId: z.string().uuid(), refreshToken: z.string().min(20) })
      .safeParse(req.body);
    if (!parsed.success) return sendZodError(reply, parsed.error.issues);
    return auth.refreshForTenant(parsed.data.tenantId, parsed.data.refreshToken);
  });

  // ---- public storefront ----
  app.get("/v1/public/:slug/catalog", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const tenant = await webOrders.resolveTenant(slug);
    if (!tenant) return reply.code(404).send({ error: "NOT_FOUND" });
    const q = z.object({ category: z.string().max(80).optional() }).parse(req.query);
    const items = await webOrders.publicCatalog(tenant.id, q.category);
    return { tenant: { name: tenant.name, slug, currency: tenant.currency }, items };
  });

  app.post("/v1/public/:slug/orders", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const tenant = await webOrders.resolveTenant(slug);
    if (!tenant) return reply.code(404).send({ error: "NOT_FOUND" });
    const parsed = z
      .object({
        customer: z
          .object({
            name: z.string().min(1).max(120),
            email: z.string().email().optional(),
            phone: z.string().min(5).max(30).optional(),
          })
          .refine((v) => v.email || v.phone, { message: "email or phone required" }),
        lines: z.array(
          z.object({ variantId: z.string().uuid(), quantity: z.number().positive().max(100) }),
        ).min(1).max(50),
      })
      .safeParse(req.body);
    if (!parsed.success) return sendZodError(reply, parsed.error.issues);
    const result = await webOrders.createOrder(tenant, parsed.data);
    return reply.code(201).send(result);
  });

  // Customer pays their own pending order → hosted-checkout redirect.
  app.post("/v1/public/:slug/orders/:orderId/pay", async (req, reply) => {
    const { slug, orderId } = req.params as { slug: string; orderId: string };
    const tenant = await webOrders.resolveTenant(slug);
    if (!tenant) return reply.code(404).send({ error: "NOT_FOUND" });
    const parsed = z.object({ gateway: z.string().default("mock") }).safeParse(req.body ?? {});
    if (!parsed.success) return sendZodError(reply, parsed.error.issues);
    const intent = await payments.createIntent(tenant.id, orderId, parsed.data.gateway);
    return reply.code(201).send(intent);
  });

  // Gateway webhooks: signature is verified over the RAW body, so this scope
  // parses JSON bodies as strings instead of objects.
  app.register(async (webhooks) => {
    webhooks.removeAllContentTypeParsers();
    webhooks.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) =>
      done(null, body),
    );
    webhooks.post("/v1/webhooks/payments/:gateway", async (req, reply) => {
      const { gateway } = req.params as { gateway: string };
      let event;
      try {
        event = payments
          .gateway(gateway)
          .parseWebhook(req.body as string, req.headers["x-webhook-signature"] as string | undefined);
      } catch (err) {
        if (err instanceof WebhookVerificationError) {
          return reply.code(401).send({ error: "BAD_SIGNATURE" });
        }
        throw err;
      }
      return payments.applyWebhook(gateway, event, req.body as string);
    });
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
          `INSERT INTO product (id, tenant_id, name, slug, tracking, description,
                                category_id, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'active')`,
          [id, req.auth.tenantId, parsed.data.name, parsed.data.slug,
           parsed.data.tracking, parsed.data.description ?? null,
           parsed.data.categoryId ?? null],
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

    const requireRole = (req: { auth: AccessClaims }, ...roles: string[]): boolean =>
      req.auth.roles.some((r) => roles.includes(r));

    secured.post("/v1/auth/mfa/enroll", async (req) =>
      auth.enrollMfa(req.auth.tenantId, req.auth.userId),
    );

    secured.post("/v1/auth/mfa/activate", async (req, reply) => {
      const parsed = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return auth.activateMfa(req.auth.tenantId, req.auth.userId, parsed.data.code);
    });

    secured.get("/v1/audit", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "manager role required" });
      }
      const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
        .parse(req.query);
      return { items: await audit.list(req.auth.tenantId, q.limit) };
    });

    secured.get("/v1/audit/verify", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "manager role required" });
      }
      return audit.verifyChain(req.auth.tenantId);
    });

    secured.post("/v1/channels", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "manager role required" });
      }
      const parsed = z
        .object({
          kind: z.enum(["marketplace", "social", "custom"]),
          name: z.string().min(1).max(60),
          connector: z.string().min(1).max(40),
          config: z.record(z.unknown()).default({}),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const id = randomUUID();
      await db.withTenant(req.auth.tenantId, (c) =>
        c.query(
          `INSERT INTO channel (id, tenant_id, kind, name, connector, config, status)
           VALUES ($1,$2,$3,$4,$5,$6,'active')`,
          [id, req.auth.tenantId, parsed.data.kind, parsed.data.name,
           parsed.data.connector, JSON.stringify(parsed.data.config)],
        ),
      );
      return reply.code(201).send({ id, ...parsed.data });
    });

    secured.get("/v1/channels", async (req) => {
      const rows = await db.withTenant(req.auth.tenantId, async (c) => {
        const { rows } = await c.query(
          `SELECT id, kind, name, connector, status FROM channel ORDER BY name`,
        );
        return rows;
      });
      return { items: rows };
    });

    secured.put("/v1/channels/:channelId/listings/:variantId", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "manager role required" });
      }
      const { channelId, variantId } = req.params as { channelId: string; variantId: string };
      const parsed = z
        .object({
          published: z.boolean().default(true),
          bufferQty: z.number().nonnegative().default(0),
          priceMinor: z.number().int().nonnegative().optional(),
          externalId: z.string().optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      await db.withTenant(req.auth.tenantId, (c) =>
        c.query(
          `INSERT INTO channel_listing
             (tenant_id, channel_id, variant_id, published, buffer_qty, price_minor, external_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (tenant_id, channel_id, variant_id)
           DO UPDATE SET published = EXCLUDED.published, buffer_qty = EXCLUDED.buffer_qty,
                         price_minor = EXCLUDED.price_minor,
                         external_id = coalesce(EXCLUDED.external_id, channel_listing.external_id)`,
          [req.auth.tenantId, channelId, variantId, parsed.data.published,
           parsed.data.bufferQty, parsed.data.priceMinor ?? null,
           parsed.data.externalId ?? null],
        ),
      );
      return { channelId, variantId, ...parsed.data };
    });

    secured.post("/v1/users", async (req, reply) => {
      if (!requireRole(req, "owner")) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "owner role required" });
      }
      const parsed = z
        .object({
          email: z.string().email(),
          password: z.string().min(10),
          fullName: z.string().min(1),
          role: z.enum(["manager", "cashier", "warehouse"]),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const created = await auth.createUser(req.auth.tenantId, parsed.data);
      return reply.code(201).send(created);
    });

    const purchasingRole = (req: { auth: AccessClaims }) =>
      requireRole(req, "owner", "manager", "warehouse");

    secured.get("/v1/suppliers", async (req) => ({
      items: await purchasing.listSuppliers(req.auth.tenantId),
    }));

    secured.post("/v1/suppliers", async (req, reply) => {
      if (!purchasingRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
      const parsed = z
        .object({
          name: z.string().min(1).max(120),
          contact: z.record(z.unknown()).optional(),
          paymentTerms: z.string().max(120).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return reply.code(201).send(await purchasing.createSupplier(req.auth.tenantId, parsed.data));
    });

    secured.post("/v1/purchase-orders", async (req, reply) => {
      if (!purchasingRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
      const parsed = z
        .object({
          supplierId: z.string().uuid(),
          locationId: z.string().uuid(),
          currency: z.string().length(3).optional(),
          expectedAt: z.string().date().optional(),
          note: z.string().max(300).optional(),
          lines: z.array(
            z.object({
              variantId: z.string().uuid(),
              orderedQty: z.number().positive(),
              unitCostMinor: z.number().int().nonnegative(),
            }),
          ).min(1),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const result = await purchasing.createPurchaseOrder(
        req.auth.tenantId, req.auth.userId, parsed.data,
      );
      return reply.code(201).send(result);
    });

    secured.get("/v1/purchase-orders/:poId", async (req) => {
      const { poId } = req.params as { poId: string };
      return purchasing.getPurchaseOrder(req.auth.tenantId, poId);
    });

    secured.post("/v1/purchase-orders/:poId/receive", async (req, reply) => {
      if (!purchasingRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
      const { poId } = req.params as { poId: string };
      const parsed = z
        .object({
          deviceId: z.string().uuid().optional(),
          lines: z.array(
            z.object({
              variantId: z.string().uuid(),
              quantity: z.number().positive().optional(),
              units: z.array(
                z.object({
                  imei1: z.string().optional(),
                  imei2: z.string().optional(),
                  serialNo: z.string().optional(),
                  unitCostMinor: z.number().int().nonnegative().optional(),
                }),
              ).optional(),
            }),
          ).min(1),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return purchasing.receiveAgainstPo(req.auth.tenantId, req.auth.userId, poId, parsed.data);
    });

    secured.post("/v1/inventory/receipts", async (req, reply) => {
      const parsed = z
        .object({
          locationId: z.string().uuid(),
          deviceId: z.string().uuid().optional(),
          reference: z.string().max(200).optional(),
          lines: z.array(
            z.object({
              variantId: z.string().uuid(),
              quantity: z.number().positive().optional(),
              units: z.array(
                z.object({
                  imei1: z.string().optional(),
                  imei2: z.string().optional(),
                  serialNo: z.string().optional(),
                  unitCostMinor: z.number().int().nonnegative().optional(),
                }),
              ).optional(),
            }),
          ).min(1),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const result = await receiving.receive(req.auth.tenantId, req.auth.userId, parsed.data);
      return reply.code(201).send(result);
    });

    secured.get("/v1/stock-units", async (req, reply) => {
      const q = z
        .object({ imei: z.string().optional(), serialNo: z.string().optional() })
        .parse(req.query);
      const unit = await receiving.findUnit(req.auth.tenantId, q);
      if (!unit) return reply.code(404).send({ error: "NOT_FOUND" });
      return unit;
    });

    secured.post("/v1/stock-units/:unitId/repair-out", async (req, reply) => {
      const { unitId } = req.params as { unitId: string };
      const parsed = z.object({ note: z.string().max(300).optional() }).safeParse(req.body ?? {});
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return units.repairOut(req.auth.tenantId, req.auth.userId, unitId, parsed.data.note);
    });

    secured.post("/v1/stock-units/:unitId/repair-in", async (req, reply) => {
      const { unitId } = req.params as { unitId: string };
      const parsed = z.object({ note: z.string().max(300).optional() }).safeParse(req.body ?? {});
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return units.repairIn(req.auth.tenantId, req.auth.userId, unitId, parsed.data.note);
    });

    secured.get("/v1/stock-units/:unitId/history", async (req, reply) => {
      const { unitId } = req.params as { unitId: string };
      const history = await units.history(req.auth.tenantId, unitId);
      if (!history) return reply.code(404).send({ error: "NOT_FOUND" });
      return history;
    });

    // Manager pre-authorizes an exceptional discount; the cashier attaches the
    // approved id to the sale line (FP-004).
    secured.post("/v1/pos/discount-approvals", async (req, reply) => {
      const parsed = z
        .object({
          reason: z.string().min(3).max(300),
          amountMinor: z.number().int().positive(),
          variantId: z.string().uuid().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const approvalId = randomUUID();
      await db.withTenant(req.auth.tenantId, (c) =>
        c.query(
          `INSERT INTO approval (id, tenant_id, kind, requested_by, status, payload, reason)
           VALUES ($1,$2,'discount',$3,'pending',$4,$5)`,
          [approvalId, req.auth.tenantId, req.auth.userId,
           JSON.stringify({ amountMinor: parsed.data.amountMinor,
                            variantId: parsed.data.variantId ?? null }),
           parsed.data.reason],
        ),
      );
      return reply.code(201).send({ approvalId, status: "pending" });
    });

    secured.post("/v1/orders/:orderId/refunds", async (req, reply) => {
      const { orderId } = req.params as { orderId: string };
      const parsed = z
        .object({
          amountMinor: z.number().int().positive(),
          reason: z.string().min(3).max(500),
          method: z.enum(["cash", "card"]),
          restock: z.array(
            z.object({
              variantId: z.string().uuid(),
              quantity: z.number().positive(),
              stockUnitId: z.string().uuid().optional(),
            }),
          ).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const result = await refunds.requestRefund(
        req.auth.tenantId, req.auth.userId, orderId, parsed.data,
      );
      return reply.code(201).send(result);
    });

    secured.get("/v1/approvals", async (req) => {
      return { items: await refunds.listPendingApprovals(req.auth.tenantId) };
    });

    secured.post("/v1/approvals/:approvalId/decision", async (req, reply) => {
      const { approvalId } = req.params as { approvalId: string };
      const parsed = z.object({ approve: z.boolean() }).safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const result = await refunds.decide(
        req.auth.tenantId,
        { userId: req.auth.userId, roles: req.auth.roles },
        approvalId,
        parsed.data.approve,
      );
      return result;
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

    secured.get("/v1/categories", async (req) => {
      const rows = await db.withTenant(req.auth.tenantId, async (c) => {
        const { rows } = await c.query(
          `SELECT id, parent_id AS "parentId", name, slug, position,
                  (SELECT count(*)::int FROM product p WHERE p.category_id = category.id) AS products
             FROM category ORDER BY position, name`,
        );
        return rows;
      });
      return { items: rows };
    });

    secured.post("/v1/categories", async (req, reply) => {
      const parsed = z
        .object({
          name: z.string().min(1).max(80),
          slug: z.string().regex(/^[a-z0-9-]+$/).max(80),
          parentId: z.string().uuid().optional(),
          position: z.number().int().min(0).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const id = randomUUID();
      await db.withTenant(req.auth.tenantId, (c) =>
        c.query(
          `INSERT INTO category (id, tenant_id, name, slug, parent_id, position)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, req.auth.tenantId, parsed.data.name, parsed.data.slug,
           parsed.data.parentId ?? null, parsed.data.position ?? 0],
        ),
      );
      return reply.code(201).send({ id, ...parsed.data });
    });

    secured.put("/v1/products/:productId/category", async (req, reply) => {
      const { productId } = req.params as { productId: string };
      const parsed = z
        .object({ categoryId: z.string().uuid().nullable() })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const res = await db.withTenant(req.auth.tenantId, (c) =>
        c.query(
          "UPDATE product SET category_id = $2, updated_at = now() WHERE id = $1",
          [productId, parsed.data.categoryId],
        ),
      );
      if (res.rowCount === 0) return reply.code(404).send({ error: "NOT_FOUND" });
      return { productId, categoryId: parsed.data.categoryId };
    });

    secured.put("/v1/customers/:customerId/price-list", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN" });
      }
      const { customerId } = req.params as { customerId: string };
      const parsed = z
        .object({ priceListId: z.string().uuid().nullable() })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return pricing.assignCustomerPriceList(
        req.auth.tenantId, customerId, parsed.data.priceListId,
      );
    });

    secured.get("/v1/price-lists", async (req) => ({
      items: await pricing.listPriceLists(req.auth.tenantId),
    }));

    secured.post("/v1/price-lists", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN" });
      }
      const parsed = z
        .object({
          name: z.string().min(1).max(80),
          kind: z.enum(["promo", "wholesale", "channel"]),
          currency: z.string().length(3),
          startsAt: z.string().datetime().optional(),
          endsAt: z.string().datetime().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return reply.code(201).send(await pricing.createPriceList(req.auth.tenantId, parsed.data));
    });

    secured.put("/v1/price-lists/:priceListId/items", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN" });
      }
      const { priceListId } = req.params as { priceListId: string };
      const parsed = z
        .object({
          items: z.array(
            z.object({
              variantId: z.string().uuid(),
              priceMinor: z.number().int().nonnegative(),
              minQty: z.number().positive().optional(),
            }),
          ).min(1).max(500),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return pricing.upsertItems(req.auth.tenantId, priceListId, parsed.data.items);
    });

    secured.post("/v1/products/:productId/images", async (req, reply) => {
      const { productId } = req.params as { productId: string };
      const parsed = z
        .object({
          url: z.string().url().max(500),
          alt: z.string().max(200).optional(),
          position: z.number().int().min(0).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const id = randomUUID();
      await db.withTenant(req.auth.tenantId, (c) =>
        c.query(
          `INSERT INTO product_image (id, tenant_id, product_id, url, alt, position)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, req.auth.tenantId, productId, parsed.data.url,
           parsed.data.alt ?? null, parsed.data.position ?? 0],
        ),
      );
      return reply.code(201).send({ id, ...parsed.data });
    });

    secured.put("/v1/products/:productId/seo", async (req, reply) => {
      const { productId } = req.params as { productId: string };
      const parsed = z
        .object({
          title: z.string().max(120).optional(),
          description: z.string().max(300).optional(),
          keywords: z.array(z.string().max(40)).max(20).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const res = await db.withTenant(req.auth.tenantId, (c) =>
        c.query(
          "UPDATE product SET seo = $2, updated_at = now() WHERE id = $1",
          [productId, JSON.stringify(parsed.data)],
        ),
      );
      if (res.rowCount === 0) return reply.code(404).send({ error: "NOT_FOUND" });
      return { productId, seo: parsed.data };
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

    const wmsRole = (req: { auth: AccessClaims }) =>
      requireRole(req, "owner", "manager", "warehouse");

    secured.post("/v1/wms/zones", async (req, reply) => {
      if (!wmsRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
      const parsed = z
        .object({
          locationId: z.string().uuid(),
          code: z.string().min(1).max(16),
          name: z.string().min(1).max(60),
          position: z.number().int().min(0).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return reply.code(201).send(await wms.createZone(req.auth.tenantId, parsed.data));
    });

    secured.post("/v1/wms/bins", async (req, reply) => {
      if (!wmsRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
      const parsed = z
        .object({
          zoneId: z.string().uuid(),
          code: z.string().min(1).max(16),
          position: z.number().int().min(0).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return reply.code(201).send(await wms.createBin(req.auth.tenantId, parsed.data));
    });

    secured.post("/v1/wms/bins/:binId/assign", async (req, reply) => {
      if (!wmsRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
      const { binId } = req.params as { binId: string };
      const parsed = z.object({ variantId: z.string().uuid() }).safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return wms.assignBin(req.auth.tenantId, { binId, variantId: parsed.data.variantId });
    });

    secured.get("/v1/wms/locations/:locationId/layout", async (req) => {
      const { locationId } = req.params as { locationId: string };
      return { zones: await wms.locationLayout(req.auth.tenantId, locationId) };
    });

    secured.post("/v1/wms/pick-lists", async (req, reply) => {
      if (!wmsRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
      const parsed = z.object({ orderId: z.string().uuid() }).safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const result = await wms.createPickList(
        req.auth.tenantId, req.auth.userId, parsed.data.orderId,
      );
      return reply.code(201).send(result);
    });

    secured.get("/v1/wms/pick-lists/:pickListId", async (req) => {
      const { pickListId } = req.params as { pickListId: string };
      return wms.getPickList(req.auth.tenantId, pickListId);
    });

    secured.put("/v1/wms/pick-lists/:pickListId/picks", async (req, reply) => {
      if (!wmsRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
      const { pickListId } = req.params as { pickListId: string };
      const parsed = z
        .object({
          picks: z.array(
            z.object({ variantId: z.string().uuid(), pickedQty: z.number().nonnegative() }),
          ).min(1),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return wms.recordPicks(req.auth.tenantId, req.auth.userId, pickListId, parsed.data.picks);
    });

    secured.post("/v1/wms/pick-lists/:pickListId/complete", async (req, reply) => {
      if (!wmsRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
      const { pickListId } = req.params as { pickListId: string };
      return wms.completePickList(req.auth.tenantId, req.auth.userId, pickListId);
    });

    secured.get("/v1/devices", async (req) => {
      const rows = await db.withTenant(req.auth.tenantId, async (c) => {
        const { rows } = await c.query(
          `SELECT id, kind, name, location_id AS "locationId", status
             FROM device WHERE status <> 'revoked' ORDER BY name`,
        );
        return rows;
      });
      return { items: rows };
    });

    secured.get("/v1/orders", async (req) => {
      const q = z
        .object({
          status: z.enum(["pending", "confirmed", "fulfilling", "fulfilled", "completed",
                          "cancelled", "refunded", "partially_refunded"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(req.query);
      const rows = await db.withTenant(req.auth.tenantId, async (c) => {
        const { rows } = await c.query(
          `SELECT o.id, o.order_no AS "orderNo", o.status, ch.kind AS "channelKind",
                  coalesce(cu.full_name, o.meta->>'customerName') AS "customerName",
                  o.total_minor AS "totalMinor", o.currency, o.placed_at AS "placedAt"
             FROM sales_order o
             JOIN channel ch ON ch.id = o.channel_id
             LEFT JOIN customer cu ON cu.id = o.customer_id
            WHERE ($1::text IS NULL OR o.status = $1)
            ORDER BY o.placed_at DESC LIMIT $2`,
          [q.status ?? null, q.limit],
        );
        return rows.map((r) => ({ ...r, totalMinor: Number(r.totalMinor) }));
      });
      return { items: rows };
    });

    secured.get("/v1/customers", async (req) => {
      const q = z.object({ query: z.string().trim().max(100).optional() }).parse(req.query);
      const rows = await db.withTenant(req.auth.tenantId, async (c) => {
        const { rows } = await c.query(
          `SELECT id, full_name AS "fullName", phone, email,
                  loyalty_points AS "loyaltyPoints"
             FROM customer
            WHERE $1::text IS NULL OR full_name ILIKE '%'||$1||'%'
               OR phone ILIKE '%'||$1||'%' OR email::text ILIKE '%'||$1||'%'
            ORDER BY full_name LIMIT 20`,
          [q.query ?? null],
        );
        return rows.map((r) => ({ ...r, loyaltyPoints: Number(r.loyaltyPoints) }));
      });
      return { items: rows };
    });

    secured.post("/v1/customers", async (req, reply) => {
      const parsed = z
        .object({
          fullName: z.string().min(1).max(120),
          phone: z.string().min(5).max(30).optional(),
          email: z.string().email().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const id = randomUUID();
      await db.withTenant(req.auth.tenantId, (c) =>
        c.query(
          "INSERT INTO customer (id, tenant_id, full_name, phone, email) VALUES ($1,$2,$3,$4,$5)",
          [id, req.auth.tenantId, parsed.data.fullName,
           parsed.data.phone ?? null, parsed.data.email ?? null],
        ),
      );
      return reply.code(201).send({ id, ...parsed.data, loyaltyPoints: 0 });
    });

    secured.post("/v1/gift-cards", async (req, reply) => {
      const parsed = z
        .object({
          amountMinor: z.number().int().positive(),
          expiresAt: z.string().date().optional(),
          orderId: z.string().uuid().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const result = await giftCards.issue(req.auth.tenantId, req.auth.userId, parsed.data);
      return reply.code(201).send(result);
    });

    secured.get("/v1/gift-cards/:code", async (req) => {
      const { code } = req.params as { code: string };
      return giftCards.balance(req.auth.tenantId, code);
    });

    secured.get("/v1/customers/:customerId/loyalty", async (req) => {
      const { customerId } = req.params as { customerId: string };
      return loyalty.balance(req.auth.tenantId, customerId);
    });

    secured.post("/v1/pos/sales", async (req, reply) => {
      const parsed = z
        .object({
          id: z.string().uuid(),
          deviceId: z.string().uuid(),
          locationId: z.string().uuid(),
          customerName: z.string().max(120).optional(),
          customerId: z.string().uuid().optional(),
          offlineCreated: z.boolean().optional(),
          occurredAt: z.coerce.date().optional(),
          lines: z.array(
            z.object({
              variantId: z.string().uuid(),
              quantity: z.number().positive(),
              unitPriceMinor: z.number().int().nonnegative(),
              stockUnitId: z.string().uuid().optional(),
              discountMinor: z.number().int().nonnegative().optional(),
              discountApprovalId: z.string().uuid().optional(),
            }),
          ).min(1),
          payments: z.array(
            z.object({
              method: z.enum(["cash", "card", "loyalty_points", "gift_card"]),
              amountMinor: z.number().int().positive(),
              giftCardCode: z.string().max(40).optional(),
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

    secured.post("/v1/orders/:orderId/shipments", async (req, reply) => {
      const { orderId } = req.params as { orderId: string };
      const parsed = z
        .object({
          courier: z.string().default("mock"),
          address: z.record(z.unknown()).default({}),
          codAmountMinor: z.number().int().nonnegative().optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const result = await shipping.createShipment(
        req.auth.tenantId, req.auth.userId, orderId, parsed.data,
      );
      return reply.code(201).send(result);
    });

    secured.post("/v1/shipments/:shipmentId/refresh", async (req) => {
      const { shipmentId } = req.params as { shipmentId: string };
      return shipping.refreshTracking(req.auth.tenantId, shipmentId);
    });

    secured.get("/v1/shipments/:shipmentId", async (req) => {
      const { shipmentId } = req.params as { shipmentId: string };
      return shipping.getShipment(req.auth.tenantId, shipmentId);
    });

    secured.get("/v1/orders/:orderId/einvoice", async (req, reply) => {
      const { orderId } = req.params as { orderId: string };
      const doc = await einvoice.generateForOrder(req.auth.tenantId, orderId);
      if (!doc) return reply.code(404).send({ error: "NOT_FOUND" });
      return doc;
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

    secured.post("/v1/orders/:orderId/fulfill", async (req, reply) => {
      const { orderId } = req.params as { orderId: string };
      const parsed = z
        .object({
          units: z.array(
            z.object({ variantId: z.string().uuid(), stockUnitId: z.string().uuid() }),
          ).optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return fulfillment.fulfill(req.auth.tenantId, req.auth.userId, orderId, parsed.data);
    });

    secured.post("/v1/orders/:orderId/cancel", async (req, reply) => {
      const { orderId } = req.params as { orderId: string };
      const parsed = z.object({ reason: z.string().min(3).max(300) }).safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return fulfillment.cancel(req.auth.tenantId, req.auth.userId, orderId, parsed.data.reason);
    });

    secured.post("/v1/cash-sessions", async (req, reply) => {
      const parsed = z
        .object({ deviceId: z.string().uuid(), openingFloatMinor: z.number().int().nonnegative() })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const result = await ops.openCashSession(req.auth.tenantId, req.auth.userId, parsed.data);
      return reply.code(201).send(result);
    });

    secured.post("/v1/cash-sessions/:sessionId/close", async (req, reply) => {
      const { sessionId } = req.params as { sessionId: string };
      const parsed = z
        .object({ declaredMinor: z.number().int().nonnegative() })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return ops.closeCashSession(
        req.auth.tenantId, req.auth.userId, sessionId, parsed.data.declaredMinor,
      );
    });

    secured.post("/v1/transfers", async (req, reply) => {
      const parsed = z
        .object({
          fromLocationId: z.string().uuid(),
          toLocationId: z.string().uuid(),
          note: z.string().max(300).optional(),
          lines: z.array(
            z.object({ variantId: z.string().uuid(), quantity: z.number().positive() }),
          ).min(1),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const result = await ops.dispatchTransfer(req.auth.tenantId, req.auth.userId, parsed.data);
      return reply.code(201).send(result);
    });

    secured.post("/v1/transfers/:transferId/receive", async (req) => {
      const { transferId } = req.params as { transferId: string };
      return ops.receiveTransfer(req.auth.tenantId, req.auth.userId, transferId);
    });

    secured.post("/v1/stock-counts", async (req, reply) => {
      const parsed = z
        .object({
          locationId: z.string().uuid(),
          variantIds: z.array(z.string().uuid()).min(1).max(500),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const result = await ops.createCount(req.auth.tenantId, req.auth.userId, parsed.data);
      return reply.code(201).send(result);
    });

    secured.put("/v1/stock-counts/:countId/lines", async (req, reply) => {
      const { countId } = req.params as { countId: string };
      const parsed = z
        .object({
          counts: z.array(
            z.object({ variantId: z.string().uuid(), countedQty: z.number().nonnegative() }),
          ).min(1),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return ops.recordCounts(req.auth.tenantId, req.auth.userId, countId, parsed.data.counts);
    });

    secured.post("/v1/stock-counts/:countId/submit", async (req) => {
      const { countId } = req.params as { countId: string };
      return ops.submitCount(req.auth.tenantId, req.auth.userId, countId);
    });

    secured.get("/v1/analytics/summary", async (req) => analytics.summary(req.auth.tenantId));

    secured.get("/v1/ai/reorder-suggestions", async (req) => {
      const q = z
        .object({
          windowDays: z.coerce.number().int().min(7).max(365).default(56),
          leadTimeDays: z.coerce.number().int().min(1).max(90).default(7),
        })
        .parse(req.query);
      return { items: await analytics.reorderSuggestions(req.auth.tenantId, q) };
    });

    secured.get("/v1/ai/dead-stock", async (req) => {
      const q = z
        .object({ thresholdDays: z.coerce.number().int().min(14).max(730).default(90) })
        .parse(req.query);
      return { items: await analytics.deadStock(req.auth.tenantId, q.thresholdDays) };
    });

    secured.post("/v1/finance/orders/:orderId/post", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "manager role required" });
      }
      const { orderId } = req.params as { orderId: string };
      return finance.postSale(req.auth.tenantId, orderId);
    });

    secured.post("/v1/finance/refunds/:refundId/post", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "manager role required" });
      }
      const { refundId } = req.params as { refundId: string };
      return finance.postRefund(req.auth.tenantId, refundId);
    });

    secured.get("/v1/finance/trial-balance", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "manager role required" });
      }
      return finance.trialBalance(req.auth.tenantId);
    });

    secured.get("/v1/finance/pnl", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "manager role required" });
      }
      const q = z
        .object({ from: z.string().datetime(), to: z.string().datetime() })
        .safeParse(req.query);
      if (!q.success) return sendZodError(reply, q.error.issues);
      return finance.profitAndLoss(req.auth.tenantId, {
        fromIso: q.data.from,
        toIso: q.data.to,
      });
    });

    secured.get("/v1/ai/daily-digest", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "manager role required" });
      }
      const tenantId = req.auth.tenantId;
      const [summary, reorder, deadStock, exceptions] = await Promise.all([
        analytics.summary(tenantId),
        analytics.reorderSuggestions(tenantId),
        analytics.deadStock(tenantId),
        analytics.exceptions(tenantId),
      ]);
      try {
        const result = await generateDailyDigest(aiGateway, tenantId, {
          summary, reorder, deadStock, exceptions,
        } as never);
        return {
          digest: result.text,
          generatedBy: config.anthropicApiKey ? "claude" : "stub",
          data: { summary, reorder, deadStock, exceptions },
        };
      } catch (err) {
        if (err instanceof AiBudgetError) {
          return reply.code(429).send({ error: err.code });
        }
        throw err;
      }
    });

    secured.get("/v1/reports/exceptions", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "manager role required" });
      }
      const q = z
        .object({ sinceHours: z.coerce.number().int().min(1).max(720).default(24) })
        .parse(req.query);
      return analytics.exceptions(req.auth.tenantId, q.sinceHours);
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

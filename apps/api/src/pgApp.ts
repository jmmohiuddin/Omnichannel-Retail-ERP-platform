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
import { EMIRATES, LedgerError, RCM_DEVICE_CLASSES } from "@omniretail/domain";
import { Db } from "./db.js";
import { AuthError, AuthService } from "./auth/service.js";
import { TokenService, type AccessClaims } from "./auth/tokens.js";
import { PgInventoryService } from "./inventory/pgInventory.js";
import { ReceivingService } from "./inventory/receivingService.js";
import { SaleError, SalesService } from "./sales/salesService.js";
import { RefundError, RefundService } from "./sales/refundService.js";
import { WebOrderService } from "./sales/webOrderService.js";
import { CodError, CodService } from "./sales/codService.js";
import { FulfillmentError, FulfillmentService } from "./sales/fulfillmentService.js";
import { OpsError, OpsService } from "./inventory/opsService.js";
import { AnalyticsService } from "./analytics/analyticsService.js";
import { EventError, EventService, isEventName, isFunnelPreset } from "./analytics/eventService.js";
import { ProductError, ProductService } from "./catalog/productService.js";
import { FinanceError, FinanceService } from "./finance/financeService.js";
import { LoyaltyError, LoyaltyService } from "./crm/loyaltyService.js";
import { WmsError, WmsService } from "./wms/wmsService.js";
import { MockGateway, WebhookVerificationError } from "./payments/gatewayPort.js";
import { PaymentError, PaymentService } from "./payments/paymentService.js";
import { MockCourier } from "./shipping/courierPort.js";
import { ShippingError, ShippingService } from "./shipping/shippingService.js";
import { EInvoiceService } from "./einvoice/einvoiceService.js";
import { CreditNoteError, CreditNoteService } from "./einvoice/creditNoteService.js";
import { AuditService } from "./audit/auditService.js";
import { UnitService } from "./inventory/unitService.js";
import { PurchasingError, PurchasingService } from "./purchasing/purchasingService.js";
import { PricingService } from "./catalog/pricingService.js";
import { GiftCardError, GiftCardService } from "./crm/giftCardService.js";
import { StoreCreditError, StoreCreditService } from "./crm/storeCreditService.js";
import { deepHealth } from "./observability/deepHealth.js";
import { registerRateLimit } from "./observability/rateLimit.js";
import {
  NoopErrorReporter,
  type ErrorReporter,
} from "./observability/errorReporter.js";
import { AiBudgetError, AiGateway, StubProvider } from "./ai/gateway.js";
import { AnthropicProvider } from "./ai/anthropicProvider.js";
import { generateDailyDigest } from "./ai/digest.js";
import { CustomerAuthError, CustomerAuthService } from "./customer/customerAuthService.js";
import { RcmError, RcmService } from "./tax/rcmService.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: AccessClaims;
    /** Populated only inside the storefront customer-session scope. */
    customerId: string;
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
  /**
   * Electronic-device class under Cabinet Decision 91/2023 (R7.3). Absent
   * means "not a qualifying device" — an accessory, a SIM, a service — which
   * is the common case, so a shop that never sells B2B never sets it.
   */
  deviceClass: z.enum(RCM_DEVICE_CLASSES).optional(),
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
  /**
   * Where unhandled failures are reported (R12.10, R14.6). Defaults to the
   * no-op so tests and local runs stay silent; main.ts supplies the real one
   * from SENTRY_DSN.
   */
  errorReporter?: ErrorReporter;
}

export function buildPgApp(config: PgAppConfig) {
  const app = Fastify({ logger: false });
  const errors = config.errorReporter ?? new NoopErrorReporter();
  const db = new Db(config.databaseUrl);
  const tokens = new TokenService(config.jwtSecret);
  const audit = new AuditService(db);
  const auth = new AuthService(db, tokens, config.jwtSecret, audit);
  const inventory = new PgInventoryService(db);
  const loyalty = new LoyaltyService(db);
  const pricing = new PricingService(db);
  const giftCards = new GiftCardService(db);
  const storeCredit = new StoreCreditService(db);
  const customerAuth = new CustomerAuthService(db);
  const rcm = new RcmService(db);
  const cod = new CodService(db);
  const sales = new SalesService(db, inventory, loyalty, pricing, giftCards, storeCredit, rcm);
  const receiving = new ReceivingService(db, inventory);
  const units = new UnitService(db, inventory);
  const purchasing = new PurchasingService(db, receiving);
  const creditNotes = new CreditNoteService(db);
  const refunds = new RefundService(db, inventory, audit, creditNotes);
  const webOrders = new WebOrderService(db, inventory, pricing);
  const fulfillment = new FulfillmentService(db, inventory);
  const ops = new OpsService(db, inventory, audit);
  const analytics = new AnalyticsService(db);
  const events = new EventService(db);
  const products = new ProductService(db, audit);
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
  // Rate limit BEFORE routes so it wraps every path. /health is bypassed
  // inside the plugin so load balancers and cron pings never trip a 429.
  void registerRateLimit(app);

  app.addHook("onClose", async () => {
    // Flush first: a crash-triggered shutdown is exactly when the queued
    // events matter most, and closing the pool can take the process with it.
    await errors.flush();
    await db.close();
  });

  const sendZodError = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, issues: unknown) =>
    reply.code(400).send({ error: "VALIDATION", issues });

  app.setErrorHandler((err, req, reply) => {
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
        // A precondition the cashier can fix in one action: open the till.
        : err.code === "NO_OPEN_CASH_SESSION" ? 409
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
        : err.code === "SHORT_PICK" || err.code === "EXCEEDS_ON_HAND" ||
          err.code === "INSUFFICIENT_BIN_QTY" ? 422
        : err.code.endsWith("NOT_FOUND") ? 404
        : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof StoreCreditError) {
      const status =
        err.code === "CUSTOMER_NOT_FOUND" || err.code === "ACCOUNT_NOT_FOUND" ? 404
        : err.code === "BAD_AMOUNT" ? 400
        : 422; // INSUFFICIENT_BALANCE
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
    if (err instanceof CustomerAuthError) {
      // Every failure mode is client input in some sense (bad token, expired
      // link, already-used link). 401 conveys "your credential is not valid"
      // without leaking whether the email itself is known.
      return reply.code(401).send({ error: err.code });
    }
    if (err instanceof ProductError) {
      const status =
        err.code === "NOT_FOUND" ? 404
        : err.code === "SLUG_TAKEN" ? 409
        // The merchant is being asked to confirm, not refused: 409 so the client
        // can re-send with confirm=true rather than treating it as a dead end.
        : err.code === "ARCHIVE_CONFIRMATION_REQUIRED" ? 409
        : err.code === "TRACKING_LOCKED" ? 409
        // `details.checklist` names the failing clause, so the editor can point
        // at the field rather than saying "publish failed".
        : err.code === "PUBLISH_BLOCKED" ? 422
        : 400;
      return reply
        .code(status)
        .send({ error: err.code, message: err.message, ...(err.details ?? {}) });
    }
    if (err instanceof EventError) {
      return reply.code(400).send({ error: err.code, message: err.message });
    }
    if (err instanceof CodError) {
      // 422, not 400: the request is well-formed and the shopper did nothing
      // wrong — this payment method is simply not available to them. The body
      // carries the reason and the alternatives so checkout can offer a next
      // step instead of a dead end.
      const status = err.code === "ORDER_NOT_FOUND" ? 404 : 422;
      return reply
        .code(status)
        .send({ error: err.code, message: err.message, ...(err.details ?? {}) });
    }
    if (err instanceof CreditNoteError) {
      const status =
        err.code === "ORDER_NOT_FOUND" ? 404
        : err.code === "EXCEEDS_INVOICE" ? 422
        : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof RcmError) {
      const status =
        err.code === "CUSTOMER_NOT_FOUND" || err.code === "DECLARATION_NOT_FOUND" ? 404
        : err.code === "ALREADY_VERIFIED" || err.code === "ALREADY_REVOKED" ? 409
        // NOT_A_BUSINESS_CUSTOMER and TRN_REQUIRED are both "fix the customer
        // record first" — a precondition the user can satisfy in one step.
        : 422;
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
    // Everything above is a typed, expected failure answered with a 4xx — the
    // client did something we have an answer for. Reaching here means we did
    // not, so this is the only branch that pages a human (R12.10, R14.6).
    app.log.error(err);
    errors.captureException(err, {
      transaction: `${req.method} ${req.routeOptions?.url ?? req.url}`,
      ...(req.auth?.tenantId ? { tenantId: req.auth.tenantId } : {}),
      ...(req.auth?.userId ? { userId: req.auth.userId } : {}),
      statusCode: 500,
    });
    return reply.code(500).send({ error: "INTERNAL" });
  });

  // ---- public ----
  app.get("/health", async () => ({ status: "ok" }));

  // `/healthz` is the path the availability NFR names as the uptime monitor's
  // target (PRD §11). Same answer as /health — an alias, so a monitor pointed
  // at either one is measuring the same thing.
  app.get("/healthz", async () => ({ status: "ok" }));

  // Deep health: proves the app role has the exact privileges the security
  // model rests on (non-superuser, no BYPASSRLS) and that migrations ran.
  // 503 when anything is degraded; production monitors page on this.
  app.get("/health/deep", async (_req, reply) => {
    const result = await deepHealth(db);
    return reply.code(result.status === "healthy" ? 200 : 503).send(result);
  });

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
    const q = z
      .object({
        category: z.string().max(80).optional(),
        // Loose match: any 2–5 char letter code; the service returns the
        // English fallback when no overlay exists, so an unknown lang is safe.
        lang: z.string().regex(/^[a-z]{2,5}$/i).optional(),
      })
      .parse(req.query);
    const items = await webOrders.publicCatalog(tenant.id, q.category, q.lang?.toLowerCase());
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
        // R5.5. Defaults to `gateway` so an older storefront build keeps
        // working; a shopper choosing COD goes through the gate.
        paymentMethod: z.enum(["gateway", "cod"]).optional(),
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
    // A COD order pays only its advance here (R5.5); the balance is collected
    // at the door. Read from the order rather than trusted from the client —
    // the amount to charge is never the caller's to decide.
    const due = await db.withTenant(tenant.id, async (c) => {
      const { rows } = await c.query<{
        payment_method: string | null; cod_advance_required_minor: string;
      }>(
        `SELECT payment_method, cod_advance_required_minor
           FROM sales_order WHERE id = $1`,
        [orderId],
      );
      return rows[0];
    });
    if (!due) return reply.code(404).send({ error: "NOT_FOUND" });
    const intent = await payments.createIntent(
      tenant.id,
      orderId,
      parsed.data.gateway,
      due.payment_method === "cod"
        ? { amountMinor: Number(due.cod_advance_required_minor) }
        : {},
    );
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

  // ---- storefront customer accounts (passwordless magic link) ----
  //
  // Two public endpoints request/consume a magic link, then a session-scoped
  // area lets a signed-in shopper read their own orders and serialized units.
  // The scheme is `Authorization: CustomerSession <token>` — deliberately
  // NOT `Bearer` — so an employee access token can never be misused against
  // the shopper endpoints and vice versa.
  //
  // SEND_EMAIL toggle: in production, set process.env.SEND_EMAIL="1" so the
  // request-link response no longer returns the raw token; delivery over
  // email is out of scope for this iteration because we have no provider
  // wired in — the toggle is the switch that hides devToken once one is.
  const emailDelivery = process.env.SEND_EMAIL === "1";

  app.post("/v1/public/:slug/customer/request-link", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const tenant = await webOrders.resolveTenant(slug);
    if (!tenant) return reply.code(404).send({ error: "NOT_FOUND" });
    const parsed = z
      .object({ email: z.string().email().max(200) })
      .safeParse(req.body);
    if (!parsed.success) return sendZodError(reply, parsed.error.issues);
    const result = await customerAuth.requestLink(tenant.id, parsed.data.email);
    if (emailDelivery) {
      // Production shape: acknowledge without revealing whether the address
      // was known and without echoing the token.
      return reply.code(200).send({ ok: true });
    }
    return reply.code(200).send({ devToken: result.devToken });
  });

  app.post("/v1/public/:slug/customer/verify-link", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const tenant = await webOrders.resolveTenant(slug);
    if (!tenant) return reply.code(404).send({ error: "NOT_FOUND" });
    const parsed = z
      .object({
        email: z.string().email().max(200),
        token: z.string().min(10).max(200),
      })
      .safeParse(req.body);
    if (!parsed.success) return sendZodError(reply, parsed.error.issues);
    const result = await customerAuth.verifyLink(
      tenant.id, parsed.data.email, parsed.data.token,
    );
    return reply.code(200).send(result);
  });

  app.register(async (shopper) => {
    // Bind the tenant from the URL and require a CustomerSession header. We
    // avoid the "Bearer" scheme on purpose so an employee access token cannot
    // be accepted here (and vice versa).
    shopper.addHook("onRequest", async (req, reply) => {
      const { slug } = req.params as { slug?: string };
      const tenant = slug ? await webOrders.resolveTenant(slug) : undefined;
      if (!tenant) return reply.code(404).send({ error: "NOT_FOUND" });
      const header = req.headers.authorization ?? "";
      const [scheme, token] = header.split(" ", 2);
      if (scheme !== "CustomerSession" || !token) {
        return reply.code(401).send({ error: "UNAUTHENTICATED" });
      }
      const resolved = await customerAuth.resolveSession(tenant.id, token);
      if (!resolved) return reply.code(401).send({ error: "UNAUTHENTICATED" });
      req.auth = { userId: resolved.customerId, tenantId: tenant.id, roles: [] };
      req.customerId = resolved.customerId;
    });

    shopper.get("/v1/public/:slug/customer/orders", async (req) => {
      const rows = await db.withTenant(req.auth.tenantId, async (c) => {
        const { rows } = await c.query(
          `SELECT id, order_no AS "orderNo", status,
                  total_minor AS "totalMinor", currency,
                  placed_at AS "placedAt"
             FROM sales_order
            WHERE customer_id = $1
            ORDER BY placed_at DESC
            LIMIT 100`,
          [req.customerId],
        );
        return rows.map((r) => ({ ...r, totalMinor: Number(r.totalMinor) }));
      });
      return { items: rows };
    });

    shopper.get("/v1/public/:slug/customer/units", async (req) => {
      const rows = await db.withTenant(req.auth.tenantId, async (c) => {
        // My Devices: every serialized unit sold to this customer, with
        // IMEI/SKU/product-name/warranty. Join through sales_order to enforce
        // that the customer actually owns the sale (RLS already scopes to the
        // tenant; this join scopes to the shopper).
        const { rows } = await c.query(
          `SELECT su.id, su.imei1, su.imei2, su.serial_no AS "serialNo",
                  su.warranty_until AS "warrantyUntil",
                  v.sku, p.name AS "productName",
                  o.order_no AS "orderNo", o.placed_at AS "placedAt"
             FROM stock_unit su
             JOIN sales_order o ON o.id = su.sold_order_id
             JOIN variant v ON v.id = su.variant_id
             JOIN product p ON p.id = v.product_id
            WHERE o.customer_id = $1
            ORDER BY o.placed_at DESC, p.name`,
          [req.customerId],
        );
        return rows;
      });
      return { items: rows };
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
                                category_id, status, device_class)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8)`,
          [id, req.auth.tenantId, parsed.data.name, parsed.data.slug,
           parsed.data.tracking, parsed.data.description ?? null,
           parsed.data.categoryId ?? null, parsed.data.deviceClass ?? null],
        ),
      );
      return reply.code(201).send({ id, ...parsed.data });
    });

    // The CD 91/2023 classification, editable on its own. Deliberately NOT
    // folded into the general product PATCH: this is a tax attribute, and a
    // change to it silently alters how future sales of the product are taxed,
    // so it deserves its own auditable action rather than riding along with a
    // description edit.
    secured.put("/v1/products/:productId/device-class", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN" });
      }
      const { productId } = req.params as { productId: string };
      const parsed = z
        .object({ deviceClass: z.enum(RCM_DEVICE_CLASSES).nullable() })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const row = await db.withTenant(req.auth.tenantId, async (c) => {
        const { rows } = await c.query(
          `UPDATE product SET device_class = $2, updated_at = now()
            WHERE id = $1 RETURNING id, device_class AS "deviceClass"`,
          [productId, parsed.data.deviceClass],
        );
        return rows[0];
      });
      if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
      await audit.record(req.auth.tenantId, {
        actorUserId: req.auth.userId,
        action: "product.device_class.set",
        entityType: "product",
        entityId: productId,
        after: { deviceClass: parsed.data.deviceClass },
      });
      return row;
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

    /**
     * May this caller see cost, margin or stock-at-cost figures?
     *
     * The threat model treats a cashier as a semi-trusted insider: they must be
     * able to look a unit up by IMEI to answer a warranty question, but must not
     * see what the shop paid for it. Routes that exist for a non-financial reason
     * redact the cost fields; routes that are wholly financial reject outright.
     */
    const financeRole = (req: { auth: AccessClaims }) => requireRole(req, "owner", "manager");

    /** Strip cost-bearing keys from a payload for callers without finance access. */
    const redactCost = <T extends Record<string, unknown>>(
      row: T,
      ...keys: Array<keyof T>
    ): Record<string, unknown> => {
      const out: Record<string, unknown> = { ...row };
      for (const k of keys) delete out[k as string];
      return out;
    };

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

    // Per-line unit cost — same guard as the sibling POST/receive routes, which
    // were already gated. This one was not.
    secured.get("/v1/purchase-orders/:poId", async (req, reply) => {
      if (!purchasingRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
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
      const parsed = z
        .object({
          note: z.string().max(300).optional(),
          // Repairs get logged after the fact, and R10.7 extends the warranty
          // from this timestamp — a wrong one shortens the customer's cover.
          occurredAt: z.coerce.date().optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return units.repairOut(
        req.auth.tenantId, req.auth.userId, unitId,
        parsed.data.note, parsed.data.occurredAt,
      );
    });

    secured.post("/v1/stock-units/:unitId/repair-in", async (req, reply) => {
      const { unitId } = req.params as { unitId: string };
      const parsed = z.object({ note: z.string().max(300).optional() }).safeParse(req.body ?? {});
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return units.repairIn(req.auth.tenantId, req.auth.userId, unitId, parsed.data.note);
    });

    // The IMEI biography. Deliberately reachable by any staff member — a customer
    // with a handset and no receipt must still be servable (R2.6) — so cost is
    // redacted rather than the route refused.
    secured.get("/v1/stock-units/:unitId/history", async (req, reply) => {
      const { unitId } = req.params as { unitId: string };
      const history = await units.history(req.auth.tenantId, unitId);
      if (!history) return reply.code(404).send({ error: "NOT_FOUND" });
      return financeRole(req) ? history : redactCost(history, "unitCostMinor");
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
          // Must match a tender actually captured on the order, or be store
          // credit — the sanctioned fallback when the original cannot be
          // reversed (R6.4). Enforced in RefundService, not here, because it
          // depends on the order.
          method: z.enum(["cash", "card", "store_credit"]),
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
          `SELECT p.id, p.name, p.slug, p.tracking, p.status, p.translations,
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

    // Per-tenant Arabic (or any-lang) content overlay for a product.
    // Merges into the translations map so setting one field doesn't wipe
    // sibling languages, and returns the merged map so the admin UI can
    // refresh the row without re-fetching the whole catalog.
    // ---- product lifecycle (R1.1, R1.5) -----------------------------------
    const productWriteRole = (req: { auth: AccessClaims }) =>
      requireRole(req, "owner", "manager");

    secured.patch("/v1/products/:productId", async (req, reply) => {
      if (!productWriteRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
      const { productId } = req.params as { productId: string };
      const parsed = z
        .object({
          name: z.string().min(1).max(200).optional(),
          description: z.string().max(5000).nullable().optional(),
          tracking: z.enum(["none", "batch", "serialized"]).optional(),
          categoryId: z.string().uuid().nullable().optional(),
          brandId: z.string().uuid().nullable().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return products.edit(req.auth.tenantId, req.auth.userId, productId, parsed.data);
    });

    secured.post("/v1/products/:productId/duplicate", async (req, reply) => {
      if (!productWriteRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
      const { productId } = req.params as { productId: string };
      const parsed = z
        .object({ slug: z.string().min(1).max(200), name: z.string().min(1).max(200).optional() })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const result = await products.duplicate(
        req.auth.tenantId, req.auth.userId, productId, parsed.data,
      );
      return reply.code(201).send(result);
    });

    // Publish is gated on the R1.5 checklist; this exposes it so the editor can
    // show what is still missing instead of only failing at the last step.
    secured.get("/v1/products/:productId/publish-checklist", async (req) => {
      const { productId } = req.params as { productId: string };
      return products.publishChecklist(req.auth.tenantId, productId);
    });

    secured.post("/v1/products/:productId/publish", async (req, reply) => {
      if (!productWriteRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
      const { productId } = req.params as { productId: string };
      return products.publish(req.auth.tenantId, req.auth.userId, productId);
    });

    secured.post("/v1/products/:productId/unpublish", async (req, reply) => {
      if (!productWriteRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
      const { productId } = req.params as { productId: string };
      return products.unpublish(req.auth.tenantId, req.auth.userId, productId);
    });

    // Archiving never deletes. With stock on hand it needs `confirm: true`,
    // which is why this is a POST carrying a body rather than a DELETE.
    secured.post("/v1/products/:productId/archive", async (req, reply) => {
      if (!productWriteRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
      const { productId } = req.params as { productId: string };
      const parsed = z
        .object({ confirm: z.boolean().optional(), reason: z.string().max(300).optional() })
        .safeParse(req.body ?? {});
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return products.archive(req.auth.tenantId, req.auth.userId, productId, parsed.data);
    });

    secured.put("/v1/products/:productId/variants/:variantId/stock-mode", async (req, reply) => {
      if (!productWriteRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
      const { productId, variantId } = req.params as { productId: string; variantId: string };
      const parsed = z
        .object({ stockMode: z.enum(["none", "batch", "serialized"]) })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return products.setVariantStockMode(
        req.auth.tenantId, req.auth.userId, productId, variantId, parsed.data.stockMode,
      );
    });

    secured.put("/v1/products/:productId/translations", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "manager role required" });
      }
      const { productId } = req.params as { productId: string };
      const parsed = z
        .object({
          lang: z.string().regex(/^[a-z]{2,5}$/i).transform((v) => v.toLowerCase()),
          name: z.string().trim().min(1).max(300).optional(),
          description: z.string().trim().max(4000).optional(),
        })
        .refine((v) => v.name !== undefined || v.description !== undefined, {
          message: "name or description required",
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      // Build a partial overlay for the requested language.
      const overlay: Record<string, string> = {};
      if (parsed.data.name !== undefined) overlay.name = parsed.data.name;
      if (parsed.data.description !== undefined) overlay.description = parsed.data.description;
      const res = await db.withTenant(req.auth.tenantId, async (c) => {
        const { rows } = await c.query<{ translations: Record<string, unknown> }>(
          `UPDATE product
              SET translations = translations
                  || jsonb_build_object($2::text,
                       coalesce(translations->$2, '{}'::jsonb) || $3::jsonb),
                  updated_at = now()
            WHERE id = $1
            RETURNING translations`,
          [productId, parsed.data.lang, JSON.stringify(overlay)],
        );
        return rows[0];
      });
      if (!res) return reply.code(404).send({ error: "NOT_FOUND" });
      return { productId, translations: res.translations };
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

    secured.post("/v1/wms/putaway", async (req, reply) => {
      if (!wmsRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
      const parsed = z
        .object({
          binId: z.string().uuid(),
          variantId: z.string().uuid(),
          quantity: z.number().positive(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return wms.putaway(req.auth.tenantId, req.auth.userId, parsed.data);
    });

    secured.post("/v1/wms/bin-moves", async (req, reply) => {
      if (!wmsRole(req)) return reply.code(403).send({ error: "FORBIDDEN" });
      const parsed = z
        .object({
          fromBinId: z.string().uuid(),
          toBinId: z.string().uuid(),
          variantId: z.string().uuid(),
          quantity: z.number().positive(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return wms.moveBin(req.auth.tenantId, req.auth.userId, parsed.data);
    });

    secured.get("/v1/wms/bins/:binId/contents", async (req) => {
      const { binId } = req.params as { binId: string };
      return { items: await wms.binContents(req.auth.tenantId, binId) };
    });

    secured.get("/v1/wms/locations/:locationId/placement/:variantId", async (req) => {
      const { locationId, variantId } = req.params as {
        locationId: string;
        variantId: string;
      };
      return wms.variantPlacement(req.auth.tenantId, locationId, variantId);
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

    // R9.3 business-customer fields. `fullName` stays the contact person;
    // `legalName` is the entity a tax invoice is made out to, and the two
    // genuinely differ (a buyer purchasing for their company).
    const businessCustomerSchema = z.object({
      isBusiness: z.boolean().optional(),
      legalName: z.string().min(1).max(200).optional(),
      // A UAE TRN is exactly 15 digits; the same constraint is enforced in the
      // database, because a malformed TRN reaches the invoice and the FTA
      // Audit File and nobody re-checks it by eye.
      trn: z.string().regex(/^\d{15}$/, "a UAE TRN is 15 digits").optional(),
      billingAddress: z
        .object({
          line1: z.string().max(200),
          line2: z.string().max(200).optional(),
          city: z.string().max(100).optional(),
          emirate: z.enum(EMIRATES).optional(),
          country: z.string().max(60).default("AE"),
        })
        .optional(),
    });

    secured.post("/v1/customers", async (req, reply) => {
      const parsed = z
        .object({
          fullName: z.string().min(1).max(120),
          phone: z.string().min(5).max(30).optional(),
          email: z.string().email().optional(),
        })
        .merge(businessCustomerSchema)
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const d = parsed.data;
      // Mirrors the DB constraint customer_business_has_legal_name: rejected
      // here so the caller gets a field-level message rather than a 500.
      if (d.isBusiness && !d.legalName) {
        return reply.code(422).send({
          error: "LEGAL_NAME_REQUIRED",
          message: "a business customer needs a legal name for its tax invoices",
        });
      }
      const id = randomUUID();
      await db.withTenant(req.auth.tenantId, (c) =>
        c.query(
          `INSERT INTO customer (id, tenant_id, full_name, phone, email,
                                 is_business, legal_name, trn, billing_address)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, req.auth.tenantId, d.fullName, d.phone ?? null, d.email ?? null,
           d.isBusiness ?? false, d.legalName ?? null, d.trn ?? null,
           d.billingAddress ? JSON.stringify(d.billingAddress) : null],
        ),
      );
      return reply.code(201).send({ id, ...d, loyaltyPoints: 0 });
    });

    secured.patch("/v1/customers/:customerId/business", async (req, reply) => {
      const { customerId } = req.params as { customerId: string };
      const parsed = businessCustomerSchema.safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const d = parsed.data;
      const updated = await db.withTenant(req.auth.tenantId, async (c) => {
        const { rows } = await c.query(
          `UPDATE customer
              SET is_business     = coalesce($2, is_business),
                  legal_name      = coalesce($3, legal_name),
                  trn             = coalesce($4, trn),
                  billing_address = coalesce($5, billing_address)
            WHERE id = $1
            RETURNING id, is_business AS "isBusiness", legal_name AS "legalName",
                      trn, billing_address AS "billingAddress"`,
          [customerId, d.isBusiness ?? null, d.legalName ?? null, d.trn ?? null,
           d.billingAddress ? JSON.stringify(d.billingAddress) : null],
        );
        return rows[0];
      });
      if (!updated) return reply.code(404).send({ error: "NOT_FOUND" });
      return updated;
    });

    // ---- cash-on-delivery policy and outcomes (R5.5, R9.5, R12.8) ----
    secured.get("/v1/settings/cod-policy", async (req) => cod.policy(req.auth.tenantId));

    secured.put("/v1/settings/cod-policy", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN" });
      }
      const parsed = z
        .object({
          enabled: z.boolean().optional(),
          advanceThresholdMinor: z.number().int().nonnegative().optional(),
          advanceMode: z.enum(["fixed", "percent"]).optional(),
          advanceFixedMinor: z.number().int().nonnegative().optional(),
          advancePercentBp: z.number().int().min(0).max(10_000).optional(),
          riskCeiling: z.number().int().min(0).max(100).optional(),
          // Explicitly nullable: null means "no cap", which is a different
          // instruction from "leave it as it is".
          maxOrderMinor: z.number().int().positive().nullable().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const updated = await cod.updatePolicy(req.auth.tenantId, parsed.data);
      await audit.record(req.auth.tenantId, {
        actorUserId: req.auth.userId,
        action: "cod.policy.updated",
        entityType: "tenant",
        entityId: req.auth.tenantId,
        after: parsed.data,
      });
      return updated;
    });

    // What COD would cost this shopper, without placing an order — so the
    // storefront can show the deposit before they commit rather than after.
    secured.get("/v1/cod/quote", async (req, reply) => {
      const parsed = z
        .object({
          totalMinor: z.coerce.number().int().nonnegative(),
          customerId: z.string().uuid().optional(),
        })
        .safeParse(req.query);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return cod.quote(
        req.auth.tenantId, parsed.data.totalMinor, parsed.data.customerId,
      );
    });

    secured.get("/v1/customers/:customerId/cod-risk", async (req) => {
      const { customerId } = req.params as { customerId: string };
      return cod.riskFor(req.auth.tenantId, customerId);
    });

    // What happened at the door (R5.4, R9.5). The row this writes is what
    // makes the next COD decision for this customer better-informed than the
    // last, so it is the single most valuable thing staff record.
    secured.post("/v1/orders/:orderId/cod-outcome", async (req, reply) => {
      const { orderId } = req.params as { orderId: string };
      const parsed = z
        .object({
          shipmentId: z.string().uuid().optional(),
          customerId: z.string().uuid().optional(),
          outcome: z.enum(["delivered", "refused", "undeliverable"]),
          collectedMinor: z.number().int().nonnegative().optional(),
          expectedMinor: z.number().int().nonnegative().optional(),
          freightCostMinor: z.number().int().nonnegative().optional(),
          area: z.string().max(100).optional(),
          emirate: z.enum(EMIRATES).optional(),
          note: z.string().max(500).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const result = await cod.recordOutcome(req.auth.tenantId, { orderId, ...parsed.data });
      return reply.code(result.recorded ? 201 : 200).send(result);
    });

    secured.get("/v1/reports/cod-performance", async (req, reply) => {
      // Cost figures are finance data; the same separation the rest of the
      // reporting surface uses (R14.5, and the `finance:read` split the audit
      // singled out as a good decision).
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN" });
      }
      const parsed = z
        .object({ sinceDays: z.coerce.number().int().min(1).max(730).default(90) })
        .safeParse(req.query);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return cod.performance(req.auth.tenantId, parsed.data.sinceDays);
    });

    // ---- supplier identity on every tax invoice (R7.1) ----
    //
    // R7.1 makes supplier name, ADDRESS and TRN mandatory on even a
    // simplified consumer receipt. `tenant.trn` has existed since migration
    // 007, but there was nowhere to put the address until 033 — so every
    // receipt this system has printed was missing a required field. There was
    // also no way to set the TRN through the API at all.
    secured.get("/v1/settings/supplier", async (req) =>
      db.withTenant(req.auth.tenantId, async (c) => {
        const { rows } = await c.query(
          `SELECT name, trn, address, vat_rate_bp AS "vatRateBp",
                  default_locale AS "defaultLocale"
             FROM tenant WHERE id = $1`,
          [req.auth.tenantId],
        );
        return rows[0];
      }),
    );

    secured.put("/v1/settings/supplier", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN" });
      }
      const parsed = z
        .object({
          trn: z.string().regex(/^\d{15}$/, "a UAE TRN is 15 digits").optional(),
          address: z
            .object({
              line1: z.string().min(1).max(200),
              line2: z.string().max(200).optional(),
              city: z.string().max(100).optional(),
              emirate: z.enum(EMIRATES).optional(),
              country: z.string().max(60).default("AE"),
            })
            .optional(),
          defaultLocale: z.enum(["en", "ar"]).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const d = parsed.data;
      return db.withTenant(req.auth.tenantId, async (c) => {
        const { rows } = await c.query(
          `UPDATE tenant
              SET trn            = coalesce($2, trn),
                  address        = coalesce($3, address),
                  default_locale = coalesce($4, default_locale)
            WHERE id = $1
            RETURNING name, trn, address, default_locale AS "defaultLocale"`,
          [req.auth.tenantId, d.trn ?? null,
           d.address ? JSON.stringify(d.address) : null, d.defaultLocale ?? null],
        );
        return rows[0];
      });
    });

    // ---- reverse-charge declarations (R7.3 / R7.3a) ----
    //
    // Two separate steps on purpose. Capturing what the buyer declared and
    // verifying that the buyer really is registered are different acts by
    // different parties, and CD 91/2023 requires both — R7.3a is explicit
    // that retaining the declaration alone is not sufficient. Collapsing them
    // into one call would make it possible to record a verification that
    // never happened.
    secured.post("/v1/customers/:customerId/rcm-declarations", async (req, reply) => {
      const { customerId } = req.params as { customerId: string };
      const parsed = z
        .object({
          declaresResaleOrManufacture: z.boolean(),
          declaresFtaRegistered: z.boolean(),
          locale: z.enum(["en", "ar"]).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const record = await rcm.captureDeclaration(req.auth.tenantId, req.auth.userId, {
        customerId,
        ...parsed.data,
      });
      return reply.code(201).send(record);
    });

    secured.get("/v1/customers/:customerId/rcm-declarations", async (req) => {
      const { customerId } = req.params as { customerId: string };
      return { items: await rcm.listForCustomer(req.auth.tenantId, customerId) };
    });

    secured.post("/v1/rcm-declarations/:declarationId/verify", async (req, reply) => {
      const { declarationId } = req.params as { declarationId: string };
      const parsed = z
        .object({
          method: z.enum(["fta_portal", "certificate", "other"]),
          // 'unavailable' is a real answer, distinct from 'failed': PRD Q10
          // (what verification means a retailer has at the counter) is still
          // open. Neither qualifies the sale; an auditor wants to know which.
          outcome: z.enum(["verified", "failed", "unavailable"]),
          reference: z.string().max(300).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return rcm.verifyDeclaration(req.auth.tenantId, req.auth.userId, {
        declarationId,
        ...parsed.data,
      });
    });

    secured.post("/v1/rcm-declarations/:declarationId/revoke", async (req, reply) => {
      const { declarationId } = req.params as { declarationId: string };
      const parsed = z
        .object({ reason: z.string().min(3).max(300) })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      return rcm.revokeDeclaration(req.auth.tenantId, declarationId, parsed.data.reason);
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

    // Store credit: direct-money wallet attached to a customer. Issue is
    // manager+ (goodwill / refund preference); balance is any authenticated
    // employee (POS needs to see it before offering it as a tender).
    secured.post("/v1/customers/:customerId/store-credit", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "manager role required" });
      }
      const { customerId } = req.params as { customerId: string };
      const parsed = z
        .object({
          amountMinor: z.number().int().positive(),
          reason: z.string().min(3).max(300),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const result = await storeCredit.issue(req.auth.tenantId, req.auth.userId, {
        customerId, ...parsed.data,
      });
      return reply.code(201).send(result);
    });

    secured.get("/v1/customers/:customerId/store-credit", async (req) => {
      const { customerId } = req.params as { customerId: string };
      return storeCredit.balance(req.auth.tenantId, customerId);
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
          // R7.3: the cashier marked this business-to-business with intent to
          // resell. Asking is not getting — the four conditions of CD 91/2023
          // are checked server-side and an unqualified sale falls back to
          // standard-rated VAT with a reason returned to the till.
          businessSale: z.boolean().optional(),
          lines: z.array(
            z.object({
              variantId: z.string().uuid(),
              quantity: z.number().positive(),
              unitPriceMinor: z.number().int().nonnegative(),
              stockUnitId: z.string().uuid().optional(),
              discountMinor: z.number().int().nonnegative().optional(),
              discountApprovalId: z.string().uuid().optional(),
              // R7.3a carve-outs: a zero-rated or exempt line stays outside
              // the reverse charge even on a fully qualifying B2B sale.
              zeroRated: z.boolean().optional(),
              exempt: z.boolean().optional(),
            }),
          ).min(1),
          payments: z.array(
            z.object({
              method: z.enum(["cash", "card", "loyalty_points", "gift_card", "store_credit"]),
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
          // R5.6: what this delivery costs to attempt, so a failed one has a
          // number to charge against the order rather than a shrug.
          outboundFreightMinor: z.number().int().nonnegative().optional(),
          returnFreightMinor: z.number().int().nonnegative().optional(),
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

    // ---- credit notes (R7.8) ----
    //
    // A refund issues one automatically inside the refund transaction; this
    // route covers the cases where no money moves — correcting a mis-priced
    // line, or a supply that was taxed when it should not have been.
    secured.post("/v1/orders/:orderId/credit-notes", async (req, reply) => {
      if (!requireRole(req, "owner", "manager")) {
        return reply.code(403).send({ error: "FORBIDDEN" });
      }
      const { orderId } = req.params as { orderId: string };
      const parsed = z
        .object({
          reason: z.string().min(3).max(300),
          // Omit to credit the whole invoice.
          lines: z
            .array(
              z.object({
                orderLineId: z.string().uuid(),
                quantity: z.number().positive(),
              }),
            )
            .optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const note = await creditNotes.issue(req.auth.tenantId, req.auth.userId, {
        orderId,
        ...parsed.data,
      });
      return reply.code(201).send(note);
    });

    secured.get("/v1/orders/:orderId/credit-notes", async (req) => {
      const { orderId } = req.params as { orderId: string };
      return { items: await creditNotes.listForOrder(req.auth.tenantId, orderId) };
    });

    secured.get("/v1/credit-notes/:creditNoteId", async (req, reply) => {
      const { creditNoteId } = req.params as { creditNoteId: string };
      const note = await creditNotes.read(req.auth.tenantId, creditNoteId);
      if (!note) return reply.code(404).send({ error: "NOT_FOUND" });
      return note;
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

    // ---- stock adjustments (R4.1) -----------------------------------------
    // Two steps on purpose: a second human approves the specific fact (reason,
    // variant, quantity, location), and 029's trigger binds the posted movement
    // to exactly that fact. One approval, one movement.
    secured.post("/v1/inventory/adjustments/requests", async (req, reply) => {
      const parsed = z
        .object({
          locationId: z.string().uuid(),
          variantId: z.string().uuid(),
          quantity: z.number().positive(),
          reason: z.enum(["damage", "theft", "found", "correction", "sample", "write_off"]),
          fromState: z.enum(["on_hand", "damaged", "returned_pending"]).optional(),
          note: z.string().max(300).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      const result = await ops.requestAdjustment(
        req.auth.tenantId,
        { userId: req.auth.userId, roles: req.auth.roles },
        parsed.data,
      );
      return reply.code(201).send(result);
    });

    secured.post("/v1/inventory/adjustments/:approvalId/post", async (req, reply) => {
      const { approvalId } = req.params as { approvalId: string };
      const result = await ops.postAdjustment(
        req.auth.tenantId,
        { userId: req.auth.userId, roles: req.auth.roles },
        approvalId,
      );
      return reply.code(201).send(result);
    });

    secured.post("/v1/transfers", async (req, reply) => {
      const parsed = z
        .object({
          fromLocationId: z.string().uuid(),
          toLocationId: z.string().uuid(),
          note: z.string().max(300).optional(),
          lines: z.array(
            z.object({
              variantId: z.string().uuid(),
              quantity: z.number().positive(),
              // Required for serialized variants — one id per unit, enforced in
              // OpsService because it depends on the variant's tracking mode.
              stockUnitIds: z.array(z.string().uuid()).optional(),
            }),
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

    // ---- product events (R12.1, R12.2) ------------------------------------
    // Batched and idempotent on the client-supplied id, so a storefront beacon
    // or an offline POS can replay without inflating a funnel.
    secured.post("/v1/events", async (req, reply) => {
      const parsed = z
        .object({
          events: z.array(
            z.object({
              id: z.string().uuid().optional(),
              name: z.string().refine(isEventName, "unknown event name"),
              sessionId: z.string().max(120).optional(),
              customerId: z.string().uuid().optional(),
              orderId: z.string().uuid().optional(),
              props: z.record(z.unknown()).optional(),
              occurredAt: z.coerce.date().optional(),
            }),
          ).min(1).max(200),
        })
        .safeParse(req.body);
      if (!parsed.success) return sendZodError(reply, parsed.error.issues);
      // The actor is taken from the token, never the body — an event that names
      // its own author is not evidence of anything.
      const result = await events.recordMany(
        req.auth.tenantId,
        parsed.data.events.map((e) => ({ ...e, userId: req.auth.userId })),
      );
      return reply.code(201).send(result);
    });

    secured.get("/v1/reports/events", async (req) => {
      const q = z
        .object({ fromIso: z.string().datetime().optional(), toIso: z.string().datetime().optional() })
        .parse(req.query);
      return events.counts(req.auth.tenantId, q);
    });

    secured.get("/v1/reports/funnels/:preset", async (req, reply) => {
      const { preset } = req.params as { preset: string };
      if (!isFunnelPreset(preset)) {
        return reply.code(404).send({ error: "UNKNOWN_FUNNEL", message: `no funnel '${preset}'` });
      }
      const q = z
        .object({ fromIso: z.string().datetime().optional(), toIso: z.string().datetime().optional() })
        .parse(req.query);
      return events.presetFunnel(req.auth.tenantId, preset, q);
    });

    // Dashboard summary. Staff may see counts and revenue; `stockValueMinor` is
    // valued at cost, so it is redacted for callers without finance access.
    secured.get("/v1/analytics/summary", async (req) => {
      const summary = await analytics.summary(req.auth.tenantId);
      return financeRole(req) ? summary : redactCost(summary, "stockValueMinor");
    });

    secured.get("/v1/ai/reorder-suggestions", async (req) => {
      const q = z
        .object({
          windowDays: z.coerce.number().int().min(7).max(365).default(56),
          leadTimeDays: z.coerce.number().int().min(1).max(90).default(7),
        })
        .parse(req.query);
      return { items: await analytics.reorderSuggestions(req.auth.tenantId, q) };
    });

    // Wholly a capital-at-risk report: every row carries unit cost and stock
    // value at cost. No non-financial use, so this one is refused outright.
    secured.get("/v1/ai/dead-stock", async (req, reply) => {
      if (!financeRole(req)) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "manager role required" });
      }
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

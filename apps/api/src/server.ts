/**
 * OmniRetail OS API — Fastify host for the modular monolith (ADR-005).
 *
 * Phase 0 skeleton: routes are wired to an in-memory InventoryLedger from
 * @omniretail/domain so the movement/availability contract is real and testable
 * end-to-end. Phase 1 replaces the repository with PostgreSQL (movement insert +
 * stock_level upsert + outbox in one transaction) without changing the routes.
 */
import Fastify from "fastify";
import { z } from "zod";
import { InventoryLedger, LedgerError } from "@omniretail/domain";

const bucketSchema = z.object({
  locationId: z.string().min(1),
  state: z.enum(["on_hand", "reserved", "in_transit", "damaged", "returned_pending"]),
});

const movementSchema = z.object({
  id: z.string().uuid(),
  movementType: z.enum([
    "receipt", "sale", "return_in", "transfer_out", "transfer_in", "adjustment",
    "reservation", "release", "write_off", "count_correction", "repair_out", "repair_in",
  ]),
  variantId: z.string().min(1),
  stockUnitId: z.string().optional(),
  quantity: z.number().positive(),
  from: bucketSchema.optional(),
  to: bucketSchema.optional(),
  actorUserId: z.string().min(1),
  deviceId: z.string().optional(),
  reference: z.object({ type: z.string().min(1), id: z.string().min(1) }),
  approvalId: z.string().optional(),
  occurredAt: z.coerce.date(),
  note: z.string().optional(),
});

export function buildServer() {
  const app = Fastify({ logger: false });
  const ledger = new InventoryLedger();

  app.get("/health", async () => ({ status: "ok", lastSeq: ledger.lastSeq }));

  app.post("/v1/inventory/movements", async (req, reply) => {
    const parsed = movementSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "VALIDATION", issues: parsed.error.issues });
    }
    try {
      const posted = ledger.post(parsed.data);
      return reply.code(201).send(posted);
    } catch (err) {
      if (err instanceof LedgerError) {
        const status =
          err.code === "DUPLICATE_MOVEMENT" ? 409
          : err.code === "INSUFFICIENT_STOCK" ? 422
          : err.code === "APPROVAL_REQUIRED" ? 403
          : 400;
        return reply.code(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get("/v1/inventory/availability/:variantId/:locationId", async (req) => {
    const { variantId, locationId } = req.params as { variantId: string; locationId: string };
    return ledger.availability(variantId, locationId);
  });

  // Ledger sync feed for POS mirrors and connector workers (cursor = seq).
  app.get("/v1/inventory/movements", async (req) => {
    const q = z
      .object({ afterSeq: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query);
    const items = ledger.history.filter((m) => m.seq > q.afterSeq).slice(0, q.limit);
    return { items, nextCursor: items.at(-1)?.seq ?? q.afterSeq };
  });

  return app;
}

const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain) {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3001);
  app.listen({ port, host: "0.0.0.0" }).then(() => {
    console.log(`OmniRetail API listening on :${port}`);
  });
}

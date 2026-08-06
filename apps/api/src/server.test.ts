import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function receiptBody(n: number, qty = 5) {
  return {
    id: UUID(n),
    movementType: "receipt",
    variantId: "v1",
    quantity: qty,
    to: { locationId: "store-1", state: "on_hand" },
    actorUserId: "u1",
    reference: { type: "grn", id: "grn-1" },
    occurredAt: "2026-08-06T10:00:00Z",
  };
}

describe("inventory API", () => {
  it("posts a receipt and reads availability", async () => {
    const app = buildServer();
    const post = await app.inject({
      method: "POST",
      url: "/v1/inventory/movements",
      payload: receiptBody(1),
    });
    expect(post.statusCode).toBe(201);

    const avail = await app.inject({ url: "/v1/inventory/availability/v1/store-1" });
    expect(avail.json()).toMatchObject({ onHand: 5, available: 5 });
  });

  it("maps ledger violations to HTTP codes", async () => {
    const app = buildServer();
    await app.inject({ method: "POST", url: "/v1/inventory/movements", payload: receiptBody(1) });

    // duplicate id -> 409
    const dup = await app.inject({
      method: "POST",
      url: "/v1/inventory/movements",
      payload: receiptBody(1),
    });
    expect(dup.statusCode).toBe(409);

    // adjustment without approval -> 403
    const adj = await app.inject({
      method: "POST",
      url: "/v1/inventory/movements",
      payload: {
        ...receiptBody(2),
        movementType: "adjustment",
        to: undefined,
        from: { locationId: "store-1", state: "on_hand" },
      },
    });
    expect(adj.statusCode).toBe(403);

    // overselling -> 422
    const sale = await app.inject({
      method: "POST",
      url: "/v1/inventory/movements",
      payload: {
        ...receiptBody(3, 99),
        movementType: "sale",
        to: undefined,
        from: { locationId: "store-1", state: "on_hand" },
      },
    });
    expect(sale.statusCode).toBe(422);
  });

  it("serves the ledger sync feed by cursor", async () => {
    const app = buildServer();
    await app.inject({ method: "POST", url: "/v1/inventory/movements", payload: receiptBody(1) });
    await app.inject({ method: "POST", url: "/v1/inventory/movements", payload: receiptBody(2) });

    const feed = await app.inject({ url: "/v1/inventory/movements?afterSeq=1" });
    const body = feed.json();
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBe(2);
  });
});

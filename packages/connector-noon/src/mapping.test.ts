import { describe, expect, it } from "vitest";
import {
  mapNoonOrder,
  mapNoonStatus,
  toMinorUnits,
  toNoonInventoryPayload,
  type NoonOrder,
} from "./mapping.js";

const baseOrder: NoonOrder = {
  order_nr: "NAE-1001",
  ordered_at: "2026-08-01T14:30:00+04:00", // Gulf time
  status: "confirmed",
  currency: "AED",
  items: [
    { sku: "TSHIRT-M-RED", item_nr: "IT-1", qty: 2, unit_price: 149.5 },
    { sku: "MUG-BLK", item_nr: "IT-2", qty: 1, unit_price: 35 },
  ],
  customer: { name: "Amina K", phone: "+971500000000" },
  subtotal: 334,
  shipping_fee: 12,
  tax_amount: 17.3,
  discount: 10,
  order_total: 353.3,
};

describe("mapNoonOrder", () => {
  it("maps ids, lines, buyer, and money as integer minor units", () => {
    const mapped = mapNoonOrder(baseOrder);
    expect(mapped.externalId).toBe("NAE-1001");
    expect(mapped.orderNumber).toBe("NAE-1001");
    expect(mapped.currency).toBe("AED");
    expect(mapped.lines).toEqual([
      {
        sku: "TSHIRT-M-RED",
        channelLineId: "IT-1",
        quantity: 2,
        unitPriceMinor: 14950,
        currency: "AED",
      },
      {
        sku: "MUG-BLK",
        channelLineId: "IT-2",
        quantity: 1,
        unitPriceMinor: 3500,
        currency: "AED",
      },
    ]);
    expect(mapped.buyer).toEqual({ name: "Amina K", phone: "+971500000000" });
    expect(mapped.totals).toEqual({
      subtotalMinor: 33400,
      shippingMinor: 1200,
      taxMinor: 1730,
      discountMinor: 1000,
      grandMinor: 35330,
    });
  });

  it("normalizes Gulf-time timestamps to UTC ISO 8601", () => {
    const mapped = mapNoonOrder(baseOrder);
    expect(mapped.placedAt).toBe("2026-08-01T10:30:00.000Z");
  });

  it("preserves the raw payload for audit/replay", () => {
    expect(mapNoonOrder(baseOrder).raw).toBe(baseOrder);
  });

  it("derives totals from lines when Noon omits summary fields", () => {
    const sparse: NoonOrder = {
      order_nr: "NAE-2002",
      ordered_at: "2026-08-02T00:00:00Z",
      status: "pending",
      currency: "AED",
      items: [{ sku: "A", qty: 3, unit_price: 10.05 }],
    };
    const mapped = mapNoonOrder(sparse);
    expect(mapped.totals.subtotalMinor).toBe(3015);
    expect(mapped.totals.shippingMinor).toBe(0);
    expect(mapped.totals.grandMinor).toBe(3015);
    expect(mapped.buyer).toBeUndefined();
    expect(mapped.lines[0]?.channelLineId).toBeUndefined();
  });
});

describe("mapNoonStatus", () => {
  it("maps the assumed Noon vocabulary onto the normalized lifecycle", () => {
    expect(mapNoonStatus("pending")).toBe("pending");
    expect(mapNoonStatus("payment_pending")).toBe("pending");
    expect(mapNoonStatus("confirmed")).toBe("paid");
    expect(mapNoonStatus("READY_TO_SHIP")).toBe("paid");
    expect(mapNoonStatus("shipped")).toBe("shipped");
    expect(mapNoonStatus("delivered")).toBe("shipped");
    expect(mapNoonStatus("cancelled")).toBe("cancelled");
    expect(mapNoonStatus("returned")).toBe("refunded");
    expect(mapNoonStatus("weird_new_state")).toBe("unknown");
  });
});

describe("toMinorUnits", () => {
  it("rounds decimal AED to integer fils and treats undefined as 0", () => {
    expect(toMinorUnits(149.5)).toBe(14950);
    expect(toMinorUnits(0.1)).toBe(10);
    expect(toMinorUnits(10.005)).toBe(1001); // rounds, never floats downstream
    expect(toMinorUnits(undefined)).toBe(0);
  });
});

describe("toNoonInventoryPayload", () => {
  it("builds the assumed batch shape, passing versions through", () => {
    const payload = toNoonInventoryPayload([
      { sku: "A", availableQty: 5, version: 7 },
      { sku: "B", availableQty: 0, version: 12 },
    ]);
    expect(payload).toEqual({
      skus: [
        { sku: "A", stock: 5, version: 7 },
        { sku: "B", stock: 0, version: 12 },
      ],
    });
  });
});

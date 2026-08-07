import { describe, expect, it } from "vitest";
import {
  inventoryPushToZid,
  mapZidStatus,
  toMinorUnits,
  zidOrderToChannelOrder,
  type ZidOrder,
} from "./mapping.js";

const baseOrder: ZidOrder = {
  id: 90210,
  code: "ZID-1001",
  order_status: { code: "preparing", name: "Preparing" },
  currency_code: "SAR",
  products: [
    { id: 11, sku: "TSHIRT-M-RED", quantity: 2, price: "149.50" },
    { id: 12, sku: "MUG-BLK", quantity: 1, price: "35" },
  ],
  customer: { name: "Amina K", mobile: "+966500000000" },
  order_subtotal: "334.00",
  shipping_cost: "12",
  tax_amount: "17.30",
  discount_amount: "10",
  order_total: "353.30",
  created_at: "2026-08-01T14:30:00+04:00", // Gulf time
};

describe("zidOrderToChannelOrder", () => {
  it("maps ids, lines, buyer, and money as integer minor units", () => {
    const mapped = zidOrderToChannelOrder(baseOrder);
    expect(mapped.externalId).toBe("90210");
    expect(mapped.orderNumber).toBe("ZID-1001");
    expect(mapped.currency).toBe("SAR");
    expect(mapped.status).toBe("paid");
    expect(mapped.lines).toEqual([
      {
        sku: "TSHIRT-M-RED",
        channelLineId: "11",
        quantity: 2,
        unitPriceMinor: 14950,
        currency: "SAR",
      },
      {
        sku: "MUG-BLK",
        channelLineId: "12",
        quantity: 1,
        unitPriceMinor: 3500,
        currency: "SAR",
      },
    ]);
    expect(mapped.buyer).toEqual({ name: "Amina K", phone: "+966500000000" });
    expect(mapped.totals).toEqual({
      subtotalMinor: 33400,
      shippingMinor: 1200,
      taxMinor: 1730,
      discountMinor: 1000,
      grandMinor: 35330,
    });
  });

  it("normalizes Gulf-time timestamps to UTC ISO 8601", () => {
    const mapped = zidOrderToChannelOrder(baseOrder);
    expect(mapped.placedAt).toBe("2026-08-01T10:30:00.000Z");
  });

  it("preserves the raw payload for audit/replay", () => {
    expect(zidOrderToChannelOrder(baseOrder).raw).toBe(baseOrder);
  });

  it("accepts a bare-string status and the `status` fallback field", () => {
    expect(
      zidOrderToChannelOrder({ ...baseOrder, order_status: "delivered" }).status,
    ).toBe("shipped");
    const noStatusObj: ZidOrder = {
      id: 1,
      status: "new",
      currency_code: "SAR",
      products: [],
      created_at: "2026-08-02T00:00:00Z",
    };
    expect(zidOrderToChannelOrder(noStatusObj).status).toBe("pending");
  });

  it("derives totals from lines when Zid omits summary fields", () => {
    const sparse: ZidOrder = {
      id: 2002,
      order_status: "new",
      currency_code: "SAR",
      products: [{ sku: "A", quantity: 3, price: "10.05" }],
      created_at: "2026-08-02T00:00:00Z",
    };
    const mapped = zidOrderToChannelOrder(sparse);
    expect(mapped.totals.subtotalMinor).toBe(3015);
    expect(mapped.totals.shippingMinor).toBe(0);
    expect(mapped.totals.taxMinor).toBe(0);
    expect(mapped.totals.grandMinor).toBe(3015);
    expect(mapped.buyer).toBeUndefined();
    expect(mapped.lines[0]?.channelLineId).toBeUndefined();
  });

  it("is defensive when products, customer, and dates are entirely missing", () => {
    const bare: ZidOrder = { id: 7 };
    const mapped = zidOrderToChannelOrder(bare);
    expect(mapped.externalId).toBe("7");
    expect(mapped.orderNumber).toBe("7"); // falls back to id
    expect(mapped.currency).toBe("SAR"); // default currency
    expect(mapped.lines).toEqual([]);
    expect(mapped.status).toBe("unknown");
    expect(mapped.buyer).toBeUndefined();
    expect(mapped.totals.grandMinor).toBe(0);
    expect(mapped.placedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("tolerates missing sku and string quantities on a line", () => {
    const order: ZidOrder = {
      id: 3,
      currency_code: "AED",
      products: [{ id: 5, product_sku: "FALLBACK", quantity: "4", price: "1.00" }],
    };
    const line = zidOrderToChannelOrder(order).lines[0];
    expect(line).toEqual({
      sku: "FALLBACK",
      channelLineId: "5",
      quantity: 4,
      unitPriceMinor: 100,
      currency: "AED",
    });
  });
});

describe("mapZidStatus", () => {
  it("maps the assumed Zid vocabulary onto the normalized lifecycle", () => {
    expect(mapZidStatus("new")).toBe("pending");
    expect(mapZidStatus("pending_payment")).toBe("pending");
    expect(mapZidStatus("preparing")).toBe("paid");
    expect(mapZidStatus("READY")).toBe("paid");
    expect(mapZidStatus("in_progress")).toBe("paid");
    expect(mapZidStatus("shipped")).toBe("shipped");
    expect(mapZidStatus("delivered")).toBe("shipped");
    expect(mapZidStatus("cancelled")).toBe("cancelled");
    expect(mapZidStatus("canceled")).toBe("cancelled");
    expect(mapZidStatus("refunded")).toBe("refunded");
    expect(mapZidStatus("reversed")).toBe("refunded");
    expect(mapZidStatus("some_new_zid_state")).toBe("unknown");
  });
});

describe("toMinorUnits", () => {
  it("parses decimal strings exactly via integer math (no float)", () => {
    expect(toMinorUnits("250.50")).toBe(25050);
    expect(toMinorUnits("250.5")).toBe(25050);
    expect(toMinorUnits("149.50")).toBe(14950);
    expect(toMinorUnits("35")).toBe(3500);
    expect(toMinorUnits("0.1")).toBe(10);
    expect(toMinorUnits("0.01")).toBe(1);
  });

  it("rounds the third fractional digit half-up", () => {
    expect(toMinorUnits("10.005")).toBe(1001);
    expect(toMinorUnits("10.004")).toBe(1000);
    expect(toMinorUnits("1.239")).toBe(124);
  });

  it("accepts number inputs and treats missing/blank/garbage as 0", () => {
    expect(toMinorUnits(149.5)).toBe(14950);
    expect(toMinorUnits(35)).toBe(3500);
    expect(toMinorUnits(undefined)).toBe(0);
    expect(toMinorUnits(null)).toBe(0);
    expect(toMinorUnits("")).toBe(0);
    expect(toMinorUnits("  ")).toBe(0);
  });

  it("handles negative amounts and stray thousands separators", () => {
    expect(toMinorUnits("-19.99")).toBe(-1999);
    expect(toMinorUnits("1,250.75")).toBe(125075);
  });
});

describe("inventoryPushToZid", () => {
  it("builds the assumed per-product stock entry, passing the version through", () => {
    expect(inventoryPushToZid({ sku: "A", availableQty: 5, version: 7 })).toEqual({
      sku: "A",
      available_quantity: 5,
      version: 7,
    });
    expect(inventoryPushToZid({ sku: "B", availableQty: 0, version: 12 })).toEqual({
      sku: "B",
      available_quantity: 0,
      version: 12,
    });
  });
});

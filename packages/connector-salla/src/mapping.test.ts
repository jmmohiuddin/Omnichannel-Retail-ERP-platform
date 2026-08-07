import { describe, expect, it } from "vitest";
import {
  inventoryPushToSalla,
  mapSallaStatus,
  sallaOrderToChannelOrder,
  toMinorUnits,
  toSallaInventoryPayload,
  type SallaOrder,
} from "./mapping.js";

const baseOrder: SallaOrder = {
  id: 12345,
  reference_id: "SALLA-1001",
  status: { name: "In Progress", slug: "in_progress" },
  currency: "SAR",
  date: "2026-08-01T14:30:00+03:00", // Riyadh time
  items: [
    {
      id: 91,
      sku: "TSHIRT-M-RED",
      quantity: 2,
      amounts: { price_without_tax: { amount: "149.50", currency: "SAR" } },
    },
    {
      id: 92,
      sku: "MUG-BLK",
      quantity: 1,
      amounts: { price_without_tax: { amount: 35, currency: "SAR" } },
    },
  ],
  customer: { first_name: "Amina", last_name: "K", mobile: "+966500000000" },
  amounts: {
    sub_total: { amount: "334.00", currency: "SAR" },
    shipping_cost: { amount: "12.00", currency: "SAR" },
    tax: { amount: "17.30", currency: "SAR" },
    discount: { amount: "10.00", currency: "SAR" },
    total: { amount: "353.30", currency: "SAR" },
  },
};

describe("sallaOrderToChannelOrder", () => {
  it("maps ids, reference, lines, buyer, and money as integer minor units", () => {
    const mapped = sallaOrderToChannelOrder(baseOrder);
    expect(mapped.externalId).toBe("12345");
    expect(mapped.orderNumber).toBe("SALLA-1001");
    expect(mapped.currency).toBe("SAR");
    expect(mapped.status).toBe("paid");
    expect(mapped.lines).toEqual([
      {
        sku: "TSHIRT-M-RED",
        channelLineId: "91",
        quantity: 2,
        unitPriceMinor: 14950,
        currency: "SAR",
      },
      {
        sku: "MUG-BLK",
        channelLineId: "92",
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

  it("normalizes Riyadh-time timestamps to UTC ISO 8601", () => {
    const mapped = sallaOrderToChannelOrder(baseOrder);
    expect(mapped.placedAt).toBe("2026-08-01T11:30:00.000Z");
  });

  it("preserves the raw payload for audit/replay", () => {
    expect(sallaOrderToChannelOrder(baseOrder).raw).toBe(baseOrder);
  });

  it("derives totals from lines when Salla omits the amounts summary", () => {
    const sparse: SallaOrder = {
      id: 2002,
      status: "under_review",
      currency: "AED",
      created_at: "2026-08-02T00:00:00Z",
      items: [{ sku: "A", quantity: 3, price: "10.05" }],
    };
    const mapped = sallaOrderToChannelOrder(sparse);
    expect(mapped.totals.subtotalMinor).toBe(3015);
    expect(mapped.totals.shippingMinor).toBe(0);
    expect(mapped.totals.grandMinor).toBe(3015);
    expect(mapped.status).toBe("pending");
    expect(mapped.buyer).toBeUndefined();
  });

  it("defends against missing id/reference/items/customer/status", () => {
    const bare = { id: 77 } as SallaOrder;
    const mapped = sallaOrderToChannelOrder(bare);
    expect(mapped.externalId).toBe("77");
    expect(mapped.orderNumber).toBe("77"); // falls back to id
    expect(mapped.lines).toEqual([]);
    expect(mapped.buyer).toBeUndefined();
    expect(mapped.status).toBe("unknown");
    expect(mapped.currency).toBe("SAR"); // default
    expect(mapped.totals.grandMinor).toBe(0);
    // No parseable date -> epoch, never Invalid Date.
    expect(mapped.placedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("falls back to a flat item price and the order currency when a line omits currency", () => {
    const order: SallaOrder = {
      id: 5,
      currency: "AED",
      items: [{ sku: "X", quantity: 1, price: 20 }],
    };
    const mapped = sallaOrderToChannelOrder(order);
    expect(mapped.lines[0]).toEqual({
      sku: "X",
      quantity: 1,
      unitPriceMinor: 2000,
      currency: "AED",
    });
    expect(mapped.lines[0]?.channelLineId).toBeUndefined();
  });

  it("uses the customer.name field directly when present", () => {
    const order: SallaOrder = {
      id: 9,
      customer: { name: "Full Name", email: "a@b.co" },
    };
    const mapped = sallaOrderToChannelOrder(order);
    expect(mapped.buyer).toEqual({ name: "Full Name", email: "a@b.co" });
  });
});

describe("mapSallaStatus", () => {
  it("maps the Salla vocabulary onto the normalized lifecycle", () => {
    expect(mapSallaStatus("payment_pending")).toBe("pending");
    expect(mapSallaStatus("under_review")).toBe("pending");
    expect(mapSallaStatus("in_progress")).toBe("paid");
    expect(mapSallaStatus("completed")).toBe("paid");
    expect(mapSallaStatus("delivering")).toBe("shipped");
    expect(mapSallaStatus("DELIVERED")).toBe("shipped");
    expect(mapSallaStatus("canceled")).toBe("cancelled");
    expect(mapSallaStatus("restored")).toBe("refunded");
    expect(mapSallaStatus("weird_new_state")).toBe("unknown");
  });

  it("accepts a { name, slug } object and empty/undefined input", () => {
    expect(mapSallaStatus({ slug: "shipped" })).toBe("shipped");
    expect(mapSallaStatus({ name: "Canceled" })).toBe("cancelled");
    expect(mapSallaStatus(undefined)).toBe("unknown");
    expect(mapSallaStatus(null)).toBe("unknown");
  });
});

describe("toMinorUnits", () => {
  it("converts decimal money strings to integer minor units with no float drift", () => {
    expect(toMinorUnits("199.95")).toBe(19995);
    expect(toMinorUnits("149.5")).toBe(14950);
    expect(toMinorUnits("0.1")).toBe(10);
    expect(toMinorUnits("35")).toBe(3500);
    expect(toMinorUnits("1000000.01")).toBe(100000001);
  });

  it("rounds a 3rd fractional digit half-up without floats", () => {
    expect(toMinorUnits("10.005")).toBe(1001);
    expect(toMinorUnits("10.004")).toBe(1000);
    expect(toMinorUnits("0.999")).toBe(100);
  });

  it("accepts numbers and nested { amount, currency } objects", () => {
    expect(toMinorUnits(149.5)).toBe(14950);
    expect(toMinorUnits(0.1)).toBe(10);
    expect(toMinorUnits({ amount: "12.34", currency: "SAR" })).toBe(1234);
    expect(toMinorUnits({ amount: 12.34 })).toBe(1234);
  });

  it("treats missing / null / non-numeric input as 0", () => {
    expect(toMinorUnits(undefined)).toBe(0);
    expect(toMinorUnits(null)).toBe(0);
    expect(toMinorUnits("")).toBe(0);
    expect(toMinorUnits("abc")).toBe(0);
    expect(toMinorUnits({})).toBe(0);
    expect(toMinorUnits(Number.NaN)).toBe(0);
  });

  it("handles negative amounts (e.g. discount adjustments)", () => {
    expect(toMinorUnits("-5.50")).toBe(-550);
  });
});

describe("inventoryPushToSalla / toSallaInventoryPayload", () => {
  it("builds the per-item quantity payload, passing the version through", () => {
    expect(inventoryPushToSalla({ sku: "A", availableQty: 5, version: 7 })).toEqual(
      { sku: "A", quantity: 5, version: 7 },
    );
  });

  it("builds the bulk products payload from SDK inventory pushes", () => {
    const payload = toSallaInventoryPayload([
      { sku: "A", availableQty: 5, version: 7 },
      { sku: "B", availableQty: 0, version: 12 },
    ]);
    expect(payload).toEqual({
      products: [
        { sku: "A", quantity: 5, version: 7 },
        { sku: "B", quantity: 0, version: 12 },
      ],
    });
  });
});

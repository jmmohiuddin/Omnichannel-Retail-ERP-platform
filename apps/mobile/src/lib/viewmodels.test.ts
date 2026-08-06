import { describe, expect, it } from "vitest";
import type { AnalyticsSummary, ApprovalDto, ProductDto } from "./api";
import {
  approvalAge,
  approvalRow,
  dashboardCards,
  shortId,
  stockSearchResults,
} from "./viewmodels";

const norm = (s: string) => s.replace(/[\u00A0\u202F]/g, " ");

const SUMMARY: AnalyticsSummary = {
  today: { orders: 12, revenueMinor: 4_512_50, vatMinor: 214_88 },
  last7Days: { orders: 91, revenueMinor: 31_240_00 },
  topSellers30Days: [
    { variantId: "var-1", description: "iPhone 15 Pro 256GB", units: 14, revenue: 6_020_000 },
  ],
  stockValueMinor: 88_000_00,
  onHandUnits: 412,
};

describe("dashboardCards", () => {
  it("maps the analytics summary to typed cards with AED values", () => {
    const cards = dashboardCards(SUMMARY);
    const byKey = Object.fromEntries(cards.map((c) => [c.key, c]));

    expect(cards.map((c) => c.key)).toEqual([
      "today-revenue",
      "week-revenue",
      "stock-value",
      "top-seller",
    ]);
    expect(norm(byKey["today-revenue"]!.value)).toBe("AED 4,512.50");
    expect(norm(byKey["today-revenue"]!.hint ?? "")).toBe("12 orders · VAT AED 214.88");
    expect(norm(byKey["week-revenue"]!.value)).toBe("AED 31,240.00");
    expect(byKey["stock-value"]!.hint).toBe("412 units on hand");
    expect(byKey["top-seller"]!.value).toBe("iPhone 15 Pro 256GB");
    expect(norm(byKey["top-seller"]!.hint ?? "")).toBe("14 units · AED 60,200.00");
  });

  it("omits the top-seller card when there were no sales", () => {
    const cards = dashboardCards({ ...SUMMARY, topSellers30Days: [] });
    expect(cards.map((c) => c.key)).toEqual(["today-revenue", "week-revenue", "stock-value"]);
  });
});

describe("approvalRow", () => {
  const NOW = Date.parse("2026-08-06T12:00:00Z");

  const refund: ApprovalDto = {
    id: "appr-1",
    kind: "refund",
    reason: "damaged box",
    payload: { amountMinor: 41_200, orderId: "1234567890abcdef" },
    requested_at: "2026-08-06T11:35:00Z",
    requestedBy: "af1e2d3c4b5a6978",
  };

  it("summarizes a refund with its AED amount, order, requester and age", () => {
    const row = approvalRow(refund, NOW);
    expect(row.kindLabel).toBe("Refund");
    expect(norm(row.summary)).toBe("Refund AED 412.00 on order 12345678");
    expect(row.reason).toBe("damaged box");
    expect(row.requestedBy).toBe("af1e2d3c");
    expect(row.age).toBe("25m ago");
    expect(row.urgent).toBe(true);
  });

  it("summarizes a stock count by variance count and is not urgent", () => {
    const row = approvalRow(
      {
        ...refund,
        id: "appr-2",
        kind: "stock_count",
        reason: "",
        payload: { variances: [{}, {}, {}] },
      },
      NOW,
    );
    expect(row.kindLabel).toBe("Stock count");
    expect(row.summary).toBe("Stock count · 3 variances");
    expect(row.reason).toBe("—");
    expect(row.urgent).toBe(false);
  });

  it("approvalAge buckets minutes, hours and days and clamps clock skew", () => {
    const now = Date.parse("2026-08-06T12:00:00Z");
    const at = (iso: string) => approvalAge(iso, now);
    expect(at("2026-08-06T11:59:40Z")).toBe("just now");
    expect(at("2026-08-06T09:00:00Z")).toBe("3h ago");
    expect(at("2026-08-04T12:00:00Z")).toBe("2d ago");
    expect(at("2026-08-06T12:05:00Z")).toBe("just now"); // future timestamp
    expect(at("not-a-date")).toBe("—");
  });
});

describe("stockSearchResults", () => {
  it("flattens products to one row per variant with formatted prices", () => {
    const products: ProductDto[] = [
      {
        id: "p1",
        name: "iPhone 15 Pro",
        slug: "iphone-15-pro",
        tracking: "serialized",
        variants: [
          { id: "v1", sku: "IP15P-256-BLK", barcode: "628123", priceMinor: 429900, currency: "AED" },
          { id: "v2", sku: "IP15P-512-BLK", barcode: null, priceMinor: 499900, currency: "AED" },
        ],
      },
      { id: "p2", name: "Charger", slug: "charger", tracking: "none", variants: [] },
    ];

    const rows = stockSearchResults(products);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      productId: "p1",
      productName: "iPhone 15 Pro",
      variantId: "v1",
      sku: "IP15P-256-BLK",
      barcode: "628123",
      tracking: "serialized",
    });
    expect(norm(rows[0]!.price)).toBe("AED 4,299.00");
    expect(rows[1]!.barcode).toBeNull();
  });

  it("shortId leaves short ids untouched", () => {
    expect(shortId("abc")).toBe("abc");
    expect(shortId("0123456789")).toBe("01234567");
  });
});

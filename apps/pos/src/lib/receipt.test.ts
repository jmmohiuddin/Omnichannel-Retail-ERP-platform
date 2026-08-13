import { describe, expect, it } from "vitest";
import type { Receipt, SalePaymentPayload, SaleResult } from "./api.js";
import type { CartLine } from "./cart.js";
import { buildReceiptDocument, isValidTrn, type CompletedSale } from "./receipt.js";

const payments: SalePaymentPayload[] = [{ method: "cash", amountMinor: 609700 }];

const cartLine: CartLine = {
  variantId: "v1",
  name: "iPhone 15 Pro 256GB",
  sku: "IP15P-256-NT",
  unitPriceMinor: 429900,
  quantity: 1,
  currency: "AED",
};

const sale: SaleResult = {
  orderId: "order-1",
  orderNo: "SO-000123",
  totals: { subtotalMinor: 580667, taxMinor: 29033, totalMinor: 609700, currency: "AED" },
};

/** A receipt in the exact shape `SalesService.receipt()` returns. */
function serverReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    kind: "tax_invoice",
    orderNo: "SO-000123",
    issuedAt: "2026-08-12T10:34:00.000Z",
    seller: { name: "Semul Miah Electronics Trading L.L.C", trn: "100234567800003" },
    location: { name: "Naif", code: "NAIF" },
    cashier: "Kabir R.",
    currency: "AED",
    vatRateBp: 500,
    lines: [
      {
        description: "iPhone 15 Pro 256GB (IP15P-256-NT)",
        quantity: 1,
        unitPriceMinor: 429900,
        discountMinor: 0,
        taxMinor: 20471,
        totalMinor: 429900,
      },
    ],
    totals: { subtotalMinor: 580667, discountMinor: 0, taxMinor: 29033, totalMinor: 609700 },
    payments: [{ method: "cash", amountMinor: 609700 }],
    ...overrides,
  };
}

function onlineSale(receipt: Receipt | null): CompletedSale {
  return { mode: "online", sale, receipt, lines: [cartLine], payments };
}

describe("isValidTrn", () => {
  it("accepts a 15-digit FTA TRN", () => {
    expect(isValidTrn("100234567800003")).toBe(true);
  });

  it("rejects the fabricated placeholder the old renderer printed", () => {
    // Regression: this literal was hardcoded as a fallback and reached real receipts.
    expect(isValidTrn("100000000000000")).toBe(false);
  });

  it("rejects wrong lengths, non-digits and absence", () => {
    expect(isValidTrn("10023456780000")).toBe(false); // 14
    expect(isValidTrn("1002345678000031")).toBe(false); // 16
    expect(isValidTrn("10023456780000X")).toBe(false);
    expect(isValidTrn(undefined)).toBe(false);
    expect(isValidTrn(null)).toBe(false);
  });
});

describe("buildReceiptDocument — server contract", () => {
  it("reads the seller block from `seller`, not from flat `tenantName`/`trn`", () => {
    // Regression: the client type declared `tenantName`/`trn` at the top level,
    // so both were always undefined against the real server response.
    const doc = buildReceiptDocument(onlineSale(serverReceipt()));
    expect(doc.sellerName).toBe("Semul Miah Electronics Trading L.L.C");
    expect(doc.trn).toBe("100234567800003");
  });

  it("renders the line description, never a generic filler", () => {
    // Regression: the client read `l.name ?? l.sku ?? "Item"` while the server
    // sends `description`, so every line printed as the word "Item".
    const doc = buildReceiptDocument(onlineSale(serverReceipt()));
    expect(doc.lines[0]?.description).toBe("iPhone 15 Pro 256GB (IP15P-256-NT)");
    expect(doc.lines.map((l) => l.description)).not.toContain("Item");
  });

  it("carries the issue date, which a tax invoice requires", () => {
    const doc = buildReceiptDocument(onlineSale(serverReceipt()));
    expect(doc.issuedAt).toBe("2026-08-12T10:34:00.000Z");
  });

  it("takes currency from the top level, where the server puts it", () => {
    const doc = buildReceiptDocument(onlineSale(serverReceipt()));
    expect(doc.currency).toBe("AED");
  });
});

describe("buildReceiptDocument — document type is earned, not asserted", () => {
  it("is a tax invoice when a valid supplier TRN is present", () => {
    const doc = buildReceiptDocument(onlineSale(serverReceipt()));
    expect(doc.documentType).toBe("tax_invoice");
  });

  it("degrades to a sale record when the TRN is missing", () => {
    const doc = buildReceiptDocument(onlineSale(serverReceipt({ seller: { name: "Shop", trn: null } })));
    expect(doc.documentType).toBe("sale_record");
    expect(doc.trn).toBeUndefined();
  });

  it("never emits a fabricated TRN, whatever the server sends", () => {
    const doc = buildReceiptDocument(
      onlineSale(serverReceipt({ seller: { name: "Shop", trn: "100000000000000" } })),
    );
    expect(doc.trn).toBeUndefined();
    expect(doc.documentType).toBe("sale_record");
  });

  it("does not claim tax-invoice status just because `kind` says so", () => {
    const doc = buildReceiptDocument(
      onlineSale(serverReceipt({ kind: "tax_invoice", seller: { name: "Shop" } })),
    );
    expect(doc.documentType).toBe("sale_record");
  });
});

describe("buildReceiptDocument — offline", () => {
  const offline: CompletedSale = {
    mode: "offline",
    saleId: "uuid-1",
    totals: { subtotalMinor: 409429, taxMinor: 20471, totalMinor: 429900, itemCount: 1 },
    lines: [{ ...cartLine, imei: "356938035643809" }],
    payments,
    currency: "AED",
  };

  it("is a sale record, never a tax invoice, and prints no TRN", () => {
    const doc = buildReceiptDocument(offline);
    expect(doc.documentType).toBe("sale_record");
    expect(doc.trn).toBeUndefined();
    expect(doc.pendingSync).toBe(true);
  });

  it("keeps the IMEI on the paper as the customer's warranty proof", () => {
    const doc = buildReceiptDocument(offline);
    expect(doc.lines[0]?.description).toContain("356938035643809");
  });

  it("uses locally computed totals", () => {
    const doc = buildReceiptDocument(offline);
    expect(doc.totals.totalMinor).toBe(429900);
  });
});

describe("buildReceiptDocument — degraded fetch", () => {
  it("falls back to cart lines and sale totals when the receipt fetch failed", () => {
    const doc = buildReceiptDocument(onlineSale(null));
    expect(doc.documentType).toBe("sale_record");
    expect(doc.lines[0]?.description).toBe("iPhone 15 Pro 256GB");
    expect(doc.totals.totalMinor).toBe(609700);
    expect(doc.orderNo).toBe("SO-000123");
  });
});

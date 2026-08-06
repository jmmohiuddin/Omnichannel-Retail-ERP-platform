import { describe, expect, it } from "vitest";
import { approvalAge, approvalKindTone, summarizeApprovalPayload } from "./approvals.js";

const ORDER_ID = "77777777-aaaa-bbbb-cccc-000000000007";

describe("summarizeApprovalPayload", () => {
  it("summarizes a refund as an AED amount on a short order id", () => {
    const out = summarizeApprovalPayload("refund", { amountMinor: 129950, orderId: ORDER_ID });
    expect(out).toContain("Refund");
    expect(out).toContain("1,299.50");
    expect(out).toContain("AED");
    expect(out).toContain("order 77777777");
  });

  it("still renders a refund when the order id is missing", () => {
    const out = summarizeApprovalPayload("refund", { amountMinor: 500 });
    expect(out).toContain("5.00");
    expect(out).not.toContain("order");
  });

  it("renders a dash amount for a refund with a malformed amount", () => {
    const out = summarizeApprovalPayload("refund", { amountMinor: "129950", orderId: ORDER_ID });
    expect(out).toContain("—");
  });

  it("summarizes a stock count by its variance count (array payload)", () => {
    const out = summarizeApprovalPayload("stock_count", {
      variances: [{ sku: "A" }, { sku: "B" }, { sku: "C" }],
    });
    expect(out).toBe("Stock count · 3 variances");
  });

  it("uses the singular for exactly one variance and accepts a numeric count", () => {
    expect(summarizeApprovalPayload("stock_count", { variances: [{}] })).toBe(
      "Stock count · 1 variance",
    );
    expect(summarizeApprovalPayload("stock_count", { varianceCount: 2 })).toBe(
      "Stock count · 2 variances",
    );
  });

  it("falls back to a humanized label for unknown kinds", () => {
    expect(summarizeApprovalPayload("price_override", {})).toBe("Price override");
    expect(summarizeApprovalPayload("stock_count", {})).toBe("Stock count");
  });
});

describe("approvalAge", () => {
  const now = Date.parse("2026-08-06T12:00:00.000Z");

  it("buckets ages into minutes, hours, and days", () => {
    expect(approvalAge("2026-08-06T11:59:40.000Z", now)).toBe("just now");
    expect(approvalAge("2026-08-06T11:15:00.000Z", now)).toBe("45m ago");
    expect(approvalAge("2026-08-06T09:00:00.000Z", now)).toBe("3h ago");
    expect(approvalAge("2026-08-04T12:00:00.000Z", now)).toBe("2d ago");
  });

  it("clamps future timestamps (clock skew) and rejects garbage", () => {
    expect(approvalAge("2026-08-06T12:05:00.000Z", now)).toBe("just now");
    expect(approvalAge("not-a-date", now)).toBe("—");
  });
});

describe("approvalKindTone", () => {
  it("marks refunds as outbound money and everything else neutral", () => {
    expect(approvalKindTone("refund")).toBe("out");
    expect(approvalKindTone("stock_count")).toBe("neutral");
    expect(approvalKindTone("price_override")).toBe("neutral");
  });
});

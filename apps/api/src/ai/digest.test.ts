import { describe, expect, it } from "vitest";
import {
  buildDailyDigestPrompt,
  formatAedMinor,
  generateDailyDigest,
  type DailyDigestData,
} from "./digest.js";
import { AiGateway, StubProvider, type AiCallLogEntry } from "./gateway.js";

const data: DailyDigestData = {
  summary: {
    today: { orders: 12, revenueMinor: 4520050, vatMinor: 215240 },
    last7Days: { orders: 80, revenueMinor: 30125000 },
    topSellers30Days: [{ variantId: "v-1", description: "Oud Perfume 50ml" }],
    stockValueMinor: 998877,
    onHandUnits: 431,
  },
  reorder: [
    {
      variantId: "v-1",
      sku: "OUD-50",
      product: "Oud Perfume 50ml",
      forecast: { dailyRate: 3.2, confidence: "low" },
      suggestion: { reorder: true, quantity: 40, daysOfCoverLeft: 2.1 },
    },
  ],
  deadStock: [
    { variantId: "v-9", sku: "SCARF-RED", onHand: 55, lastSaleDaysAgo: 120 },
  ],
  exceptions: {
    windowHours: 24,
    refunds: [{ id: "r-1", amountMinor: 12500, reason: "damaged" }],
    approvals: [],
  },
};

describe("formatAedMinor", () => {
  it("formats minor units as AED with two decimals", () => {
    expect(formatAedMinor(12345)).toBe("AED 123.45");
  });

  it("groups thousands and pads fils", () => {
    expect(formatAedMinor(1234567)).toBe("AED 12,345.67");
    expect(formatAedMinor(500)).toBe("AED 5.00");
    expect(formatAedMinor(7)).toBe("AED 0.07");
  });

  it("handles zero and negative amounts", () => {
    expect(formatAedMinor(0)).toBe("AED 0.00");
    expect(formatAedMinor(-12345)).toBe("-AED 123.45");
  });
});

describe("buildDailyDigestPrompt", () => {
  it("system prompt carries the analyst persona and every guardrail", () => {
    const { system } = buildDailyDigestPrompt(data);
    expect(system).toContain("retail operations analyst");
    expect(system).toContain("UAE (Dubai)");
    expect(system).toContain("ONLY reference figures present in the provided JSON");
    expect(system).toContain("Never fabricate");
    expect(system).toContain("250 words");
    expect(system).toContain("tentative");
    expect(system).toContain("minor units");
    // worked AED example produced by the shared formatting helper
    expect(system).toContain("AED 12,345.67");
  });

  it("user prompt embeds all four data sections as JSON", () => {
    const { user } = buildDailyDigestPrompt(data);
    expect(user).toContain("## summary");
    expect(user).toContain(JSON.stringify(data.summary));
    expect(user).toContain("## reorderSuggestions");
    expect(user).toContain(JSON.stringify(data.reorder));
    expect(user).toContain("## deadStock");
    expect(user).toContain(JSON.stringify(data.deadStock));
    expect(user).toContain("## exceptions");
    expect(user).toContain(JSON.stringify(data.exceptions));
  });

  it("is pure — same input yields the same prompt", () => {
    expect(buildDailyDigestPrompt(data)).toEqual(buildDailyDigestPrompt(data));
  });
});

describe("generateDailyDigest", () => {
  it("calls the gateway with kind daily_digest and returns the narration", async () => {
    const entries: AiCallLogEntry[] = [];
    const gateway = new AiGateway(new StubProvider(), {
      logger: { info: (e) => entries.push(e) },
    });

    const result = await generateDailyDigest(gateway, "tenant-1", data);

    expect(result.text).toMatch(/^\[stub completion [0-9a-f]{8}\]/);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tenantId: "tenant-1",
      kind: "daily_digest",
    });
  });
});

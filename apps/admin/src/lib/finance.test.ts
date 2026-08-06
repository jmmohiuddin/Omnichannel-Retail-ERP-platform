import { afterEach, describe, expect, it, vi } from "vitest";
import { getPnl } from "./api.js";
import { defaultPnlRange, pnlQuery } from "./finance.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("defaultPnlRange", () => {
  it("spans the last 30 days ending today", () => {
    const range = defaultPnlRange(new Date("2026-08-06T12:00:00.000Z"));
    expect(range).toEqual({ from: "2026-07-07", to: "2026-08-06" });
  });

  it("crosses year boundaries correctly", () => {
    const range = defaultPnlRange(new Date("2026-01-15T00:00:00.000Z"));
    expect(range).toEqual({ from: "2025-12-16", to: "2026-01-15" });
  });
});

describe("pnlQuery", () => {
  it("expands calendar dates to inclusive ISO datetimes", () => {
    expect(pnlQuery({ from: "2026-08-01", to: "2026-08-06" })).toBe(
      "?from=2026-08-01T00:00:00.000Z&to=2026-08-06T23:59:59.999Z",
    );
  });

  it("rejects malformed and inverted ranges", () => {
    expect(pnlQuery({ from: "01/08/2026", to: "2026-08-06" })).toBeNull();
    expect(pnlQuery({ from: "2026-08-01", to: "" })).toBeNull();
    expect(pnlQuery({ from: "2026-08-07", to: "2026-08-06" })).toBeNull();
  });

  it("allows a single-day range and feeds getPnl verbatim", async () => {
    const query = pnlQuery({ from: "2026-08-06", to: "2026-08-06" });
    expect(query).toBe("?from=2026-08-06T00:00:00.000Z&to=2026-08-06T23:59:59.999Z");

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            grossRevenueMinor: 0,
            refundsMinor: 0,
            netRevenueMinor: 0,
            costOfSalesMinor: 0,
            costOfSalesNote: "n/a",
            vatCollectedMinor: 0,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getPnl(query as string);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(
      "http://localhost:3001/v1/finance/pnl?from=2026-08-06T00:00:00.000Z&to=2026-08-06T23:59:59.999Z",
    );
  });
});

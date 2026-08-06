import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import { digestErrorMessage } from "./digest.js";

describe("digestErrorMessage", () => {
  it("maps 429 AI_BUDGET_EXCEEDED to a friendly budget message", () => {
    const out = digestErrorMessage(new ApiError(429, "AI_BUDGET_EXCEEDED"));
    expect(out).toContain("AI budget");
    expect(out).toContain("tomorrow");
    expect(out).not.toContain("AI_BUDGET_EXCEEDED"); // no raw code leaking through
  });

  it("maps any 403 to the manager/owner role explanation", () => {
    for (const code of ["FORBIDDEN_ROLE", "FORBIDDEN"]) {
      const out = digestErrorMessage(new ApiError(403, code));
      expect(out).toContain("manager");
      expect(out).toContain("owner");
    }
  });

  it("keeps other API errors' own messages", () => {
    expect(digestErrorMessage(new ApiError(500, "INTERNAL", "Digest generation crashed"))).toBe(
      "Digest generation crashed",
    );
    expect(digestErrorMessage(new ApiError(429, "RATE_LIMITED"))).toBe("RATE_LIMITED (HTTP 429)");
  });

  it("handles non-API errors and unknown values", () => {
    expect(digestErrorMessage(new Error("network down"))).toBe("network down");
    expect(digestErrorMessage(undefined)).toBe("Failed to load the daily digest.");
  });
});

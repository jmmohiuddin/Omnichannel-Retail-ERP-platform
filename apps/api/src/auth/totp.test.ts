import { describe, expect, it } from "vitest";
import {
  base32Encode,
  decryptSecret,
  encryptSecret,
  otpauthUri,
  totpCode,
  verifyTotp,
} from "./totp.js";

// RFC 6238 Appendix B test vectors (SHA-1): secret is ASCII "12345678901234567890";
// 8-digit codes listed in the RFC — our 6-digit output is the last 6 digits.
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("TOTP (RFC 6238 vectors)", () => {
  it.each([
    [59_000, "287082"],           // RFC: 94287082
    [1_111_111_109_000, "081804"], // RFC: 07081804
    [1_234_567_890_000, "005924"], // RFC: 89005924
    [20_000_000_000_000, "353130"], // RFC: 65353130
  ])("at %ims produces %s", (atMs, expected) => {
    expect(totpCode(RFC_SECRET, atMs)).toBe(expected);
  });

  it("verifies the current window and ±1 step for clock skew", () => {
    const now = 1_234_567_890_000;
    const code = totpCode(RFC_SECRET, now);
    expect(verifyTotp(RFC_SECRET, code, now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, now + 30_000)).toBe(true);  // one step later
    expect(verifyTotp(RFC_SECRET, code, now + 61_000)).toBe(false); // two steps later
    expect(verifyTotp(RFC_SECRET, "000000", now)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "28708", now)).toBe(false); // wrong length
  });
});

describe("base32 / otpauth", () => {
  it("encodes RFC 4648 vectors", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Encode(Buffer.from("fo"))).toBe("MZXQ");
  });

  it("builds a scannable otpauth URI", () => {
    const uri = otpauthUri("MZXW6YTBOI", "owner@shop.ae");
    expect(uri).toContain("otpauth://totp/OmniRetail:owner%40shop.ae");
    expect(uri).toContain("secret=MZXW6YTBOI");
    expect(uri).toContain("period=30");
  });
});

describe("secret encryption", () => {
  it("round-trips and fails closed on a wrong key", () => {
    const secret = Buffer.from("12345678901234567890");
    const blob = encryptSecret(secret, "app-secret-1");
    expect(decryptSecret(blob, "app-secret-1").equals(secret)).toBe(true);
    expect(() => decryptSecret(blob, "app-secret-2")).toThrow();
  });

  it("produces distinct ciphertexts per call (fresh IV)", () => {
    const secret = Buffer.from("12345678901234567890");
    const a = encryptSecret(secret, "k");
    const b = encryptSecret(secret, "k");
    expect(a.equals(b)).toBe(false);
  });
});

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 TOTP (SHA-1, 30s step, 6 digits — what authenticator apps expect)
 * plus app-layer AES-256-GCM secret encryption. No dependencies; verified
 * against the RFC test vectors in totp.test.ts.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function generateTotpSecret(): { secret: Buffer; base32: string } {
  const secret = randomBytes(20);
  return { secret, base32: base32Encode(secret) };
}

export function otpauthUri(base32Secret: string, account: string, issuer = "OmniRetail"): string {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(account)}?secret=${base32Secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function hotp(secret: Buffer, counter: bigint, digits: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(code % 10 ** digits).padStart(digits, "0");
}

export function totpCode(secret: Buffer, atMs: number, stepSeconds = 30, digits = 6): string {
  return hotp(secret, BigInt(Math.floor(atMs / 1000 / stepSeconds)), digits);
}

/** Accepts the current step ± one (clock skew), constant-time comparison. */
export function verifyTotp(secret: Buffer, code: string, atMs: number): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const provided = Buffer.from(code);
  for (const skew of [0, -1, 1]) {
    const expected = Buffer.from(totpCode(secret, atMs + skew * 30_000));
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return true;
  }
  return false;
}

/** AES-256-GCM under a key derived from the app secret (iv ∥ tag ∥ ciphertext). */
const encKey = (appSecret: string): Buffer =>
  createHash("sha256").update(`${appSecret}:mfa-secret-encryption`).digest();

export function encryptSecret(secret: Buffer, appSecret: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(appSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(blob: Buffer, appSecret: string): Buffer {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encKey(appSecret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

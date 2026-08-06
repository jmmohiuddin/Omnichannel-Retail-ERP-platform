import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });

// scrypt (built-in, no native deps) with OWASP-recommended parameters.
// Format: scrypt$N$r$p$salthex$keyhex — parameters travel with the hash so they
// can be raised later without invalidating existing credentials.
const N = 1 << 15;
const r = 8;
const p = 1;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, KEYLEN, { N, r, p, maxmem: 128 * N * r * 2 })) as Buffer;
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltHex, keyHex] = parts;
  const params = { N: Number(nStr), r: Number(rStr), p: Number(pStr) };
  const salt = Buffer.from(saltHex!, "hex");
  const expected = Buffer.from(keyHex!, "hex");
  const actual = (await scrypt(password, salt, expected.length, {
    ...params,
    maxmem: 128 * params.N * params.r * 2,
  })) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

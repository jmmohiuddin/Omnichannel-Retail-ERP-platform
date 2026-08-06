import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Cron endpoints run privileged, cross-tenant maintenance, so they must never
 * be publicly triggerable. Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`
 * when that env var is set; we require it. Manual invocation uses the same header.
 * Returns true when the request is authorized (else it has already 401'd).
 */
export function authorizeCron(req: IncomingMessage, res: ServerResponse): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "CRON_SECRET not configured" }));
    return false;
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "UNAUTHORIZED" }));
    return false;
  }
  return true;
}

/** Worker-role pool (bounded — one per warm container). Falls back to the app URL. */
export function workerDatabaseUrl(): string {
  const url = process.env.WORKER_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("WORKER_DATABASE_URL or DATABASE_URL must be set");
  return url;
}

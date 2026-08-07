import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Token-bucket rate limiter, in-memory (per warm process). Keyed by:
 *   - tenantId when the request carries a verified access token,
 *   - customer session token for storefront customer routes,
 *   - source IP otherwise (unauth public endpoints and webhooks).
 *
 * In-memory is fine for a single Fastify replica and for the current serverless
 * shape (each warm container is its own bucket). Multi-region or fleet-wide
 * limiting would move the counters to Redis; the interface stays identical.
 */
export interface RateLimitConfig {
  /** Requests allowed per windowMs. Defaults chosen conservatively. */
  authenticatedPerMinute?: number;
  unauthenticatedPerMinute?: number;
  /** Public webhook endpoints (`/v1/webhooks/*`) get their own bucket. */
  webhookPerMinute?: number;
}

interface Bucket {
  tokens: number;
  resetAt: number;
}

const KEY_STORAGE = Symbol("rateLimitStore");
type Store = Map<string, Bucket>;

function bucketKey(req: FastifyRequest): { key: string; kind: "auth" | "webhook" | "ip" } {
  const url = req.url ?? "";
  if (url.startsWith("/v1/webhooks/")) {
    return { key: `wh:${req.ip}`, kind: "webhook" };
  }
  // Employee session (Bearer …).
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return { key: `t:${auth.slice(7, 39)}`, kind: "auth" }; // first 32 chars of token
  }
  // Customer session (CustomerSession …).
  if (auth?.startsWith("CustomerSession ")) {
    return { key: `c:${auth.slice(16, 48)}`, kind: "auth" };
  }
  return { key: `ip:${req.ip}`, kind: "ip" };
}

export async function registerRateLimit(
  app: FastifyInstance,
  cfg: RateLimitConfig = {},
): Promise<void> {
  const authLimit = cfg.authenticatedPerMinute ?? 600;
  const unauthLimit = cfg.unauthenticatedPerMinute ?? 60;
  const webhookLimit = cfg.webhookPerMinute ?? 120;

  const store: Store = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any)[KEY_STORAGE] = store;

  app.addHook("onRequest", async (req, reply) => {
    // Health endpoints must never be throttled — cron pings and load balancers
    // hit them relentlessly and a 429 there triggers a false-positive outage.
    if (req.url === "/health" || req.url === "/health/deep") return;

    const { key, kind } = bucketKey(req);
    const now = Date.now();
    const limit = kind === "webhook" ? webhookLimit
      : kind === "auth" ? authLimit
      : unauthLimit;

    let b = store.get(key);
    if (!b || b.resetAt <= now) {
      b = { tokens: limit, resetAt: now + 60_000 };
      store.set(key, b);
    }

    if (b.tokens <= 0) {
      const retryAfter = Math.ceil((b.resetAt - now) / 1000);
      reply.header("Retry-After", String(retryAfter));
      reply.header("X-RateLimit-Limit", String(limit));
      reply.header("X-RateLimit-Remaining", "0");
      reply.header("X-RateLimit-Reset", String(Math.floor(b.resetAt / 1000)));
      return reply.code(429).send({ error: "RATE_LIMITED", retryAfter });
    }

    b.tokens -= 1;
    reply.header("X-RateLimit-Limit", String(limit));
    reply.header("X-RateLimit-Remaining", String(b.tokens));
    reply.header("X-RateLimit-Reset", String(Math.floor(b.resetAt / 1000)));
  });
}

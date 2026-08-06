/**
 * Vercel serverless entry for the OmniRetail API.
 *
 * The Fastify app is built ONCE per warm container and reused across
 * invocations; requests are handed to its underlying Node server via the
 * 'request' event, which is the supported way to run Fastify on a serverless
 * platform (do NOT call app.listen()).
 *
 * The app is loaded with a DYNAMIC import on purpose: Vercel compiles this
 * entry to CommonJS (the repo root has no "type": "module"), while the rest
 * of the codebase is ESM — a static import becomes require() and dies with
 * ERR_REQUIRE_ESM. A dynamic import() is valid from CommonJS and keeps the
 * monorepo's module config untouched.
 *
 * Deliberately different from apps/api/src/main.ts:
 *  - no migrations at boot (a cold start must never mutate the schema; run
 *    them from CI or a laptop against the direct, non-pooler Neon endpoint);
 *  - no worker loops — the relay, janitor, and drift check are continuous
 *    processes and cannot live on a serverless platform.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

interface ServerlessApp {
  server: { emit: (event: string, req: IncomingMessage, res: ServerResponse) => void };
}

let appPromise: Promise<ServerlessApp> | undefined;

async function loadApp(): Promise<ServerlessApp> {
  const databaseUrl = process.env.DATABASE_URL;
  const jwtSecret = process.env.JWT_SECRET;
  if (!databaseUrl || !jwtSecret) {
    throw new Error("DATABASE_URL and JWT_SECRET must be set in the Vercel project");
  }

  const mod = await import("../apps/api/dist/pgApp.js");
  const app = mod.buildPgApp({
    databaseUrl,
    jwtSecret,
    ...(process.env.ANTHROPIC_API_KEY ? { anthropicApiKey: process.env.ANTHROPIC_API_KEY } : {}),
    ...(process.env.PAYMENT_WEBHOOK_SECRET
      ? { paymentWebhookSecret: process.env.PAYMENT_WEBHOOK_SECRET }
      : {}),
  });
  await app.ready();
  return app as unknown as ServerlessApp;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  appPromise ??= loadApp();
  const app = await appPromise;
  app.server.emit("request", req, res);
}

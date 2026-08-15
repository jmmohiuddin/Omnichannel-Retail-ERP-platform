import { migrate } from "@omniretail/db";
import { buildPgApp } from "./pgApp.js";
import { reporterFromEnv } from "./observability/errorReporter.js";

const databaseUrl = process.env.DATABASE_URL;
const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL; // owner role, for migrations
const jwtSecret = process.env.JWT_SECRET;

if (!databaseUrl || !jwtSecret) {
  console.error("DATABASE_URL and JWT_SECRET are required");
  process.exit(1);
}

if (adminDatabaseUrl) {
  const applied = await migrate(adminDatabaseUrl);
  if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
}

const errorReporter = reporterFromEnv();

// Failures outside the request lifecycle reach no route handler, so the
// Fastify error hook never sees them. Without these two listeners an unhandled
// rejection in a background task is a silent process death (R12.10).
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
  errorReporter.captureException(reason, { transaction: "process:unhandledRejection" });
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
  errorReporter.captureException(err, { transaction: "process:uncaughtException" });
  // Flush before exiting: an uncaught exception leaves the process in an
  // undefined state, so we report and go rather than trying to carry on.
  void errorReporter.flush(2_000).finally(() => process.exit(1));
});

const app = buildPgApp({
  databaseUrl,
  jwtSecret,
  errorReporter,
  ...(process.env.ANTHROPIC_API_KEY ? { anthropicApiKey: process.env.ANTHROPIC_API_KEY } : {}),
});
const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });
console.log(`OmniRetail API listening on :${port}`);

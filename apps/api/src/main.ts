import { migrate } from "@omniretail/db";
import { buildPgApp } from "./pgApp.js";

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

const app = buildPgApp({ databaseUrl, jwtSecret });
const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });
console.log(`OmniRetail API listening on :${port}`);

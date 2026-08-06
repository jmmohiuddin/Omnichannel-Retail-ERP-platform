import pg from "pg";
import { OutboxRelay } from "./relay.js";
import { BullPublisher } from "./bullPublisher.js";

const databaseUrl = process.env.WORKER_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) {
  console.error("WORKER_DATABASE_URL and REDIS_URL are required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const publisher = new BullPublisher(redisUrl);
const relay = new OutboxRelay(pool, publisher);

const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());

console.log("outbox relay running");
await relay.runForever(500, abort.signal);
await publisher.close();
await pool.end();

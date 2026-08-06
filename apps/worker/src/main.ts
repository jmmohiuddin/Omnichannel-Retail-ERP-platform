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
const { startEventConsumer } = await import("./consumer.js");
const { ReservationJanitor } = await import("./reservationJanitor.js");
const consumer = startEventConsumer(pool, redisUrl);

const janitor = new ReservationJanitor(pool);
const janitorTimer = setInterval(() => {
  janitor.runOnce().catch((err) => console.error("janitor:", err.message));
}, 60_000);

const { DriftCheck } = await import("./driftCheck.js");
const driftCheck = new DriftCheck(pool);
const driftTimer = setInterval(() => {
  driftCheck
    .runOnce()
    .then((findings) => {
      if (findings.length) console.error(`LEDGER DRIFT: ${findings.length} bucket(s) diverged`);
    })
    .catch((err) => console.error("drift-check:", err.message));
}, 60 * 60_000);

const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());

console.log("outbox relay + event consumer + reservation janitor running");
await relay.runForever(500, abort.signal);
clearInterval(janitorTimer);
clearInterval(driftTimer);
await consumer.close();
await publisher.close();
await pool.end();

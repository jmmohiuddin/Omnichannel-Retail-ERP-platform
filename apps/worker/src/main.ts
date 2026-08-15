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

const pruneTimer = setInterval(() => {
  relay
    .pruneRelayed(7)
    .then((n) => { if (n) console.log(`outbox retention: pruned ${n} relayed rows`); })
    .catch((err) => console.error("outbox prune:", err.message));
}, 6 * 60 * 60_000);

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

// Payment reconciliation (R6.2). Repairs intents whose gateway webhook never
// arrived, through the very same effect path the webhook would have taken.
const { Db } = await import("@omniretail/api/db");
const { MockGateway } = await import("@omniretail/api/payments/gateway");
const { PaymentService } = await import("@omniretail/api/payments");
const { PaymentReconciler, PgExceptionSink } = await import("./paymentReconciler.js");

const gateway = new MockGateway(process.env.PAYMENT_WEBHOOK_SECRET ?? "dev-mock-webhook-secret");
const reconciler = new PaymentReconciler(
  pool,
  // The service's own pool is this worker's connection, so the repair runs
  // under the worker role and the same RLS policies as every other job here.
  new PaymentService(new Db(databaseUrl), new Map([[gateway.key, gateway]])),
  new PgExceptionSink(pool),
);
const reconcileTimer = setInterval(() => {
  reconciler
    .runOnce()
    .catch((err) => console.error("payment reconciler:", err.message));
}, 5 * 60_000);

// Customer notification delivery (R13.1). Without SMTP configured the queue
// simply accumulates — enqueue still works and the Messages screen still shows
// what is waiting, which is a far better failure mode than dropping mail.
const { NotificationDelivery } = await import("./notificationDelivery.js");
const { SmtpTransport, smtpConfigFromEnv } = await import("@omniretail/api/notify/transport");
const smtpConfig = smtpConfigFromEnv();
let notifyTimer: NodeJS.Timeout | undefined;
if (smtpConfig) {
  const delivery = new NotificationDelivery(pool, new SmtpTransport(smtpConfig));
  notifyTimer = setInterval(() => {
    delivery.runOnce().catch((err) => console.error("notification delivery:", err.message));
  }, 15_000);
} else {
  console.warn("SMTP_HOST/SMTP_FROM unset — notification delivery is idle, queue will build up");
}

const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());

console.log(
  "outbox relay + event consumer + reservation janitor + payment reconciler running",
);
await relay.runForever(500, abort.signal);
clearInterval(janitorTimer);
clearInterval(driftTimer);
clearInterval(pruneTimer);
clearInterval(reconcileTimer);
if (notifyTimer) clearInterval(notifyTimer);
await consumer.close();
await publisher.close();
await pool.end();

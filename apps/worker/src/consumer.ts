import { Worker } from "bullmq";
import type pg from "pg";
import {
  ConnectorRegistry,
  MemoryStateStore,
  type ConnectorContext,
  type ConnectorHttp,
} from "@omniretail/connector-sdk";
import { noonConnector } from "@omniretail/connector-noon";
import { ChannelSyncService } from "./channelSync.js";
import type { OutboxEvent } from "./relay.js";

/** fetch-backed ConnectorHttp for production connector calls. */
const fetchHttp = (baseUrl: string, headers: Record<string, string>): ConnectorHttp => {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : {}; } catch { /* leave as text */ }
    return { status: res.status, body: parsed };
  };
  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    put: (path, body) => call("PUT", path, body),
  };
};

/**
 * Consumes relayed domain events and fans out channel work. State stores are
 * in-memory per process for now — cursors that must survive restarts move to
 * a `connector_state` table when order-import goes live.
 */
export function startEventConsumer(pool: pg.Pool, redisUrl: string): Worker {
  const registry = new ConnectorRegistry();
  registry.register(noonConnector);

  const stateStores = new Map<string, MemoryStateStore>();
  const contextFor = (channel: { id: string; config: unknown }): ConnectorContext => {
    let state = stateStores.get(channel.id);
    if (!state) {
      state = new MemoryStateStore();
      stateStores.set(channel.id, state);
    }
    const cfg = (channel.config ?? {}) as { baseUrl?: string };
    return {
      http: fetchHttp(cfg.baseUrl ?? "https://invalid.example", {}),
      credentials: async () => ({}), // per-tenant decryption lands with real channels
      state,
      log: (level, msg, meta) => console.log(`[connector:${channel.id}] ${level}: ${msg}`, meta ?? ""),
    };
  };

  const sync = new ChannelSyncService(pool, registry, contextFor);
  const url = new URL(redisUrl);

  return new Worker<OutboxEvent>(
    "domain-events",
    async (job) => {
      const event = job.data;
      if (event.eventType === "inventory.level.changed") {
        const payload = event.payload as { variantId: string; seq: number };
        await sync.handleInventoryChanged(event.tenantId, payload.variantId, payload.seq);
      }
      // order.created / refund.approved consumers (notifications, accounting)
      // attach here as they come online.
    },
    {
      connection: {
        host: url.hostname,
        port: Number(url.port || 6379),
        ...(url.password ? { password: url.password } : {}),
      },
      concurrency: 4,
    },
  );
}

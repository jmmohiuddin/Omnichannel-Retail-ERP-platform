import type pg from "pg";
import type {
  Connector,
  ConnectorContext,
  ConnectorRegistry,
} from "@omniretail/connector-sdk";

export interface SyncResult {
  channelId: string;
  connector: string;
  sku: string;
  pushedQty: number;
  ok: boolean;
  error?: string;
}

/**
 * Pushes inventory changes to marketplace channels (docs/integrations/03):
 * ERP is the source of truth for stock; each channel sees on-hand minus its
 * configured buffer, floored at zero. Failures are recorded on the listing
 * (sync_error) and never block other channels.
 */
export class ChannelSyncService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: ConnectorRegistry,
    private readonly contextFor: (channel: { id: string; config: unknown }) => ConnectorContext,
  ) {}

  async handleInventoryChanged(tenantId: string, variantId: string, seq: number): Promise<SyncResult[]> {
    const { rows } = await this.pool.query(
      `SELECT cl.channel_id, cl.buffer_qty, c.connector, c.config, v.sku,
              coalesce((SELECT sum(sl.quantity) FROM stock_level sl
                 WHERE sl.tenant_id = $1 AND sl.variant_id = $2
                   AND sl.state = 'on_hand'), 0)::float8 AS on_hand
         FROM channel_listing cl
         JOIN channel c ON c.id = cl.channel_id
         JOIN variant v ON v.id = cl.variant_id
        WHERE cl.tenant_id = $1 AND cl.variant_id = $2
          AND cl.published AND c.status = 'active' AND c.connector IS NOT NULL`,
      [tenantId, variantId],
    );

    const results: SyncResult[] = [];
    for (const row of rows) {
      const connector: Connector | undefined = this.registry.get(row.connector);
      if (!connector?.capabilities.inventorySync) continue;
      const availableQty = Math.max(0, Math.floor(row.on_hand - Number(row.buffer_qty)));
      const ctx = this.contextFor({ id: row.channel_id, config: row.config });
      try {
        const outcomes = await connector.pushInventory(ctx, [
          { sku: row.sku, availableQty, version: seq },
        ]);
        const failed = outcomes.find((o) => !o.ok);
        const failMessage = failed ? failed.message ?? "push failed" : null;
        await this.pool.query(
          `UPDATE channel_listing
              SET last_synced_seq = $4, last_synced_at = now(), sync_error = $5
            WHERE tenant_id = $1 AND channel_id = $2 AND variant_id = $3`,
          [tenantId, row.channel_id, variantId, seq, failMessage],
        );
        results.push({
          channelId: row.channel_id, connector: row.connector, sku: row.sku,
          pushedQty: availableQty, ok: !failed,
          ...(failMessage ? { error: failMessage } : {}),
        });
      } catch (err) {
        const message = (err as Error).message;
        await this.pool.query(
          `UPDATE channel_listing SET sync_error = $4
            WHERE tenant_id = $1 AND channel_id = $2 AND variant_id = $3`,
          [tenantId, row.channel_id, variantId, message],
        );
        results.push({
          channelId: row.channel_id, connector: row.connector, sku: row.sku,
          pushedQty: availableQty, ok: false, error: message,
        });
      }
    }
    return results;
  }
}

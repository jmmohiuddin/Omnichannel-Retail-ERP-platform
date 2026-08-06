import { randomUUID } from "node:crypto";
import type pg from "pg";

/**
 * Releases expired stock reservations (unpaid web checkouts past their TTL —
 * docs/integrations/03 reservation lifecycle). Marketplace reservations carry
 * no expiry and are never touched. Runs on the worker role: discovery is a
 * bounded cross-tenant read; all writes happen under the tenant GUC and the
 * same RLS policies as the API.
 */
export class ReservationJanitor {
  constructor(private readonly pool: pg.Pool) {}

  /** Release one batch of expired reservations. Returns released order ids. */
  async runOnce(limit = 50): Promise<string[]> {
    const { rows: due } = await this.pool.query<{ tenant_id: string; reference_id: string }>(
      `SELECT DISTINCT tenant_id, reference_id
         FROM stock_reservation
        WHERE status = 'active' AND reference_type = 'order' AND expires_at < now()
        LIMIT $1`,
      [limit],
    );

    const released: string[] = [];
    for (const { tenant_id: tenantId, reference_id: orderId } of due) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

        const order = await client.query<{ status: string; location_id: string }>(
          "SELECT status, location_id FROM sales_order WHERE id = $1 FOR UPDATE",
          [orderId],
        );
        const head = order.rows[0];
        // Paid/fulfilled/cancelled in the meantime → just retire the rows.
        if (!head || head.status !== "pending") {
          await client.query(
            `UPDATE stock_reservation SET status = 'expired'
              WHERE reference_type = 'order' AND reference_id = $1 AND status = 'active'`,
            [orderId],
          );
          await client.query("COMMIT");
          continue;
        }

        const system = await client.query<{ id: string }>(
          "SELECT id FROM app_user WHERE email = 'system@omniretail.internal' LIMIT 1",
        );
        const systemUserId = system.rows[0]?.id;
        if (!systemUserId) {
          await client.query("ROLLBACK");
          continue;
        }

        const { rows: reservations } = await client.query<{
          id: string; variant_id: string; location_id: string; quantity: string;
        }>(
          `SELECT id, variant_id, location_id, quantity FROM stock_reservation
            WHERE reference_type = 'order' AND reference_id = $1 AND status = 'active'
            FOR UPDATE`,
          [orderId],
        );

        for (const r of reservations) {
          const movement = await client.query<{ seq: string }>(
            `INSERT INTO stock_movement
               (id, tenant_id, movement_type, variant_id, quantity,
                from_location_id, from_state, to_location_id, to_state,
                actor_user_id, reference_type, reference_id, note)
             VALUES ($1,$2,'release',$3,$4,$5,'reserved',$5,'on_hand',$6,'order',$7,
                     'reservation expired')
             RETURNING seq`,
            [randomUUID(), tenantId, r.variant_id, r.quantity, r.location_id,
             systemUserId, orderId],
          );
          const seq = Number(movement.rows[0]!.seq);
          const debit = await client.query(
            `UPDATE stock_level
                SET quantity = quantity - $4, updated_seq = $5, updated_at = now()
              WHERE tenant_id = $1 AND location_id = $2 AND variant_id = $3
                AND state = 'reserved'`,
            [tenantId, r.location_id, r.variant_id, r.quantity, seq],
          );
          if (debit.rowCount === 0) {
            throw new Error(`reserved bucket missing for variant ${r.variant_id}`);
          }
          await client.query(
            `INSERT INTO stock_level (tenant_id, location_id, variant_id, state, quantity, updated_seq)
             VALUES ($1,$2,$3,'on_hand',$4,$5)
             ON CONFLICT (tenant_id, location_id, variant_id, state)
             DO UPDATE SET quantity = stock_level.quantity + EXCLUDED.quantity,
                           updated_seq = EXCLUDED.updated_seq, updated_at = now()`,
            [tenantId, r.location_id, r.variant_id, r.quantity, seq],
          );
          await client.query(
            "UPDATE stock_reservation SET status = 'expired' WHERE id = $1",
            [r.id],
          );
        }

        await client.query(
          "UPDATE payment SET status = 'voided' WHERE order_id = $1 AND status = 'pending'",
          [orderId],
        );
        await client.query(
          "UPDATE sales_order SET status = 'cancelled' WHERE id = $1",
          [orderId],
        );
        await client.query(
          `INSERT INTO outbox (id, tenant_id, aggregate, event_type, payload)
           VALUES ($1,$2,$3,'order.expired',$4)`,
          [randomUUID(), tenantId, `order:${orderId}`, JSON.stringify({ orderId })],
        );
        await client.query("COMMIT");
        released.push(orderId);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`reservation janitor: order ${orderId}:`, (err as Error).message);
      } finally {
        client.release();
      }
    }
    return released;
  }
}

import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { ReceivingService, ReceiveLineInput, ReceiveUnitInput } from "../inventory/receivingService.js";

export class PurchasingError extends Error {
  constructor(
    readonly code:
      | "SUPPLIER_NOT_FOUND"
      | "PO_NOT_FOUND"
      | "BAD_STATE"
      | "UNKNOWN_VARIANT"
      | "OVER_RECEIPT"
      | "EMPTY_PO",
    message: string,
  ) {
    super(message);
    this.name = "PurchasingError";
  }
}

export interface Supplier {
  id: string;
  name: string;
  contact: Record<string, unknown>;
  paymentTerms: string | null;
  isActive: boolean;
}

export interface CreatePoLineInput {
  variantId: string;
  orderedQty: number;
  unitCostMinor: number;
}

export interface CreatePoInput {
  supplierId: string;
  locationId: string;
  currency?: string;
  expectedAt?: string; // ISO date
  note?: string;
  lines: CreatePoLineInput[];
}

export interface PoLineView {
  variantId: string;
  sku: string;
  orderedQty: number;
  receivedQty: number;
  unitCostMinor: number;
}

export interface PurchaseOrderView {
  id: string;
  poNo: string;
  supplierId: string;
  locationId: string;
  status: string;
  currency: string;
  expectedAt: string | null;
  note: string | null;
  placedAt: Date | null;
  createdAt: Date;
  lines: PoLineView[];
}

export interface ReceiveAgainstPoInput {
  lines: {
    variantId: string;
    /** Non-serialized: explicit quantity. Serialized: derived from units.length. */
    quantity?: number;
    units?: ReceiveUnitInput[];
  }[];
  deviceId?: string;
}

interface PoRow {
  id: string;
  po_no: string;
  supplier_id: string;
  location_id: string;
  status: string;
  currency: string;
  expected_at: string | null;
  note: string | null;
  placed_at: Date | null;
  created_at: Date;
}

interface PoLineRow {
  variant_id: string;
  sku: string;
  ordered_qty: string; // numeric comes back as text
  received_qty: string;
  unit_cost_minor: string; // bigint comes back as text
}

/**
 * Purchasing v1: suppliers, purchase orders, and receiving against a PO.
 *
 * Stock is NEVER written here — the injected ReceivingService posts the ledger
 * movements and stock_unit rows (ADR-002: levels derive from movements). This
 * service owns only the PO bookkeeping around that call.
 */
export class PurchasingService {
  constructor(
    private readonly db: Db,
    private readonly receiving: ReceivingService,
  ) {}

  // ---- suppliers -----------------------------------------------------------

  async createSupplier(
    tenantId: string,
    input: { name: string; contact?: Record<string, unknown>; paymentTerms?: string },
  ): Promise<{ supplierId: string }> {
    return this.db.withTenant(tenantId, async (c) => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO supplier (id, tenant_id, name, contact, payment_terms)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, tenantId, input.name, JSON.stringify(input.contact ?? {}), input.paymentTerms ?? null],
      );
      return { supplierId: id };
    });
  }

  async listSuppliers(tenantId: string): Promise<Supplier[]> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{
        id: string; name: string; contact: Record<string, unknown>;
        payment_terms: string | null; is_active: boolean;
      }>(
        `SELECT id, name, contact, payment_terms, is_active
           FROM supplier ORDER BY name`,
      );
      return rows.map((r) => ({
        id: r.id, name: r.name, contact: r.contact,
        paymentTerms: r.payment_terms, isActive: r.is_active,
      }));
    });
  }

  // ---- purchase orders -----------------------------------------------------

  async createPurchaseOrder(
    tenantId: string,
    userId: string,
    input: CreatePoInput,
  ): Promise<{ poId: string; poNo: string }> {
    if (input.lines.length === 0) {
      throw new PurchasingError("EMPTY_PO", "a purchase order needs at least one line");
    }
    return this.db.withTenant(tenantId, async (c) => {
      const supplier = await c.query("SELECT id FROM supplier WHERE id = $1", [input.supplierId]);
      if (!supplier.rows[0]) {
        throw new PurchasingError("SUPPLIER_NOT_FOUND", `supplier ${input.supplierId} not found`);
      }

      const variantIds = input.lines.map((l) => l.variantId);
      const known = await c.query<{ id: string }>(
        "SELECT id FROM variant WHERE id = ANY($1::uuid[])",
        [variantIds],
      );
      const knownIds = new Set(known.rows.map((r) => r.id));
      const missing = variantIds.find((v) => !knownIds.has(v));
      if (missing) {
        throw new PurchasingError("UNKNOWN_VARIANT", `variant ${missing} not found`);
      }

      // Gapless per-tenant PO number: row-lock counter incremented inside this
      // transaction (order_counter pattern) — a rollback rolls the counter back.
      const counter = await c.query<{ last_no: string }>(
        `INSERT INTO po_counter (tenant_id, last_no) VALUES ($1, 1)
         ON CONFLICT (tenant_id) DO UPDATE SET last_no = po_counter.last_no + 1
         RETURNING last_no`,
        [tenantId],
      );
      const poNo = `PO-${String(counter.rows[0]!.last_no).padStart(6, "0")}`;

      // v1 skips the draft workflow: every PO is created already 'placed'
      // (draft/approve routing is a later feature; the status CHECK allows it).
      const poId = randomUUID();
      await c.query(
        `INSERT INTO purchase_order
           (id, tenant_id, supplier_id, po_no, location_id, status, currency,
            expected_at, note, created_by, placed_at)
         VALUES ($1,$2,$3,$4,$5,'placed',$6,$7,$8,$9,now())`,
        [poId, tenantId, input.supplierId, poNo, input.locationId,
         input.currency ?? "AED", input.expectedAt ?? null, input.note ?? null, userId],
      );
      for (const line of input.lines) {
        await c.query(
          `INSERT INTO purchase_order_line
             (po_id, tenant_id, variant_id, ordered_qty, unit_cost_minor)
           VALUES ($1,$2,$3,$4,$5)`,
          [poId, tenantId, line.variantId, line.orderedQty, line.unitCostMinor],
        );
      }
      return { poId, poNo };
    });
  }

  async getPurchaseOrder(tenantId: string, poId: string): Promise<PurchaseOrderView> {
    return this.db.withTenant(tenantId, (c) => this.loadPo(c, poId));
  }

  // ---- receiving against a PO ---------------------------------------------

  /**
   * Receive goods against a placed PO. Validation and quantity math happen
   * here; the actual stock intake is delegated to ReceivingService, which
   * posts the ledger movements / stock_unit rows exactly as ad-hoc receiving
   * does (one GRN, IMEI uniqueness enforced by the database).
   *
   * TRANSACTION SEAM (v1, deliberate): ReceivingService.receive opens its own
   * transaction, so the PO bookkeeping below runs in a SECOND transaction. A
   * crash between the two leaves stock correctly received but the PO's
   * received_qty/status stale — reconcilable, because every movement carries
   * the GRN id and the PO number as its note/reference. The v2 fix is to
   * refactor receive() to accept an external client and run both in one
   * transaction.
   */
  async receiveAgainstPo(
    tenantId: string,
    userId: string,
    poId: string,
    input: ReceiveAgainstPoInput,
  ): Promise<{ grnId: string; unitIds: string[]; status: string }> {
    if (input.lines.length === 0) {
      throw new PurchasingError("EMPTY_PO", "receiving requires at least one line");
    }

    // Transaction 1 (read): load + validate the PO, compute receive quantities.
    const { po, receiveLines, qtyByVariant, costByVariant } = await this.db.withTenant(
      tenantId,
      async (c) => {
        const po = await this.loadPo(c, poId);
        if (po.status !== "placed" && po.status !== "partially_received") {
          throw new PurchasingError("BAD_STATE", `cannot receive against a ${po.status} PO`);
        }
        const byVariant = new Map(po.lines.map((l) => [l.variantId, l]));

        const receiveLines: ReceiveLineInput[] = [];
        const qtyByVariant = new Map<string, number>();
        const costByVariant = new Map<string, number>();
        for (const line of input.lines) {
          const poLine = byVariant.get(line.variantId);
          if (!poLine) {
            throw new PurchasingError(
              "UNKNOWN_VARIANT",
              `variant ${line.variantId} is not on ${po.poNo}`,
            );
          }
          const quantity = line.quantity ?? line.units?.length ?? 0;
          if (quantity <= 0) {
            throw new PurchasingError("EMPTY_PO", `line ${line.variantId} receives nothing`);
          }
          if (poLine.receivedQty + quantity > poLine.orderedQty) {
            throw new PurchasingError(
              "OVER_RECEIPT",
              `${po.poNo} line ${line.variantId}: received ${poLine.receivedQty} + ${quantity} exceeds ordered ${poLine.orderedQty}`,
            );
          }
          qtyByVariant.set(line.variantId, quantity);
          costByVariant.set(line.variantId, poLine.unitCostMinor);

          // Serialized units default to the PO line's negotiated unit cost.
          const units = line.units?.map((u) => ({
            ...u,
            unitCostMinor: u.unitCostMinor ?? poLine.unitCostMinor,
          }));
          receiveLines.push({
            variantId: line.variantId,
            ...(line.quantity !== undefined ? { quantity: line.quantity } : {}),
            ...(units ? { units } : {}),
          });
        }
        return { po, receiveLines, qtyByVariant, costByVariant };
      },
    );

    // Stock intake: ledger movements + stock_units via the existing service.
    const result = await this.receiving.receive(tenantId, userId, {
      locationId: po.locationId,
      lines: receiveLines,
      reference: po.poNo,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    });

    // Transaction 2: PO bookkeeping (see seam note above).
    const status = await this.db.withTenant(tenantId, async (c) => {
      for (const [variantId, quantity] of qtyByVariant) {
        await c.query(
          `UPDATE purchase_order_line
              SET received_qty = received_qty + $3
            WHERE po_id = $1 AND variant_id = $2`,
          [poId, variantId, quantity],
        );
        // Simple last-cost policy: the latest PO cost becomes the variant cost.
        // Moving-average costing is a v2 policy choice (needs on-hand valuation).
        await c.query("UPDATE variant SET cost_minor = $2 WHERE id = $1", [
          variantId, costByVariant.get(variantId),
        ]);
      }
      // Attribute the newly created serialized units to this PO (003 left the
      // column dangling; 019 added the FK).
      if (result.unitIds.length > 0) {
        await c.query(
          "UPDATE stock_unit SET purchase_order_id = $1, updated_at = now() WHERE id = ANY($2::uuid[])",
          [poId, result.unitIds],
        );
      }
      const complete = await c.query<{ done: boolean }>(
        `SELECT bool_and(received_qty >= ordered_qty) AS done
           FROM purchase_order_line WHERE po_id = $1`,
        [poId],
      );
      const status = complete.rows[0]?.done ? "received" : "partially_received";
      await c.query("UPDATE purchase_order SET status = $2 WHERE id = $1", [poId, status]);
      return status;
    });

    return { grnId: result.grnId, unitIds: result.unitIds, status };
  }

  // ---- internals -----------------------------------------------------------

  private async loadPo(
    c: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
    poId: string,
  ): Promise<PurchaseOrderView> {
    const header = await c.query(
      `SELECT id, po_no, supplier_id, location_id, status, currency,
              expected_at, note, placed_at, created_at
         FROM purchase_order WHERE id = $1`,
      [poId],
    );
    const po = header.rows[0] as PoRow | undefined;
    if (!po) throw new PurchasingError("PO_NOT_FOUND", `purchase order ${poId} not found`);

    const lines = await c.query(
      `SELECT l.variant_id, v.sku, l.ordered_qty, l.received_qty, l.unit_cost_minor
         FROM purchase_order_line l JOIN variant v ON v.id = l.variant_id
        WHERE l.po_id = $1 ORDER BY v.sku`,
      [poId],
    );
    return {
      id: po.id,
      poNo: po.po_no,
      supplierId: po.supplier_id,
      locationId: po.location_id,
      status: po.status,
      currency: po.currency,
      expectedAt: po.expected_at,
      note: po.note,
      placedAt: po.placed_at,
      createdAt: po.created_at,
      lines: (lines.rows as PoLineRow[]).map((l) => ({
        variantId: l.variant_id,
        sku: l.sku,
        orderedQty: Number(l.ordered_qty),
        receivedQty: Number(l.received_qty),
        unitCostMinor: Number(l.unit_cost_minor),
      })),
    };
  }
}

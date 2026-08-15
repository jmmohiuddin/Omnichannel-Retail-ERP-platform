/**
 * Domestic reverse charge — capture, verification and resolution (R7.3, R7.3a).
 *
 * This service holds the I/O half of the reverse-charge feature. The RULE —
 * which conditions gate the treatment, which lines qualify, what happens when
 * a condition fails — lives in `packages/domain/src/reverseCharge.ts` and is
 * called from here, never re-implemented (CLAUDE.md).
 *
 * What this file owns:
 *   * capturing the buyer's written declaration, snapshotted;
 *   * recording the supplier's verification of the buyer's registration,
 *     which R7.3a requires and which a declaration alone does not satisfy;
 *   * assembling a `SaleTaxContext` from the database so the domain can
 *     decide, and handing the decision back to the sale path.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  RCM_DECLARATION_TEXT,
  resolveSaleTaxTreatment,
  type RcmDeviceClass,
  type RcmVerificationMethod,
  type RcmVerificationOutcome,
  type SaleTaxContext,
  type SaleTaxTreatment,
} from "@omniretail/domain";
import type { Db } from "../db.js";

export class RcmError extends Error {
  constructor(
    readonly code:
      | "CUSTOMER_NOT_FOUND"
      | "DECLARATION_NOT_FOUND"
      | "NOT_A_BUSINESS_CUSTOMER"
      | "TRN_REQUIRED"
      | "ALREADY_VERIFIED"
      | "ALREADY_REVOKED",
    message: string,
  ) {
    super(message);
    this.name = "RcmError";
  }
}

export interface CaptureDeclarationInput {
  customerId: string;
  /** Both limbs of CD 91/2023. Stored separately; both must be true to qualify. */
  declaresResaleOrManufacture: boolean;
  declaresFtaRegistered: boolean;
  /** Which language the declaration was presented and agreed in. */
  locale?: "en" | "ar";
}

export interface VerifyDeclarationInput {
  declarationId: string;
  method: RcmVerificationMethod;
  outcome: RcmVerificationOutcome;
  /** Portal reference, certificate id, or a note describing the evidence. */
  reference?: string;
}

export interface DeclarationRecord {
  id: string;
  customerId: string;
  trn: string;
  legalName: string;
  declaresResaleOrManufacture: boolean;
  declaresFtaRegistered: boolean;
  declarationText: string;
  declarationLocale: "en" | "ar";
  verificationMethod?: RcmVerificationMethod;
  verificationOutcome?: RcmVerificationOutcome;
  verificationRef?: string;
  verifiedAt?: Date;
  capturedAt: Date;
  revokedAt?: Date;
  /** True only when every condition this record can satisfy is satisfied. */
  usable: boolean;
}

interface DeclarationRow {
  id: string;
  customer_id: string;
  trn: string;
  legal_name: string;
  address: unknown;
  declares_resale_or_manufacture: boolean;
  declares_fta_registered: boolean;
  declaration_text: string;
  declaration_locale: "en" | "ar";
  verification_method: RcmVerificationMethod | null;
  verification_outcome: RcmVerificationOutcome | null;
  verification_ref: string | null;
  verified_at: Date | null;
  captured_at: Date;
  revoked_at: Date | null;
}

const toRecord = (r: DeclarationRow): DeclarationRecord => ({
  id: r.id,
  customerId: r.customer_id,
  trn: r.trn,
  legalName: r.legal_name,
  declaresResaleOrManufacture: r.declares_resale_or_manufacture,
  declaresFtaRegistered: r.declares_fta_registered,
  declarationText: r.declaration_text,
  declarationLocale: r.declaration_locale,
  ...(r.verification_method ? { verificationMethod: r.verification_method } : {}),
  ...(r.verification_outcome ? { verificationOutcome: r.verification_outcome } : {}),
  ...(r.verification_ref ? { verificationRef: r.verification_ref } : {}),
  ...(r.verified_at ? { verifiedAt: r.verified_at } : {}),
  capturedAt: r.captured_at,
  ...(r.revoked_at ? { revokedAt: r.revoked_at } : {}),
  usable:
    r.revoked_at === null &&
    r.declares_resale_or_manufacture &&
    r.declares_fta_registered &&
    r.verification_outcome === "verified",
});

/** A sale line as the tax resolver needs to see it. */
export interface RcmSaleLine {
  lineId: string;
  variantId: string;
  deviceClass?: RcmDeviceClass | undefined;
  zeroRated?: boolean;
  exempt?: boolean;
}

export interface ResolvedSaleTax {
  treatment: SaleTaxTreatment;
  /** The declaration the treatment rests on, when one applied. */
  declarationId?: string;
  buyerTrn?: string;
  buyerLegalName?: string;
  buyerAddress?: unknown;
}

export class RcmService {
  constructor(private readonly db: Db) {}

  /**
   * Capture the buyer's written declaration.
   *
   * The buyer's TRN, legal name and address are SNAPSHOTTED onto the record
   * rather than joined at read time. A tax document must show what was
   * declared on the day; editing the customer row two years later must not
   * silently rewrite the evidence behind an invoice already filed.
   */
  async captureDeclaration(
    tenantId: string,
    actorUserId: string,
    input: CaptureDeclarationInput,
  ): Promise<DeclarationRecord> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{
        is_business: boolean; legal_name: string | null; trn: string | null; billing_address: unknown;
      }>(
        "SELECT is_business, legal_name, trn, billing_address FROM customer WHERE id = $1",
        [input.customerId],
      );
      const customer = rows[0];
      if (!customer) {
        throw new RcmError("CUSTOMER_NOT_FOUND", `customer ${input.customerId} not found`);
      }
      if (!customer.is_business || !customer.legal_name) {
        throw new RcmError(
          "NOT_A_BUSINESS_CUSTOMER",
          "a reverse-charge declaration needs a business customer with a legal name",
        );
      }
      if (!customer.trn) {
        throw new RcmError("TRN_REQUIRED", "a reverse-charge declaration needs the buyer's TRN");
      }

      const locale = input.locale ?? "en";
      const id = randomUUID();
      const { rows: created } = await c.query<DeclarationRow>(
        `INSERT INTO rcm_declaration
           (id, tenant_id, customer_id, trn, legal_name, address,
            declares_resale_or_manufacture, declares_fta_registered,
            declaration_text, declaration_locale, captured_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          id, tenantId, input.customerId, customer.trn, customer.legal_name,
          customer.billing_address ?? null,
          input.declaresResaleOrManufacture, input.declaresFtaRegistered,
          RCM_DECLARATION_TEXT[locale], locale, actorUserId,
        ],
      );
      return toRecord(created[0]!);
    });
  }

  /**
   * Record the supplier-side verification of the buyer's FTA registration
   * (R7.3a). Retaining the declaration is expressly not sufficient, so until
   * this runs with outcome 'verified' the sale cannot be reverse-charged.
   *
   * PRD Q10 — which verification means a retailer actually has at the counter
   * — is still open, which is why `outcome` admits 'unavailable' as a real
   * answer distinct from 'failed'. Neither qualifies the sale, but they are
   * different facts and an auditor will want to know which.
   */
  async verifyDeclaration(
    tenantId: string,
    actorUserId: string,
    input: VerifyDeclarationInput,
  ): Promise<DeclarationRecord> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<DeclarationRow>(
        "SELECT * FROM rcm_declaration WHERE id = $1 FOR UPDATE",
        [input.declarationId],
      );
      const existing = rows[0];
      if (!existing) {
        throw new RcmError("DECLARATION_NOT_FOUND", `declaration ${input.declarationId} not found`);
      }
      if (existing.revoked_at) {
        throw new RcmError("ALREADY_REVOKED", "this declaration has been revoked");
      }

      const { rows: updated } = await c.query<DeclarationRow>(
        `UPDATE rcm_declaration
            SET verification_method = $2, verification_outcome = $3,
                verification_ref = $4, verified_by_user_id = $5, verified_at = now()
          WHERE id = $1
          RETURNING *`,
        [input.declarationId, input.method, input.outcome, input.reference ?? null, actorUserId],
      );
      return toRecord(updated[0]!);
    });
  }

  /** Withdraw a declaration — e.g. the buyer's registration lapsed. */
  async revokeDeclaration(
    tenantId: string,
    declarationId: string,
    reason: string,
  ): Promise<DeclarationRecord> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<DeclarationRow>(
        `UPDATE rcm_declaration
            SET revoked_at = now(), revoked_reason = $2
          WHERE id = $1 AND revoked_at IS NULL
          RETURNING *`,
        [declarationId, reason],
      );
      const row = rows[0];
      if (!row) {
        throw new RcmError(
          "DECLARATION_NOT_FOUND",
          "declaration not found, or already revoked",
        );
      }
      return toRecord(row);
    });
  }

  async listForCustomer(tenantId: string, customerId: string): Promise<DeclarationRecord[]> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<DeclarationRow>(
        `SELECT * FROM rcm_declaration
          WHERE customer_id = $1
          ORDER BY captured_at DESC`,
        [customerId],
      );
      return rows.map(toRecord);
    });
  }

  /** The declaration a sale to this customer would rest on, if any. */
  async activeDeclarationWith(
    c: pg.PoolClient,
    customerId: string,
  ): Promise<DeclarationRecord | undefined> {
    const { rows } = await c.query<DeclarationRow>(
      `SELECT * FROM rcm_declaration
        WHERE customer_id = $1 AND revoked_at IS NULL
        ORDER BY captured_at DESC
        LIMIT 1`,
      [customerId],
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  /**
   * Decide the tax treatment for a sale, inside the caller's transaction.
   *
   * Runs on the same client as the sale so the declaration cannot be revoked
   * between the decision and the invoice — the read and the write are one
   * atomic act, which is the property that makes the invoice defensible.
   */
  async resolveForSaleWith(
    c: pg.PoolClient,
    args: {
      customerId?: string | undefined;
      rcmRequested: boolean;
      standardRateBp: number;
      lines: readonly RcmSaleLine[];
    },
  ): Promise<ResolvedSaleTax> {
    const { rows: tenantRows } = await c.query<{ trn: string | null }>(
      "SELECT trn FROM tenant WHERE id = current_tenant_id()",
    );
    const supplierTrn = tenantRows[0]?.trn ?? undefined;

    const declaration = args.rcmRequested && args.customerId
      ? await this.activeDeclarationWith(c, args.customerId)
      : undefined;

    const ctx: SaleTaxContext = {
      rcmRequested: args.rcmRequested,
      standardRateBp: args.standardRateBp,
      ...(supplierTrn ? { supplierTrn } : {}),
      ...(declaration?.trn ? { buyerTrn: declaration.trn } : {}),
      ...(declaration
        ? {
            declaration: {
              declaresResaleOrManufacture: declaration.declaresResaleOrManufacture,
              declaresFtaRegistered: declaration.declaresFtaRegistered,
              // A revoked declaration reaches here only if it was revoked
              // between the two reads; `usable` already accounts for it, and
              // omitting the verification makes the domain refuse.
              ...(declaration.verificationMethod && declaration.verificationOutcome && !declaration.revokedAt
                ? {
                    verification: {
                      method: declaration.verificationMethod,
                      outcome: declaration.verificationOutcome,
                    },
                  }
                : {}),
            },
          }
        : {}),
      lines: args.lines.map((l) => ({
        lineId: l.lineId,
        ...(l.deviceClass ? { deviceClass: l.deviceClass } : {}),
        ...(l.zeroRated ? { zeroRated: true } : {}),
        ...(l.exempt ? { exempt: true } : {}),
      })),
    };

    const treatment = resolveSaleTaxTreatment(ctx);

    // Only attach the buyer identity when the treatment actually rests on it.
    // A refused sale is an ordinary standard-rated sale and must not carry a
    // declaration reference implying otherwise — the DB constraint
    // `sales_order_rcm_is_supported` depends on exactly this.
    if (treatment.kind === "standard" || !declaration) {
      return { treatment };
    }
    return {
      treatment,
      declarationId: declaration.id,
      buyerTrn: declaration.trn,
      buyerLegalName: declaration.legalName,
    };
  }
}

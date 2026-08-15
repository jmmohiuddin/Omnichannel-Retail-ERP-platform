import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Gateway abstraction (docs/08 §4). Real UAE adapters — Network International
 * N-Genius, Telr, Stripe AE, Tabby/Tamara — implement this port with merchant
 * credentials; the ERP core never changes. Card data never transits the ERP:
 * `redirectUrl` is the gateway's hosted page and webhooks carry only refs.
 */
export interface GatewayIntent {
  gatewayRef: string;
  redirectUrl?: string;
}

export interface GatewayWebhookEvent {
  /** Gateway's unique delivery id — the idempotency key. */
  externalId: string;
  type: "payment.succeeded" | "payment.failed";
  gatewayRef: string;
}

/**
 * Authoritative status of an intent, pulled from the gateway rather than
 * pushed by it (R6.2). `succeeded` carries the amount the gateway actually
 * took: the reconciler refuses to capture anything it cannot match against the
 * intent, because a webhook that never arrived is exactly the situation where
 * the two could have diverged.
 */
export type GatewayPaymentStatus =
  | { state: "succeeded"; amountMinor: number; currency: string }
  | { state: "failed"; reason?: string }
  /** Gateway still working — a slow authorization, not a lost webhook. */
  | { state: "pending" }
  /** Gateway does not recognise the ref, or answered something we cannot act on. */
  | { state: "unknown"; reason?: string };

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export interface PaymentGatewayPort {
  readonly key: string;
  createIntent(req: {
    orderId: string;
    orderNo: string;
    amountMinor: number;
    currency: string;
    returnUrl?: string;
  }): Promise<GatewayIntent>;
  /**
   * Verify an incoming webhook (signature over the RAW body) and parse it.
   * Throws WebhookVerificationError on any signature problem.
   */
  parseWebhook(rawBody: string, signatureHeader: string | undefined): GatewayWebhookEvent;
  /**
   * Poll the gateway for an intent's real status (R6.2 reconciliation).
   *
   * Optional on purpose. Webhooks remain the primary path; this is the safety
   * net for the delivery that never arrived. An adapter whose gateway exposes
   * no status/query API simply omits it, and the reconciler flags its stuck
   * intents for a human instead of guessing.
   */
  fetchStatus?(gatewayRef: string): Promise<GatewayPaymentStatus>;
}

/**
 * Mock gateway: HMAC-SHA256-signed webhooks over the raw body — the same
 * verification discipline real adapters need, exercisable in tests and demos.
 */
export class MockGateway implements PaymentGatewayPort {
  readonly key = "mock";
  /**
   * Stands in for the remote gateway's ledger. A real adapter calls the
   * gateway's query API here; tests and demos drive it with `setStatus`.
   */
  private readonly remoteStatus = new Map<string, GatewayPaymentStatus>();

  constructor(private readonly webhookSecret: string) {
    if (webhookSecret.length < 16) throw new Error("webhook secret too short");
  }

  async createIntent(req: {
    orderId: string; orderNo: string; amountMinor: number; currency: string;
  }): Promise<GatewayIntent> {
    const gatewayRef = `mock_${randomUUID()}`;
    this.remoteStatus.set(gatewayRef, { state: "pending" });
    return {
      gatewayRef,
      redirectUrl: `https://pay.mock.invalid/checkout/${gatewayRef}?amount=${req.amountMinor}&cur=${req.currency}`,
    };
  }

  /** Test/demo hook: what the gateway will report for this ref. */
  setStatus(gatewayRef: string, status: GatewayPaymentStatus): void {
    this.remoteStatus.set(gatewayRef, status);
  }

  async fetchStatus(gatewayRef: string): Promise<GatewayPaymentStatus> {
    return this.remoteStatus.get(gatewayRef) ?? { state: "unknown", reason: "no such ref" };
  }

  sign(rawBody: string): string {
    return createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
  }

  parseWebhook(rawBody: string, signatureHeader: string | undefined): GatewayWebhookEvent {
    if (!signatureHeader) throw new WebhookVerificationError("missing signature");
    const expected = Buffer.from(this.sign(rawBody), "hex");
    let provided: Buffer;
    try {
      provided = Buffer.from(signatureHeader, "hex");
    } catch {
      throw new WebhookVerificationError("malformed signature");
    }
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new WebhookVerificationError("signature mismatch");
    }
    let body: { id?: string; type?: string; gatewayRef?: string };
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError("invalid JSON body");
    }
    if (!body.id || !body.gatewayRef ||
        (body.type !== "payment.succeeded" && body.type !== "payment.failed")) {
      throw new WebhookVerificationError("malformed event");
    }
    return { externalId: body.id, type: body.type, gatewayRef: body.gatewayRef };
  }
}

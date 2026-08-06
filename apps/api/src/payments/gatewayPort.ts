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
}

/**
 * Mock gateway: HMAC-SHA256-signed webhooks over the raw body — the same
 * verification discipline real adapters need, exercisable in tests and demos.
 */
export class MockGateway implements PaymentGatewayPort {
  readonly key = "mock";

  constructor(private readonly webhookSecret: string) {
    if (webhookSecret.length < 16) throw new Error("webhook secret too short");
  }

  async createIntent(req: {
    orderId: string; orderNo: string; amountMinor: number; currency: string;
  }): Promise<GatewayIntent> {
    const gatewayRef = `mock_${randomUUID()}`;
    return {
      gatewayRef,
      redirectUrl: `https://pay.mock.invalid/checkout/${gatewayRef}?amount=${req.amountMinor}&cur=${req.currency}`,
    };
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

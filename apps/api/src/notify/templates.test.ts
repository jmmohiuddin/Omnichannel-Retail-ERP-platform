/**
 * Template rendering (R13.3, R13.4, R13.5) — pure, so this is a plain unit
 * suite with no database and no network.
 *
 * The load-bearing assertions are: both locales render every template; Arabic
 * is real Arabic rather than an English fallback; money never goes through a
 * float; and the same input always produces the same bytes, which is what
 * makes the body stored on the notification row usable as evidence.
 */
import { describe, expect, it } from "vitest";
import {
  LOCALES,
  TEMPLATE_NAMES,
  currencyExponent,
  formatMoneyMinor,
  formatQuantity,
  formatVatRate,
  formatDate,
  recipientKindFor,
  render,
  type Locale,
  type NotificationRequest,
} from "./templates.js";

const RLM = "‏";
const LRI = "⁦";
const ARABIC = /[؀-ۿ]/;

const requests: Record<string, NotificationRequest> = {
  order_confirmation: {
    template: "order_confirmation",
    payload: {
      tenantName: "Al Noor Electronics",
      customerName: "Fatima Al Mansoori",
      orderNo: "INV-000123",
      currency: "AED",
      lines: [
        { description: "Samsung Galaxy A55 (SKU-A55)", quantity: "1.000", totalMinor: 129900 },
        { description: "Screen protector (SKU-SP1)", quantity: "2.000", totalMinor: 5000 },
      ],
      subtotalMinor: 128476,
      taxMinor: 6424,
      totalMinor: 134900,
      vatRateBp: 500,
    },
  },
  dispatch_tracking: {
    template: "dispatch_tracking",
    payload: {
      tenantName: "Al Noor Electronics",
      customerName: "Fatima Al Mansoori",
      orderNo: "INV-000123",
      courier: "Aramex",
      trackingNo: "ARX-99887766",
      trackingUrl: "https://track.example.ae/ARX-99887766",
      expectedDeliveryIso: "2026-08-18T00:00:00.000Z",
    },
  },
  cod_reminder: {
    template: "cod_reminder",
    payload: {
      tenantName: "Al Noor Electronics",
      customerName: "Fatima Al Mansoori",
      orderNo: "INV-000123",
      currency: "AED",
      amountDueMinor: 134900,
      expectedDeliveryIso: "2026-08-18",
    },
  },
  return_received: {
    template: "return_received",
    payload: {
      tenantName: "Al Noor Electronics",
      customerName: "Fatima Al Mansoori",
      orderNo: "INV-000123",
      items: [{ description: "Screen protector (SKU-SP1)", quantity: "1.000" }],
      currency: "AED",
      refundMinor: 2500,
      refundEtaDays: 5,
    },
  },
  warranty_expiring: {
    template: "warranty_expiring",
    payload: {
      tenantName: "Al Noor Electronics",
      customerName: "Fatima Al Mansoori",
      productName: "Samsung Galaxy A55",
      serialNo: "IMEI-356938035643809",
      expiresOnIso: "2026-09-30",
      daysRemaining: 47,
    },
  },
  low_stock: {
    template: "low_stock",
    payload: {
      tenantName: "Al Noor Electronics",
      locationName: "Deira Store",
      items: [
        { sku: "SKU-A55", name: "Samsung Galaxy A55", onHand: "3.000", reorderPoint: "10.000" },
      ],
    },
  },
};

describe("money formatting", () => {
  it("formats AED minor units without float arithmetic", () => {
    expect(formatMoneyMinor(134900, "AED")).toBe("AED 1,349.00");
    expect(formatMoneyMinor(5, "AED")).toBe("AED 0.05");
    expect(formatMoneyMinor(0, "AED")).toBe("AED 0.00");
    expect(formatMoneyMinor(-2500, "AED")).toBe("-AED 25.00");
  });

  it("respects three-decimal Gulf currencies and zero-decimal ones", () => {
    // The reason CURRENCY_EXPONENT exists: `/ 100` misprices a dinar by 10x.
    expect(currencyExponent("KWD")).toBe(3);
    expect(formatMoneyMinor(1234567, "KWD")).toBe("KWD 1,234.567");
    expect(formatMoneyMinor(1500, "JPY")).toBe("JPY 1,500");
  });

  it("is exact past the range where a float would drift", () => {
    // 90,071,992,547,409.93 — beyond Number.MAX_SAFE_INTEGER in minor units.
    expect(formatMoneyMinor("9007199254740993", "AED")).toBe("AED 90,071,992,547,409.93");
    expect(formatMoneyMinor(9007199254740993n, "AED")).toBe("AED 90,071,992,547,409.93");
  });

  it("accepts pg's string BIGINT and NUMERIC representations", () => {
    expect(formatMoneyMinor("134900", "AED")).toBe("AED 1,349.00");
    expect(formatQuantity("2.000")).toBe("2");
    expect(formatQuantity("1.500")).toBe("1.5");
    expect(formatQuantity(3)).toBe("3");
  });

  it("renders a VAT rate from basis points rather than assuming 5%", () => {
    expect(formatVatRate(500)).toBe("5");
    expect(formatVatRate(750)).toBe("7.5");
    expect(formatVatRate(0)).toBe("0");
    expect(formatVatRate(1234)).toBe("12.34");
  });

  it("formats dates as ISO, not through a host-dependent Intl formatter", () => {
    expect(formatDate("2026-08-18T13:45:00.000Z")).toBe("2026-08-18");
    expect(formatDate("2026-08-18")).toBe("2026-08-18");
    // Unparseable input passes through rather than becoming "Invalid Date".
    expect(formatDate("soon")).toBe("soon");
  });
});

describe("every template, in both locales (R13.3, R13.4)", () => {
  it("covers all six R13.3 templates", () => {
    expect(Object.keys(requests).sort()).toEqual([...TEMPLATE_NAMES].sort());
  });

  for (const name of TEMPLATE_NAMES) {
    for (const locale of LOCALES) {
      it(`${name} / ${locale} renders a complete message`, () => {
        const result = render(requests[name]!, locale);
        expect(result.subject.trim().length).toBeGreaterThan(0);
        expect(result.bodyText.trim().length).toBeGreaterThan(0);
        expect(result.bodyHtml).toContain(`lang="${locale}"`);
        expect(result.bodyHtml).toContain(`dir="${locale === "ar" ? "rtl" : "ltr"}"`);
        // No template may leak an unresolved placeholder.
        expect(result.bodyText).not.toMatch(/\$\{|undefined|\[object Object\]/);
        expect(result.subject).not.toMatch(/\$\{|undefined/);
      });
    }

    it(`${name} is deterministic (R13.5)`, () => {
      const a = render(requests[name]!, "ar");
      const b = render(requests[name]!, "ar");
      expect(a).toEqual(b);
    });

    it(`${name} in Arabic is actually Arabic and RTL-marked`, () => {
      const result = render(requests[name]!, "ar");
      expect(result.subject).toMatch(ARABIC);
      expect(result.bodyText).toMatch(ARABIC);
      // Every non-empty line carries the RLM that fixes paragraph direction.
      const lines = result.bodyText.split("\n").filter((l) => l.length > 0);
      expect(lines.every((l) => l.startsWith(RLM))).toBe(true);
    });

    it(`${name} in English contains no Arabic (no fallback leakage)`, () => {
      const result = render(requests[name]!, "en");
      expect(result.subject).not.toMatch(ARABIC);
      expect(result.bodyText).not.toMatch(ARABIC);
    });
  }
});

describe("order confirmation", () => {
  it("shows every line, the totals, and the tenant's own VAT rate", () => {
    const en = render(requests.order_confirmation!, "en");
    expect(en.subject).toContain("INV-000123");
    expect(en.bodyText).toContain("Samsung Galaxy A55 (SKU-A55)");
    expect(en.bodyText).toContain("Screen protector (SKU-SP1)");
    expect(en.bodyText).toContain("Subtotal: AED 1,284.76");
    expect(en.bodyText).toContain("VAT (5%): AED 64.24");
    expect(en.bodyText).toContain("Total: AED 1,349.00");
    // Quantities come off NUMERIC(14,3) as "2.000" and must not read that way.
    expect(en.bodyText).toContain("qty 2 ");
  });

  it("labels VAT from basis points, so a non-5% tenant is not told 5%", () => {
    const request: NotificationRequest = {
      template: "order_confirmation",
      payload: { ...requests.order_confirmation!.payload as never, vatRateBp: 750 },
    };
    expect(render(request, "en").bodyText).toContain("VAT (7.5%)");
    expect(render(request, "ar").bodyText).toContain("7.5");
  });

  it("omits the rate entirely when the tenant's rate is unknown", () => {
    const { vatRateBp: _drop, ...rest } = requests.order_confirmation!
      .payload as { vatRateBp?: number };
    const request = {
      template: "order_confirmation",
      payload: rest,
    } as NotificationRequest;
    const body = render(request, "en").bodyText;
    expect(body).toContain("VAT: AED");
    expect(body).not.toContain("VAT (");
  });

  it("asks a COD customer to have cash ready", () => {
    const request: NotificationRequest = {
      template: "order_confirmation",
      payload: { ...(requests.order_confirmation!.payload as never), paymentMethod: "cod" },
    };
    expect(render(request, "en").bodyText).toContain("ready in cash on delivery");
    expect(render(request, "ar").bodyText).toContain("نقداً عند الاستلام");
  });

  it("escapes HTML from customer-supplied text", () => {
    const request: NotificationRequest = {
      template: "order_confirmation",
      payload: {
        ...(requests.order_confirmation!.payload as never),
        customerName: '<script>alert("x")</script>',
      },
    };
    const html = render(request, "en").bodyHtml;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("dispatch tracking (R5.3)", () => {
  for (const locale of LOCALES) {
    it(`surfaces the tracking number in subject and body — ${locale}`, () => {
      const result = render(requests.dispatch_tracking!, locale as Locale);
      expect(result.subject).toContain("ARX-99887766");
      expect(result.bodyText).toContain("ARX-99887766");
      expect(result.bodyHtml).toContain("ARX-99887766");
      expect(result.bodyText).toContain("Aramex");
    });
  }

  it("isolates the tracking number so Arabic text cannot reorder it", () => {
    const ar = render(requests.dispatch_tracking!, "ar");
    expect(ar.bodyText).toContain(`${LRI}ARX-99887766`);
  });

  it("still renders without an optional tracking URL or ETA", () => {
    const request: NotificationRequest = {
      template: "dispatch_tracking",
      payload: {
        tenantName: "Shop",
        customerName: "Customer",
        orderNo: "INV-1",
        courier: "mock",
        trackingNo: "MOCK-INV-1",
      },
    };
    const result = render(request, "en");
    expect(result.bodyText).toContain("MOCK-INV-1");
    expect(result.bodyHtml).not.toContain("<a href");
  });
});

describe("the remaining templates", () => {
  it("cod_reminder leads with the amount due", () => {
    const en = render(requests.cod_reminder!, "en");
    expect(en.subject).toContain("AED 1,349.00");
    expect(en.bodyText).toContain("Amount due: AED 1,349.00");
  });

  it("return_received states the refund when it is decided", () => {
    expect(render(requests.return_received!, "en").bodyText)
      .toContain("We will refund AED 25.00 within 5 working days.");
  });

  it("return_received says inspection is pending when it is not", () => {
    const request: NotificationRequest = {
      template: "return_received",
      payload: {
        tenantName: "Shop",
        customerName: "Customer",
        orderNo: "INV-1",
        items: [{ description: "Thing", quantity: 1 }],
        currency: "AED",
      },
    };
    const body = render(request, "en").bodyText;
    expect(body).toContain("We will inspect the items");
    expect(body).not.toContain("refund AED");
  });

  it("warranty_expiring carries the date and the serial", () => {
    const en = render(requests.warranty_expiring!, "en");
    expect(en.subject).toContain("2026-09-30");
    expect(en.bodyText).toContain("in 47 days");
    expect(en.bodyText).toContain("IMEI-356938035643809");
  });

  it("low_stock is addressed to staff, not to a customer", () => {
    expect(recipientKindFor("low_stock")).toBe("staff");
    expect(recipientKindFor("order_confirmation")).toBe("customer");
    const en = render(requests.low_stock!, "en");
    expect(en.bodyText).toContain("on hand 3");
    expect(en.bodyText).toContain("reorder point 10");
    expect(en.subject).toContain("Deira Store");
  });
});

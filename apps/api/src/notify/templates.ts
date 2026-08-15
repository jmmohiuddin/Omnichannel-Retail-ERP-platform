/**
 * Customer notification templates (R13.3, R13.4, R13.5).
 *
 * R13.5 is the binding constraint here: **deterministic templated content
 * only**. There is no model call in this file and there must never be one —
 * the same payload must render the same bytes today and in a dispute eighteen
 * months from now, because notificationService freezes the render into the
 * `notification` row and that row is the evidence of what a customer was told.
 * Everything below is a pure function of its arguments; the only ambient input
 * is the locale, which the caller resolves.
 *
 * R13.4 asks for bilingual templates. Arabic is not a bolt-on translation
 * layer: Federal Decree-Law 15/2020 Art. 8(4) makes Arabic mandatory on
 * consumer-facing commercial communication in the UAE, so `ar` is written as a
 * first-class body, not a machine gloss of the English one.
 *
 * RTL correctness. An Arabic paragraph containing `INV-000123` or `AED 129.00`
 * is bidirectional text, and a naive concatenation renders those runs in the
 * wrong place — a tracking number that reads backwards is a support ticket.
 * Two Unicode controls fix it deterministically, without any renderer help:
 *   * U+200F RLM starts each Arabic line, so first-strong paragraph direction
 *     resolves to RTL even when the line opens with a digit or a Latin word.
 *   * U+2066 LRI … U+2069 PDI isolate every LTR run (order numbers, tracking
 *     numbers, money, dates) so it cannot reorder its Arabic surroundings.
 * The isolates sit *outside* the token, so `bodyText.includes(trackingNo)`
 * still holds — which is what R5.3 is checked by.
 *
 * Money. Minor units are integers and stay integers: formatting goes through
 * BigInt and string surgery, never `/ 100`. Quantities are NUMERIC(14,3) and
 * arrive from pg as strings; they are formatted as strings too.
 */

export type Locale = "en" | "ar";

export const LOCALES: readonly Locale[] = ["en", "ar"] as const;

export const isLocale = (value: unknown): value is Locale =>
  value === "en" || value === "ar";

/** The six templates R13.3 names. Mirrors the CHECK in 032_notifications.sql. */
export const TEMPLATE_NAMES = [
  "order_confirmation",
  "dispatch_tracking",
  "cod_reminder",
  "return_received",
  "warranty_expiring",
  "low_stock",
] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export const isTemplateName = (value: unknown): value is TemplateName =>
  typeof value === "string" && (TEMPLATE_NAMES as readonly string[]).includes(value);

/** What a template produces. `bodyHtml` is optional at the column level but
 *  every template here renders one — a plain-text-only receipt looks broken. */
export interface RenderedMessage {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

/** Minor units as they cross a JSON boundary: pg hands BIGINT back as string. */
export type MinorUnits = number | string | bigint;
/** NUMERIC(14,3) as it crosses a JSON boundary. */
export type Quantity = number | string;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface OrderLineView {
  description: string;
  quantity: Quantity;
  totalMinor: MinorUnits;
}

export interface OrderConfirmationPayload {
  tenantName: string;
  customerName: string;
  orderNo: string;
  currency: string;
  lines: OrderLineView[];
  subtotalMinor: MinorUnits;
  taxMinor: MinorUnits;
  totalMinor: MinorUnits;
  /** Tenant VAT rate in basis points (500 = 5%). Omitted → unlabelled tax line.
   *  Never hardcoded: a tenant outside the 5% standard rate must not be lied to. */
  vatRateBp?: number;
  /** Drives the closing line: a COD order still owes money at the door. */
  paymentMethod?: "cod" | "prepaid";
}

export interface DispatchTrackingPayload {
  tenantName: string;
  customerName: string;
  orderNo: string;
  courier: string;
  /** R5.3: this is the whole point of the message. */
  trackingNo: string;
  trackingUrl?: string;
  /** ISO-8601 date or timestamp; only the date part is shown. */
  expectedDeliveryIso?: string;
}

export interface CodReminderPayload {
  tenantName: string;
  customerName: string;
  orderNo: string;
  currency: string;
  amountDueMinor: MinorUnits;
  expectedDeliveryIso?: string;
}

export interface ReturnReceivedPayload {
  tenantName: string;
  customerName: string;
  orderNo: string;
  items: { description: string; quantity: Quantity }[];
  currency: string;
  /** Present once the refund is decided; absent while inspection is pending. */
  refundMinor?: MinorUnits;
  /** Working days until the refund reaches the customer's account. */
  refundEtaDays?: number;
}

export interface WarrantyExpiringPayload {
  tenantName: string;
  customerName: string;
  productName: string;
  serialNo?: string;
  /** ISO-8601 date the warranty lapses. */
  expiresOnIso: string;
  daysRemaining: number;
}

/** The one internal template: it goes to staff, not to a customer. */
export interface LowStockPayload {
  tenantName: string;
  locationName: string;
  items: { sku: string; name: string; onHand: Quantity; reorderPoint: Quantity }[];
}

/** Template name → its payload type. Keeps render() exhaustively typed. */
export interface TemplatePayloads {
  order_confirmation: OrderConfirmationPayload;
  dispatch_tracking: DispatchTrackingPayload;
  cod_reminder: CodReminderPayload;
  return_received: ReturnReceivedPayload;
  warranty_expiring: WarrantyExpiringPayload;
  low_stock: LowStockPayload;
}

/** A discriminated union: the wrong payload for a template is a compile error. */
export type NotificationRequest = {
  [K in TemplateName]: { template: K; payload: TemplatePayloads[K] };
}[TemplateName];

// ---------------------------------------------------------------------------
// Deterministic formatting primitives
// ---------------------------------------------------------------------------

/**
 * ISO-4217 minor-unit exponents for the currencies this platform can plausibly
 * quote. The GCC three-decimal currencies are the reason this table exists at
 * all: `/ 100` would misprice a Kuwaiti dinar by a factor of ten.
 */
const CURRENCY_EXPONENT: Readonly<Record<string, number>> = {
  AED: 2, SAR: 2, QAR: 2, EGP: 2, USD: 2, EUR: 2, GBP: 2, INR: 2, PKR: 2,
  KWD: 3, BHD: 3, OMR: 3, JOD: 3, TND: 3,
  JPY: 0, KRW: 0,
};

export const currencyExponent = (currency: string): number =>
  CURRENCY_EXPONENT[currency.toUpperCase()] ?? 2;

const groupThousands = (digits: string): string =>
  digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * Minor units → "AED 1,234.50", by integer arithmetic only.
 *
 * The ISO code rather than a symbol, in both locales: "د.إ" is ambiguous
 * between the UAE and Sudanese dirham, and an invoice amount is not the place
 * to be ambiguous. Western digits in Arabic too — that is what UAE tax
 * invoices and bank statements use.
 */
export const formatMoneyMinor = (minor: MinorUnits, currency: string): string => {
  const value = BigInt(typeof minor === "number" ? Math.trunc(minor) : minor);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  const exponent = currencyExponent(currency);
  const padded = digits.padStart(exponent + 1, "0");
  const whole = groupThousands(padded.slice(0, padded.length - exponent));
  const fraction = exponent === 0 ? "" : `.${padded.slice(padded.length - exponent)}`;
  return `${negative ? "-" : ""}${currency.toUpperCase()} ${whole}${fraction}`;
};

/** NUMERIC(14,3) → "2", "1.5". Trailing zeros are noise in a customer email. */
export const formatQuantity = (quantity: Quantity): string => {
  const raw = typeof quantity === "number" ? String(quantity) : quantity.trim();
  if (!raw.includes(".")) return raw;
  const trimmed = raw.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
};

/** Basis points → "5", "7.5". Integer arithmetic; 500bp is 5%, not 5.000000001%. */
export const formatVatRate = (basisPoints: number): string => {
  const bp = Math.trunc(basisPoints);
  const negative = bp < 0;
  const abs = Math.abs(bp).toString().padStart(3, "0");
  const whole = abs.slice(0, abs.length - 2);
  const fraction = abs.slice(abs.length - 2).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
};

/**
 * ISO-8601 in, ISO date out. Deliberately NOT Intl.DateTimeFormat: its output
 * shifts with the host's ICU version, which would make a stored body
 * irreproducible — the exact failure mode R13.5 exists to prevent.
 */
export const formatDate = (iso: string): string => {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? iso : new Date(parsed).toISOString().slice(0, 10);
};

// --- bidi controls (see file header) ---------------------------------------
const RLM = "‏";
const LRI = "⁦";
const PDI = "⁩";

/** Isolate an LTR run so it cannot reorder the Arabic text around it. */
const isolate = (value: string): string => `${LRI}${value}${PDI}`;

/**
 * Per-locale formatting. The `ar` variant isolates every value it produces, so
 * template bodies never have to think about bidi — they just interpolate.
 */
interface Formatter {
  money(minor: MinorUnits, currency: string): string;
  qty(quantity: Quantity): string;
  date(iso: string): string;
  pct(basisPoints: number): string;
  /** Isolate an opaque LTR token supplied by a caller (order/tracking/SKU). */
  token(value: string): string;
  num(value: number): string;
}

const FORMATTERS: Record<Locale, Formatter> = {
  en: {
    money: formatMoneyMinor,
    qty: formatQuantity,
    date: formatDate,
    pct: formatVatRate,
    token: (v) => v,
    num: (v) => String(v),
  },
  ar: {
    money: (m, c) => isolate(formatMoneyMinor(m, c)),
    qty: (q) => isolate(formatQuantity(q)),
    date: (iso) => isolate(formatDate(iso)),
    pct: (bp) => isolate(formatVatRate(bp)),
    token: isolate,
    num: (v) => isolate(String(v)),
  },
};

const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Assemble a plain-text body. Arabic lines are prefixed with RLM so each
 * paragraph resolves RTL regardless of what character it happens to start with.
 */
const textBody = (locale: Locale, lines: string[]): string =>
  lines
    .map((line) => (locale === "ar" && line.length > 0 ? `${RLM}${line}` : line))
    .join("\n");

/** HTML blocks are pre-escaped by their builders; this only wraps them. */
const htmlBody = (locale: Locale, blocks: string[]): string => {
  const dir = locale === "ar" ? "rtl" : "ltr";
  const align = locale === "ar" ? "right" : "left";
  return [
    `<div dir="${dir}" lang="${locale}" style="font-family:system-ui,-apple-system,'Segoe UI',Tahoma,sans-serif;`
      + `font-size:15px;line-height:1.6;color:#111;text-align:${align};max-width:640px;margin:0 auto">`,
    ...blocks,
    "</div>",
  ].join("\n");
};

const p = (content: string): string => `<p>${content}</p>`;
const h1 = (content: string): string =>
  `<h1 style="font-size:20px;margin:0 0 16px">${content}</h1>`;

/** A two/three-column table, already escaped by the caller. */
const table = (locale: Locale, headers: string[], rows: string[][]): string => {
  const align = locale === "ar" ? "right" : "left";
  const cells = (values: string[], tag: "th" | "td"): string =>
    values
      .map(
        (v, i) =>
          `<${tag} style="text-align:${i === 0 ? align : locale === "ar" ? "left" : "right"};`
          + `padding:6px 10px;border-bottom:1px solid #e5e5e5">${v}</${tag}>`,
      )
      .join("");
  return [
    `<table style="width:100%;border-collapse:collapse;margin:12px 0" dir="${locale === "ar" ? "rtl" : "ltr"}">`,
    `<thead><tr>${cells(headers, "th")}</tr></thead>`,
    `<tbody>${rows.map((r) => `<tr>${cells(r, "td")}</tr>`).join("")}</tbody>`,
    "</table>",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// R13.3 — the six templates
// ---------------------------------------------------------------------------

const renderOrderConfirmation = (
  locale: Locale,
  d: OrderConfirmationPayload,
): RenderedMessage => {
  const f = FORMATTERS[locale];
  const orderNo = f.token(d.orderNo);
  const taxLabel =
    d.vatRateBp === undefined
      ? locale === "ar" ? "ضريبة القيمة المضافة" : "VAT"
      : locale === "ar"
        ? `ضريبة القيمة المضافة (${f.pct(d.vatRateBp)}%)`
        : `VAT (${f.pct(d.vatRateBp)}%)`;
  const lineRows = d.lines.map((l) => [
    l.description,
    f.qty(l.quantity),
    f.money(l.totalMinor, d.currency),
  ]);
  const closing =
    d.paymentMethod === "cod"
      ? locale === "ar"
        ? `يرجى تجهيز مبلغ ${f.money(d.totalMinor, d.currency)} نقداً عند الاستلام.`
        : `Please have ${f.money(d.totalMinor, d.currency)} ready in cash on delivery.`
      : locale === "ar"
        ? "سنعلمك فور شحن طلبك."
        : "We will let you know as soon as your order ships.";

  if (locale === "ar") {
    const lines = [
      `مرحباً ${d.customerName}،`,
      "",
      `شكراً لتسوقك من ${d.tenantName}. لقد استلمنا طلبك رقم ${orderNo} وجارٍ تجهيزه.`,
      "",
      "تفاصيل الطلب:",
      ...d.lines.map(
        (l) => `• ${l.description} — الكمية ${f.qty(l.quantity)} — ${f.money(l.totalMinor, d.currency)}`,
      ),
      "",
      `المجموع الفرعي: ${f.money(d.subtotalMinor, d.currency)}`,
      `${taxLabel}: ${f.money(d.taxMinor, d.currency)}`,
      `الإجمالي: ${f.money(d.totalMinor, d.currency)}`,
      "",
      closing,
      "",
      d.tenantName,
    ];
    return {
      subject: `تأكيد الطلب ${orderNo} — ${d.tenantName}`,
      bodyText: textBody(locale, lines),
      bodyHtml: htmlBody(locale, [
        h1(esc(`تأكيد الطلب ${orderNo}`)),
        p(esc(`مرحباً ${d.customerName}،`)),
        p(esc(`شكراً لتسوقك من ${d.tenantName}. لقد استلمنا طلبك رقم ${orderNo} وجارٍ تجهيزه.`)),
        table(locale, ["المنتج", "الكمية", "المبلغ"].map(esc), lineRows.map((r) => r.map(esc))),
        p(
          [
            esc(`المجموع الفرعي: ${f.money(d.subtotalMinor, d.currency)}`),
            esc(`${taxLabel}: ${f.money(d.taxMinor, d.currency)}`),
            `<strong>${esc(`الإجمالي: ${f.money(d.totalMinor, d.currency)}`)}</strong>`,
          ].join("<br>"),
        ),
        p(esc(closing)),
        p(esc(d.tenantName)),
      ]),
    };
  }

  const lines = [
    `Hello ${d.customerName},`,
    "",
    `Thank you for shopping with ${d.tenantName}. We have received order ${orderNo} and are preparing it.`,
    "",
    "Order details:",
    ...d.lines.map(
      (l) => `• ${l.description} — qty ${f.qty(l.quantity)} — ${f.money(l.totalMinor, d.currency)}`,
    ),
    "",
    `Subtotal: ${f.money(d.subtotalMinor, d.currency)}`,
    `${taxLabel}: ${f.money(d.taxMinor, d.currency)}`,
    `Total: ${f.money(d.totalMinor, d.currency)}`,
    "",
    closing,
    "",
    d.tenantName,
  ];
  return {
    subject: `Order ${orderNo} confirmed — ${d.tenantName}`,
    bodyText: textBody(locale, lines),
    bodyHtml: htmlBody(locale, [
      h1(esc(`Order ${orderNo} confirmed`)),
      p(esc(`Hello ${d.customerName},`)),
      p(esc(`Thank you for shopping with ${d.tenantName}. We have received order ${orderNo} and are preparing it.`)),
      table(locale, ["Item", "Qty", "Amount"], lineRows.map((r) => r.map(esc))),
      p(
        [
          esc(`Subtotal: ${f.money(d.subtotalMinor, d.currency)}`),
          esc(`${taxLabel}: ${f.money(d.taxMinor, d.currency)}`),
          `<strong>${esc(`Total: ${f.money(d.totalMinor, d.currency)}`)}</strong>`,
        ].join("<br>"),
      ),
      p(esc(closing)),
      p(esc(d.tenantName)),
    ]),
  };
};

const renderDispatchTracking = (
  locale: Locale,
  d: DispatchTrackingPayload,
): RenderedMessage => {
  const f = FORMATTERS[locale];
  const orderNo = f.token(d.orderNo);
  // R5.3: the tracking number is the payload of this message, so it is in the
  // subject as well as the body — a customer scanning an inbox should not have
  // to open the mail to find it.
  const trackingNo = f.token(d.trackingNo);
  const eta = d.expectedDeliveryIso ? f.date(d.expectedDeliveryIso) : undefined;

  if (locale === "ar") {
    const lines = [
      `مرحباً ${d.customerName}،`,
      "",
      `تم شحن طلبك رقم ${orderNo} وسلّمناه إلى شركة الشحن ${d.courier}.`,
      "",
      `رقم التتبع: ${trackingNo}`,
      ...(d.trackingUrl ? [`رابط التتبع: ${f.token(d.trackingUrl)}`] : []),
      ...(eta ? [`موعد التسليم المتوقع: ${eta}`] : []),
      "",
      "يمكنك متابعة الشحنة باستخدام رقم التتبع أعلاه.",
      "",
      d.tenantName,
    ];
    return {
      subject: `تم شحن طلبك ${orderNo} — رقم التتبع ${trackingNo}`,
      bodyText: textBody(locale, lines),
      bodyHtml: htmlBody(locale, [
        h1(esc(`تم شحن طلبك ${orderNo}`)),
        p(esc(`مرحباً ${d.customerName}،`)),
        p(esc(`تم شحن طلبك رقم ${orderNo} وسلّمناه إلى شركة الشحن ${d.courier}.`)),
        p(
          [
            `<strong>${esc(`رقم التتبع: ${trackingNo}`)}</strong>`,
            ...(eta ? [esc(`موعد التسليم المتوقع: ${eta}`)] : []),
          ].join("<br>"),
        ),
        ...(d.trackingUrl
          ? [p(`<a href="${esc(d.trackingUrl)}">${esc("تتبع الشحنة")}</a>`)]
          : []),
        p(esc(d.tenantName)),
      ]),
    };
  }

  const lines = [
    `Hello ${d.customerName},`,
    "",
    `Your order ${orderNo} has been dispatched with ${d.courier}.`,
    "",
    `Tracking number: ${trackingNo}`,
    ...(d.trackingUrl ? [`Track it here: ${d.trackingUrl}`] : []),
    ...(eta ? [`Expected delivery: ${eta}`] : []),
    "",
    "You can follow the parcel with the tracking number above.",
    "",
    d.tenantName,
  ];
  return {
    subject: `Order ${orderNo} dispatched — tracking ${trackingNo}`,
    bodyText: textBody(locale, lines),
    bodyHtml: htmlBody(locale, [
      h1(esc(`Order ${orderNo} dispatched`)),
      p(esc(`Hello ${d.customerName},`)),
      p(esc(`Your order ${orderNo} has been dispatched with ${d.courier}.`)),
      p(
        [
          `<strong>${esc(`Tracking number: ${trackingNo}`)}</strong>`,
          ...(eta ? [esc(`Expected delivery: ${eta}`)] : []),
        ].join("<br>"),
      ),
      ...(d.trackingUrl ? [p(`<a href="${esc(d.trackingUrl)}">${esc("Track your parcel")}</a>`)] : []),
      p(esc(d.tenantName)),
    ]),
  };
};

const renderCodReminder = (locale: Locale, d: CodReminderPayload): RenderedMessage => {
  const f = FORMATTERS[locale];
  const orderNo = f.token(d.orderNo);
  const amount = f.money(d.amountDueMinor, d.currency);
  const eta = d.expectedDeliveryIso ? f.date(d.expectedDeliveryIso) : undefined;

  if (locale === "ar") {
    const lines = [
      `مرحباً ${d.customerName}،`,
      "",
      `طلبك رقم ${orderNo} في طريقه إليك، وسيتم الدفع عند الاستلام.`,
      "",
      `المبلغ المطلوب: ${amount}`,
      ...(eta ? [`موعد التسليم المتوقع: ${eta}`] : []),
      "",
      "يرجى تجهيز المبلغ نقداً لتسليمه لمندوب التوصيل.",
      "",
      d.tenantName,
    ];
    return {
      subject: `تذكير: الدفع عند الاستلام للطلب ${orderNo} — ${amount}`,
      bodyText: textBody(locale, lines),
      bodyHtml: htmlBody(locale, [
        h1(esc(`الدفع عند الاستلام — الطلب ${orderNo}`)),
        p(esc(`مرحباً ${d.customerName}،`)),
        p(esc(`طلبك رقم ${orderNo} في طريقه إليك، وسيتم الدفع عند الاستلام.`)),
        p(
          [
            `<strong>${esc(`المبلغ المطلوب: ${amount}`)}</strong>`,
            ...(eta ? [esc(`موعد التسليم المتوقع: ${eta}`)] : []),
          ].join("<br>"),
        ),
        p(esc("يرجى تجهيز المبلغ نقداً لتسليمه لمندوب التوصيل.")),
        p(esc(d.tenantName)),
      ]),
    };
  }

  const lines = [
    `Hello ${d.customerName},`,
    "",
    `Your order ${orderNo} is on its way and will be paid for on delivery.`,
    "",
    `Amount due: ${amount}`,
    ...(eta ? [`Expected delivery: ${eta}`] : []),
    "",
    "Please have the exact amount ready in cash for the courier.",
    "",
    d.tenantName,
  ];
  return {
    subject: `Reminder: ${amount} due on delivery for order ${orderNo}`,
    bodyText: textBody(locale, lines),
    bodyHtml: htmlBody(locale, [
      h1(esc(`Cash on delivery — order ${orderNo}`)),
      p(esc(`Hello ${d.customerName},`)),
      p(esc(`Your order ${orderNo} is on its way and will be paid for on delivery.`)),
      p(
        [
          `<strong>${esc(`Amount due: ${amount}`)}</strong>`,
          ...(eta ? [esc(`Expected delivery: ${eta}`)] : []),
        ].join("<br>"),
      ),
      p(esc("Please have the exact amount ready in cash for the courier.")),
      p(esc(d.tenantName)),
    ]),
  };
};

const renderReturnReceived = (locale: Locale, d: ReturnReceivedPayload): RenderedMessage => {
  const f = FORMATTERS[locale];
  const orderNo = f.token(d.orderNo);
  const refund = d.refundMinor === undefined ? undefined : f.money(d.refundMinor, d.currency);
  const itemRows = d.items.map((i) => [i.description, f.qty(i.quantity)]);

  if (locale === "ar") {
    const outcome = refund
      ? `سنقوم برد مبلغ ${refund}` +
        (d.refundEtaDays === undefined
          ? "."
          : ` خلال ${f.num(d.refundEtaDays)} أيام عمل.`)
      : "سنفحص المنتجات ونبلغك بنتيجة طلب الاسترجاع قريباً.";
    const lines = [
      `مرحباً ${d.customerName}،`,
      "",
      `استلمنا المنتجات المرتجعة من طلبك رقم ${orderNo}.`,
      "",
      "المنتجات المستلمة:",
      ...d.items.map((i) => `• ${i.description} — الكمية ${f.qty(i.quantity)}`),
      "",
      outcome,
      "",
      d.tenantName,
    ];
    return {
      subject: `تم استلام مرتجع الطلب ${orderNo}`,
      bodyText: textBody(locale, lines),
      bodyHtml: htmlBody(locale, [
        h1(esc(`تم استلام المرتجع — الطلب ${orderNo}`)),
        p(esc(`مرحباً ${d.customerName}،`)),
        p(esc(`استلمنا المنتجات المرتجعة من طلبك رقم ${orderNo}.`)),
        table(locale, ["المنتج", "الكمية"].map(esc), itemRows.map((r) => r.map(esc))),
        p(esc(outcome)),
        p(esc(d.tenantName)),
      ]),
    };
  }

  const outcome = refund
    ? `We will refund ${refund}` +
      (d.refundEtaDays === undefined ? "." : ` within ${d.refundEtaDays} working days.`)
    : "We will inspect the items and let you know the outcome of your return shortly.";
  const lines = [
    `Hello ${d.customerName},`,
    "",
    `We have received the returned items from your order ${orderNo}.`,
    "",
    "Items received:",
    ...d.items.map((i) => `• ${i.description} — qty ${f.qty(i.quantity)}`),
    "",
    outcome,
    "",
    d.tenantName,
  ];
  return {
    subject: `Return received for order ${orderNo}`,
    bodyText: textBody(locale, lines),
    bodyHtml: htmlBody(locale, [
      h1(esc(`Return received — order ${orderNo}`)),
      p(esc(`Hello ${d.customerName},`)),
      p(esc(`We have received the returned items from your order ${orderNo}.`)),
      table(locale, ["Item", "Qty"], itemRows.map((r) => r.map(esc))),
      p(esc(outcome)),
      p(esc(d.tenantName)),
    ]),
  };
};

const renderWarrantyExpiring = (
  locale: Locale,
  d: WarrantyExpiringPayload,
): RenderedMessage => {
  const f = FORMATTERS[locale];
  const expiresOn = f.date(d.expiresOnIso);
  const days = f.num(d.daysRemaining);
  const serialLine = d.serialNo
    ? locale === "ar"
      ? `الرقم التسلسلي: ${f.token(d.serialNo)}`
      : `Serial number: ${d.serialNo}`
    : undefined;

  if (locale === "ar") {
    const lines = [
      `مرحباً ${d.customerName}،`,
      "",
      `ينتهي ضمان ${d.productName} بتاريخ ${expiresOn}، أي بعد ${days} يوماً.`,
      ...(serialLine ? ["", serialLine] : []),
      "",
      "إذا كان لديك أي عطل مشمول بالضمان، يرجى التواصل معنا قبل انتهاء المدة.",
      "",
      d.tenantName,
    ];
    return {
      subject: `ضمان ${d.productName} ينتهي بتاريخ ${expiresOn}`,
      bodyText: textBody(locale, lines),
      bodyHtml: htmlBody(locale, [
        h1(esc("تنبيه بقرب انتهاء الضمان")),
        p(esc(`مرحباً ${d.customerName}،`)),
        p(esc(`ينتهي ضمان ${d.productName} بتاريخ ${expiresOn}، أي بعد ${days} يوماً.`)),
        ...(serialLine ? [p(esc(serialLine))] : []),
        p(esc("إذا كان لديك أي عطل مشمول بالضمان، يرجى التواصل معنا قبل انتهاء المدة.")),
        p(esc(d.tenantName)),
      ]),
    };
  }

  const lines = [
    `Hello ${d.customerName},`,
    "",
    `The warranty on your ${d.productName} expires on ${expiresOn}, in ${days} days.`,
    ...(serialLine ? ["", serialLine] : []),
    "",
    "If you have a fault covered by the warranty, please contact us before it lapses.",
    "",
    d.tenantName,
  ];
  return {
    subject: `Warranty on your ${d.productName} expires ${expiresOn}`,
    bodyText: textBody(locale, lines),
    bodyHtml: htmlBody(locale, [
      h1(esc("Warranty expiring soon")),
      p(esc(`Hello ${d.customerName},`)),
      p(esc(`The warranty on your ${d.productName} expires on ${expiresOn}, in ${days} days.`)),
      ...(serialLine ? [p(esc(serialLine))] : []),
      p(esc("If you have a fault covered by the warranty, please contact us before it lapses.")),
      p(esc(d.tenantName)),
    ]),
  };
};

const renderLowStock = (locale: Locale, d: LowStockPayload): RenderedMessage => {
  const f = FORMATTERS[locale];
  const rows = d.items.map((i) => [
    `${i.name} (${f.token(i.sku)})`,
    f.qty(i.onHand),
    f.qty(i.reorderPoint),
  ]);
  const count = f.num(d.items.length);

  if (locale === "ar") {
    const lines = [
      `تنبيه مخزون منخفض — ${d.locationName}`,
      "",
      `${count} صنفاً وصل إلى نقطة إعادة الطلب أو أقل:`,
      ...d.items.map(
        (i) =>
          `• ${i.name} (${f.token(i.sku)}) — المتوفر ${f.qty(i.onHand)} — نقطة إعادة الطلب ${f.qty(i.reorderPoint)}`,
      ),
      "",
      "يرجى إنشاء أمر شراء لتفادي نفاد المخزون.",
      "",
      d.tenantName,
    ];
    return {
      subject: `مخزون منخفض: ${count} صنفاً في ${d.locationName}`,
      bodyText: textBody(locale, lines),
      bodyHtml: htmlBody(locale, [
        h1(esc(`تنبيه مخزون منخفض — ${d.locationName}`)),
        p(esc(`${count} صنفاً وصل إلى نقطة إعادة الطلب أو أقل:`)),
        table(locale, ["الصنف", "المتوفر", "نقطة إعادة الطلب"].map(esc), rows.map((r) => r.map(esc))),
        p(esc("يرجى إنشاء أمر شراء لتفادي نفاد المخزون.")),
      ]),
    };
  }

  const lines = [
    `Low stock alert — ${d.locationName}`,
    "",
    `${count} item(s) are at or below their reorder point:`,
    ...d.items.map(
      (i) =>
        `• ${i.name} (${i.sku}) — on hand ${f.qty(i.onHand)} — reorder point ${f.qty(i.reorderPoint)}`,
    ),
    "",
    "Please raise a purchase order to avoid a stock-out.",
    "",
    d.tenantName,
  ];
  return {
    subject: `Low stock: ${count} item(s) at ${d.locationName}`,
    bodyText: textBody(locale, lines),
    bodyHtml: htmlBody(locale, [
      h1(esc(`Low stock alert — ${d.locationName}`)),
      p(esc(`${count} item(s) are at or below their reorder point:`)),
      table(locale, ["Item", "On hand", "Reorder point"], rows.map((r) => r.map(esc))),
      p(esc("Please raise a purchase order to avoid a stock-out.")),
    ]),
  };
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Render a notification. Pure: same (request, locale) always yields the same
 * bytes, which is what makes the stored body reproducible evidence (R13.5).
 */
export const render = (request: NotificationRequest, locale: Locale): RenderedMessage => {
  switch (request.template) {
    case "order_confirmation":
      return renderOrderConfirmation(locale, request.payload);
    case "dispatch_tracking":
      return renderDispatchTracking(locale, request.payload);
    case "cod_reminder":
      return renderCodReminder(locale, request.payload);
    case "return_received":
      return renderReturnReceived(locale, request.payload);
    case "warranty_expiring":
      return renderWarrantyExpiring(locale, request.payload);
    case "low_stock":
      return renderLowStock(locale, request.payload);
    default: {
      // Exhaustiveness: adding a template to the union without a renderer is a
      // compile error here, not a blank email in production.
      const unreachable: never = request;
      throw new Error(`no renderer for template ${JSON.stringify(unreachable)}`);
    }
  }
};

/** low_stock is the one template addressed to staff (recipient_kind='staff'). */
export const recipientKindFor = (template: TemplateName): "customer" | "staff" =>
  template === "low_stock" ? "staff" : "customer";

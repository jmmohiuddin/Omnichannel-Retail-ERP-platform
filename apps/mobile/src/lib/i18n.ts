/**
 * Hand-rolled mobile i18n (no runtime dependency, no React Native imports —
 * this module stays node-testable like the rest of src/lib). `en` is the
 * source of truth: its keys define `MessageKey`, and the Arabic dictionary is
 * typed `Record<MessageKey, string>` so a missing or extra key fails `tsc`.
 *
 * RTL: React Native has no `document`, so there is nothing to flip globally
 * from here. Screens call `isRtl(lang)` and flip inline `flexDirection`
 * (row ↔ row-reverse) themselves. Full native RTL (mirrored navigation,
 * safe-area, text alignment everywhere) requires `I18nManager.forceRTL(true)`
 * plus an app reload — that is the documented native step, deliberately not
 * wired here.
 *
 * Numbers/currency: AED amounts keep the `en-AE` formatter (see money.ts)
 * even in the Arabic UI — Western numerals are the UAE retail convention.
 */

export type Lang = "en" | "ar";

/** Right-to-left script? Screens use this for inline layout flips. */
export function isRtl(lang: Lang): boolean {
  return lang === "ar";
}

export const en = {
  // ---- Login ----
  "login.subtitle": "Owner / manager companion",
  "login.apiPlaceholder": "API server (http://192.168.x.x:3001)",
  "login.slugPlaceholder": "Store slug",
  "login.emailPlaceholder": "Email",
  "login.passwordPlaceholder": "Password",
  "login.signIn": "Sign in",
  "login.signingIn": "Signing in…",
  "login.networkError":
    "Cannot reach the API — check the server address (use your machine's LAN IP).",
  "login.failed": "Sign-in failed",

  // ---- Dashboard ----
  "dashboard.title": "Today",
  "dashboard.todaySales": "Today's sales",
  "dashboard.last7Days": "Last 7 days",
  "dashboard.stockValue": "Stock value (cost)",
  "dashboard.topSeller": "Top seller (30d)",
  "dashboard.order": "{count} order",
  "dashboard.orders": "{count} orders",
  "dashboard.vat": "VAT {amount}",
  "dashboard.unitsOnHand": "{units} units on hand",
  "dashboard.unitsSold": "{units} units · {revenue}",
  "dashboard.dailyDigest": "Daily digest",
  "dashboard.loadFailed": "Failed to load dashboard",
  "dashboard.signOut": "Sign out",

  // ---- Navigation ----
  "nav.approvals": "Approvals",
  "nav.stockLookup": "Stock lookup",
  "nav.orders": "Orders",

  // ---- Approvals ----
  "approvals.title": "Approvals",
  "approvals.empty": "Nothing waiting for approval.",
  "approvals.approve": "Approve",
  "approvals.reject": "Reject",
  "approvals.reason": "Reason: {reason}",
  "approvals.loadFailed": "Failed to load approvals",
  "approvals.decisionFailed": "Decision failed",

  // ---- Stock lookup ----
  "stock.title": "Stock lookup",
  "stock.searchPlaceholder": "Search products or SKU",
  "stock.backToResults": "Back to results",
  "stock.searchHint": "Search to see stock.",
  "stock.noData": "No data",
  "stock.availabilityLine":
    "Available {available} · On hand {onHand} · Reserved {reserved} · In transit {inTransit}",
  "stock.searchFailed": "Search failed",
  "stock.availabilityFailed": "Availability lookup failed",

  // ---- Orders ----
  "orders.title": "Orders",
  "orders.empty": "No orders.",
  "orders.loadFailed": "Failed to load orders",
  "orders.walkIn": "walk-in",
  "orders.filter.all": "all",
  "orders.filter.pending": "pending",
  "orders.filter.confirmed": "confirmed",
  "orders.filter.fulfilled": "fulfilled",
  "orders.filter.cancelled": "cancelled",
  "orders.filter.refunded": "refunded",
} as const;

export type MessageKey = keyof typeof en;

/** Natural ar-AE staff-app Arabic. Same keys as `en`, enforced by type. */
export const ar: Record<MessageKey, string> = {
  "login.subtitle": "تطبيق مرافق للمالك والمدير",
  "login.apiPlaceholder": "خادم API (http://192.168.x.x:3001)",
  "login.slugPlaceholder": "معرّف المتجر",
  "login.emailPlaceholder": "البريد الإلكتروني",
  "login.passwordPlaceholder": "كلمة المرور",
  "login.signIn": "تسجيل الدخول",
  "login.signingIn": "جارٍ تسجيل الدخول…",
  "login.networkError": "تعذر الوصول إلى الخادم — تحقق من عنوان الخادم (استخدم عنوان IP المحلي لجهازك).",
  "login.failed": "فشل تسجيل الدخول",

  "dashboard.title": "اليوم",
  "dashboard.todaySales": "مبيعات اليوم",
  "dashboard.last7Days": "آخر ٧ أيام",
  "dashboard.stockValue": "قيمة المخزون (بالتكلفة)",
  "dashboard.topSeller": "الأكثر مبيعاً (٣٠ يوماً)",
  "dashboard.order": "{count} طلب",
  "dashboard.orders": "{count} طلبات",
  "dashboard.vat": "الضريبة {amount}",
  "dashboard.unitsOnHand": "{units} وحدة في المخزون",
  "dashboard.unitsSold": "{units} وحدة · {revenue}",
  "dashboard.dailyDigest": "الملخص اليومي",
  "dashboard.loadFailed": "فشل تحميل لوحة المعلومات",
  "dashboard.signOut": "تسجيل الخروج",

  "nav.approvals": "الموافقات",
  "nav.stockLookup": "الاستعلام عن المخزون",
  "nav.orders": "الطلبات",

  "approvals.title": "الموافقات",
  "approvals.empty": "لا توجد طلبات بانتظار الموافقة.",
  "approvals.approve": "موافقة",
  "approvals.reject": "رفض",
  "approvals.reason": "السبب: {reason}",
  "approvals.loadFailed": "فشل تحميل الموافقات",
  "approvals.decisionFailed": "فشل تنفيذ القرار",

  "stock.title": "الاستعلام عن المخزون",
  "stock.searchPlaceholder": "ابحث عن المنتجات أو رمز الصنف",
  "stock.backToResults": "العودة إلى النتائج",
  "stock.searchHint": "ابحث لعرض المخزون.",
  "stock.noData": "لا توجد بيانات",
  "stock.availabilityLine":
    "المتاح {available} · الموجود {onHand} · المحجوز {reserved} · قيد النقل {inTransit}",
  "stock.searchFailed": "فشل البحث",
  "stock.availabilityFailed": "فشل الاستعلام عن التوفر",

  "orders.title": "الطلبات",
  "orders.empty": "لا توجد طلبات.",
  "orders.loadFailed": "فشل تحميل الطلبات",
  "orders.walkIn": "زبون مباشر",
  "orders.filter.all": "الكل",
  "orders.filter.pending": "قيد الانتظار",
  "orders.filter.confirmed": "مؤكد",
  "orders.filter.fulfilled": "منفّذ",
  "orders.filter.cancelled": "ملغى",
  "orders.filter.refunded": "مسترد",
};

const dictionaries: Record<Lang, Record<MessageKey, string>> = { en, ar };

/** Interpolation parameters; `{name}` tokens in the template are replaced. */
export type MessageParams = Record<string, string | number>;

/**
 * Translate `key` into `lang`, interpolating `{token}` placeholders from
 * `params`. Unknown placeholders are left as-is (a visible copy bug beats a
 * crashed screen).
 */
export function t(lang: Lang, key: MessageKey, params?: MessageParams): string {
  const template = dictionaries[lang][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

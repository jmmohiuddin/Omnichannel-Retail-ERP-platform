/**
 * Hand-rolled EN/AR i18n for the POS (docs/08-uae-localization.md §3).
 *
 * `en` is the source of truth: its keys define `MessageKey`, and `ar` is
 * typed `Record<MessageKey, string>` so a missing or extra Arabic key is a
 * compile error (parity is also asserted at runtime in i18n.test.ts).
 *
 * Placeholders use `{name}` and are replaced by `t()`; unknown placeholders
 * are left verbatim so a template typo is visible, never a crash.
 *
 * NOTE ON NUMBERS: money and quantities are rendered with Western (Latin)
 * numerals in BOTH languages — UAE retail convention (receipts, price tags
 * and card terminals all use Western digits). See lib/money.ts (en-AE
 * formatter) — translations must not introduce Eastern Arabic digit
 * conversion for amounts, barcodes or IMEIs.
 */

export type Lang = "en" | "ar";

export const en = {
  // Shared
  "common.retry": "Retry",
  "common.signOut": "Sign out",
  "common.processing": "Processing…",

  // Language toggle
  "lang.switchToArabic": "Switch to Arabic",
  "lang.switchToEnglish": "Switch to English",

  // Setup / bootstrap (App.tsx)
  "setup.starting": "Starting…",
  "setup.registeringDevice": "Registering this register…",
  "setup.loadingLocations": "Loading locations…",
  "setup.failed": "Setup failed",

  // Login
  "login.subtitle": "Sign in to this register",
  "login.storeSlug": "Store slug",
  "login.email": "Email",
  "login.password": "Password",
  "login.signIn": "Sign in",
  "login.signingIn": "Signing in…",
  "login.invalidCredentials": "Invalid store, email or password.",
  "login.failedHttp": "Login failed (HTTP {status}).",
  "login.network": "Cannot reach the server. Check the connection and try again.",
  "login.failedUnexpected": "Login failed unexpectedly.",

  // Location picker
  "location.title": "Choose location",
  "location.subtitle": "Sales from this register will post to the selected location.",
  "location.none": "No locations found for this tenant — create one in the back office first.",

  // Top bar
  "topbar.pendingSync": "{count} pending sync",
  "topbar.pendingSyncTitle": "Sales saved offline, waiting to sync",

  // Scan input
  "scan.placeholder": "Scan barcode or type SKU, then Enter",
  "scan.barcodeAria": "Barcode",
  "scan.noMatch": "No product matches “{code}”.",
  "scan.unitState": "Unit is {state} — it cannot be sold.",
  "scan.unitAlreadyInCart": "Unit already in cart.",
  "scan.lookupFailed": "Unit lookup failed — check the connection and rescan.",

  // Serialized-unit states (non-sellable notice detail)
  "unitState.inbound": "inbound",
  "unitState.reserved": "reserved",
  "unitState.sold": "sold",
  "unitState.returned_pending": "pending return",
  "unitState.in_transit": "in transit",
  "unitState.in_repair": "in repair",
  "unitState.damaged": "damaged",
  "unitState.written_off": "written off",

  // Product search
  "search.sectionAria": "Product search",
  "search.placeholder": "Search products by name…",
  "search.resultsAria": "Search results",
  "search.searching": "Searching…",
  "search.noProducts": "No products found.",

  // Cart
  "cart.sectionAria": "Cart",
  "cart.empty": "Cart is empty — scan an item to start.",
  "cart.each": "{price} each",
  "cart.imei": "IMEI {imei}",
  "cart.qtySerializedAria": "Quantity of {name} (serialized)",
  "cart.decreaseAria": "Decrease quantity of {name}",
  "cart.increaseAria": "Increase quantity of {name}",
  "cart.removeAria": "Remove {name}",

  // Totals
  "totals.subtotal": "Subtotal (excl. VAT)",
  "totals.vat": "VAT 5% (included)",
  "totals.total": "Total",
  "totals.loyaltyPoints": "Loyalty points",
  "totals.remainingDue": "Remaining due",

  // Tender
  "tender.cash": "CASH",
  "tender.card": "CARD",
  "tender.loyalty": "LOYALTY",
  "tender.loyaltyAppliedDue": "LOYALTY APPLIED — {amount} due by cash/card",
  "tender.loyaltyAppliedFull": "LOYALTY APPLIED — fully covered",

  // Sale errors
  "sale.rejected": "Sale rejected by the server (HTTP {status}). Nothing was charged.",
  "sale.insufficientPoints": "Not enough loyalty points — the balance has been refreshed.",
  "sale.network": "Network error — the sale was not submitted.",
  "sale.failedUnexpected": "Sale failed unexpectedly.",

  // Customer panel
  "customer.sectionAria": "Customer",
  "customer.searchPlaceholder": "Customer phone or name…",
  "customer.searchAria": "Customer search",
  "customer.resultsAria": "Customer results",
  "customer.noneFound": "No customer found.",
  "customer.pts": "{points} pts",
  "customer.points": "Points: {points}",
  "customer.pointsWorth": "Points: {points} (worth {value})",
  "customer.detachAria": "Detach {name}",
  "customer.phonePlaceholder": "Phone (optional)",
  "customer.newPhoneAria": "New customer phone",
  "customer.create": "New customer “{name}”",
  "customer.creating": "Creating…",
  "customer.createFailed": "Could not create the customer.",

  // Receipt modal
  "receipt.aria": "Receipt",
  "receipt.taxInvoice": "Tax Invoice",
  "receipt.trn": "TRN: {trn}",
  "receipt.orderNo": "Order {orderNo}",
  "receipt.offlineSaved": "Saved offline — will sync when back online",
  "receipt.item": "Item",
  "receipt.paidBy": "Paid by",
  "receipt.newSale": "New sale",
  "method.cash": "Cash",
  "method.card": "Card",
  "method.loyalty_points": "Loyalty points",
} as const;

export type MessageKey = keyof typeof en;

/** Natural retail Arabic (Gulf usage), not transliteration. */
export const ar: Record<MessageKey, string> = {
  "common.retry": "إعادة المحاولة",
  "common.signOut": "تسجيل الخروج",
  "common.processing": "جارٍ المعالجة…",

  "lang.switchToArabic": "التبديل إلى العربية",
  "lang.switchToEnglish": "التبديل إلى الإنجليزية",

  "setup.starting": "جارٍ البدء…",
  "setup.registeringDevice": "جارٍ تسجيل جهاز الكاشير…",
  "setup.loadingLocations": "جارٍ تحميل الفروع…",
  "setup.failed": "فشل الإعداد",

  "login.subtitle": "سجّل الدخول إلى هذا الكاشير",
  "login.storeSlug": "معرّف المتجر",
  "login.email": "البريد الإلكتروني",
  "login.password": "كلمة المرور",
  "login.signIn": "تسجيل الدخول",
  "login.signingIn": "جارٍ تسجيل الدخول…",
  "login.invalidCredentials": "المتجر أو البريد الإلكتروني أو كلمة المرور غير صحيحة.",
  "login.failedHttp": "فشل تسجيل الدخول (HTTP {status}).",
  "login.network": "تعذّر الوصول إلى الخادم. تحقّق من الاتصال وحاول مرة أخرى.",
  "login.failedUnexpected": "فشل تسجيل الدخول بشكل غير متوقع.",

  "location.title": "اختر الفرع",
  "location.subtitle": "ستُسجَّل مبيعات هذا الكاشير على الفرع المحدد.",
  "location.none": "لا توجد فروع لهذا المتجر — أنشئ فرعاً من لوحة الإدارة أولاً.",

  "topbar.pendingSync": "{count} بانتظار المزامنة",
  "topbar.pendingSyncTitle": "مبيعات محفوظة دون اتصال، بانتظار المزامنة",

  "scan.placeholder": "امسح الباركود أو اكتب رمز الصنف (SKU) ثم اضغط Enter",
  "scan.barcodeAria": "الباركود",
  "scan.noMatch": "لا يوجد منتج مطابق لـ «{code}».",
  "scan.unitState": "القطعة {state} — لا يمكن بيعها.",
  "scan.unitAlreadyInCart": "هذه القطعة موجودة في السلة بالفعل.",
  "scan.lookupFailed": "تعذّر البحث عن القطعة — تحقّق من الاتصال وأعد المسح.",

  "unitState.inbound": "قيد الاستلام",
  "unitState.reserved": "محجوزة",
  "unitState.sold": "مُباعة",
  "unitState.returned_pending": "بانتظار معالجة الإرجاع",
  "unitState.in_transit": "قيد النقل",
  "unitState.in_repair": "قيد الصيانة",
  "unitState.damaged": "تالفة",
  "unitState.written_off": "مشطوبة",

  "search.sectionAria": "بحث المنتجات",
  "search.placeholder": "ابحث عن المنتجات بالاسم…",
  "search.resultsAria": "نتائج البحث",
  "search.searching": "جارٍ البحث…",
  "search.noProducts": "لا توجد منتجات.",

  "cart.sectionAria": "السلة",
  "cart.empty": "السلة فارغة — امسح صنفاً للبدء.",
  "cart.each": "{price} للقطعة",
  "cart.imei": "IMEI {imei}",
  "cart.qtySerializedAria": "كمية {name} (قطعة مُسلسلة)",
  "cart.decreaseAria": "إنقاص كمية {name}",
  "cart.increaseAria": "زيادة كمية {name}",
  "cart.removeAria": "إزالة {name}",

  "totals.subtotal": "المجموع الفرعي (غير شامل الضريبة)",
  "totals.vat": "ضريبة القيمة المضافة ٥٪ (شاملة)",
  "totals.total": "الإجمالي",
  "totals.loyaltyPoints": "نقاط الولاء",
  "totals.remainingDue": "المتبقي للدفع",

  "tender.cash": "نقداً",
  "tender.card": "بطاقة",
  "tender.loyalty": "نقاط الولاء",
  "tender.loyaltyAppliedDue": "نقاط الولاء مطبّقة — المتبقي {amount} نقداً أو بالبطاقة",
  "tender.loyaltyAppliedFull": "نقاط الولاء مطبّقة — المبلغ مغطى بالكامل",

  "sale.rejected": "رفض الخادم عملية البيع (HTTP {status}). لم يُخصم أي مبلغ.",
  "sale.insufficientPoints": "نقاط الولاء غير كافية — تم تحديث الرصيد.",
  "sale.network": "خطأ في الشبكة — لم تُرسل عملية البيع.",
  "sale.failedUnexpected": "فشلت عملية البيع بشكل غير متوقع.",

  "customer.sectionAria": "العميل",
  "customer.searchPlaceholder": "هاتف العميل أو اسمه…",
  "customer.searchAria": "بحث العملاء",
  "customer.resultsAria": "نتائج العملاء",
  "customer.noneFound": "لم يُعثر على عميل.",
  "customer.pts": "{points} نقطة",
  "customer.points": "النقاط: {points}",
  "customer.pointsWorth": "النقاط: {points} (بقيمة {value})",
  "customer.detachAria": "إلغاء ربط {name}",
  "customer.phonePlaceholder": "الهاتف (اختياري)",
  "customer.newPhoneAria": "هاتف العميل الجديد",
  "customer.create": "عميل جديد «{name}»",
  "customer.creating": "جارٍ الإنشاء…",
  "customer.createFailed": "تعذّر إنشاء العميل.",

  "receipt.aria": "الإيصال",
  "receipt.taxInvoice": "فاتورة ضريبية",
  "receipt.trn": "الرقم الضريبي: {trn}",
  "receipt.orderNo": "رقم الطلب {orderNo}",
  "receipt.offlineSaved": "حُفظت دون اتصال — ستتم المزامنة عند عودة الاتصال",
  "receipt.item": "صنف",
  "receipt.paidBy": "طريقة الدفع",
  "receipt.newSale": "عملية بيع جديدة",
  "method.cash": "نقداً",
  "method.card": "بطاقة",
  "method.loyalty_points": "نقاط الولاء",
};

export const dictionaries: Record<Lang, Record<MessageKey, string>> = { en, ar };

export type MessageParams = Record<string, string | number>;

/**
 * Translate `key` into `lang`, replacing `{param}` placeholders. Numbers are
 * stringified as-is (Western digits — see file header). Placeholders without
 * a matching param are left verbatim.
 */
export function t(lang: Lang, key: MessageKey, params?: MessageParams): string {
  const template = dictionaries[lang][key] ?? en[key];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * Localized label for a serialized-unit state (used in the "Unit is {state}"
 * scan notice). Unknown states (a newer server) fall back to the raw state
 * with underscores humanized, so the notice still reads.
 */
export function unitStateLabel(lang: Lang, state: string): string {
  const key = `unitState.${state}`;
  if (Object.prototype.hasOwnProperty.call(en, key)) return t(lang, key as MessageKey);
  return state.replace(/_/g, " ");
}

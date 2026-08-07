/**
 * Hand-rolled storefront i18n (no runtime dependency). `en` is the source of
 * truth: its keys define `MessageKey`, and the Arabic dictionary is typed as
 * `Record<MessageKey, string>` so a missing or extra key fails `tsc`.
 *
 * Interpolation uses `{name}` placeholders replaced by `t(lang, key, params)`.
 *
 * Note on numbers/currency: AED amounts intentionally keep the existing
 * `en-AE` formatter (see money.ts) even in the Arabic UI, so prices render
 * with Western numerals — the prevailing convention in UAE retail. Literal
 * numerals inside Arabic copy (e.g. ٥٪ VAT) are part of the translation.
 */

export type Lang = "en" | "ar";

export const en = {
  // ---- Store layout / header / footer ----
  "layout.shop": "Shop",
  "layout.cart": "Cart",
  "layout.cartBadge": "{count} items in cart",
  "layout.langToggle": "Switch language",
  "layout.loading": "Loading store…",
  "layout.storeNotAvailable": "Store not available",
  "layout.storeNotFound": "We couldn't find a store called “{slug}”.",
  "layout.storeUnavailable": "The store is temporarily unavailable. Please try again shortly.",
  "layout.footer": "All prices include 5% VAT. Powered by OmniRetail OS.",
  "layout.landingTitle": "OmniRetail OS storefront",
  "layout.landingBody": "Open a store by its address, e.g.",

  // ---- Catalog ----
  "catalog.searchLabel": "Search products",
  "catalog.searchPlaceholder": "Search products…",
  "catalog.empty": "This store hasn't published any products yet. Check back soon.",
  "catalog.noMatches": "No products match “{query}”.",
  "catalog.from": "From",
  "catalog.inStock": "In stock",
  "catalog.outOfStock": "Out of stock",

  // ---- Product page ----
  "product.breadcrumbLabel": "Breadcrumb",
  "product.notFoundTitle": "Product not found",
  "product.notFoundBody": "This product may no longer be available.",
  "product.backToShop": "Back to the shop",
  "product.notOrderable": "This product is not currently orderable.",
  "product.chooseOption": "Choose an option",
  "product.sku": "SKU {sku}",
  "product.vatNote": "Price includes 5% VAT.",
  "product.qty": "Qty",
  "product.addToCart": "Add to cart",
  "product.added": "Added to cart.",
  "product.viewCart": "View cart",

  // ---- Cart ----
  "cart.title": "Your cart",
  "cart.emptyTitle": "Your cart is empty",
  "cart.emptyCta": "Browse the shop to add something.",
  "cart.qtyOf": "Quantity of {name}",
  "cart.decrease": "Decrease quantity of {name}",
  "cart.increase": "Increase quantity of {name}",
  "cart.remove": "Remove",
  "cart.subtotal": "Subtotal",
  "cart.vatNote":
    "Includes 5% VAT of approximately {amount}. The exact VAT breakdown appears on your tax invoice.",
  "cart.continueShopping": "Continue shopping",
  "cart.checkout": "Proceed to checkout",

  // ---- Checkout ----
  "checkout.title": "Checkout",
  "checkout.emptyTitle": "Nothing to check out",
  "checkout.emptyBody": "Your cart is empty.",
  "checkout.details": "Your details",
  "checkout.name": "Full name *",
  "checkout.email": "Email",
  "checkout.phone": "Phone",
  "checkout.error.nameRequired": "Your name is required.",
  "checkout.error.contactRequired":
    "Provide an email address or a phone number so we can reach you.",
  "checkout.error.email": "That email address doesn't look right.",
  "checkout.error.phone": "That phone number doesn't look right.",
  "checkout.placeOrder": "Place order",
  "checkout.placingOrder": "Placing order…",
  "checkout.noPaymentNote":
    "No payment is taken now — you'll receive payment instructions after placing the order.",
  "checkout.summary": "Order summary",
  "checkout.total": "Total",
  "checkout.vatNote": "Includes 5% VAT of approximately {amount}.",
  "checkout.error.shortages":
    "Some items in your cart are no longer available in the quantity requested:",
  "checkout.error.stockChanged":
    "Stock changed while you were checking out. Please review your cart and try again.",
  "checkout.error.someOutOfStock":
    "Some items are out of stock. Please review your cart and try again.",
  "checkout.error.storeGone": "This store is no longer available.",
  "checkout.error.orderFailed": "We couldn't place your order. Please try again in a moment.",
  "checkout.shortageOnlyLeft": "{name} (SKU {sku}) — requested {requested}, only {available} left",
  "checkout.shortageOutOfStock": "{name} (SKU {sku}) — requested {requested}, out of stock",
  "checkout.adjustCart": "Adjust your cart and try again.",

  // ---- Confirmation ----
  "confirm.title": "Thank you — order received",
  "confirm.orderNumber": "Order number",
  "confirm.subtotalExVat": "Subtotal (excl. VAT)",
  "confirm.vat": "VAT (5%)",
  "confirm.total": "Total",
  "confirm.pendingTitle": "Payment pending.",
  "confirm.pendingBody":
    "Your order is reserved. Pay now to confirm it — you'll be taken to a secure payment page.",
  "confirm.payNow": "Pay now",
  "confirm.startingPayment": "Starting payment…",
  "confirm.payStarted": "Payment started — follow the instructions sent to you.",
  "confirm.payAlreadyStarted": "Payment for this order has already been started.",
  "confirm.payBadState": "This order can no longer be paid online — it may already be paid.",
  "confirm.payFailed": "Could not start payment. Please try again.",
  "confirm.signInPrompt": "Sign in to track future orders and view your devices.",

  // ---- Customer account ----
  "account.signIn": "Sign in",
  "account.signOut": "Sign out",
  "account.myOrders": "My orders",
  "account.myDevices": "My devices",
  "account.emailLabel": "Email",
  "account.emailPlaceholder": "you@example.com",
  "account.sendLink": "Send sign-in code",
  "account.sendingLink": "Sending…",
  "account.linkSent":
    "We've sent a sign-in code to {email}. Enter it below to continue.",
  "account.enterCode": "Sign-in code",
  "account.codePlaceholder": "Paste your code",
  "account.verify": "Verify and sign in",
  "account.verifying": "Signing in…",
  "account.useDifferentEmail": "Use a different email",
  "account.error.emailRequired": "Enter your email address.",
  "account.error.emailInvalid": "That email address doesn't look right.",
  "account.error.tokenRequired": "Enter the code from your email.",
  "account.error.invalidCode": "That code isn't valid. Try again or request a new one.",
  "account.error.expiredCode": "That code has expired. Please request a new one.",
  "account.error.consumedCode": "That code was already used. Please request a new one.",
  "account.error.storeGone": "This store is no longer available.",
  "account.error.requestFailed": "Couldn't send a sign-in code. Please try again in a moment.",
  "account.error.verifyFailed": "Couldn't sign you in. Please try again in a moment.",
  "account.error.sessionExpired": "Your session has expired — please sign in again.",
  "account.signedInAs": "Signed in as {name}",
  "account.devTokenNotice":
    "Dev mode: no email provider is configured, so the sign-in code is shown below. In production it would be emailed and never displayed.",
  "account.devTokenLabel": "Dev sign-in code",
  "account.copyCode": "Copy code",

  // ---- My Orders / My Devices ----
  "orders.title": "My orders",
  "orders.empty": "You haven't placed any orders yet.",
  "orders.orderNo": "Order",
  "orders.placedAt": "Placed",
  "orders.status": "Status",
  "orders.total": "Total",
  "devices.title": "My devices",
  "devices.empty": "Serialized devices you buy from this store will appear here.",
  "devices.imei": "IMEI",
  "devices.serial": "Serial",
  "devices.warrantyUntil": "Warranty until",
  "devices.noWarranty": "No warranty on file",
  "devices.fromOrder": "From order {orderNo}",
} as const;

export type MessageKey = keyof typeof en;

/** Natural commerce Arabic (ar-AE register). Same keys as `en`, enforced by type. */
export const ar: Record<MessageKey, string> = {
  "layout.shop": "تسوق",
  "layout.cart": "السلة",
  "layout.cartBadge": "{count} منتجات في السلة",
  "layout.langToggle": "تغيير اللغة",
  "layout.loading": "جارٍ تحميل المتجر…",
  "layout.storeNotAvailable": "المتجر غير متاح",
  "layout.storeNotFound": "لم نعثر على متجر باسم «{slug}».",
  "layout.storeUnavailable": "المتجر غير متاح مؤقتاً. يرجى المحاولة مرة أخرى بعد قليل.",
  "layout.footer": "جميع الأسعار شاملة ضريبة القيمة المضافة ٥٪. مدعوم من OmniRetail OS.",
  "layout.landingTitle": "متجر OmniRetail OS",
  "layout.landingBody": "افتح متجراً عبر عنوانه، مثل",

  "catalog.searchLabel": "بحث عن المنتجات",
  "catalog.searchPlaceholder": "بحث…",
  "catalog.empty": "لم ينشر هذا المتجر أي منتجات بعد. عُد قريباً.",
  "catalog.noMatches": "لا توجد منتجات مطابقة لـ «{query}».",
  "catalog.from": "ابتداءً من",
  "catalog.inStock": "متوفر",
  "catalog.outOfStock": "غير متوفر",

  "product.breadcrumbLabel": "مسار التنقل",
  "product.notFoundTitle": "المنتج غير موجود",
  "product.notFoundBody": "قد لا يكون هذا المنتج متاحاً بعد الآن.",
  "product.backToShop": "العودة إلى المتجر",
  "product.notOrderable": "هذا المنتج غير قابل للطلب حالياً.",
  "product.chooseOption": "اختر خياراً",
  "product.sku": "رمز الصنف {sku}",
  "product.vatNote": "السعر شامل ضريبة القيمة المضافة ٥٪.",
  "product.qty": "الكمية",
  "product.addToCart": "أضف إلى السلة",
  "product.added": "تمت الإضافة إلى السلة.",
  "product.viewCart": "عرض السلة",

  "cart.title": "سلتك",
  "cart.emptyTitle": "سلتك فارغة",
  "cart.emptyCta": "تصفح المتجر لإضافة المنتجات.",
  "cart.qtyOf": "كمية {name}",
  "cart.decrease": "إنقاص كمية {name}",
  "cart.increase": "زيادة كمية {name}",
  "cart.remove": "إزالة",
  "cart.subtotal": "المجموع الفرعي",
  "cart.vatNote":
    "شامل ضريبة القيمة المضافة ٥٪ بقيمة {amount} تقريباً. يظهر التفصيل الدقيق للضريبة في فاتورتك الضريبية.",
  "cart.continueShopping": "مواصلة التسوق",
  "cart.checkout": "إتمام الشراء",

  "checkout.title": "إتمام الطلب",
  "checkout.emptyTitle": "لا يوجد شيء لإتمام شرائه",
  "checkout.emptyBody": "سلتك فارغة.",
  "checkout.details": "بياناتك",
  "checkout.name": "الاسم الكامل *",
  "checkout.email": "البريد الإلكتروني",
  "checkout.phone": "رقم الهاتف",
  "checkout.error.nameRequired": "الاسم مطلوب.",
  "checkout.error.contactRequired":
    "يرجى إدخال بريد إلكتروني أو رقم هاتف حتى نتمكن من التواصل معك.",
  "checkout.error.email": "البريد الإلكتروني غير صحيح.",
  "checkout.error.phone": "رقم الهاتف غير صحيح.",
  "checkout.placeOrder": "تأكيد الطلب",
  "checkout.placingOrder": "جارٍ تأكيد الطلب…",
  "checkout.noPaymentNote": "لن يتم أخذ أي دفعة الآن — ستصلك تعليمات الدفع بعد تأكيد الطلب.",
  "checkout.summary": "ملخص الطلب",
  "checkout.total": "الإجمالي",
  "checkout.vatNote": "شامل ضريبة القيمة المضافة ٥٪ بقيمة {amount} تقريباً.",
  "checkout.error.shortages": "بعض المنتجات في سلتك لم تعد متوفرة بالكمية المطلوبة:",
  "checkout.error.stockChanged":
    "تغيّر المخزون أثناء إتمام الشراء. يرجى مراجعة سلتك والمحاولة مرة أخرى.",
  "checkout.error.someOutOfStock": "بعض المنتجات غير متوفرة. يرجى مراجعة سلتك والمحاولة مرة أخرى.",
  "checkout.error.storeGone": "هذا المتجر لم يعد متاحاً.",
  "checkout.error.orderFailed": "تعذر تأكيد طلبك. يرجى المحاولة مرة أخرى بعد قليل.",
  "checkout.shortageOnlyLeft": "{name} (رمز الصنف {sku}) — المطلوب {requested}، المتبقي {available} فقط",
  "checkout.shortageOutOfStock": "{name} (رمز الصنف {sku}) — المطلوب {requested}، غير متوفر",
  "checkout.adjustCart": "عدّل سلتك وحاول مرة أخرى.",

  "confirm.title": "شكراً لك — تم استلام طلبك",
  "confirm.orderNumber": "رقم الطلب",
  "confirm.subtotalExVat": "المجموع الفرعي (غير شامل الضريبة)",
  "confirm.vat": "ضريبة القيمة المضافة (٥٪)",
  "confirm.total": "الإجمالي",
  "confirm.pendingTitle": "الدفع قيد الانتظار.",
  "confirm.pendingBody": "طلبك محجوز. ادفع الآن لتأكيده — سيتم نقلك إلى صفحة دفع آمنة.",
  "confirm.payNow": "ادفع الآن",
  "confirm.startingPayment": "جارٍ بدء الدفع…",
  "confirm.payStarted": "تم بدء الدفع — اتبع التعليمات المرسلة إليك.",
  "confirm.payAlreadyStarted": "تم بدء الدفع لهذا الطلب من قبل.",
  "confirm.payBadState": "لم يعد بالإمكان دفع هذا الطلب عبر الإنترنت — قد يكون مدفوعاً بالفعل.",
  "confirm.payFailed": "تعذر بدء الدفع. يرجى المحاولة مرة أخرى.",
  "confirm.signInPrompt": "سجّل الدخول لتتبّع طلباتك المستقبلية وعرض أجهزتك.",

  "account.signIn": "تسجيل الدخول",
  "account.signOut": "تسجيل الخروج",
  "account.myOrders": "طلباتي",
  "account.myDevices": "أجهزتي",
  "account.emailLabel": "البريد الإلكتروني",
  "account.emailPlaceholder": "you@example.com",
  "account.sendLink": "أرسل رمز الدخول",
  "account.sendingLink": "جارٍ الإرسال…",
  "account.linkSent": "أرسلنا رمز الدخول إلى {email}. أدخله أدناه للمتابعة.",
  "account.enterCode": "رمز الدخول",
  "account.codePlaceholder": "ألصق الرمز هنا",
  "account.verify": "تحقق وسجّل الدخول",
  "account.verifying": "جارٍ تسجيل الدخول…",
  "account.useDifferentEmail": "استخدم بريداً إلكترونياً آخر",
  "account.error.emailRequired": "أدخل بريدك الإلكتروني.",
  "account.error.emailInvalid": "البريد الإلكتروني غير صحيح.",
  "account.error.tokenRequired": "أدخل الرمز الذي وصلك.",
  "account.error.invalidCode": "الرمز غير صحيح. حاول مرة أخرى أو اطلب رمزاً جديداً.",
  "account.error.expiredCode": "انتهت صلاحية الرمز. يرجى طلب رمز جديد.",
  "account.error.consumedCode": "تم استخدام هذا الرمز من قبل. يرجى طلب رمز جديد.",
  "account.error.storeGone": "هذا المتجر لم يعد متاحاً.",
  "account.error.requestFailed": "تعذّر إرسال رمز الدخول. يرجى المحاولة مرة أخرى بعد قليل.",
  "account.error.verifyFailed": "تعذّر تسجيل دخولك. يرجى المحاولة مرة أخرى بعد قليل.",
  "account.error.sessionExpired": "انتهت جلستك — يرجى تسجيل الدخول من جديد.",
  "account.signedInAs": "تم تسجيل الدخول باسم {name}",
  "account.devTokenNotice":
    "وضع التطوير: لا يوجد مزوّد بريد إلكتروني مُعدّ، لذا يُعرض رمز الدخول أدناه. في الإنتاج يُرسل عبر البريد ولا يظهر أبداً.",
  "account.devTokenLabel": "رمز الدخول للتطوير",
  "account.copyCode": "نسخ الرمز",

  "orders.title": "طلباتي",
  "orders.empty": "لم تقم بأي طلبات بعد.",
  "orders.orderNo": "رقم الطلب",
  "orders.placedAt": "تاريخ الطلب",
  "orders.status": "الحالة",
  "orders.total": "الإجمالي",
  "devices.title": "أجهزتي",
  "devices.empty": "ستظهر هنا الأجهزة ذات الأرقام التسلسلية التي تشتريها من هذا المتجر.",
  "devices.imei": "IMEI",
  "devices.serial": "الرقم التسلسلي",
  "devices.warrantyUntil": "الضمان حتى",
  "devices.noWarranty": "لا يوجد ضمان مسجل",
  "devices.fromOrder": "من الطلب {orderNo}",
};

const dictionaries: Record<Lang, Record<MessageKey, string>> = { en, ar };

/** Interpolation parameters; `{name}` tokens in the template are replaced. */
export type MessageParams = Record<string, string | number>;

/**
 * Translate `key` into `lang`, interpolating `{token}` placeholders from
 * `params`. Unknown placeholders are left as-is (they signal a copy bug
 * rather than crashing the storefront).
 */
export function t(lang: Lang, key: MessageKey, params?: MessageParams): string {
  const template = dictionaries[lang][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

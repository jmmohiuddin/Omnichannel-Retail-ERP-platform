/**
 * Hand-rolled EN/AR dictionary for the admin portal (docs/08-uae-localization.md §3).
 * Pure module: no I/O, no framework imports. `en` is the canonical key set;
 * `ar` is checked for full parity by i18n.test.ts.
 *
 * Conventions:
 * - Flat dot-namespaced keys ("nav.orders", "finance.trialBalance").
 * - `{name}`-style interpolation via t(lang, key, params).
 * - Enum-ish server values (order status, stock state, movement type, …) live
 *   under value prefixes ("status.pending") and are resolved by enumLabel(),
 *   which falls back to a humanized form for unknown values.
 * - Money keeps Western (Latin) digits in both languages — see money.ts.
 */

export type Lang = "en" | "ar";

export const en = {
  // ---- shell / navigation ----
  "nav.primary": "Primary",
  "nav.dashboard": "Dashboard",
  "nav.catalog": "Catalog",
  "nav.inventory": "Inventory",
  "nav.orders": "Orders",
  "nav.approvals": "Approvals",
  "nav.finance": "Finance",
  "nav.digest": "Digest",
  "nav.audit": "Audit",
  "nav.signOut": "Sign out",
  "nav.tenantTitle": "Tenant {id}",
  "nav.language": "Language",

  // ---- shared ----
  "common.loading": "Loading…",
  "common.close": "Close",
  "common.search": "Search",
  "common.apply": "Apply",
  "common.refresh": "Refresh",
  "common.actions": "Actions",
  "common.loadMore": "Load more",
  "common.timesInDubai": "Times shown in Asia/Dubai",

  // ---- table headers ----
  "th.seq": "Seq",
  "th.time": "Time",
  "th.timeDubai": "Time (Dubai)",
  "th.type": "Type",
  "th.sku": "SKU",
  "th.qty": "Qty",
  "th.flow": "From → To",
  "th.product": "Product",
  "th.state": "State",
  "th.quantity": "Quantity",
  "th.actor": "Actor",
  "th.reference": "Reference",
  "th.note": "Note",
  "th.barcode": "Barcode",
  "th.price": "Price",
  "th.order": "Order",
  "th.status": "Status",
  "th.channel": "Channel",
  "th.customer": "Customer",
  "th.total": "Total",
  "th.placedDubai": "Placed (Dubai)",
  "th.kind": "Kind",
  "th.summary": "Summary",
  "th.reason": "Reason",
  "th.requestedBy": "Requested by",
  "th.age": "Age",
  "th.code": "Code",
  "th.account": "Account",
  "th.debit": "Debit",
  "th.credit": "Credit",
  "th.balance": "Balance",
  "th.item": "Item",
  "th.unit": "Unit",
  "th.vat": "VAT",

  // ---- auth: login ----
  "login.subtitle": "Sign in to your admin portal",
  "login.slug": "Tenant slug",
  "login.email": "Email",
  "login.password": "Password",
  "login.submit": "Sign in",
  "login.submitting": "Signing in…",
  "login.failed": "Sign-in failed",
  "login.newBusiness": "New business?",
  "login.createTenant": "Create a tenant",

  // ---- auth: register ----
  "register.subtitle": "Set up a new tenant",
  "register.businessName": "Business name",
  "register.slugPattern": "Lowercase letters, digits and hyphens (2–40 chars)",
  "register.slugHint": "Used to sign in: lowercase letters, digits, hyphens.",
  "register.fullName": "Your full name",
  "register.passwordHint": "At least 10 characters.",
  "register.submit": "Create tenant",
  "register.submitting": "Creating tenant…",
  "register.failed": "Registration failed",
  "register.already": "Already registered?",

  // ---- dashboard ----
  "dashboard.loading": "Loading dashboard…",
  "dashboard.loadFailed": "Failed to load dashboard: {error}",
  "dashboard.locations": "Locations",
  "dashboard.products": "Products",
  "dashboard.unitsOnHand": "Units on hand",
  "dashboard.movements24h": "Movements (24h)",
  "dashboard.manageInventory": "Manage inventory",
  "dashboard.openCatalog": "Open catalog",
  "dashboard.acrossLocations": "Across all locations",
  "dashboard.fullAudit": "Full audit trail",
  "dashboard.recentMovements": "Recent movements",
  "dashboard.noMovements": "No stock movements yet.",

  // ---- catalog ----
  "catalog.countProducts": "{count} products",
  "catalog.newProduct": "New product",
  "catalog.name": "Name",
  "catalog.slug": "Slug",
  "catalog.tracking": "Tracking",
  "catalog.create": "Create product",
  "catalog.creating": "Creating…",
  "catalog.createFailed": "Create failed",
  "catalog.searchLabel": "Search products",
  "catalog.searchPlaceholder": "Name or slug…",
  "catalog.loadFailed": "Failed to load products: {error}",
  "catalog.loading": "Loading catalog…",
  "catalog.noProducts": "No products yet.",
  "catalog.noProductsMatching": "No products matching “{query}”.",
  "catalog.variantOne": "1 variant",
  "catalog.variantMany": "{count} variants",
  "catalog.priceAed": "Price (AED)",
  "catalog.barcodeOptional": "Barcode (optional)",
  "catalog.addVariant": "Add variant",
  "catalog.adding": "Adding…",
  "catalog.priceInvalid": "Price must be a positive AED amount with up to 2 decimals, e.g. 1299.00",
  "catalog.translations.title": "Arabic content",
  "catalog.translations.arName": "Arabic name",
  "catalog.translations.arDescription": "Arabic description",
  "catalog.translations.save": "Save Arabic content",
  "catalog.translations.saving": "Saving…",
  "catalog.translations.saved": "Arabic content saved.",
  "catalog.translations.failed": "Failed to save Arabic content",
  "catalog.translations.hint": "Leave blank to keep the English fallback.",

  // ---- inventory ----
  "inventory.location": "Location",
  "inventory.loadingLocations": "Loading locations…",
  "inventory.locationsFailed": "Failed to load locations: {error}",
  "inventory.noLocations": "No locations yet — create a store or warehouse first.",
  "inventory.levelsFailed": "Failed to load stock levels: {error}",
  "inventory.loadingLevels": "Loading stock levels…",
  "inventory.noStock": "No stock at this location.",
  "inventory.skuOne": "1 SKU",
  "inventory.skuMany": "{count} SKUs",
  "inventory.detail": "Detail",

  // ---- variant detail ----
  "variant.loading": "Loading variant…",
  "variant.loadFailed": "Failed to load variant: {error}",
  "variant.breadcrumb": "Variant",
  "variant.barcode": "barcode",
  "variant.availabilityAt": "Availability at",
  "variant.availability": "Availability",
  "variant.noAvailability": "No availability data at this location.",
  "variant.movementHistory": "Movement history",
  "variant.noMovements": "No movements recorded for this variant.",

  // ---- orders ----
  "orders.countSummary": "{count} orders · times in Asia/Dubai",
  "orders.filterLabel": "Order status filter",
  "orders.all": "All",
  "orders.loadFailed": "Failed to load orders: {error}",
  "orders.loading": "Loading orders…",
  "orders.none": "No orders.",
  "orders.noneFiltered": "No {status} orders.",
  "orders.walkIn": "Walk-in",
  "orders.fulfill": "Fulfill",
  "orders.cancel": "Cancel",
  "orders.receipt": "Receipt",
  "orders.cancelPrompt": "Reason for cancelling {orderNo}?",
  "orders.cancelReasonRequired": "A cancellation reason is required.",
  "orders.cancelFailed": "Cancel failed",
  "orders.fulfillFailed": "Fulfilment failed",
  "orders.unitRequired":
    "Serialized units must be scanned at the warehouse before this order can be fulfilled.",

  // ---- receipt (tax invoice) ----
  "receipt.title": "Tax invoice",
  "receipt.loading": "Loading receipt…",
  "receipt.loadFailed": "Failed to load receipt: {error}",
  "receipt.trn": "TRN",
  "receipt.issued": "Issued",
  "receipt.subtotal": "Subtotal",
  "receipt.vat5": "VAT (5%)",
  "receipt.total": "Total",
  "receipt.payments": "Payments",
  "receipt.rawJson": "Raw receipt JSON",

  // ---- approvals ----
  "approvals.countPending": "{count} pending · times in Asia/Dubai",
  "approvals.loadFailed": "Failed to load approvals: {error}",
  "approvals.loading": "Loading approvals…",
  "approvals.empty": "Nothing waiting for approval.",
  "approvals.approve": "Approve",
  "approvals.reject": "Reject",
  "approvals.decisionFailed": "Decision failed",
  "approvals.refundOn": "Refund {amount} on order {order}",
  "approvals.refund": "Refund {amount}",
  "approvals.stockCount": "Stock count",
  "approvals.stockCountVarianceOne": "Stock count · 1 variance",
  "approvals.stockCountVariances": "Stock count · {count} variances",
  "age.justNow": "just now",
  "age.minutes": "{count}m ago",
  "age.hours": "{count}h ago",
  "age.days": "{count}d ago",

  // ---- finance ----
  "finance.allAmountsAed": "All amounts in AED",
  "finance.trialBalance": "Trial balance",
  "finance.balanced": "Balanced ✓",
  "finance.outOfBalance": "Out of balance by {amount}",
  "finance.tbFailed": "Failed to load trial balance: {error}",
  "finance.tbLoading": "Loading trial balance…",
  "finance.noAccounts": "No ledger accounts yet.",
  "finance.totals": "Totals",
  "finance.pnl": "Profit & loss",
  "finance.from": "From",
  "finance.to": "To",
  "finance.pnlLoading": "Loading P&L…",
  "finance.invalidRange": "Pick a valid date range (from must not be after to).",
  "finance.grossRevenue": "Gross revenue",
  "finance.refunds": "Refunds",
  "finance.netRevenue": "Net revenue",
  "finance.costOfSales": "Cost of sales",
  "finance.vatCollected": "VAT collected",

  // ---- daily digest ----
  "digest.title": "Daily digest",
  "digest.byClaude": "Generated by Claude",
  "digest.stub": "Statistical stub (no API key)",
  "digest.preparing": "Preparing today’s digest…",
  "digest.rawData": "Raw data behind this digest",
  "digest.budgetExceeded":
    "Today's AI budget has been used up, so the digest can't be generated right now. It will be back tomorrow — the underlying numbers are still on the Dashboard and Finance pages.",
  "digest.forbidden":
    "The daily digest is available to manager and owner roles only. Ask an owner to upgrade your role if you need access.",
  "digest.loadFailed": "Failed to load the daily digest.",

  // ---- audit trail ----
  "audit.title": "Audit trail",
  "audit.summary": "Append-only stock ledger · {count} entries loaded · times in Asia/Dubai",
  "audit.refFailed": "Failed to load reference data: {error}",
  "audit.ledgerFailed": "Failed to load ledger",
  "audit.empty": "The ledger is empty.",
  "audit.endOfLedger": "End of ledger.",

  // ---- movement presentation ----
  "movement.external": "External",

  // ---- enum values: stock states ----
  "state.on_hand": "On hand",
  "state.reserved": "Reserved",
  "state.in_transit": "In transit",
  "state.damaged": "Damaged",
  "state.returned_pending": "Returned pending",
  "state.available": "Available",

  // ---- enum values: movement types ----
  "mtype.receipt": "Receipt",
  "mtype.sale": "Sale",
  "mtype.return_in": "Return in",
  "mtype.transfer_in": "Transfer in",
  "mtype.transfer_out": "Transfer out",
  "mtype.repair_in": "Repair in",
  "mtype.repair_out": "Repair out",
  "mtype.write_off": "Write off",
  "mtype.reservation": "Reservation",
  "mtype.release": "Release",
  "mtype.adjustment": "Adjustment",
  "mtype.count_correction": "Count correction",

  // ---- enum values: order status ----
  "status.pending": "Pending",
  "status.confirmed": "Confirmed",
  "status.fulfilled": "Fulfilled",
  "status.cancelled": "Cancelled",
  "status.refunded": "Refunded",

  // ---- enum values: sales channels ----
  "channel.pos": "POS",
  "channel.online": "Online",
  "channel.marketplace": "Marketplace",

  // ---- enum values: approval kinds ----
  "kind.refund": "Refund",
  "kind.stock_count": "Stock count",

  // ---- enum values: product tracking ----
  "tracking.none": "None",
  "tracking.batch": "Batch",
  "tracking.serialized": "Serialized (IMEI)",

  // ---- enum values: location kinds ----
  "lockind.store": "Store",
  "lockind.warehouse": "Warehouse",
  "lockind.virtual": "Virtual",

  // ---- enum values: ledger account kinds ----
  "acct.asset": "Asset",
  "acct.liability": "Liability",
  "acct.equity": "Equity",
  "acct.revenue": "Revenue",
  "acct.income": "Income",
  "acct.expense": "Expense",

  // ---- enum values: payment methods ----
  "pay.cash": "Cash",
  "pay.card": "Card",

  // ---- enum values: product status ----
  "pstatus.active": "Active",
  "pstatus.archived": "Archived",
  "pstatus.draft": "Draft",
} as const;

export type MessageKey = keyof typeof en;

/**
 * Modern Standard Arabic with Gulf retail usage (UAE market). Translated
 * meaningfully — not transliterated. Numerals inside interpolated params stay
 * Western (see money.ts note); Arabic templates therefore keep the `{param}`
 * slots verbatim.
 */
export const ar: Record<MessageKey, string> = {
  // ---- shell / navigation ----
  "nav.primary": "التنقل الرئيسي",
  "nav.dashboard": "لوحة التحكم",
  "nav.catalog": "الكتالوج",
  "nav.inventory": "المخزون",
  "nav.orders": "الطلبات",
  "nav.approvals": "الموافقات",
  "nav.finance": "المالية",
  "nav.digest": "الموجز",
  "nav.audit": "التدقيق",
  "nav.signOut": "تسجيل الخروج",
  "nav.tenantTitle": "المنشأة {id}",
  "nav.language": "اللغة",

  // ---- shared ----
  "common.loading": "جارٍ التحميل…",
  "common.close": "إغلاق",
  "common.search": "بحث",
  "common.apply": "تطبيق",
  "common.refresh": "تحديث",
  "common.actions": "إجراءات",
  "common.loadMore": "تحميل المزيد",
  "common.timesInDubai": "التوقيت بحسب آسيا/دبي",

  // ---- table headers ----
  "th.seq": "التسلسل",
  "th.time": "الوقت",
  "th.timeDubai": "الوقت (دبي)",
  "th.type": "النوع",
  "th.sku": "رمز الصنف",
  "th.qty": "الكمية",
  "th.flow": "من ← إلى",
  "th.product": "المنتج",
  "th.state": "الحالة",
  "th.quantity": "الكمية",
  "th.actor": "المنفّذ",
  "th.reference": "المرجع",
  "th.note": "ملاحظة",
  "th.barcode": "الباركود",
  "th.price": "السعر",
  "th.order": "الطلب",
  "th.status": "الحالة",
  "th.channel": "القناة",
  "th.customer": "العميل",
  "th.total": "الإجمالي",
  "th.placedDubai": "تاريخ الطلب (دبي)",
  "th.kind": "النوع",
  "th.summary": "الملخص",
  "th.reason": "السبب",
  "th.requestedBy": "مقدم الطلب",
  "th.age": "منذ",
  "th.code": "الرمز",
  "th.account": "الحساب",
  "th.debit": "مدين",
  "th.credit": "دائن",
  "th.balance": "الرصيد",
  "th.item": "الصنف",
  "th.unit": "سعر الوحدة",
  "th.vat": "ضريبة القيمة المضافة",

  // ---- auth: login ----
  "login.subtitle": "سجّل الدخول إلى بوابة الإدارة",
  "login.slug": "معرّف المنشأة",
  "login.email": "البريد الإلكتروني",
  "login.password": "كلمة المرور",
  "login.submit": "تسجيل الدخول",
  "login.submitting": "جارٍ تسجيل الدخول…",
  "login.failed": "فشل تسجيل الدخول",
  "login.newBusiness": "منشأة جديدة؟",
  "login.createTenant": "إنشاء منشأة جديدة",

  // ---- auth: register ----
  "register.subtitle": "إعداد منشأة جديدة",
  "register.businessName": "اسم النشاط التجاري",
  "register.slugPattern": "أحرف لاتينية صغيرة وأرقام وشرطات (2–40 حرفًا)",
  "register.slugHint": "يُستخدم لتسجيل الدخول: أحرف لاتينية صغيرة وأرقام وشرطات.",
  "register.fullName": "الاسم الكامل",
  "register.passwordHint": "10 أحرف على الأقل.",
  "register.submit": "إنشاء المنشأة",
  "register.submitting": "جارٍ إنشاء المنشأة…",
  "register.failed": "فشل إنشاء الحساب",
  "register.already": "مسجّل بالفعل؟",

  // ---- dashboard ----
  "dashboard.loading": "جارٍ تحميل لوحة التحكم…",
  "dashboard.loadFailed": "تعذّر تحميل لوحة التحكم: {error}",
  "dashboard.locations": "المواقع",
  "dashboard.products": "المنتجات",
  "dashboard.unitsOnHand": "الوحدات المتوفرة",
  "dashboard.movements24h": "الحركات (آخر 24 ساعة)",
  "dashboard.manageInventory": "إدارة المخزون",
  "dashboard.openCatalog": "فتح الكتالوج",
  "dashboard.acrossLocations": "في جميع المواقع",
  "dashboard.fullAudit": "سجل التدقيق الكامل",
  "dashboard.recentMovements": "أحدث الحركات",
  "dashboard.noMovements": "لا توجد حركات مخزون بعد.",

  // ---- catalog ----
  "catalog.countProducts": "{count} منتج",
  "catalog.newProduct": "منتج جديد",
  "catalog.name": "الاسم",
  "catalog.slug": "المعرّف",
  "catalog.tracking": "التتبع",
  "catalog.create": "إنشاء منتج",
  "catalog.creating": "جارٍ الإنشاء…",
  "catalog.createFailed": "فشل الإنشاء",
  "catalog.searchLabel": "البحث في المنتجات",
  "catalog.searchPlaceholder": "الاسم أو المعرّف…",
  "catalog.loadFailed": "تعذّر تحميل المنتجات: {error}",
  "catalog.loading": "جارٍ تحميل الكتالوج…",
  "catalog.noProducts": "لا توجد منتجات بعد.",
  "catalog.noProductsMatching": "لا توجد منتجات مطابقة لـ «{query}».",
  "catalog.variantOne": "متغير واحد",
  "catalog.variantMany": "{count} متغيرات",
  "catalog.priceAed": "السعر (درهم)",
  "catalog.barcodeOptional": "الباركود (اختياري)",
  "catalog.addVariant": "إضافة متغير",
  "catalog.adding": "جارٍ الإضافة…",
  "catalog.priceInvalid":
    "يجب أن يكون السعر مبلغًا موجبًا بالدرهم وبحد أقصى خانتين عشريتين، مثل 1299.00",
  "catalog.translations.title": "المحتوى بالعربية",
  "catalog.translations.arName": "اسم المنتج بالعربية",
  "catalog.translations.arDescription": "وصف المنتج بالعربية",
  "catalog.translations.save": "حفظ المحتوى بالعربية",
  "catalog.translations.saving": "جارٍ الحفظ…",
  "catalog.translations.saved": "تم حفظ المحتوى بالعربية.",
  "catalog.translations.failed": "تعذّر حفظ المحتوى بالعربية",
  "catalog.translations.hint": "اترك الحقل فارغًا للإبقاء على النص الإنجليزي.",

  // ---- inventory ----
  "inventory.location": "الموقع",
  "inventory.loadingLocations": "جارٍ تحميل المواقع…",
  "inventory.locationsFailed": "تعذّر تحميل المواقع: {error}",
  "inventory.noLocations": "لا توجد مواقع بعد — أنشئ متجرًا أو مستودعًا أولًا.",
  "inventory.levelsFailed": "تعذّر تحميل مستويات المخزون: {error}",
  "inventory.loadingLevels": "جارٍ تحميل مستويات المخزون…",
  "inventory.noStock": "لا يوجد مخزون في هذا الموقع.",
  "inventory.skuOne": "صنف واحد",
  "inventory.skuMany": "{count} أصناف",
  "inventory.detail": "التفاصيل",

  // ---- variant detail ----
  "variant.loading": "جارٍ تحميل المتغير…",
  "variant.loadFailed": "تعذّر تحميل المتغير: {error}",
  "variant.breadcrumb": "المتغير",
  "variant.barcode": "الباركود",
  "variant.availabilityAt": "التوفر في",
  "variant.availability": "التوفر",
  "variant.noAvailability": "لا توجد بيانات توفر في هذا الموقع.",
  "variant.movementHistory": "سجل الحركات",
  "variant.noMovements": "لا توجد حركات مسجلة لهذا المتغير.",

  // ---- orders ----
  "orders.countSummary": "{count} طلب · التوقيت بحسب آسيا/دبي",
  "orders.filterLabel": "تصفية حسب حالة الطلب",
  "orders.all": "الكل",
  "orders.loadFailed": "تعذّر تحميل الطلبات: {error}",
  "orders.loading": "جارٍ تحميل الطلبات…",
  "orders.none": "لا توجد طلبات.",
  "orders.noneFiltered": "لا توجد طلبات بحالة «{status}».",
  "orders.walkIn": "عميل حضوري",
  "orders.fulfill": "تنفيذ",
  "orders.cancel": "إلغاء",
  "orders.receipt": "الفاتورة",
  "orders.cancelPrompt": "سبب إلغاء الطلب {orderNo}؟",
  "orders.cancelReasonRequired": "يجب إدخال سبب الإلغاء.",
  "orders.cancelFailed": "فشل الإلغاء",
  "orders.fulfillFailed": "فشل تنفيذ الطلب",
  "orders.unitRequired": "يجب مسح الوحدات المتسلسلة (IMEI) في المستودع قبل تنفيذ هذا الطلب.",

  // ---- receipt (tax invoice) ----
  "receipt.title": "فاتورة ضريبية",
  "receipt.loading": "جارٍ تحميل الفاتورة…",
  "receipt.loadFailed": "تعذّر تحميل الفاتورة: {error}",
  "receipt.trn": "رقم التسجيل الضريبي (TRN)",
  "receipt.issued": "تاريخ الإصدار",
  "receipt.subtotal": "المجموع الفرعي",
  "receipt.vat5": "ضريبة القيمة المضافة (5٪)",
  "receipt.total": "الإجمالي",
  "receipt.payments": "المدفوعات",
  "receipt.rawJson": "بيانات الفاتورة الخام (JSON)",

  // ---- approvals ----
  "approvals.countPending": "{count} قيد الانتظار · التوقيت بحسب آسيا/دبي",
  "approvals.loadFailed": "تعذّر تحميل الموافقات: {error}",
  "approvals.loading": "جارٍ تحميل الموافقات…",
  "approvals.empty": "لا توجد طلبات بانتظار الموافقة.",
  "approvals.approve": "موافقة",
  "approvals.reject": "رفض",
  "approvals.decisionFailed": "فشل تسجيل القرار",
  "approvals.refundOn": "استرداد {amount} على الطلب {order}",
  "approvals.refund": "استرداد {amount}",
  "approvals.stockCount": "جرد المخزون",
  "approvals.stockCountVarianceOne": "جرد المخزون · فرق واحد",
  "approvals.stockCountVariances": "جرد المخزون · {count} فروقات",
  "age.justNow": "الآن",
  "age.minutes": "قبل {count} دقيقة",
  "age.hours": "قبل {count} ساعة",
  "age.days": "قبل {count} يوم",

  // ---- finance ----
  "finance.allAmountsAed": "جميع المبالغ بالدرهم الإماراتي",
  "finance.trialBalance": "ميزان المراجعة",
  "finance.balanced": "متوازن ✓",
  "finance.outOfBalance": "غير متوازن بفارق {amount}",
  "finance.tbFailed": "تعذّر تحميل ميزان المراجعة: {error}",
  "finance.tbLoading": "جارٍ تحميل ميزان المراجعة…",
  "finance.noAccounts": "لا توجد حسابات في دفتر الأستاذ بعد.",
  "finance.totals": "الإجماليات",
  "finance.pnl": "الأرباح والخسائر",
  "finance.from": "من",
  "finance.to": "إلى",
  "finance.pnlLoading": "جارٍ تحميل تقرير الأرباح والخسائر…",
  "finance.invalidRange": "اختر نطاق تواريخ صحيحًا (يجب ألا يكون تاريخ البداية بعد تاريخ النهاية).",
  "finance.grossRevenue": "إجمالي الإيرادات",
  "finance.refunds": "المبالغ المستردة",
  "finance.netRevenue": "صافي الإيرادات",
  "finance.costOfSales": "تكلفة المبيعات",
  "finance.vatCollected": "ضريبة القيمة المضافة المحصّلة",

  // ---- daily digest ----
  "digest.title": "الموجز اليومي",
  "digest.byClaude": "أُنشئ بواسطة Claude",
  "digest.stub": "ملخص إحصائي (بدون مفتاح API)",
  "digest.preparing": "جارٍ إعداد موجز اليوم…",
  "digest.rawData": "البيانات الخام وراء هذا الموجز",
  "digest.budgetExceeded":
    "استُنفدت ميزانية الذكاء الاصطناعي لهذا اليوم، لذا يتعذّر إنشاء الموجز حاليًا. سيعود غدًا — الأرقام الأساسية متاحة في لوحة التحكم وصفحة المالية.",
  "digest.forbidden":
    "الموجز اليومي متاح لدوري المدير والمالك فقط. اطلب من المالك ترقية دورك إذا كنت بحاجة إلى الوصول.",
  "digest.loadFailed": "تعذّر تحميل الموجز اليومي.",

  // ---- audit trail ----
  "audit.title": "سجل التدقيق",
  "audit.summary": "دفتر حركات المخزون (إضافة فقط) · تم تحميل {count} قيدًا · التوقيت بحسب آسيا/دبي",
  "audit.refFailed": "تعذّر تحميل البيانات المرجعية: {error}",
  "audit.ledgerFailed": "تعذّر تحميل دفتر الحركات",
  "audit.empty": "دفتر الحركات فارغ.",
  "audit.endOfLedger": "نهاية السجل.",

  // ---- movement presentation ----
  "movement.external": "خارجي",

  // ---- enum values: stock states ----
  "state.on_hand": "متوفر",
  "state.reserved": "محجوز",
  "state.in_transit": "قيد النقل",
  "state.damaged": "تالف",
  "state.returned_pending": "مرتجع قيد المعالجة",
  "state.available": "متاح",

  // ---- enum values: movement types ----
  "mtype.receipt": "استلام",
  "mtype.sale": "بيع",
  "mtype.return_in": "إرجاع وارد",
  "mtype.transfer_in": "تحويل وارد",
  "mtype.transfer_out": "تحويل صادر",
  "mtype.repair_in": "وارد من الصيانة",
  "mtype.repair_out": "صادر إلى الصيانة",
  "mtype.write_off": "شطب",
  "mtype.reservation": "حجز",
  "mtype.release": "إلغاء حجز",
  "mtype.adjustment": "تسوية",
  "mtype.count_correction": "تصحيح جرد",

  // ---- enum values: order status ----
  "status.pending": "قيد الانتظار",
  "status.confirmed": "مؤكد",
  "status.fulfilled": "منفّذ",
  "status.cancelled": "ملغى",
  "status.refunded": "مسترد",

  // ---- enum values: sales channels ----
  "channel.pos": "نقطة البيع",
  "channel.online": "عبر الإنترنت",
  "channel.marketplace": "سوق إلكتروني",

  // ---- enum values: approval kinds ----
  "kind.refund": "استرداد",
  "kind.stock_count": "جرد المخزون",

  // ---- enum values: product tracking ----
  "tracking.none": "بدون",
  "tracking.batch": "دفعات",
  "tracking.serialized": "متسلسل (IMEI)",

  // ---- enum values: location kinds ----
  "lockind.store": "متجر",
  "lockind.warehouse": "مستودع",
  "lockind.virtual": "افتراضي",

  // ---- enum values: ledger account kinds ----
  "acct.asset": "أصول",
  "acct.liability": "التزامات",
  "acct.equity": "حقوق الملكية",
  "acct.revenue": "إيرادات",
  "acct.income": "دخل",
  "acct.expense": "مصروفات",

  // ---- enum values: payment methods ----
  "pay.cash": "نقدًا",
  "pay.card": "بطاقة",

  // ---- enum values: product status ----
  "pstatus.active": "نشط",
  "pstatus.archived": "مؤرشف",
  "pstatus.draft": "مسودة",
};

export type MessageParams = Record<string, string | number>;

const dictionaries: Record<Lang, Record<MessageKey, string>> = { en, ar };

/**
 * Translate `key` into `lang`, substituting `{name}`-style placeholders from
 * `params`. Unknown placeholders are left verbatim (they surface in review
 * rather than rendering as "undefined").
 */
export function t(lang: Lang, key: MessageKey, params?: MessageParams): string {
  const template = dictionaries[lang][key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/** "on_hand" → "On hand" — last-resort label for values with no dictionary key. */
function humanizeFallback(value: string): string {
  const words = value.replace(/_/g, " ").trim();
  return words.length === 0 ? value : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Label a server enum value (`prefix` scopes the namespace, e.g.
 * enumLabel("ar", "status", "pending") → "قيد الانتظار"). Unknown values fall
 * back to a humanized English form so new server states never render blank.
 */
export function enumLabel(lang: Lang, prefix: string, value: string): string {
  const key = `${prefix}.${value}`;
  if (Object.prototype.hasOwnProperty.call(en, key)) return t(lang, key as MessageKey);
  return humanizeFallback(value);
}

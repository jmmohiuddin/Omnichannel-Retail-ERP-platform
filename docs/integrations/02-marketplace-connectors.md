# Marketplace & Payment Gateway Integration Notes

**Status:** Reference notes compiled from public API knowledge as of early 2026. Marketplace APIs change quarterly — **every rate limit, endpoint name, and deprecation date below must be verified against current official docs before implementation.** Numbers marked *(approx.)* are order-of-magnitude planning figures, not contracts.

---

## 1. Shopify (Admin GraphQL API)

- **Auth:** OAuth 2.0 for public/custom apps (online + offline access tokens); offline token is what a sync connector uses. Admin API access scopes are granular (`read_orders`, `write_inventory`, ...). API versions are date-pinned quarterly (e.g. `2026-01`) with ~12-month support windows — pin and schedule upgrades.
- **REST is legacy:** Shopify has declared the REST Admin API legacy; **new development must target the GraphQL Admin API**. Product/variant REST endpoints were the first to be closed to new apps. Build GraphQL-only.
- **Key objects:** `Order`, `FulfillmentOrder` (fulfillments are created against fulfillment orders, not orders — a common migration trap), `ProductVariant` + `InventoryItem` + `InventoryLevel` (per-`Location`), `PriceList` (Markets). Inventory writes: `inventorySetQuantities` / `inventoryAdjustQuantities` mutations; prefer the absolute-set mutation (matches our no-deltas rule).
- **Webhooks:** first-class; `orders/create`, `orders/updated`, `refunds/create`, `inventory_levels/update`, `products/update`, plus mandatory GDPR topics. HMAC-SHA256 verification via `X-Shopify-Hmac-Sha256`. Delivery is at-least-once but **not guaranteed** — Shopify explicitly recommends reconciliation polling.
- **Rate limits:** GraphQL uses a **calculated query cost** model — roughly a leaky bucket of 1,000 cost points with 50 points/s restore for standard plans, higher for Plus *(approx., plan-dependent; the API returns actual cost + throttle status in `extensions.cost`, use it to drive the adaptive governor)*. Bulk operations API exists for large exports (async JSONL) — use it for reconciliation snapshots instead of paging.
- **Sandbox:** free development stores via Partner Dashboard — excellent.
- **Gotchas:** fulfillment must go through FulfillmentOrders; inventory is per-location so location mapping is mandatory setup; `orders/updated` fires very chattily (dedupe hard); GraphQL cost varies wildly with query shape, so keep sync queries narrow; protected customer data requires app approval for PII fields.

## 2. WooCommerce (REST)

- **Auth:** REST keys (consumer key/secret) over HTTPS Basic auth, generated per store; OAuth 1.0a one-legged only for non-HTTPS stores (refuse those). No central app store handshake for private integrations.
- **Key endpoints:** `/wp-json/wc/v3/orders`, `/products`, `/products/<id>/variations`, batch endpoints (`/products/batch`, up to 100 objects). Stock via `stock_quantity`/`manage_stock` on product/variation. Prices: `regular_price`/`sale_price` strings.
- **Webhooks:** configurable per store (`order.created`, `order.updated`, `product.updated`...), signed with HMAC-SHA256 (`X-WC-Webhook-Signature`). **Delivery depends on WP-Cron**, which depends on site traffic — webhooks on low-traffic or badly hosted stores are unreliable. Polling is mandatory here, not optional.
- **Rate limits:** none from Woo itself — limits are whatever the site's hosting/WAF imposes *(often surprisingly low; treat 2–5 req/s as a safe default and make it a per-account setting)*.
- **Sandbox:** none official; spin up disposable WP+Woo instances (we maintain a Docker fixture).
- **Gotchas:** every store is a snowflake (plugin conflicts alter API responses — e.g. bundles, custom order statuses); pagination via `page` param is offset-based and racy under writes, use `modified_after` filters with overlap; decimal prices as strings; server clock skew breaks signature timestamps; HPOS (high-performance order storage) vs legacy posts storage can subtly change behavior on older plugin stacks. Verify against current docs — Woo ships fast.

## 3. Amazon Selling Partner API (SP-API)

- **Auth:** OAuth 2.0 (Login with Amazon) for app authorization → refresh token per selling partner; requests need LWA access token; AWS SigV4 signing was **removed** in favor of LWA-only tokens for most cases *(verify — auth model has evolved; restricted operations still need Restricted Data Tokens (RDT) for PII like buyer addresses)*.
- **Key APIs:** Orders API (`getOrders`, `getOrderItems` — PII requires RDT), Listings Items API (`putListingsItem`, `patchListingsItem` — JSON, replaces old XML feeds for listing data), Feeds API (`JSON_LISTINGS_FEED`, inventory/price bulk), Reports API (`GET_FBA_MYI_...`, order/settlement/inventory reports), FBA Inventory API, Notifications API, Product Pricing API.
- **Notifications:** via **SQS/EventBridge subscriptions** (`ORDER_CHANGE`, `LISTINGS_ITEM_STATUS_CHANGE`, `FEED_PROCESSING_FINISHED`...), not HTTP webhooks — the connector host consumes an SQS queue per app.
- **Rate limits:** per-operation token buckets, typically small — e.g. `getOrders` around 0.0167 req/s sustained with burst ~20 *(approx.; actual rate/burst returned in `x-amzn-RateLimit-Limit` header — feed it to the governor)*. Feeds/reports are the intended path for volume.
- **Sandbox:** static sandbox (canned responses) + limited dynamic sandbox; genuinely useful only for contract testing, not behavior. Real testing needs a real seller account.
- **Gotchas:** **everything bulk is asynchronous** — submit feed → poll `FEED_PROCESSING_FINISHED` → download result doc → parse per-item errors (our async-handle pattern exists for this); processing can take minutes to hours; order PII requires RDT and PII handling attestation/audit for the app; FBA stock is Amazon-controlled (model as separate ERP location fed from reports); listing errors are cryptic attribute-schema failures (fetch Product Type Definitions to pre-validate); settlement/fee data only via reports with delay.

## 4. eBay Sell APIs

- **Auth:** OAuth 2.0 (user tokens with refresh; scopes per API family). Old Auth'n'Auth tokens exist only for legacy Trading API.
- **The split:** modern **Sell APIs** (Inventory API: `inventory_item`, `offer`, `publish`; Fulfillment API: orders + shipping; Account API: policies) vs the legacy **Trading API** (XML). Listings created via Trading/old tools are not natively manageable via Inventory API — migration endpoint (`bulkMigrateListing`) exists, and sellers with legacy listings are common. **Plan for read-via-Fulfillment (works for all orders) but listing management may require dual-stack support** for onboarding existing sellers.
- **Key objects:** `inventoryItem` (SKU-keyed), `offer` (marketplace+format+price+quantity), published offer = live listing; orders via Fulfillment API `getOrders`.
- **Notifications:** Platform Notifications (legacy) + newer **Notification API** (e.g. marketplace account deletion is mandatory to subscribe for compliance); order events historically weak — **poll Fulfillment API** as primary.
- **Rate limits:** daily call quotas per API per app (e.g. Inventory API in the low millions/day for production-approved apps; unapproved apps much lower) *(approx.; check developer portal quotas)*.
- **Sandbox:** yes, full sandbox environment with test users; moderately faithful.
- **Gotchas:** Inventory API SKU limit rules (SKU immutable per item), offer/publish two-phase flow surprises people; category + item specifics (aspects) validation; the Trading/Inventory split is the #1 integration cost; multi-marketplace (ebay.com, .co.uk...) under one account needs per-marketplace offers.

## 5. Walmart Marketplace (US)

- **Auth:** client ID/secret → token endpoint (OAuth-ish client-credentials), token per seller; headers `WM_SEC.ACCESS_TOKEN`, `WM_QOS.CORRELATION_ID` required.
- **Key endpoints:** Orders (`/v3/orders`, with **mandatory acknowledge** step before shipping), Inventory (`/v3/inventory`, absolute quantity per SKU per node), Items (`/v3/items`, setup via feeds — bulk item spec JSON/XML), Prices (`/v3/price`), Returns API, Fulfillment (WFS) APIs.
- **Notifications:** webhook-style **event subscriptions** exist for a growing set (order events, item lifecycle) *(coverage varies; verify current event catalog)* — but polling `getOrders` with `createdStartDate` remains the dependable path.
- **Rate limits:** per-endpoint token buckets documented per API (e.g. hundreds of calls/min for inventory, less for item setup) *(approx.; response headers expose remaining tokens)*.
- **Sandbox:** limited sandbox; much behavior only testable with an approved seller account.
- **Gotchas:** order flow requires `acknowledge` within SLA or orders auto-cancel and metrics suffer (our `orders.acknowledge` hook exists for this); item setup is feed-based and slow with per-item ingestion errors surfaced via feed status; strict on-time-ship metrics mean statusSync latency is commercially important; lag between item feed acceptance and listing going live.

## 6. Daraz / Lazada Open Platform (South & Southeast Asia)

Daraz (BD/PK/LK/NP/MM) runs on Lazada's platform tech; the Daraz Open Platform API is essentially the Lazada Open Platform pattern (shared signature scheme and endpoint style), but with separate portal, app registration, and country endpoints. **Treat them as one connector family, two registries.**

- **Auth:** app key + app secret; seller authorizes app → `access_token` + `refresh_token` (auth-code flow through the seller center); **every request signed** (HMAC-SHA256 over sorted params — the signature scheme is the classic Alibaba open-platform style). Tokens expire (access ~ hours–days, refresh ~ weeks) *(verify current TTLs)*.
- **Key endpoints:** `/orders/get`, `/order/items/get`, `/order/pack`, ready-to-ship endpoints; products via `/product/create`, `/product/update`, `/product/price_quantity/update` (the workhorse for sync — absolute qty + price per seller SKU); category attributes via `/category/attributes/get`.
- **Webhooks:** message push / callback service for order status and other events exists on both platforms *(reliability varies by country; poll as primary, treat push as accelerator)*.
- **Rate limits:** per-app QPS caps, historically modest (single-digit to low-double-digit QPS per app) *(approx.; check per-API quotas in the console)*.
- **Sandbox:** limited/none in practice for Daraz; test with a real seller account in a test category. Lazada has some sandbox tooling.
- **Gotchas:** signature ordering bugs are the classic first failure; XML-ish payloads inside JSON for product APIs on older endpoints; per-country endpoints and tokens (a BD seller and PK seller are separate authorizations); order statuses are granular (`pending`→`ready_to_ship`→`shipped`...) and shipping-provider-coupled; documentation gaps — budget reverse-engineering time; API versions/domains have churned, **verify current base URLs**.

## 7. Facebook / Instagram Commerce (Meta)

- **Auth:** Meta Graph API OAuth; system user tokens on a Business Manager for server integrations; Commerce permissions (`catalog_management`, `commerce_account_read_orders`, ...) require App Review.
- **Key objects:** **Catalog** (product feed or Catalog Batch API `/{catalog_id}/items_batch` for inventory/price — this is the sync surface), Commerce Account (`/{cms_id}/orders`) for **Checkout on Facebook/Instagram orders — US-centric**; in most other markets IG/FB shopping is *catalog + tagging that links out to your site*, so "orderImport" often doesn't apply outside US checkout.
- **Webhooks:** Graph API webhooks for commerce order updates (US checkout) and catalog feed status.
- **Rate limits:** Graph API BUC (business use case) rate limiting — dynamic, per-app/per-business *(opaque; design conservatively and back off on `X-Business-Use-Case-Usage` headers)*.
- **Sandbox:** test catalogs and test commerce accounts are limited; App Review is the real bottleneck (weeks).
- **Gotchas:** Meta has repeatedly **restructured commerce (Checkout availability, shop requirements) — verify current state before committing scope**; feed-based catalog updates can lag; policy compliance (product category bans) causes silent item rejection — poll item-level diagnostics; treat this connector as `listings + priceSync + inventorySync` with `orderImport` only for US checkout accounts.

## 8. TikTok Shop

- **Auth:** TikTok Shop Partner Center app → authorized shop → access/refresh token; requests signed (HMAC-SHA256 over path+params+body with app secret — similar spirit to Lazada). Region-partitioned APIs (US vs SEA vs UK) with separate hosts and sometimes separate app registrations.
- **Key endpoints (202xxx versioned, e.g. `/order/202309/orders/search`):** order search/detail, product create/update, **inventory update** (`/product/202309/products/{id}/inventory/update` style — absolute qty per SKU per warehouse), price update, fulfillment (package ship), returns/cancellations APIs.
- **Webhooks:** yes — shop webhook subscriptions for order status changes, cancellations, returns; signed payloads. Reasonably reliable but young — keep polling.
- **Rate limits:** per-app QPS limits (commonly cited around 5–10 QPS per endpoint group) *(approx.; verify in Partner Center)*.
- **Sandbox:** sandbox environment available via Partner Center with test shops *(fidelity moderate)*.
- **Gotchas:** **API surface is young and changes fast** — versioned paths (`/202309/`) deprecate aggressively, verify current versions; strict fulfillment SLAs with penalties (statusSync latency matters commercially); mandatory product certification/qualification attributes per category and per region; US vs cross-border seller types have different capabilities; settlement/fee reconciliation APIs are still maturing.

## 9. Etsy (Open API v3)

- **Auth:** OAuth 2.0 with PKCE; personal access + app scopes (`transactions_r`, `listings_w`, ...); API key (`x-api-key`) plus bearer token on each call.
- **Key endpoints:** `getShopReceipts` (orders = "receipts"; `Transaction` = line), `updateListingInventory` (a **single JSON document describing the full offering matrix** — products × property values × price × quantity — replace-style, which suits our absolute-value rule but forces read-modify-write of the whole structure), `createDraftListing` → publish, shipping profiles.
- **Webhooks:** **none** (historically; verify). Polling `getShopReceipts` with `min_last_modified` is the pattern.
- **Rate limits:** classic documented default ~10,000 req/day and ~10 req/s per app *(approx.; per-app, can request uplift)*.
- **Sandbox:** no real sandbox; use a test shop (Etsy has at times required listings to be paid/live to fully test — budget for it).
- **Gotchas:** receipts vs transactions vs payments model takes a minute; `updateListingInventory` whole-document semantics mean concurrent edits clobber (serialize per listing); variation properties must match Etsy's property taxonomy; personal-account app approval process; VAT/marketplace-facilitator fields differ by region.

---

## 10. Capability Matrix

Legend: ✅ solid · ◐ partial/conditional · ✖ not available · **?** verify current docs

| Capability | Shopify | Woo | Amazon SP | eBay Sell | Walmart | Daraz/Lazada | Meta Commerce | TikTok Shop | Etsy |
|---|---|---|---|---|---|---|---|---|---|
| Listing create/update | ✅ GraphQL | ✅ REST | ◐ async feeds/Listings API | ◐ Inventory API (legacy split) | ◐ item feeds | ✅ | ✅ catalog batch | ✅ | ✅ |
| Inventory push (absolute) | ✅ per-location | ✅ | ◐ async (feed/Listings patch) | ✅ offer quantity | ✅ | ✅ price_quantity | ✅ catalog | ✅ per-warehouse | ◐ whole-doc replace |
| Price push | ✅ | ✅ | ◐ async | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ whole-doc |
| Order import (pull) | ✅ | ✅ | ✅ (RDT for PII) | ✅ Fulfillment API | ✅ | ✅ | ◐ US checkout only | ✅ | ✅ receipts |
| Order webhooks/push events | ✅ HMAC | ◐ WP-Cron reliant | ◐ SQS/EventBridge | ◐ weak, poll | ◐ growing **?** | ◐ push service **?** | ✅ (where checkout exists) | ✅ | ✖ **?** |
| Order acknowledge required | ✖ | ✖ | ✖ | ✖ | ✅ SLA | ◐ (RTS flow) | ✖ | ◐ (ship SLA) | ✖ |
| Fulfillment/tracking push | ✅ FulfillmentOrders | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ | ✅ | ✅ |
| Returns/refunds API | ✅ | ✅ | ◐ reports+APIs | ✅ | ✅ Returns API | ✅ | ◐ | ✅ | ◐ refunds via payments |
| Sandbox quality | ✅ dev stores | ✖ (self-host) | ◐ static | ✅ | ◐ | ✖/◐ | ◐ | ◐ | ✖ |
| Sync model bias | webhooks+GraphQL | poll-heavy | async feeds + SQS | poll | poll+ack | poll+sign | feeds | webhook+poll | poll |
| Buffer recommendation (§ see 01 doc) | low (0–1) | med | high (2+/5%) | med | med-high | med-high | high | med | med |

---

## 11. Payment Gateways (tokenization-first, ERP stays out of PCI scope)

**Principle:** the ERP never sees, stores, transmits, or processes a PAN. All card capture happens in gateway-hosted fields/pages/SDK elements; the ERP stores only **opaque tokens, gateway customer/transaction ids, last4/brand metadata, and webhook-confirmed states**. This keeps us in **SAQ A** territory for e-com flows and out of CDE scope entirely. Card data never transits our servers, our logs, or our DOM (hosted iframes only). POS card-present uses gateway/acquirer terminals (e.g. Stripe Terminal) where the device is the PCI boundary and we receive tokens.

### 11.1 Stripe

- **Model:** PaymentIntents + PaymentMethods; card capture via Stripe Elements / Checkout (hosted). Server creates intent, client confirms with hosted fields, we get `payment_intent.succeeded` webhook. `SetupIntent` + `Customer` for card-on-file (network tokens managed by Stripe). Stripe Terminal for POS card-present (`connection_token` flow; reader handles the card).
- **ERP stores:** `customer_id`, `payment_method_id` (opaque), `payment_intent_id`, last4/brand/exp metadata, webhook events (verified via signing secret).
- **Refunds/disputes:** Refunds API against the intent; dispute webhooks feed the returns module.
- **Notes:** idempotency keys on every mutating call (native support); use `Stripe-Account` header pattern if we ever do platform/Connect marketplace payouts.

### 11.2 SSLCommerz (Bangladesh)

- **Model:** hosted checkout redirect (EasyCheckout/hosted page): create session server-side (`store_id` + `store_passwd` → `GatewayPageURL`), customer pays on SSLCommerz page (cards, MFS incl. bKash/Nagad rails, net banking), gateway redirects back + sends **IPN**.
- **Critical rule:** IPN and redirect params are **not proof of payment** — always call the **order validation API** (`validator/api/validationserverAPI.php` style endpoint) with `val_id` server-to-server before marking paid *(endpoint naming: verify current docs)*.
- **ERP stores:** session id, `val_id`, `bank_tran_id`, card_type/brand metadata. No PAN ever reaches us (hosted page) → SAQ A.
- **Notes:** sandbox available (test store credentials); refund API exists (partial/full) with reference ids; settlement reporting is portal/report-based — plan manual reconciliation hooks.

### 11.3 bKash / Nagad (Bangladesh MFS)

These are mobile wallets, not card gateways — no PCI scope, but equivalent secret-handling discipline applies (wallet credentials, API keys in the same encrypted credential store).

- **bKash (Tokenized Checkout / PGW):** app key/secret → **grant token** (short-lived, ~1 h, refreshable); flow: `create payment` → customer authorizes in bKash dialog/app (OTP+PIN) → `execute payment` → **always confirm with `query payment`** (execute responses can time out while payment succeeds — the classic bKash gotcha; build the query-on-timeout path). Webhook support is limited; poll/query is the guarantee. Sandbox with test wallets available. Refund API available with transaction id. *(bKash has both "Checkout (URL)" and "Tokenized" product lines — verify which product the merchant account is provisioned for.)*
- **Nagad:** merchant integration uses **RSA key-pair signing** (merchant signs requests, verifies Nagad's signatures) + payment reference flow: initialize → complete → callback → **verify payment** server-to-server. Date-stamped order id conventions and strict timestamp windows; sandbox provided during onboarding. Docs are thinner than bKash — budget integration time and pin everything with contract tests.
- **ERP stores (both):** payment reference/trx id, wallet-masked msisdn if provided, verified status + amount. Amount verification on the server is mandatory (never trust callback amounts).

### 11.4 PayPal

- **Model:** Orders v2 API: server creates order → buyer approves in PayPal popup/redirect (JS SDK Smart Buttons) → server `capture`. Card fields exist (Advanced Card Processing, hosted fields) — if used, still iframe-hosted so PAN bypasses us (SAQ A / SAQ A-EP depending on integration — prefer pure hosted to stay SAQ A). Vault API for stored payment methods (opaque vault token).
- **Webhooks:** signed webhooks (`PAYMENT.CAPTURE.COMPLETED`, disputes, refunds) with certificate/signature verification API.
- **ERP stores:** order id, capture id, payer id, vault token. Refunds via capture id.
- **Notes:** sandbox is full-featured (sandbox business/personal accounts); auth is OAuth2 client-credentials access tokens; idempotency via `PayPal-Request-Id` header.

### 11.5 Gateway abstraction in the ERP

One internal `PaymentProvider` interface (createPaymentSession, verifyPayment, refund, webhook verify/parse) mirroring the connector SDK pattern; per-tenant gateway credentials in the same envelope-encrypted store; a **payment state machine** (`initiated → pending → authorized → captured → settled | failed | refunded(partial|full) | disputed`) where **no state advances to captured/paid without server-to-server verification** (Stripe webhook + retrieve, SSLCommerz validation API, bKash query, Nagad verify, PayPal capture response + webhook). Every provider callback endpoint is idempotent and replay-safe.

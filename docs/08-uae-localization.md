# UAE Localization Specification (Dubai-first)

The platform's launch market is the UAE, with Dubai's mobile-phone and electronics trade
(Deira corridor, mall retailers, online sellers) as the archetype customer. This document
is the authority for market-specific behavior; generic docs defer to it.

> Regulatory details below reflect knowledge as of early 2026 — verify against current
> FTA/TDRA publications during implementation of each item.

## 1. Currency & formatting

- Default tenant currency **AED**; minor unit = fils (×100) — already compatible with our
  `bigint` minor-units convention. Multi-currency stays supported (USD wholesale is common
  in the Dubai phone trade; price lists per currency).
- Number/date formatting per locale (`en-AE`, `ar-AE`); Hijri display dates are cosmetic
  only — storage stays Gregorian UTC. Business week: Mon–Fri (UAE moved the weekend to
  Sat–Sun in 2022); store hours config per location. Timezone default `Asia/Dubai` (GMT+4).

## 2. VAT (Federal Tax Authority)

- **5% standard rate** on most retail goods; zero-rated exports; tax config must remain
  table-driven (rates change by decree, not by code deploy).
- Every tenant stores a **TRN (Tax Registration Number, 15 digits)**; invoices/receipts
  must show: "Tax Invoice", supplier name + TRN, invoice date, per-line VAT, and totals in
  AED. Simplified tax invoices allowed under the FTA threshold — receipt template supports
  both.
- Price display is **VAT-inclusive** at retail (the norm in UAE); the ledger stores net +
  VAT separately per line for reporting.
- VAT return support: output/input VAT summary report per period (FTA files quarterly for
  most SMEs).
- **E-invoicing:** the UAE e-billing/e-invoicing mandate (Peppol-based, phased from
  2026–2027) is on the roadmap — invoice records already carry structured, per-line tax
  data so the reporting layer can be added without schema surgery.

## 3. Language & UI

- **Bilingual English/Arabic** across admin, POS, storefront, and receipts; full **RTL**
  support is a design-system requirement (logical CSS properties, direction-aware icons),
  not a retrofit. Receipts print EN/AR dual-language (standard practice in Dubai retail).
- Product catalog: name/description fields localizable (`jsonb` i18n map on
  product/category SEO + content fields).

## 4. Payments (tokenized — ERP stays out of PCI scope)

Priority integrations:
| Provider | Role |
| --- | --- |
| Network International (N-Genius) | Dominant UAE acquirer; POS terminals + e-com gateway |
| Telr / PayTabs | SME-friendly UAE gateways |
| Stripe (AE entity) | Developer-grade e-com fallback |
| Tabby / Tamara | BNPL — heavily used in UAE electronics retail |
| Apple Pay / Google Pay | Via the above gateways |

Cash remains significant in the phone trade — cash sessions/blind reconciliation (already
built) are first-class. Cheque and bank-transfer (wholesale) recorded as payment methods
with reference numbers.

## 5. Marketplaces & channels (connector priority)

1. **Noon** (Seller API — orders, inventory, pricing)
2. **Amazon.ae** (SP-API, same connector family as global Amazon)
3. **Shopify** (widely used by UAE D2C stores)
4. **Dubizzle** (used-device listings — Dubai's dominant secondhand channel)
5. WhatsApp Business / Instagram commerce flows (order capture, later phase)

## 6. Compliance & data

- **UAE PDPL** (Federal Decree-Law 45/2021) governs personal data: consent, purpose
  limitation, breach notification, data-subject rights — our GDPR-style controls map
  across; add PDPL to the compliance matrix. Free-zone regimes (DIFC/ADGM) have their own
  laws — relevant only if we host or sell there.
- Data residency: prefer an AWS/Azure **UAE region** (me-central-1 / UAE North) for
  production; keeps latency low and residency questions simple.
- **TDRA** regulates telecom equipment: imported phones must be TDRA type-approved; the
  serialized-unit record keeps supplier + import metadata so retailers can evidence
  provenance. IMEI checks against national blacklists are a possible future integration —
  do not promise it until an official API is confirmed.
- Invoice/audit retention: FTA requires records kept ≥ 5 years — our append-only ledger
  and immutable audit log satisfy this by construction; retention policy set to 7 years.

## 7. Defaults changed in code

- `tenant.base_currency` default → `AED`; `tenant.timezone` default → `Asia/Dubai`
  (`packages/db/sql/001_foundation.sql`).
- Seed/demo data uses AED pricing and Dubai locations.

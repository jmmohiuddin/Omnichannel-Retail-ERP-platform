# Channel Onboarding — what each platform needs before it can be switched on

Every connector in this repo is written against the Connector SDK and is
**credential-blocked, not code-blocked**. This document records exactly what a
seller must obtain per platform, and what is already built.

> **Status legend** — *Built*: connector package exists with tested mapping
> logic and UNVERIFIED-flagged endpoints awaiting real API docs/credentials.
> *Planned*: no package yet.
>
> **There are no MCP servers for any of these platforms** (checked against the
> connector registry). Integration is via each platform's own REST/GraphQL API
> using seller credentials — an MCP connector would not change the licence
> requirement below.

## The universal blocker: vendor registration

Every marketplace and store platform below requires, before issuing API
credentials:

1. **A UAE trade licence** (mainland/free-zone) — the legal entity that sells.
2. **A registered vendor/merchant account** approved by the platform.
3. **VAT/TRN registration** where turnover requires it (see `08-uae-localization.md`).
4. **A bank account** in the entity's name for settlements.

Only after (1)–(2) does the platform's developer console issue OAuth client
credentials or API keys. **No code can bypass this**, and no credential should
ever be committed — they belong in the tenant's encrypted `channel.credentials_enc`
column (see `01-connector-architecture.md`).

## Per-platform

| Platform | Status | Credential model | Notes |
| --- | --- | --- | --- |
| **Noon** | Built (`connector-noon`) | Seller Lab account → API keys | Endpoint paths UNVERIFIED — Noon's seller API is not publicly documented in full; confirm in Seller Lab before go-live |
| **Salla** | Built (`connector-salla`) | Partner app → OAuth2 (`docs.salla.dev`) | Arabic-first; app must be created in Salla Partners portal, then merchant installs it |
| **Zid** | Built (`connector-zid`) | OAuth2 + manager token (`docs.zid.sa`) | Dual-header auth quirk captured in `endpoints.ts` |
| **Amazon.ae** | Planned | SP-API: LWA app + IAM role + seller authorization | Heaviest onboarding: developer profile approval, restricted-data (PII) roles for order addresses. Amazon feeds are asynchronous — the SDK's async-handle path exists for this |
| **DubaiStore** | Planned | Local seller onboarding | UAE-focused; verify whether a public seller API exists at all before promising sync — it may be portal-only, in which case CSV/manual export is the honest integration |
| **Shopify / WooCommerce** | Planned | Admin API token / REST consumer key | Best-documented options if you want a fast second channel |

## Own-marketplace platforms (Bagisto / Yo!Kart / Sharetribe)

These are a **different architectural decision**, not a connector. They are
platforms for *running your own multi-vendor marketplace* — vendor registration,
seller dashboards, commissions, payouts.

OmniRetail already provides the inventory/order/finance core. Adopting one of
these would mean either (a) running it as a separate storefront that syncs to us
as just another channel via a connector, or (b) building multi-vendor natively
here — which needs a vendor entity, commission ledger, and payout runs on top of
the existing double-entry finance module. **Do not adopt one before deciding
which**; running both as sources of truth would violate the single-ledger
principle this system is built on.

## Switching a built connector on

1. Obtain credentials (above).
2. `POST /v1/channels` `{kind:"marketplace", name, connector:"salla"|"zid"|"noon"}`.
3. Store credentials encrypted against that channel (never in git/env).
4. Publish listings: `PUT /v1/channels/:id/listings/:variantId` `{published:true, bufferQty}`.
5. Host `apps/worker` on a persistent runtime — channel sync and order import are
   queue consumers and **cannot run on Vercel** (see `../05-deployment-guide.md` §5).
6. Verify against the platform's sandbox before pointing at live stock.

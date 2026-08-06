# ADR-009: Frontend stack (Next.js, Expo) and AI gateway (Claude API)

**Status:** Accepted · 2026-08-06

## Context
Admin portal and storefront need SSR/SEO and fast iteration; mobile needs shared TS code;
AI features must be centrally governed (cost, privacy, prompt versioning).

## Decision
- **Admin portal & storefront:** Next.js (App Router) + Tailwind + a shared design-system
  package (Radix primitives). Storefront is SSR/ISR for SEO; admin is a protected SPA-ish
  app behind the same design system.
- **Mobile companion:** Expo/React Native (owner dashboards, stock lookup, barcode scan via
  camera, approvals on the go). POS-lite on mobile is a later phase.
- **AI:** single server-side **AI gateway module**; provider = Anthropic Claude API
  (structured outputs via tool use for forecasts/suggestions, streaming for assistants).
  Per-tenant budgets & rate caps, prompt template versioning, response logging, PII
  redaction before egress, and honest confidence labels on every ML-ish output.
  Statistical baselines (e.g., seasonal-naive forecast) run alongside LLM analysis so
  numeric predictions are grounded in classical methods, with the LLM explaining rather
  than inventing numbers.

## Alternatives rejected
- **Separate native iOS/Android apps:** double cost, no benefit for a companion app.
- **Direct LLM calls scattered across modules:** ungovernable cost/privacy surface.
- **Self-hosted OSS models for v1:** ops burden + quality gap; revisit for high-volume,
  low-stakes tasks (description drafts) once usage data exists.

## Consequences
One design system serves admin/POS/storefront; AI usage is a governed, observable
subsystem with a kill switch per tenant and per feature.

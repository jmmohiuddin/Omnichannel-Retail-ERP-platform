# Executive Summary

## What we are building

**OmniRetail OS** is a multi-tenant SaaS retail operating system that lets a retailer run
physical stores, warehouses, an online storefront, and marketplace channels from **one
centralized inventory database**. It combines ERP (purchasing, finance, employees), POS
(desktop-first, offline-capable), WMS (zones/bins/picking), OMS (all orders from all
channels), e-commerce, CRM/loyalty, and an AI layer (forecasting, reorder suggestions,
dead-stock detection, content generation, executive briefings).

Initial beachhead market: **mobile-phone and electronics retailers** (serialized inventory,
IMEI tracking, high fraud exposure, thin margins) in the **UAE — Dubai first** (Deira's
mobile-phone trade corridor being the archetype customer), then the wider GCC and general
retail. UAE specifics — AED, 5% VAT with TRN invoicing, bilingual English/Arabic (RTL),
Amazon.ae/Noon marketplaces, PDPL — are specified in
[08-uae-localization.md](08-uae-localization.md). This niche is underserved: horizontal ERPs (Odoo, ERPNext) handle serialized
stock poorly at POS speed; POS SaaS (Square, Lightspeed) lacks deep IMEI/warranty/repair
workflows and marketplace-grade sync.

## Why we win

1. **Ledger-based inventory.** Stock levels are *derived* from an append-only movement
   ledger, like double-entry accounting. Inventory can never change silently; every unit is
   traceable from receiving to sale to return. This is simultaneously our accuracy story,
   our audit story, and our fraud-prevention story — competitors bolt audit logs on; ours
   is the data model.
2. **Serialized-first.** IMEI/serial uniqueness, per-unit state machines, warranty and
   repair history are first-class, not an afterthought.
3. **Connector architecture.** Marketplaces attach as independent connector packages
   against a stable SDK; adding a channel never touches the core.
4. **Offline-first POS.** Sales continue through internet outages; the sync protocol is
   designed for it (client-generated IDs, idempotent command log replay), not retrofitted.
5. **AI where it pays.** Demand forecasting, reorder suggestions, dead-stock detection,
   anomaly/exception reporting, and description/SEO generation — grounded in the tenant's
   own ledger data, with honest confidence framing.

## Delivery strategy

A **modular monolith** on PostgreSQL ships first (fast iteration, one deployment,
transactional integrity where it matters most — inventory + orders), with module boundaries
and an event outbox designed so high-churn components (connector workers, AI services) can
be extracted to services when scale demands. See [ADR-001](adr/ADR-001-modular-monolith.md).

Phased roadmap in [07-roadmap.md](07-roadmap.md): Phase 1 core inventory + catalog + POS;
Phase 2 OMS + e-commerce + first connectors; Phase 3 WMS + AI + analytics depth.

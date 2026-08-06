# ADR-007: Desktop POS on Tauri with offline-first SQLite command log

**Status:** Accepted · 2026-08-06

## Context
POS must be desktop-grade fast (barcode scans, cash drawer, receipt printers on
ESC/POS), keep selling through internet outages, and never violate ledger invariants.

## Decision
Tauri 2 (Rust shell + system webview) hosting the React POS UI, sharing
`@omniretail/domain` with the server. Local SQLite holds a catalog/price/stock mirror
(synced by ledger-sequence cursor) and an append-only **command log** of sales with
client-generated UUIDv7 ids, replayed idempotently on reconnect. Hardware (printer, drawer,
scanner HID, customer display) accessed via Rust-side plugins.

## Alternatives rejected
- **Electron:** mature hardware ecosystem, but 150–250 MB baseline memory per register and
  larger update payloads; Tauri gives native-side Rust for serial/USB device access with a
  ~10× smaller footprint. Risk (younger ecosystem) accepted; ESC/POS and HID libraries in
  Rust are adequate.
- **PWA-only POS:** unacceptable hardware access (cash drawers, serial customer displays)
  and weaker offline guarantees under storage eviction.

## Consequences
Same domain code enforces invariants offline; conflict policy (last-unit double-sale →
flagged exception, not silent negative stock) is implemented once in the domain package.
Registers are registered devices with device-bound tokens (see security docs).

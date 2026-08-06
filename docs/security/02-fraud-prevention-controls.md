# Fraud Prevention Controls — Internal / Employee Fraud Catalog

> **Scope.** Retail loss-prevention controls implemented in OmniRetail OS against *internal* fraud: cashier theft, manager collusion, warehouse shrinkage, refund/void abuse, sweethearting. External fraud (stolen cards, e-com chargebacks) is the payment gateway's domain and out of scope here.
>
> **Foundations assumed** (see [`01-security-architecture.md`](./01-security-architecture.md)): every mutation is attributable to `(user_id, device_id)`, the inventory ledger is append-only, and the audit log is hash-chained. These controls are only as strong as that substrate — a control that reads from an editable table is theater.
>
> **Honesty note.** Rules catch *patterns we already know about* (§ Anomaly scoring). They deter and detect the common 80%: skimming via voids/no-sales, refund fraud, discount abuse, receiving theft. They do not catch novel collusion schemes or anything happening entirely off-system (goods walking out the back door unscanned). That's what cycle counts, blind reconciliation, CCTV correlation, and segregation of duties are for.

---

## Control Catalog

Format — **ID · Name**: *Prevents* / *Mechanism* / *Data captured*.

---

### FP-001 · Authenticated-Sale Linkage

- **Prevents:** anonymous transactions; "nobody knows who rang this up" disputes; shared-login accountability holes.
- **Mechanism:** every sale, return, void, drawer event, and price change requires an active cashier session (PIN or badge) layered on a registered device session (device-bound token). The API rejects POS mutations missing either identity. Cashier session auto-locks after configurable idle (default 60 s), so a walk-away till can't be used under someone else's name. Shared PINs are policy-forbidden and detectable (same PIN active on two devices simultaneously → alert).
- **Data captured:** `sale.user_id`, `sale.device_id`, `sale.store_id`, session ID, login method (PIN/badge), local sequence number, client + server timestamps.

### FP-002 · Refund Approval Threshold

- **Prevents:** cashier-initiated fictitious refunds to self or accomplice (classic skimming vector #1).
- **Mechanism:** refunds above a per-tenant threshold (default: $50 or any no-receipt refund) enter `pending_approval` and cannot tender until a user with `sales:refund:approve` approves via dual-auth (FP-010). Refund lines must reference original sale lines (quantity-capped: cannot refund more units than sold, cumulatively across partial refunds). No-receipt refunds always require approval and capture customer ID fields per tenant policy.
- **Data captured:** refund record with `original_sale_id`, line-level linkage, initiator, approver, approval timestamp, reason code (enumerated, not free-text-only), tender type, threshold snapshot at time of transaction.

### FP-003 · Write-off / Damage Adjustment Approval

- **Prevents:** "damaging out" sellable goods and taking them home; shrink hidden as breakage.
- **Mechanism:** inventory adjustments with negative quantity and reason ∈ {damage, spoilage, theft, correction} above threshold (default: cost value $25 or qty 5) require `inventory:adjustment:approve` from a *different* user than the initiator (self-approval blocked at the API even for admins). Adjustment posts to the ledger only on approval; pending adjustments don't move stock. Photos can be attached (configurable requirement per reason code).
- **Data captured:** adjustment ledger entry (append-only), reason code, cost value at time of adjustment, initiator, approver, attachment refs, location/bin.

### FP-004 · Exceptional Discount Approval

- **Prevents:** unauthorized discounting, margin theft, sweethearting via ad-hoc discounts.
- **Mechanism:** discounts beyond the cashier's ceiling (default: 10% line / 5% basket, per-role configurable) require manager dual-auth. Discounts must carry an enumerated reason code. Promotion-engine discounts (automatic) are distinguished from manual discounts in the data model — only manual ones count against ceilings and appear in exception reports.
- **Data captured:** discount type (manual/promo), percent + absolute value, reason code, cashier, approver (if any), SKU, customer ID (if attached to sale).

### FP-005 · Price Override Approval

- **Prevents:** ringing items at arbitrary prices (a $900 phone "sold" for $9).
- **Mechanism:** any deviation from catalog price (that isn't a discount with a reason code) is a `price_override` event, permitted only with `pos:price-override` + dual-auth when deviation exceeds threshold (default 15%). Server re-prices from catalog on sync (architecture §1.2); an override without a matching approved override event is rejected and quarantined.
- **Data captured:** catalog price at time of sale, override price, delta %, initiator, approver, SKU, device, override reason code.

### FP-006 · Serialized-Item Scan Enforcement (IMEI/serial)

- **Prevents:** selling/refunding high-value serialized goods (phones, consoles) against fabricated or reused serials; refund fraud with serials copied from boxes on the shelf.
- **Mechanism:** for SKUs flagged `serial_required`, the POS requires the serial to be **captured by scanner** (barcode/2D scan event from the HID/scanner API), not keyboard-typed. The POS distinguishes scan input (burst inter-character timing + scanner device source in Tauri) from manual typing; manual entry is blocked by default, or — where tenant config allows (`serial_manual_entry: manager_approval`) — permitted only with dual-auth and flagged in exception reports. Serial must exist in on-hand ledger for sales; refund serial must match the serial recorded on the original sale line. Duplicate serial sale attempts hard-fail.
- **Data captured:** serial value, capture method (`scanned | typed_approved`), scanner input timing metadata, ledger serial state transition (in_stock → sold → returned), approver if manual.

### FP-007 · Cash Drawer Event Tracking

- **Prevents:** untracked drawer opens (the physical prerequisite for cash skimming).
- **Mechanism:** the drawer kick is software-controlled; every open is an event with an enumerated cause: `sale_tender`, `refund_tender`, `no_sale`, `paid_in`, `paid_out`, `change_fund`, `drop`, `shift_open`, `shift_close`. `no_sale` and `paid_out` require reason codes; `paid_out` above threshold requires dual-auth. Physical-key opens can't be prevented by software but leave a reconciliation discrepancy (FP-008) and a CCTV-correlatable gap (FP-012).
- **Data captured:** drawer event type, cause, amount (for paid in/out/drop), user, device, timestamp, linked transaction ID where applicable.

### FP-008 · Blind Cash Reconciliation at Shift Close

- **Prevents:** cashiers counting-to-match (skim exactly the overage; adjust count to expected total).
- **Mechanism:** at shift close the cashier counts and enters the drawer denomination-by-denomination **without being shown the expected total** ("blind count"). Only after submission does the system compute over/short against the drawer's event-derived expected cash. Recounts allowed but every submission is versioned — a count revised after seeing the variance is itself a red flag. Variance beyond threshold (default ±$5) requires manager acknowledgment with reason code; repeated small shorts trend in exception reporting (FP-011).
- **Data captured:** per-denomination counts, all count versions with timestamps, expected total (computed server-side from FP-007 events), variance, acknowledging manager, shift ID, cashier.

### FP-009 · Void / No-Sale Monitoring

- **Prevents:** the void-after-tender skim (ring sale, take cash, void it) and no-sale drawer access.
- **Mechanism:** three distinct events, deliberately not conflated: `line_void` (item removed pre-tender), `transaction_void` (whole sale cancelled pre-tender), `post_tender_void` (after payment — always requires dual-auth and, for card tenders, routes through gateway reversal). All voids carry reason codes. Per-cashier rolling counters (voids/shift, void value/shift, no-sales/shift) feed exception reports; configurable hard limits can force manager approval after N voids in a shift.
- **Data captured:** void type, voided lines with values, time-since-tender for post-tender voids, reason code, cashier, approver, running per-shift counters.

### FP-010 · Manager Override with Dual-Auth (Second Badge/PIN)

- **Prevents:** self-approval; "manager mode" toggles that stay on; approval by an absent manager's borrowed session.
- **Mechanism:** every approval (FP-002/003/004/005, post-tender voids, threshold paid-outs, manual serial entry) requires the approver to authenticate **at the moment of approval** on that device — badge scan or PIN — creating a discrete approval event. The approver must differ from the initiator (enforced server-side by user ID, not role). Approval is per-transaction: no sticky elevated mode. Remote approval (manager off-site) is possible via mobile-app push with biometric confirm, recorded as `approval_channel: remote`.
- **Data captured:** approver ID, auth method, approval channel, approved event reference, initiator ID, device, timestamp. Approval events are audit-log entries (hash-chained).

### FP-011 · Exception Reporting (Daily Digest)

- **Prevents:** nothing directly — it makes everything else *reviewed*. Undetected patterns are the actual failure mode of POS controls.
- **Mechanism:** a nightly BullMQ job per tenant compiles a digest per store, delivered to manager/owner (email + in-app), with drill-down links. Sections:
  - **Excessive discounts:** manual discount value and % by cashier vs store baseline (flag > 2σ or > configurable absolute).
  - **Repeated voids:** cashiers exceeding void count/value thresholds; post-tender voids listed individually, always.
  - **After-hours activity:** any POS/inventory mutation outside store hours (server clock), incl. sync of offline events whose *server receipt* is after-hours.
  - **Negative-stock attempts:** sales/transfers rejected or forced past zero on-hand (ledger never goes silently negative; forced sales require a flag and appear here).
  - **Same-card refund patterns:** ≥2 refunds to the same gateway payment-method fingerprint across different sales within 30 d, or refund-to-card ≠ original tender card (blocked by FP-014, attempts logged).
  - **Sweethearting indicators:** same customer account receiving manual discounts from the same cashier ≥3 times/30 d; high no-receipt-return rate per cashier; cashier's average basket discount vs peers.
  - **Reconciliation trends:** per-cashier cumulative over/short (systematic small shorts beat one big one).
  - **Serial-entry exceptions:** every manually-entered serial (FP-006).
- **Data captured:** the digest itself is stored (immutable snapshot) with delivery + read receipts — "manager was told on the 3rd" matters in HR/legal follow-up.

### FP-012 · CCTV Timestamp Correlation (metadata link only)

- **Prevents:** disputes about what physically happened during a flagged transaction; strengthens evidence for HR/prosecution.
- **Mechanism:** we do **not** ingest, analyze, or make any AI claims about video. Each POS device is configured with `camera_ids[]` and a measured clock-offset between the CCTV NVR clock and server time (re-measured at shift open via a manual sync step or NTP-derived offset). Every exception-report line item and drawer event exposes a "locate footage" link rendering: camera IDs + NVR-adjusted timestamp range (event ± configurable padding, default 90 s). Retrieval and interpretation of footage stays entirely with the human reviewer and the CCTV system's own retention/permissions.
- **Data captured:** device↔camera mapping, clock-offset samples with measurement timestamps, correlation lookups performed (who viewed which event's footage link — itself audit-logged).

### FP-013 · Immutable Audit Trail Semantics

- **Prevents:** cover-up after the fact — the difference between a control and a suggestion.
- **Mechanism:** inventory and cash events are append-only ledgers: corrections are *new* reversing entries referencing the original, never UPDATE/DELETE (revoked at the DB grant level; architecture §9). Audit entries are hash-chained per tenant with external anchoring, so even a DBA edit is detectable. POS offline events are device-signed with monotonic sequence numbers; gaps or signature failures at sync quarantine the batch for manager review instead of silently dropping. Every record in this catalog resolves to ledger/audit rows that cannot be quietly rewritten.
- **Data captured:** reversal linkage (`reverses_entry_id`), device signatures, sequence gap flags, chain-verification job results.

### FP-014 · Refund Tender Restriction

- **Prevents:** refunding a cash sale to the fraudster's own card, or a card sale to a different card (self-payment via refund).
- **Mechanism:** card refunds are executed **only** as gateway reversals/refunds against the original charge ID — a different destination card is impossible by construction. Cash refunds of card sales are blocked by default (configurable to manager-dual-auth). Refund tender must match original tender class unless dual-auth override, which is exception-reported.
- **Data captured:** original charge ID, refund gateway reference, tender class match flag, override approver if any.

### FP-015 · Segregation of Duties (Procurement-to-Stock)

- **Prevents:** the classic warehouse fraud loop — create a PO to a friendly vendor, "receive" goods that never arrived, adjust counts to hide it, approve your own paper trail.
- **Mechanism:** RBAC permission strings are partitioned so no single non-owner role can execute an end-to-end procurement or shrink-concealment cycle; the API enforces *different-user* rules on adjacent steps (PO creator ≠ PO approver; receiver ≠ adjustment approver for the same SKUs within a window). Small tenants where one human wears every hat can't have SoD — the system then auto-escalates: owner receives a mandatory weekly conflict report of every same-user adjacent-step action.

  **SoD matrix** (✅ allowed, ⛔ never, 🔶 allowed but exception-reported / different-user rule applies):

  | Action | Owner | Admin | Manager | Warehouse | Cashier |
  |---|---|---|---|---|---|
  | Create purchase order | ✅ | ✅ | ✅ | 🔶 | ⛔ |
  | Approve purchase order | ✅ | ✅ (not own) | 🔶 (not own, ≤ threshold) | ⛔ | ⛔ |
  | Receive goods against PO | 🔶 | 🔶 | 🔶 | ✅ (not PO creator) | ⛔ |
  | Create inventory adjustment | ✅ | ✅ | ✅ | ✅ | ⛔ |
  | Approve adjustment / write-off | ✅ (not own) | ✅ (not own) | ✅ (not own) | ⛔ | ⛔ |
  | Approve refund / override / post-tender void | ✅ | ✅ | ✅ (not own) | ⛔ | ⛔ |
  | Initiate stock count | ✅ | ✅ | ✅ | ✅ | ⛔ |
  | Post/accept count variances | ✅ | ✅ | ✅ (not counter for that count) | ⛔ | ⛔ |
  | Edit vendor master data | ✅ | ✅ | 🔶 | ⛔ | ⛔ |
  | Change catalog prices | ✅ | ✅ | 🔶 (store scope) | ⛔ | ⛔ |
  | Manage roles/permissions | ✅ | ✅ (below admin) | ⛔ | ⛔ | ⛔ |

- **Data captured:** every 🔶 event lands in the exception digest; same-user adjacent-step attempts are logged whether blocked or allowed-with-flag.

### FP-016 · Anomaly Scoring (rules first, ML later)

- **Prevents:** analyst overload — turns FP-011's raw exceptions into a ranked review queue.
- **Mechanism — phase 1 (rules, shipping now):** each cashier/device/store gets a daily score = weighted sum of normalized rule hits (void rate vs store baseline, manual-discount ratio, no-receipt return rate, reconciliation short trend, after-hours count, serial manual entries, same-customer discount repetition). Weights are tenant-configurable with sane defaults; every score is **explainable** — the UI shows exactly which rules fired with the underlying transactions. Thresholds trigger digest prominence, not automated punishment.
  **What rules honestly catch:** known patterns with clear data signatures — refund/void abuse, discount abuse, drawer manipulation, receiving fraud with paper trails. **What they don't:** collusion that stays under every threshold, novel schemes, off-system theft, or a manager who is the reviewer *and* the fraudster (mitigate: owner-level digest includes manager-actor exceptions; reviewers can't edit or suppress their own line items).
  **Phase 2 (ML, later, explicitly not promised as magic):** unsupervised peer-group outlier detection over the same feature set to *rank* cases, only once ≥12 months of labeled outcomes exist from phase 1 investigations. ML output will never auto-accuse; it reorders the human review queue, and every flag still resolves to raw ledger evidence.
- **Data captured:** daily feature vectors per actor, score with per-rule contributions, reviewer disposition (confirmed / benign / inconclusive) — dispositions become the future ML label set.

---

## Control → Data Dependencies → Reviewer Matrix

| Control | Key events / tables relied on | Primary reviewer | Escalation |
|---|---|---|---|
| FP-001 Authenticated-sale linkage | `sales`, `pos_sessions`, `devices`, `audit_log` | Store manager (spot check) | Owner/admin |
| FP-002 Refund approval | `refunds`, `refund_lines`→`sale_lines`, `approvals`, `audit_log` | Store manager (real-time), owner (digest) | Owner |
| FP-003 Write-off approval | `inventory_ledger` (adjustment entries), `approvals`, attachments | Inventory/ops manager | Owner |
| FP-004 Discount approval | `sale_line_discounts` (manual vs promo flag), `approvals` | Store manager | Owner |
| FP-005 Price override | `price_override_events`, catalog price snapshots, `approvals` | Store manager | Owner |
| FP-006 Serial scan enforcement | `serial_ledger`, `scan_capture_meta`, `approvals` | Store manager | Loss-prevention lead |
| FP-007 Drawer events | `drawer_events`, linked `sales`/`refunds` | Store manager | — |
| FP-008 Blind reconciliation | `shift_counts` (versioned), `drawer_events`, computed expected-cash | Store manager (per shift), owner (trend) | Owner |
| FP-009 Void/no-sale monitoring | `void_events`, `drawer_events(no_sale)`, per-shift counters | Store manager | Loss-prevention lead |
| FP-010 Dual-auth overrides | `approvals`, `audit_log` (hash-chained) | Owner/admin (pattern review) | — |
| FP-011 Exception digest | Aggregates all of the above + `digest_snapshots`, read receipts | Store manager (daily), owner (weekly roll-up) | Owner |
| FP-012 CCTV correlation | `device_camera_map`, `clock_offset_samples`, event timestamps | Loss-prevention lead / manager | HR/legal |
| FP-013 Immutable audit trail | `audit_log` chain, `inventory_ledger`, device signatures, anchor verifications | Security engineering (chain jobs), auditors | CISO/owner |
| FP-014 Refund tender restriction | `refunds`, gateway charge references, `approvals` | Store manager | Owner |
| FP-015 Segregation of duties | `purchase_orders`, `receipts`, `inventory_ledger`, `approvals`, role assignments | Owner (weekly conflict report) | External auditor |
| FP-016 Anomaly scoring | `anomaly_scores`, feature vectors, reviewer dispositions | Loss-prevention lead / owner | HR/legal |

**Review cadence contract:** FP-011's digest is the backbone — controls without a named reviewer and cadence decay into noise. Tenant onboarding requires assigning the "Primary reviewer" column to real users before POS go-live; unassigned digests escalate to the owner automatically after 7 days unread.

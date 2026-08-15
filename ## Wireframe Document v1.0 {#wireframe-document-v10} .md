# Voltix Commerce OS

## Wireframe Document v1.0

**Status:** Draft for design review · **Date:** 12 August 2026 · **Companion to:** PRD v2.0, TRD v2.0 · **Interactive prototype:** `voltix-wireframes.html`

* * *

## 0\. How to read this document

**AUDIT:** wireframing was skipped entirely before the original build. Information architecture emerged from the navigation, user flows were implicit in the state machines, and screens were never designed — only tokens were. This document closes that gap for the surfaces being built, and specifies the existing screens only where they change.

These are **low\-fidelity structural wireframes**. They fix layout, hierarchy, state coverage and interaction; they do not fix colour, typography or spacing, which live in the Design Document.

Every screen specification carries the same seven parts:

| Part | What it answers |
| --- | --- |
| **Purpose** | Why the screen exists, in one sentence |
| **Primary action** | The single thing this screen is for. If there are two, the screen is wrong |
| **Layout** | Structural wireframe |
| **States** | Default, empty, loading, error, permission\-denied, offline where applicable |
| **Interaction** | Keyboard, scanner, touch, focus order |
| **Data** | What is fetched and what it costs |
| **Notes** | Decisions, risks and open questions |

**AUDIT gap being closed throughout:** no admin screen has a loading skeleton — every one relies on RSC streaming, so on a slow connection the admin appears frozen. Every screen below specifies its loading state. This is not optional polish; on a Sharjah 4G connection it is the difference between "slow" and "broken".

* * *

## 1\. Information architecture

### 1\.1 Four surfaces

```
STOREFRONT (public)        POS (till)              ADMIN (back office)        CHANNELS (headless)
├─ Home                    ├─ Sale            ┌─ SELL                          ├─ noon
├─ Search / category       ├─ Park / resume   │  ├─ Dashboard                  └─ Amazon.ae
├─ Product detail          ├─ Returns         │  ├─ Orders  (all channels)
├─ Cart                    ├─ Unit lookup     │  ├─ Products
├─ Checkout                ├─ Shift           │  └─ Customers
├─ Confirmation            └─ Settings        ├─ STOCK
├─ Track order                                │  ├─ Inventory
└─ Delivery / Returns /                       │  ├─ Serial units      ← new
   Contact                                    │  ├─ Stocktake         ← new
                                              │  ├─ Transfers         ← new
                                              │  ├─ Purchase orders   ← new
                                              │  └─ Suppliers         ← new
                                              ├─ FULFIL
                                              │  ├─ Shipments         ← new
                                              │  └─ Returns
                                              ├─ MONEY                ← new group
                                              │  ├─ Tax documents
                                              │  ├─ Payments
                                              │  └─ Reports
                                              ├─ CHANNELS             ← new group
                                              │  ├─ Sync health
                                              │  └─ Listings
                                              └─ SETUP
                                                 ├─ Messages
                                                 ├─ Staff & roles
                                                 ├─ Tax settings      ← new
                                                 └─ Terminals         ← new
```

**AUDIT — a decision worth keeping.** Unbuilt sections are currently shown as greyed, non\-clickable labels rather than dead links. It communicates the roadmap without shipping broken navigation. Keep it, and extend it to the new groups.

### 1\.2 Navigation model per surface

| Surface | Model | Rationale |
| --- | --- | --- |
| Storefront | Top nav \+ search, mobile bottom\-anchored cart | Standard, works, unchanged |
| POS | **No navigation chrome on the sale screen.** Everything else is behind one menu button | The cashier has one job. Navigation on the sale screen is a source of mis\-taps |
| Admin | Left sidebar, grouped, collapsible to icons below 1200px, drawer below 900px | **AUDIT:** currently collapses below 900px and becomes unusable — this fixes it |

* * *

## 2\. POS — the new surface

The POS is specified first because it is the largest new surface and the one with the least prior art in this codebase.

### 2\.1 Screen: Sale

**Purpose.** Ring a sale, take payment, print. Nothing else.

**Primary action.** Tender.

**Layout — 1280×800 landscape, the reference till**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ☰  Voltix POS      Till 1 · Kabir      ⟳ synced        14:32   ⏻ Shift  │  56px
├────────────────────────────────────────────┬─────────────────────────────┤
│                                            │                             │
│  ┌──────────────────────────────────────┐  │   CART                      │
│  │ 🔍  Scan or search…            [⌨]   │  │   ─────────────────────     │
│  └──────────────────────────────────────┘  │                             │
│   ↑ ALWAYS FOCUSED. Scanner lands here     │   iPhone 15 Pro 256GB       │
│                                            │   Natural Titanium          │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────┐ │   IMEI ·· 3809       [✎][×] │
│  │        │ │        │ │        │ │      │ │   1 × 4,299.00    4,299.00  │
│  │ iPhone │ │ Galaxy │ │ Airpods│ │ USB-C│ │                             │
│  │ 15 Pro │ │  S24   │ │  Pro 2 │ │ 65W  │ │   AirPods Pro 2             │
│  │        │ │        │ │        │ │      │ │   2 × 899.00      1,798.00  │
│  │ 4,299  │ │ 3,199  │ │  899   │ │ 149  │ │                     [-][+]  │
│  │ ● 4    │ │ ● 12   │ │ ● 31   │ │ ● 8  │ │                             │
│  └────────┘ └────────┘ └────────┘ └──────┘ │   ─────────────────────     │
│                                            │   Subtotal        5,806.67  │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────┐ │   VAT 5%            290.33  │
│  │ Pixel  │ │ Case   │ │ Screen │ │ Power│ │   ─────────────────────     │
│  │  9     │ │        │ │ Guard  │ │ Bank │ │   TOTAL       AED 6,097.00  │
│  │        │ │        │ │        │ │      │ │                             │
│  │ 2,799  │ │   89   │ │   45   │ │  199 │ │   👤 + Add customer         │
│  │ ○ 0    │ │ ● 44   │ │ ● 120  │ │ ● 15 │ │   🏢 Business sale (TRN)    │
│  └────────┘ └────────┘ └────────┘ └──────┘ │                             │
│                                            │  ┌───────────────────────┐  │
│  [ All ] [ Phones ] [ Audio ] [ Access… ]  │  │      T E N D E R      │  │  72px
│                                            │  └───────────────────────┘  │
│                                            │  [ Park ]        [ Clear ]  │
└────────────────────────────────────────────┴─────────────────────────────┘
        60% — search & grid                     40% — cart, fixed 420px min
```

**States**

| State | Behaviour |
| --- | --- |
| Empty cart | Grid shows the 12 most\-sold products of the last 30 days. Cart panel reads "Scan an item to start", not "No items" |
| Item out of stock | Tile shows `○ 0`, is dimmed but **still tappable** — tapping explains "0 in stock at this branch · 4 at Sharjah" with a transfer request action. Never a dead tile with no explanation |
| Serialised item added | Cart line appears immediately in a pending state; a modal takes over demanding the IMEI scan (§2.2) |
| Offline | Header sync chip turns amber: `⚠ offline · 3 queued`. Stock counts on tiles get a dotted underline meaning "as of 14:12" |
| Loading catalogue at shift open | Full\-screen progress with a count: "Loading catalogue — 1,840 of 2,310". This happens once per shift and honesty beats a spinner |
| Permission denied | Discount and price\-override controls are absent, not disabled — a cashier should not see affordances they cannot use |

**Interaction**

- Search input holds focus permanently. Any keystroke anywhere returns focus to it, except while a modal is open.
- Scanner detection by inter\-keystroke timing; the input never visibly "types" a scan, it resolves it.
- `F1` tender · `F2` park · `F3` customer · `F4` discount (permission) · `Esc` closes any modal, never the sale.
- Touch targets minimum 44×44px; product tiles are 160×160.
- **No double\-tap destroys anything.** Clear cart requires a confirmation naming the item count.

**Data.** Everything from the local IndexedDB snapshot. Zero network calls during a sale. This is what makes it fast and what makes it work offline.

**Notes.** The grid exists for accessories a customer hands over without a scannable barcode and for the cashier who has not memorised SKUs. It is not the primary path — scanning is. If telemetry shows the grid carrying more than about a third of lines, the scanner setup is wrong and that is the thing to fix.

### 2\.2 Modal: IMEI capture

**Purpose.** Bind a specific physical unit to a sale line. This is the product's core promise (R2.5) and the moment it either happens or does not.

```
┌───────────────────────────────────────────────────────┐
│  Scan the IMEI                                   [×]  │
│  iPhone 15 Pro 256GB · Natural Titanium               │
│                                                       │
│      ┌───────────────────────────────────────┐        │
│      │                                       │        │
│      │        [ ▌                        ]   │        │
│      │                                       │        │
│      └───────────────────────────────────────┘        │
│        Scan the barcode on the box, or type 15 digits │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │ ⚠  This box has 3 barcodes.                     │  │
│  │    Scan the one labelled IMEI (usually first).  │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  Available in this branch: 4                          │
│  ·· 3809  ·· 4471  ·· 8820  ·· 1156   [ pick from list ]│
│                                                       │
│                         [ Cancel ]   [ 📷 Use camera ] │
└───────────────────────────────────────────────────────┘
```

**States**

| State | Behaviour |
| --- | --- |
| Valid, in stock here | Modal closes instantly, the cart line resolves, a soft confirmation tone plays. No confirm button — the scan *is* the confirmation |
| Fails Luhn | Field turns red inline: "Not a valid IMEI — check the last digit". Stays open. Does not clear what was typed |
| Not in this tenant | "This IMEI isn't in your stock. Received today? Add it to a purchase order first." with a link, permission allowing |
| In stock at another branch | "In stock at Sharjah, not here." Offers a transfer request. Does not allow the sale |
| Already sold | **Hard block, red.** "Sold on 3 March 2026 on INV\-2026\-00871." Links to that invoice. This is the duplicate\-sale guard being visible |
| Reserved by an online order | "Held for order \#10428." Offers release with permission |
| Offline | Validates against the local serial index; unknown IMEIs are allowed through with a warning badge and resolved on sync |

**Interaction.** The field autofocuses. A scan submits on the terminator with no Enter needed. `Esc` cancels and removes the pending cart line. The picker list exists for a box whose label is damaged — a real, frequent occurrence.

**Notes.** The three\-barcode warning is not decoration. **RESEARCH:** phone boxes carry IMEI1, IMEI2 for dual\-SIM, plus a serial and a part number, and taking the first read blindly is the most common capture error in this category.

### 2\.3 Screen: Tender

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ← Back to sale                                        TOTAL  AED 6,097  │
├────────────────────────────────────┬─────────────────────────────────────┤
│                                    │                                     │
│   ┌──────────┐  ┌──────────┐       │   TENDERED                          │
│   │          │  │          │       │   ───────────────────────────       │
│   │   CASH   │  │   CARD   │       │   Cash              6,000.00  [×]   │
│   │          │  │ external │       │                                     │
│   └──────────┘  └──────────┘       │   ───────────────────────────       │
│                                    │   Remaining        AED   97.00      │
│   ┌──────────┐  ┌──────────┐       │                                     │
│   │  TABBY   │  │  STORE   │       │                                     │
│   │          │  │  CREDIT  │       │                                     │
│   └──────────┘  └──────────┘       │                                     │
│                                    │                                     │
│   ── CASH ────────────────────     │                                     │
│   ┌────────────────────────────┐   │                                     │
│   │  6,000.00                  │   │                                     │
│   └────────────────────────────┘   │                                     │
│   [6097 exact] [6100] [6500] [7000]│                                     │
│   [ 7 ][ 8 ][ 9 ]                  │  ┌───────────────────────────────┐  │
│   [ 4 ][ 5 ][ 6 ]                  │  │   COMPLETE  ·  AED 97 due     │  │
│   [ 1 ][ 2 ][ 3 ]                  │  └───────────────────────────────┘  │
│   [ 0 ][00 ][ ⌫ ]                  │                                     │
└────────────────────────────────────┴─────────────────────────────────────┘
```

**States**

| State | Behaviour |
| --- | --- |
| Cash over\-tendered | The Complete button becomes `COMPLETE · CHANGE AED 403.00` in high contrast. Change is the biggest number on the screen because it is what the cashier acts on |
| Card selected | Panel shows: amount to key into the terminal, then an approval\-code field. Nothing is recorded until the code is entered |
| Tabby selected | Phone number field → "Sending link…" → a pending state with a live countdown and a Cancel button → approved or expired |
| Offline | Card (external) and cash remain available. Tabby and store credit are visibly unavailable with the reason: "needs connection" |
| Split tender | Each tender appends to the right\-hand list with its own remove control; Complete stays disabled while Remaining \> 0 |
| Business sale, RCM applies | A banner above the total: "Reverse charge — no VAT charged. Declaration on file." The total changes and the reason is stated (§2.4) |

**Interaction.** The numeric keypad is on\-screen and also bound to the physical numpad. `Enter` on an exact amount completes. **`Esc` returns to the sale and never discards tenders already taken** — losing a recorded cash tender is unrecoverable.

### 2\.4 Modal: Business sale and reverse charge

**Purpose.** Capture what UAE tax law requires at the moment of sale, without turning the counter into a form.

```
┌─────────────────────────────────────────────────────────────┐
│  Business sale                                         [×]  │
│                                                             │
│  TRN            [ 100234567800003        ]  ✓ 15 digits     │
│  Legal name     [ Al Noor Trading LLC    ]                  │
│  Address        [ Shop 12, Naif, Deira, Dubai ]             │
│  Emirate        [ Dubai              ▾ ]  ← branch emirate  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  ☑  Buying for resale or manufacture                  │  │
│  │                                                       │  │
│  │  Phones, computers and tablets sold to a VAT-         │  │
│  │  registered buyer for resale are reverse charged.     │  │
│  │  You charge no VAT — the buyer accounts for it.       │  │
│  │  Cabinet Decision 91 of 2023.                         │  │
│  │                                                       │  │
│  │  The declaration must state BOTH:                     │  │
│  │   ☑ intent to resell or manufacture                   │  │
│  │   ☑ that the buyer is registered with the FTA         │  │
│  │                                                       │  │
│  │      ┌─────────────────────────────────────────┐      │  │
│  │      │   ✍  Sign here                          │      │  │
│  │      └─────────────────────────────────────────┘      │  │
│  │      [ Or upload a signed declaration ]               │  │
│  │      [ ✓ Declaration already on file — 4 Feb 2026 ]   │  │
│  │                                                       │  │
│  │  Registration verified   ☐ not yet                    │  │
│  │  [ How we verify ▾ ]                                  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  This sale:  VAT-exclusive · 0% RCM on 2 device lines       │
│              Accessories stay standard-rated at 5%          │
│              AED 5,806.67  (was AED 6,097.00 with VAT)      │
│                                                             │
│                        [ Cancel ]      [ Apply ]            │
└─────────────────────────────────────────────────────────────┘
```

**States**

| State | Behaviour |
| --- | --- |
| No declaration captured | Apply is disabled with one sentence: "A signed declaration is needed before reverse charge can apply." The sale can still proceed at standard 5% |
| Declaration captured, registration not verified | Apply stays disabled. **RESEARCH:** the supplier must *verify* the buyer's registration by a means approved by the FTA — retaining the declaration alone is not enough |
| Declaration already on file | Shown with its date and a "replace" action. Repeat trade customers should not re\-sign every visit |
| Buyer is registered but not reselling | Standard 5% VAT. **RCM does not apply to a buyer purchasing for their own business use** — the FTA's own example is handsets issued to employees. Above AED 10,000 this still needs a **full** tax invoice, not a simplified receipt |
| Mixed cart — devices and accessories | Only qualifying device lines get the RCM code. The line\-by\-line split is shown; this is where a wrong assumption becomes a tax liability |
| Line is a zero\-rated export | RCM does not apply — zero\-rating takes precedence. The line is excluded from the RCM set and labelled |
| TRN fails the format check | Inline, non\-blocking warning. We do not have live TRN verification — do not imply that we do |

**Notes.** **RESEARCH, verified:** the burden sits on the *supplier* to obtain, **verify** and retain the declaration. Without it the supplier remains liable for the VAT. The interface therefore refuses to apply RCM without both a stored declaration and a recorded verification step, and says why in one sentence — no legal essay at a busy counter.

**Emirate is the branch, not the buyer.** The emirate field defaults to the selling branch's emirate and is not derived from the customer's address. **RESEARCH:** VAT return Box 1 is reported by the emirate of the fixed establishment most closely connected to the supply. The exception is e\-commerce supplies by a "qualifying registrant" (over AED 100m of e\-commerce supplies in the calendar year), which report by where the customer receives the supply — far above this business's scale, but the data model should not make it impossible.

**OPEN — W5 / Q10:** what means of verifying a buyer's FTA registration is actually available to a retailer at the counter. If no lookup service exists, this control becomes "record what evidence was seen", and the copy must change to match.

### 2\.5 Screen: Unit lookup — the differentiator, made visible

**Purpose.** Answer "what is this handset" from nothing but the handset. This is the screen that closes the audit's P\-03 finding, and it is what a competitor cannot copy quickly.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ← Back                          UNIT LOOKUP                             │
├──────────────────────────────────────────────────────────────────────────┤
│   ┌────────────────────────────────────────────────────────────────┐     │
│   │ 🔍  356938035643809                                            │     │
│   └────────────────────────────────────────────────────────────────┘     │
│                                                                          │
│   ┌────────────────────────────────────────────────────────────────┐     │
│   │  iPhone 15 Pro 256GB · Natural Titanium                        │     │
│   │  IMEI 356938035643809      IMEI2 356938035643817               │     │
│   │                                                                │     │
│   │  ┌──────────────────────────────────────────────────────────┐  │     │
│   │  │  ✓  UNDER WARRANTY — 218 days remaining                  │  │     │
│   │  │     Shop warranty · expires 6 March 2027                 │  │     │
│   │  └──────────────────────────────────────────────────────────┘  │     │
│   │                                                                │     │
│   │  ●─── Received      12 Jan 2026   PO-1042 · Gulf Mobile Dist. │     │
│   │  │                                Cost AED 3,880  [finance]   │     │
│   │  ●─── Transferred   28 Jan 2026   Deira → Sharjah             │     │
│   │  ●─── Sold           6 Mar 2026   INV-2026-00871 · Till 1     │     │
│   │  │                                Ahmed K. · +971 5• ••• 4471 │     │
│   │  │                                AED 4,299 · Kabir           │     │
│   │  ●─── Returned      14 Mar 2026   Screen fault · inspected    │     │
│   │  ●─── RMA           16 Mar 2026   Supplier claim SC-0093      │     │
│   │  ●─── Back in stock 02 Apr 2026   Replaced by supplier        │     │
│   │  ●─── Sold          19 Apr 2026   INV-2026-01204              │     │
│   │                                                                │     │
│   │  [ Start return ]  [ Print history ]  [ Open invoice ]         │     │
│   └────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────┘
```

**States**

| State | Behaviour |
| --- | --- |
| Not found | "No unit with this IMEI." Offers: search by partial · check another branch · this may be grey\-market stock |
| In stock, never sold | Timeline stops at Received. Shows the current branch, shelf location and asking price |
| Out of warranty | Red badge with the expiry date and how long ago. Offers a paid repair job ticket |
| Cost hidden | The cost row is absent for a cashier, not blurred or marked "hidden" — **AUDIT:** the `finance:read` separation already exists and is enforced; do not hint at what is withheld |
| Multiple returns | Timeline scrolls; the most recent event is anchored at the bottom and highlighted |

**Notes.** The timeline is the product's argument in one screen. It is worth building well, and it is the right screenshot for any future sales conversation. **AUDIT:** the homepage already promises this ("the IMEI recorded against your order") while `serial_units` is never written — this screen is the promise being kept.

### 2\.6 Screen: Shift open and close

```
OPEN                                    CLOSE — blind count
┌───────────────────────────┐          ┌────────────────────────────────┐
│  Open shift · Till 1      │          │  Close shift · Till 1          │
│                           │          │                                │
│  Cashier   Kabir R.       │          │  Count the drawer and enter    │
│  Opening float            │          │  the total. You'll see the     │
│  ┌─────────────────────┐  │          │  expected figure after.        │
│  │  AED  500.00        │  │          │                                │
│  └─────────────────────┘  │          │  500 × [ 2 ]      1,000.00     │
│                           │          │  200 × [ 8 ]      1,600.00     │
│  Catalogue: 2,310 items   │          │  100 × [12 ]      1,200.00     │
│  Last sync 3 min ago      │          │   50 × [ 6 ]        300.00     │
│                           │          │   ...                          │
│  ┌─────────────────────┐  │          │  ───────────────────────────   │
│  │    Open shift       │  │          │  Counted        AED 4,220.00   │
│  └─────────────────────┘  │          │                                │
└───────────────────────────┘          │  [ Submit count ]              │
                                       └────────────────────────────────┘
                                                     ↓
                                       ┌────────────────────────────────┐
                                       │  Expected      AED 4,265.00    │
                                       │  Counted       AED 4,220.00    │
                                       │  ─────────────────────────     │
                                       │  Short         AED    45.00    │
                                       │                                │
                                       │  Reason  [ ................. ] │
                                       │  Recorded against Kabir R.     │
                                       │            [ Confirm close ]   │
                                       └────────────────────────────────┘
```

**States**

| State | Behaviour |
| --- | --- |
| Unsynced sales pending | **Close is blocked.** "3 sales not yet synced. Reconnect before closing." Sign\-out is blocked too. This is the single rule standing between a queued sale and permanent loss |
| Variance over the threshold | Reason becomes mandatory; a manager approval prompt appears above a configurable amount |
| Perfect count | Confirms cleanly, no ceremony. Do not celebrate a correct count — it is the expectation |

**Notes.** Blind counting is deliberate: showing the expected figure first makes the count meaningless. The denomination helper is not decoration — it is how a real drawer gets counted, and it reduces arithmetic errors that would otherwise be recorded as shrinkage.

* * *

## 3\. Admin — new and changed screens

### 3\.1 Screen: Product editor *(closes P\-01, the most serious gap)*

**Purpose.** Let a merchant create and maintain the catalogue without a developer.

**AUDIT:** the catalogue can currently only be populated by `npm run db:seed` or direct SQL. This screen is why the admin becomes an admin.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ← Products          iPhone 15 Pro                    [Draft ▾] [ Save ]  │
├────────────────────────────────────────────┬─────────────────────────────┤
│                                            │                             │
│  ┌── BASICS ───────────────────────────┐   │  ┌── STATUS ─────────────┐  │
│  │ Title EN  [ iPhone 15 Pro         ] │   │  │ ○ Draft               │  │
│  │ Title AR  [ آيفون 15 برو          ] │   │  │ ● Published           │  │
│  │ Category  [ Smartphones         ▾ ] │   │  │ ○ Archived            │  │
│  │ Brand     [ Apple               ▾ ] │   │  │                       │  │
│  └─────────────────────────────────────┘   │  │ Publishing needs:     │  │
│                                            │  │ ✓ price > 0           │  │
│  ┌── SERIALISATION ────────────────────┐   │  │ ✓ 1+ variant          │  │
│  │ ☑ Track every unit by IMEI/serial   │   │  │ ✗ Arabic title        │  │
│  │                                     │   │  └───────────────────────┘  │
│  │ Every unit must be scanned when     │   │                             │
│  │ received and when sold.             │   │  ┌── CHANNELS ───────────┐  │
│  │ ⚠ Cannot be turned off once units   │   │  │ ☑ Storefront          │  │
│  │   exist.                            │   │  │ ☑ POS                 │  │
│  └─────────────────────────────────────┘   │  │ ☑ noon    buffer [2]  │  │
│                                            │  │ ☐ Amazon.ae           │  │
│  ┌── WARRANTY ─────────────────────────┐   │  └───────────────────────┘  │
│  │ Period [ 12 ] months                │   │                             │
│  │ Provider [ Manufacturer         ▾ ] │   │  ┌── MEDIA ──────────────┐  │
│  └─────────────────────────────────────┘   │  │  [+] [img] [img]      │  │
│                                            │  └───────────────────────┘  │
│  ┌── VARIANTS ─────────────────────────────────────────────────────────┐ │
│  │ Options: Colour [Natural Ti, Blue Ti] × Storage [256GB, 512GB]      │ │
│  │ ┌────────────────┬──────────┬────────┬────────┬────────┬──────────┐ │ │
│  │ │ Variant        │ SKU      │ Cost   │ Price  │ Stock  │ Serial   │ │ │
│  │ ├────────────────┼──────────┼────────┼────────┼────────┼──────────┤ │ │
│  │ │ Natural·256GB  │ IP15P-N2 │ 3,880  │ 4,299  │   4    │ tracked  │ │ │
│  │ │ Natural·512GB  │ IP15P-N5 │ 4,510  │ 4,999  │   2    │ tracked  │ │ │
│  │ │ Blue·256GB     │ IP15P-B2 │ 3,880  │ 4,299  │   0    │ tracked  │ │ │
│  │ └────────────────┴──────────┴────────┴────────┴────────┴──────────┘ │ │
│  │ [ + Add variant ]   [ Bulk edit ]                                   │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

**States**

| State | Behaviour |
| --- | --- |
| New product | Everything empty; Publish disabled with a live checklist showing exactly what is missing |
| Publish blocked | The checklist is the error message. Never a generic "please fill required fields" |
| Serialisation toggle after units exist | Locked with an explanation; the only path is archiving and recreating |
| Unsaved changes | Sticky footer bar: "Unsaved changes · \[Discard\] \[Save\]". Navigation warns |
| Save failed | Inline at the failing field where possible; a banner only when the failure is not field\-specific. **Never lose typed input** |
| Loading | Skeleton matching the real layout, not a spinner — **AUDIT:** admin has none today |

**Interaction.** `⌘S` / `Ctrl+S` saves. The variant table is keyboard\-navigable cell to cell like a spreadsheet, because that is what merchants expect and it is how bulk price edits actually get done. Arabic fields are RTL inputs inside an LTR form — this is the specific detail most implementations get wrong.

### 3\.2 Screen: Stocktake

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ← Inventory     STOCKTAKE · Deira · started 14:02 by Amal               │
├──────────────────────────────────────────────────────────────────────────┤
│  Scope: Smartphones          Counted 184 of ~210 expected                │
│  ████████████████████████████████████░░░░░░░                             │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ 🔍 Scan an item or IMEI…                                           │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  RECENT                                                                  │
│  14:31  iPhone 15 Pro 256 Natural   ·· 3809   ✓                          │
│  14:31  iPhone 15 Pro 256 Natural   ·· 4471   ✓                          │
│  14:30  AirPods Pro 2                  ×3     ✓                          │
│  14:30  Galaxy S24 128 Black        ·· 9920   ⚠ system says SOLD         │
│  14:29  USB-C 65W                      ×12    ✓                          │
│                                                                          │
│  ┌──────────────────────┐              ┌──────────────────────────────┐  │
│  │  Pause               │              │  Review variance  →          │  │
│  └──────────────────────┘              └──────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  VARIANCE · 7 differences · net −AED 8,441                               │
│  ┌──────────────────────┬──────────┬─────────┬──────────┬─────────────┐  │
│  │ Item                 │ Expected │ Counted │ Variance │ Value       │  │
│  ├──────────────────────┼──────────┼─────────┼──────────┼─────────────┤  │
│  │ iPhone 15 Pro 256 N  │    4     │    3    │   −1     │  −3,880.00  │  │
│  │ Galaxy S24 128 Black │    2     │    3    │   +1  ⚠  │  +2,340.00  │  │
│  │ AirPods Pro 2        │   31     │   28    │   −3     │  −1,890.00  │  │
│  │ …                                                                  │  │
│  └──────────────────────┴──────────┴─────────┴──────────┴─────────────┘  │
│                                                                          │
│  ⚠ 1 serialised unit was counted that the system records as sold.        │
│    It will be raised as an exception, not restocked automatically.       │
│                                                                          │
│  Reason for adjustments  [ Quarterly count — Deira            ]          │
│                                        [ Cancel ]  [ Post count ]        │
└──────────────────────────────────────────────────────────────────────────┘
```

**States**

| State | Behaviour |
| --- | --- |
| Duplicate scan | Inline "already counted at 14:29" — does not increment |
| Unknown barcode | "Not in the catalogue. \[Create product\] or \[Skip and note\]" |
| Serialised unit recorded as sold | Amber inline, listed separately in the variance review, **never silently reinstated** |
| Paused | Session persists; anyone with permission can resume; the header shows who paused and when |
| Posting | One transaction. Progress shown. A failure rolls back everything, and says so |

**Notes.** **AUDIT** rated stock drift the highest\-probability failure — "will happen in week one" — because no correction path existed at all. This screen and its adjustment sibling are that path.

### 3\.3 Screen: Receive against a purchase order

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ← Purchase orders     RECEIVE PO-1042 · Gulf Mobile Distribution        │
├──────────────────────────────────────────────────────────────────────────┤
│  Ordered 8 Jan · Expected 12 Jan · AED 47,320                            │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ 🔍 Scan IMEI or item barcode…                                      │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌──────────────────────────┬──────────┬───────────┬──────────────────┐  │
│  │ Line                     │ Ordered  │ Received  │                  │  │
│  ├──────────────────────────┼──────────┼───────────┼──────────────────┤  │
│  │ iPhone 15 Pro 256 Nat.   │    6     │  ███░ 4   │ [ scan ] serial  │  │
│  │   ·· 3809 ·· 4471 ·· 8820 ·· 1156                                  │  │
│  │ iPhone 15 Pro 512 Nat.   │    2     │  ████ 2   │ ✓ complete       │  │
│  │ AirPods Pro 2            │   20     │  ████ 20  │ ✓ complete       │  │
│  │ USB-C 65W                │   50     │  ██░░ 30  │ [ 30 ] of 50     │  │
│  └──────────────────────────┴──────────┴───────────┴──────────────────┘  │
│                                                                          │
│  ┌── LANDED COST ─────────────────────────────────────────────────────┐  │
│  │ Freight [  850.00 ]  Duty [ 0.00 ]  Clearing [ 120.00 ]            │  │
│  │ Distribute by ( ● value  ○ weight )   → unit cost updated on post  │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  [ Save progress ]         [ Receive partial ]      [ Receive & close ]  │
└──────────────────────────────────────────────────────────────────────────┘
```

**States**

| State | Behaviour |
| --- | --- |
| Over\-receipt | "6 ordered, 7 scanned." Blocks close until resolved: amend the PO or reject the extra unit |
| Duplicate IMEI in this tenant | Amber: "This IMEI was received before on PO\-0988." Requires explicit acknowledgement — the cheapest grey\-stock and double\-receipt detector available |
| Partial receipt | PO stays open with what remains; a second receipt session continues it |
| Non\-serialised line | Simple quantity field; no scanning ceremony where none is needed |

### 3\.4 Screen: Channel sync health

**Purpose.** Answer "is my stock right on noon" in under five seconds, and show the truth when it is not.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  CHANNELS                                                                │
├──────────────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────┐  ┌────────────────────────┐                  │
│  │  noon                  │  │  Amazon.ae             │                  │
│  │  ● Healthy             │  │  ⚠ Degraded            │                  │
│  │  Last push  14:31      │  │  Last push  13:58      │                  │
│  │  Queue      0          │  │  Queue      142        │                  │
│  │  Listings   1,204      │  │  Listings   890        │                  │
│  │  Drift      0          │  │  Drift      3 SKUs     │                  │
│  └────────────────────────┘  └────────────────────────┘                  │
│                                                                          │
│  ⚠ ATTENTION                                                             │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Amazon rate limited since 13:58 · retrying with backoff            │  │
│  │ 142 stock updates queued · oldest 34 min                           │  │
│  │                                          [ Details ] [ Force sync ]│  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │ 3 SKUs disagree with Amazon's reported stock                       │  │
│  │ IP15P-N2  we say 3 · Amazon says 5   [ Push ours ] [ Investigate ] │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  RECENT PUSHES                                                           │
│  14:31  noon    IP15P-N2   4 → 3   sale · POS Till 1        ✓ 240ms      │
│  14:31  amazon  IP15P-N2   4 → 3   sale · POS Till 1        ⏳ queued    │
│  14:28  noon    APP2       31 → 28 stocktake                ✓ 180ms      │
└──────────────────────────────────────────────────────────────────────────┘
```

**States**

| State | Behaviour |
| --- | --- |
| Circuit breaker tripped | Full\-width red banner: "A stock push would have zeroed 63% of listings. Blocked. \[Review\] \[Override\]". Override requires a typed confirmation |
| Channel credentials expired | Red card with a direct link to reconnect and the exact error the channel returned |
| Never connected | Card shows a connect flow rather than a fake healthy state |
| Loading | Skeleton cards. Sync health is exactly where a spinner reads as "broken" |

**Notes.** The drift row is deliberately not auto\-healed. **RESEARCH:** silent auto\-heal is how a stock bug becomes invisible; alerting and offering a choice is the accepted practice.

### 3\.5 Screen: Tax documents

```
┌──────────────────────────────────────────────────────────────────────────┐
│  TAX DOCUMENTS        [ All ▾ ] [ Aug 2026 ▾ ] [ 🔍 ]      [ Export FAF ]│
├──────────────────────────────────────────────────────────────────────────┤
│  This period    Sales AED 284,110 · VAT AED 12,940 · RCM AED 41,200      │
│                                                                          │
│  ┌────────────┬──────────┬─────────────────┬──────────┬────────┬───────┐ │
│  │ Number     │ Date     │ Customer        │ Type     │ Net    │ VAT   │ │
│  ├────────────┼──────────┼─────────────────┼──────────┼────────┼───────┤ │
│  │ INV-001204 │ 12 Aug   │ Walk-in         │ Simple   │ 4,094  │  205  │ │
│  │ INV-001203 │ 12 Aug   │ Al Noor Trading │ Full·RCM │ 5,807  │    0  │ │
│  │ INV-001202 │ 11 Aug   │ Fatima A.       │ Simple   │ 1,713  │   86  │ │
│  │ CN-000045  │ 11 Aug   │ Al Noor Trading │ Credit   │ −2,340 │    0  │ │
│  └────────────┴──────────┴─────────────────┴──────────┴────────┴───────┘ │
│                                                                          │
│  ┌── E-INVOICING ─────────────────────────────────────────────────────┐  │
│  │ Not yet connected to an Accredited Service Provider.               │  │
│  │ Required for B2B sales from 1 July 2027 (revenue under AED 50m).   │  │
│  │ Your documents already carry every PINT AE field.   [ Connect ]    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

**States**

| State | Behaviour |
| --- | --- |
| Sequence gap detected | Red banner naming the missing number. Gapless numbering is a legal requirement, so a gap is an incident |
| ASP connected | The banner becomes a status strip: transmitted / accepted / rejected counts, with rejections clickable |
| Document opened | Read\-only. The only action is "Issue credit note" — issued documents are immutable |

### 3\.6 Changed: Admin shell responsive behaviour *(closes P\-13)*

**AUDIT:** the admin is desktop\-first and collapses below 900px, while the primary persona checks a phone many times a day.

```
≥1200px                    900–1199px                <900px
┌────┬──────────────┐     ┌──┬───────────────┐      ┌─────────────────┐
│Side│   Content    │     │▪ │   Content     │      │ ☰  Voltix    👤 │
│bar │              │     │▪ │               │      ├─────────────────┤
│    │              │     │▪ │               │      │                 │
│    │              │     │▪ │               │      │  Card-based     │
│    │              │     │  │               │      │  content —      │
└────┴──────────────┘     └──┴───────────────┘      │  never a table  │
 full labels               icons + tooltip          │                 │
                                                    ├─────────────────┤
                                                    │ 🏠  📦  📋  ⋯   │
                                                    └─────────────────┘
                                                     bottom tab bar
```

**Below 900px the rule is: tables become cards.** Horizontal scroll on a phone is a failure, not a fallback. Priority order for the phone: Dashboard → Orders → Inventory → Returns. Products and Reports stay desktop\-first — nobody edits a variant matrix on a phone.

* * *

## 4\. Storefront changes

The storefront is the most complete surface. **AUDIT:** all ten routes are complete and the purchase flow was verified end to end in production. Only these change.

| Screen | Change | Requirement |
| --- | --- | --- |
| Product detail | Show "IMEI recorded on your invoice" only where the product is genuinely serialised — the current blanket homepage claim is not honoured | R2.8 / P\-03 |
| Checkout | COD above the threshold requires an advance payment step, with honest copy explaining why | R5.5 |
| Checkout | High COD risk means COD is not offered at all — stated plainly, not hidden | R5.5 |
| Confirmation | Show the tax document number and offer the PDF | R7.1 |
| Track order | Show the carrier and tracking number once dispatched | R5.3 |
| Track order | Rate limited, with a friendly lockout rather than a silent failure | R14.3 |
| Returns | A real return request form replacing "contact us" | R10.5 |
| All | Arabic product content, not only Arabic UI | R1.4 |

### 4\.1 Checkout — the COD advance step *(closes P\-15)*

```
┌────────────────────────────────────────────────────────┐
│  Payment                                               │
│                                                        │
│  ○ Card                                                │
│  ○ Tabby — 4 payments of AED 1,524                     │
│  ● Cash on delivery                                    │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Orders over AED 1,500 need a part payment now.  │  │
│  │                                                  │  │
│  │  Pay now      AED   500.00   by card or Tabby    │  │
│  │  Pay on       AED 5,597.00   cash to the driver  │  │
│  │  delivery                                        │  │
│  │                                                  │  │
│  │  This is refunded in full if you cancel before   │  │
│  │  dispatch.                                       │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│              [ Pay AED 500 and place order ]           │
└────────────────────────────────────────────────────────┘
```

**Notes.** The copy states the refund condition because a customer asked to pay AED 500 for a COD order will otherwise abandon. **AUDIT:** the existing product's honest\-copy principle — COD confirmations never say "paid" — is exactly right and is extended here.

* * *

## 5\. Cross\-cutting state coverage

**AUDIT:** the previous QA checklist showed loading state as the only row failing across every feature. This is the required matrix. A screen is not done until every applicable cell is implemented.

| Screen | Default | Empty | Loading | Error | No permission | Offline |
| --- | --- | --- | --- | --- | --- | --- |
| POS sale | ✔ | ✔ top sellers | ✔ catalogue progress | ✔ inline | ✔ controls absent | ✔ amber chip |
| POS tender | ✔ | n/a | ✔ pending countdown | ✔ inline | ✔ | ✔ methods disabled with reason |
| IMEI capture | ✔ | n/a | ✔ validating | ✔ six distinct cases | n/a | ✔ local index |
| Unit lookup | ✔ | ✔ not found \+ next steps | ✔ skeleton | ✔ | ✔ cost row absent | ✔ cached only |
| Shift close | ✔ | n/a | ✔ | ✔ | ✔ | ✔ **blocked** |
| Product editor | ✔ | ✔ new product | ✔ skeleton | ✔ field\-level | ✔ read\-only | ✖ requires connection |
| Stocktake | ✔ | ✔ "scan to begin" | ✔ posting progress | ✔ rollback message | ✔ | ✔ queue counts |
| Receive PO | ✔ | ✔ | ✔ | ✔ over\-receipt | ✔ | ✔ queue |
| Channel health | ✔ | ✔ connect flow | ✔ skeleton cards | ✔ per channel | ✔ | n/a |
| Tax documents | ✔ | ✔ | ✔ skeleton | ✔ gap \= incident | ✔ | n/a |
| Admin orders | ✔ | ✔ | **✔ new** | ✔ | ✔ | n/a |
| Admin dashboard | ✔ | ✔ | **✔ new** | ✔ | ✔ | n/a |

* * *

## 6\. Accessibility and localisation baseline

**AUDIT:** semantic HTML, `sr-only` and aria labels are present but never audited; focus\-visible styling is unverified. Rules for every screen in this document:

- **Keyboard.** Every action reachable without a mouse. The POS is keyboard\-first by design, not by accommodation. Visible focus rings everywhere — a POS used by a fast cashier is a keyboard application.
- **Targets.** 44×44px minimum on the POS, 32×32px minimum in admin.
- **Contrast.** WCAG 2.2 AA minimum; the POS aims higher because it runs under shop\-floor lighting and glare.
- **Announcements.** Scan results, tender outcomes and sync state changes go to a live region. A cashier watching the customer, not the screen, needs the audio confirmation to be meaningful.
- **RTL.** **AUDIT:** logical properties (`inset-inline-*`, `text-align: start`) are used throughout, which is genuinely good and makes RTL mostly free. The remaining work is Arabic *content*, not layout, plus the mixed\-direction case of an Arabic field inside an English form.
- **Numbers stay LTR in RTL layouts.** Prices, IMEIs, phone numbers and invoice numbers. Getting this wrong makes an Arabic receipt unreadable.

* * *

## 7\. Open questions

| \# | Question | Blocks |
| --- | --- | --- |
| W1 | Till screen size and orientation — 15" landscape assumed. A 10" portrait tablet needs a different sale layout | POS layout |
| W2 | Is a customer\-facing display in scope? It changes the tender screen and is needed for BNPL QR flows | R3.16 |
| W3 | Receipt paper width — 80mm assumed. 58mm halves the usable characters and changes every template | Receipt design |
| W4 | Does the shop want a keypad\-only mode for cashiers who prefer typing SKUs to tapping tiles? | Sale screen |
| W5 | Is live TRN verification against the FTA available to a retailer? If so it belongs in §2.4 | Business sale modal |
| W6 | Arabic\-first or English\-first default for the POS? The persona suggests Arabic may be the better default for cashiers | Localisation |

* * *

*The interactive prototype `voltix-wireframes.html` implements the POS sale, IMEI capture, tender, unit lookup, product editor and channel health screens as a clickable flow. It is a wireframe, not a design — see the Design Document for visual specification.*

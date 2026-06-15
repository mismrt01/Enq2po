# Production & Dispatch Modules — End-to-End Specification

A self-contained implementation guide for the **Production** pipeline (Job Cards → Molding → Finishing → Inspection) and the **Dispatch** module that consumes its output. Written so an engineer in any stack (web, mobile, ERP) can rebuild these modules from scratch.

---

## 1. High-Level Concept

A factory takes a confirmed **Order**, breaks each line item into a **Job Card** (one JC = one item × one MOC × one ordered quantity), then runs that JC through a fixed shop-floor pipeline:

```
Order Confirmed
   │
   ▼
[Job Card auto-generated]   ← one per order line item
   │
   ▼
┌───────────────────────────────────────────────────────────────┐
│   MOLDING       →   FINISHING   →   INSPECTION                │
│   (qtyMolded)       (qtyFinished)    (passed/rejected/rework/ │
│                                       scrap split)            │
│                            ▲                                  │
│                            └─── rework auto-queues back ──────┤
└───────────────────────────────────────────────────────────────┘
   │
   ▼
Passed pool ≥ 1  →  JC enters "Ready to Dispatch"
   │
   ▼
[DISPATCH]   one invoice = many JC line items
   │
   ▼
Status: Dispatched → In Transit → Delivered (or Returned)
```

Three principles drive every design decision:

1. **Append-only.** Molding, Finishing, Inspection, and Dispatch records are immutable. Corrections require a new entry.
2. **Status is derived, never stored.** A Job Card's stage (`Molding`, `Finishing`, `Ready to Dispatch`, etc.) is computed live from its child records. There is no `status` column to keep in sync.
3. **Aggregates compute on demand.** Counters like `molded`, `passed`, `dispatched` are summed from child tables every time they're read — no triggers, no stale totals.

---

## 2. Data Model

All entities live in flat arrays / SQL tables. The relationships are:

```
ORDERS ─1:N─► JOB_CARDS ─1:N─► MOLDING
                       ├─1:N─► FINISHING
                       ├─1:N─► INSPECTION
                       └─1:N─► DISPATCH_ITEMS ◄─N:1─ DISPATCHES (1:1 invoice)
```

### 2.1 `JOB_CARDS`

Generated automatically when an order is confirmed (one JC per line item).

| Field | Type | Notes |
|---|---|---|
| `id` | string PK | Format `JC-YYYY-{last3OfOrderId}-{seq3}` e.g. `JC-2026-042-001` |
| `orderId` | FK | Parent order |
| `poNo` | string | Customer PO ref |
| `cust` | string | Customer name (denormalised) |
| `itemSeq` | int | Position within the order |
| `itemCode` | FK → Item Master | |
| `ourDesc` | string | Internal description |
| `desc` | string | Customer's description |
| `mat` | string | MOC (material) — prefilled from Item Master |
| `qty` | number | Ordered quantity (planned) |
| `uom` | string | `pcs`, `kg`, etc. |
| `dieNo` | string | Prefilled from Item Master via Type_Model_MOC match |
| `priority` | enum | `Low \| Normal \| High \| Urgent` |
| `dlvDate` | date | Promised delivery date |
| `createdAt` | timestamp | |
| `notes` | string | |

> **No `status` field.** Status is derived (see §3.2).

### 2.2 `MOLDING` (append-only)

| Field | Type | Notes |
|---|---|---|
| `moldingId` | string PK | `MLD-YYYY-NNNNN` |
| `timestamp` | ISO datetime | When saved |
| `moldingDate` | date | When molded |
| `jobCardId` | FK | |
| `orderId`, `itemCode`, `ourDesc` | denorm | Snapshot at entry time |
| `dieNo`, `typeItemMOC` | string | |
| `pressNo` | string * | Required |
| `qtyMolded` | int * | Required |
| `plannedQty` | int | Snapshot of JC qty |
| `cureTime` | number * | minutes |
| `cureTemp` | number | °C (optional) |
| `operatorName` | string * | |
| `startTime`, `endTime`, `workingTime` | time / computed | Working time = end−start (auto, handles midnight wrap) |
| `shift` | enum | `A \| B \| C` |
| `weightBefore`, `weightAfter` | number | grams |
| `scotchTime`, `dieChangeDuration`, `doriKhatamDuration` | number | minutes |
| `spray` | string | Mould-release used |
| `operationType` | enum | `Production \| Trial \| Rework` |
| `tiklíSize` | string | |
| `remarks` | string | |
| `enteredBy` | email | |

### 2.3 `FINISHING` (append-only)

| Field | Type | Notes |
|---|---|---|
| `finishingId` | string PK | `FIN-YYYY-NNNNN` |
| `timestamp` | datetime | |
| `finishingDate` | date | |
| `jobCardId` | FK | |
| `orderId`, `dieNo`, `typeItemMOC` | denorm | |
| `plannedQty` | int | |
| `actualQty` | int * | Required — qty finished this session |
| `workingHours` | number | Decimal hours |
| `finisherName` | string * | Required |
| `isRework` | bool-as-string | `"TRUE" \| "FALSE"` |
| `remarks` | string | |
| `enteredBy` | email | |

### 2.4 `INSPECTION` (append-only)

| Field | Type | Notes |
|---|---|---|
| `inspectionId` | string PK | `INS-YYYY-NNNNN` |
| `timestamp`, `inspectionDate` | | |
| `jobCardId`, `orderId`, `dieNo`, `typeItemMOC` | | |
| `qtyToInspect` | int * | The batch size |
| `qtyInspected` | int | Equals `qtyToInspect` on save |
| `passed`, `rejected`, `rework`, `scrapped` | int * | **Must sum to `qtyToInspect`** |
| `inspectorName` | string * | |
| `startTime`, `endTime`, `workingHours` | | Auto-computed in hours |
| `rejectionReasons` | string | Free text: `Flash, Unfill, Blow, Dimension, Damage…` |
| `remarks` | string | |
| `enteredBy` | email | |

### 2.5 `DISPATCHES` (master) + `DISPATCH_ITEMS` (lines)

**Dispatch master** — one row per invoice:

| Field | Type | Notes |
|---|---|---|
| `dispatchId` | string PK | `DSP-YYYY-NNNNN` |
| `timestamp`, `dispatchDate` | | |
| `invoiceNo` * | string | Unique per dispatch |
| `customerName` * | FK | |
| `poNo`, `poDate` | | |
| `totalQtyDispatched` | int | Sum of line items |
| `mode` | enum | `Road \| Courier \| Rail \| Air \| Hand Delivery` |
| `courierName`, `trackingNumber` | string | |
| `biltyNo`, `biltyDate`, `noOfCartons` | | LR / transport |
| `invoiceValue` | number | ₹ |
| `status` | enum | `Dispatched \| In Transit \| Delivered \| Returned` |
| `remarks`, `enteredBy`, `receivedByCRM` | | |

**Dispatch line item** — one row per JC × invoice:

| Field | Type | Notes |
|---|---|---|
| `dispatchItemId` | string PK | `DI-{epoch_ms}-{seq}` |
| `dispatchId` | FK → DISPATCHES | |
| `jobCardId` | FK → JOB_CARDS | |
| `orderId`, `poNo`, `orderedItem`, `dieNo`, `moc` | denorm | |
| `qtyDispatched` * | int | |
| `unit` | string | |
| `orderedQty` | int | JC.qty snapshot |
| `remainingQty` | int | = `orderedQty − previously_dispatched − qtyDispatched` (computed at save) |
| `dispatchDate`, `invoiceNo` | denorm | |
| `enteredBy` | | |

---

## 3. Core Algorithms

### 3.1 Per-JC aggregates (`jcStats`)

Recomputed on every read. Cost is O(n) over the four child tables filtered by `jobCardId` — fine at typical factory scale; add an index if you move to SQL.

```js
function jcStats(jcId) {
  const molded     = MOLDING.filter(m=>m.jobCardId===jcId).reduce((a,m)=>a+(+m.qtyMolded||0),0);
  const finished   = FINISHING.filter(f=>f.jobCardId===jcId).reduce((a,f)=>a+(+f.actualQty||0),0);
  const insRows    = INSPECTION.filter(i=>i.jobCardId===jcId);
  const passed     = insRows.reduce((a,i)=>a+(+i.passed||0),0);
  const rejected   = insRows.reduce((a,i)=>a+(+i.rejected||0),0);
  const rework     = insRows.reduce((a,i)=>a+(+i.rework||0),0);
  const scrapped   = insRows.reduce((a,i)=>a+(+i.scrapped||0),0);
  const dispatched = DISPATCH_ITEMS.filter(d=>d.jobCardId===jcId).reduce((a,d)=>a+(+d.qtyDispatched||0),0);
  const yieldRate  = molded>0 ? Math.round(passed/molded*100) : 0;
  return { molded, finished, passed, rejected, rework, scrapped, dispatched, yieldRate };
}
```

### 3.2 JC status derivation (`deriveJCStatus`)

Pure function — never written to disk.

```js
function deriveJCStatus(jc) {
  const s = jcStats(jc.id);
  const planned = +jc.qty || 0;
  if (planned > 0 && s.dispatched >= planned)     return 'Dispatched';
  if (s.dispatched > 0)                            return 'Partially Dispatched';
  if (s.passed > 0)                                return 'Ready to Dispatch';
  if (INSPECTION.some(i => i.jobCardId === jc.id)) return 'Inspection';
  if (FINISHING.some(f => f.jobCardId === jc.id))  return 'Finishing';
  if (MOLDING.some(m => m.jobCardId === jc.id))    return 'Molding';
  return 'Pending Molding';
}
```

**Order matters.** The chain `Dispatched → Partial → Ready → Inspection → Finishing → Molding → Pending` ensures the latest reached stage wins.

### 3.3 Ready-to-dispatch pool

```js
readyQty(jcId) = jcStats(jcId).passed - jcStats(jcId).dispatched
```

A JC appears on the Dispatch Board iff `readyQty > 0`. This is the single rule that gates dispatch.

### 3.4 ID generators

Year-prefixed, zero-padded, scanned from existing records (so they survive restarts without a counter table):

```js
function nextMldId() {
  const nums = MOLDING.map(m => { const x = m.moldingId.match(/MLD-\d+-(\d+)/); return x?+x[1]:0; });
  return `MLD-${new Date().getFullYear()}-${String(Math.max(0,...nums)+1).padStart(5,'0')}`;
}
// Same pattern for FIN-, INS-, DSP-, CMP-
```

For Job Cards, ID is deterministic on order/line:
```js
function nextJCId(orderId, seq) {
  const ordSeq = orderId.replace(/[^0-9]/g, '').slice(-3);
  return `JC-${new Date().getFullYear()}-${ordSeq}-${String(seq).padStart(3,'0')}`;
}
```

### 3.5 Item Master defaults — Type_Model_MOC matching

To prefill `dieNo`, `pressNo`, `cureTime`, `tikliSize` on Molding entries, items sharing the same **Type_Model_MOC** code (e.g. `GCH_S121_NBR`) are treated as one molding-setup group. New SKUs inherit defaults from sibling SKUs that already carry them.

```js
function findMasterByTypeMoc(itemCode) {
  if (!itemCode) return null;
  const seed = ITEM_MASTER.find(i => i.itemCode === itemCode);
  const typeMoc = seed?.typeMoc;
  if (!typeMoc) return seed || null;
  const group = ITEM_MASTER.filter(i => i.typeMoc === typeMoc);
  const score = i => (i.dieNo?1:0) + (i.pressNo?1:0) + (i.cureTime?1:0)
                   + (i.cureTemp?1:0) + (i.tikliSize?1:0) + (i.moc?1:0);
  group.sort((a,b) => score(b) - score(a));
  return group[0] || seed || null;
}
```

Molding prefill cascades: **history first, master second**:
```js
function getLastMldSetup(itemCode) {
  const last = MOLDING.find(m => m.itemCode === itemCode);   // newest entry
  if (last) return { ...last, source: 'history' };
  const master = findMasterByTypeMoc(itemCode);
  if (master && (master.dieNo || master.pressNo || master.cureTime))
    return { ...master, source: 'master' };
  return null;
}
```

---

## 4. Module Walk-Through

### 4.1 Module 05 — Job Card Board

**Purpose**: single visual hub showing every JC in the factory, grouped by derived stage.

**Layout**: two view modes:
- **Kanban**: 7 columns matching the 7 derived statuses, each card shows `JC ID · itemCode · desc · dieNo · qty · ▲molded ✓passed ✕rejected ↑dispatched · % ready`.
- **Table**: same JCs, sortable, with action buttons (`Mold`, `Finish`, `Inspect`).

**Filters**: by Stage, by Order ID.

**Auto-generation**: when an Order is marked **Won**, the system iterates `order.items` and creates one JC per line. The `dieNo` and `mat` (MOC) come from `findMasterByTypeMoc(item.itemCode)` so the JC carries the correct die from day one.

**Detail panel** (click any JC): shows the qty summary (`Molded / Passed / Rejected / Dispatched`), remaining-to-dispatch, and four chronological tables — Molding sessions, Finishing sessions, Inspection sessions, Dispatched entries — for full lineage.

### 4.2 Module 06 — Log Molding

**Form layout** (top to bottom):
1. **Job Card & Date** — JC dropdown (excludes already-Dispatched JCs), date, shift (`A/B/C`), operation type (`Production/Trial/Rework`).
2. **Press & Die Details** — pressNo *, dieNo, tikliSize; cureTime *, scotchTime, dieChange, doriKhatam; spray, weight before/after.
3. **Quantity & Operator** — qtyMolded *, planned qty (readonly), start/end time → auto worktime, operator *, remarks.

**Prefill behaviour on JC select** (`prefillMldFromJC`):
1. Set planned qty.
2. Call `getLastMldSetup(itemCode)`:
   - If a prior molding entry exists → fill die/press/tikli/cure/spray from it, tag "Prefilled from last record".
   - Else fall back to Item Master via typeMoc grouping → tag "Prefilled from Item Master".
3. Show an info banner: itemCode chip + customer desc + MOC + ordered qty + running molded/passed.

**Running-total widget**: as the user types qtyMolded, shows `Previously molded + this entry = new total / planned` and a "✓ Planned qty met" tick when reached.

**Save rules**:
- Required: JC, qty, press, operator.
- Generates `MLD-YYYY-NNNNN`, snapshots `orderId`/`itemCode`/`plannedQty` onto the entry, unshifts to `MOLDING`, persists, and syncs to backend.
- Immutable — Allow edit/create duplicate, no delete in UI.

### 4.3 Module 07 — Log Finishing

**Eligible JCs**: status ∈ {`Molding, Finishing, Inspection, Ready to Dispatch, Partially Dispatched`}. (You can finish after dispatch starts because rework may come back.)

**Rework Queue banner** (top of page): scans `INSPECTION` for entries with `rework > 0`, lists them as `JC X · Rework from INS-… · N pcs need re-finishing` with a **Fill** button that one-click prefills:
- Selects the right JC,
- Sets `actualQty = rework_qty`,
- Sets `isRework = "TRUE"`.

**Save rules**: required JC, qty, finisher. Generates `FIN-YYYY-NNNNN`, persists, immutable. The `isRework` flag is what closes the loop with Module 08. Allow edit/create duplicate

### 4.4 Module 08 — Log Inspection

**Eligible JCs**: status ∈ {`Finishing, Inspection, Ready to Dispatch, Partially Dispatched`}.

**The split rule** (key UX moment): user enters `qtyToInspect`, then four boxes — Passed / Rejected / Rework / Scrap. As they type, a live validator shows:
- ✓ green when `passed + rejected + rework + scrapped === qtyToInspect`
- ✕ red with the diff otherwise

Save is blocked unless the split balances. A `validateInsSplit()` runs `oninput` on every field.

**Rework auto-routing**: if `rework > 0`, a yellow notice appears: *"Rework qty will auto-queue to Finishing"*. No DB flip happens — the queue is just a SQL/array filter that Module 07 runs every time it renders:
```js
const reworkTasks = INSPECTION
  .filter(i => +i.rework > 0)
  .map(i => ({ jcId: i.jobCardId, inspId: i.inspectionId, qty: +i.rework, date: i.inspectionDate }));
```
When the user logs a finishing session with `isRework=TRUE` against the same JC, the rework qty is implicitly "consumed" (the user is expected to size `actualQty` to the rework amount). The system doesn't auto-decrement — it trusts the operator's input.

**Yield calculation** in the register: `yield% = round(passed / qtyInspected × 100)`. Colour-coded green ≥90, amber ≥70, red below.

**Save**: generates `INS-YYYY-NNNNN`, immutable. Allow edit/create duplicate

### 4.5 Module 09 — Dispatch Board

Two stacked panels:

**Ready-to-Dispatch pool** (top): one card per JC where `readyQty > 0`, sorted as-found. Each card shows JC ID, description, MOC, die, the big green **Ready qty** number, the customer/order, and a **Dispatch →** button that opens the Create Dispatch form pre-selected to that JC.

**Dispatch Register** (bottom): table of all `DISPATCHES` rows. Click any row to expand inline and reveal its `DISPATCH_ITEMS` lines plus bilty/courier/carton info.

**Status updates**: inline `<select>` in each row lets the user move a dispatch through `Dispatched → In Transit → Delivered → Returned`. On `Delivered`, the handler also walks the linked DISPATCH_ITEMS and, for any JC where total dispatched ≥ ordered qty, sets `jc.status = 'Delivered'` (one of the rare places a JC status is written — used as an override after the derived value reaches Dispatched).

**Complaint shortcut**: any non-Delivered dispatch has a **Complaint** button that opens Module 10 pre-linked to that DSP.

### 4.6 Module 09 — Create Dispatch

**Form layout**:
1. **Invoice & Customer** — invoiceNo *, dispatchDate *, customer dropdown *, poNo.
2. **Transport Details** — mode, courierName, trackingNumber; biltyNo, biltyDate, noOfCartons, invoiceValue; remarks.
3. **Dispatch Line Items table** — repeating rows. Each row: JC dropdown (only `readyQty>0` JCs) → on select, autofills Item desc (readonly), Ready Pool (display only), Qty to Dispatch (defaults to ready qty, capped at ready qty via `max` attribute), Unit. Trash button to remove. **+ Add Job Card Line** at the bottom.

**Save validation** (`saveDispatch`):
1. invoiceNo and customer are required.
2. For each row: skip if no JC, error if qty is 0, **error if qty > readyQty** at save time (re-checked because the pool may have shifted). Allow edit/create duplicate
3. Generates `DSP-YYYY-NNNNN`, builds one master row + N line items, links them via `dispatchId`, persists both arrays, syncs.
4. Snapshots `orderedQty` and computes `remainingQty = orderedQty − previouslyDispatched − thisQty` per line so historical lines stay accurate even as future dispatches happen. 

**Side effects of saving a dispatch**:
- JC's derived status flips to `Partially Dispatched` (if remainder > 0) or `Dispatched` (if zero remainder) automatically — no field updates needed.
- JC's `readyQty` recomputes to `passed − dispatched`, removing it from the Ready pool if fully shipped.

---

## 5. End-to-End Walk-Through (worked example)

A 1,000-pc order for `GCH-001` (`GCH_S121_NBR`) lands and is marked Won.

| Step | Module | What happens | DB writes |
|---|---|---|---|
| 1 | Orders → Won | Order confirmed | `ORDERS[i].status = 'Won'` |
| 2 | JC auto-gen | `JC-2026-042-001` created with `qty:1000`, `dieNo:569`, `mat:NBR` (from Item Master via typeMoc) | 1 row in `JOB_CARDS` |
| 3 | Log Molding | Operator opens form, picks JC → prefilled (Press 2, cure 180 min, die 569 from history or master). Enters `qtyMolded: 400`. | 1 row in `MOLDING` |
| 4 | JC Board | JC status auto-derives to **Molding** | none |
| 5 | Log Finishing | Finisher logs `actualQty: 400`, `isRework: FALSE` | 1 row in `FINISHING` |
| 6 | JC status | Now derives to **Finishing** | none |
| 7 | Log Inspection | Inspector enters batch 400 → splits as `passed:380, rejected:5, rework:15, scrapped:0`. Validator confirms 400=400, save allowed. | 1 row in `INSPECTION` |
| 8 | JC status | Derives to **Ready to Dispatch** (passed > 0) | none |
| 9 | Rework Queue | Module 07 now shows "JC-2026-042-001 · 15 pcs need re-finishing" | none |
| 10 | Dispatch Board | JC appears in Ready pool with `readyQty = 380 − 0 = 380` | none |
| 11 | Create Dispatch | User makes invoice `INV/26/0042`, dispatches 380. `remainingQty = 1000 − 0 − 380 = 620`. | 1 row in `DISPATCHES`, 1 in `DISPATCH_ITEMS` |
| 12 | JC status | Derives to **Partially Dispatched** | none |
| 13 | Cycle repeats | More molding/finishing/inspection sessions build up `passed`; rework gets re-finished and re-inspected. | append rows |
| 14 | Final dispatch | Once `dispatched ≥ qty(1000)`, JC derives to **Dispatched** | new dispatch row |
| 15 | Mark Delivered | User flips DSP status to Delivered. Handler sets `jc.status='Delivered'` on fully-shipped JCs. | `DISPATCHES[i].status='Delivered'`; some `JOB_CARDS[i].status` set |

Everywhere along the way, no aggregate field is mutated — every screen reads `jcStats()` live.

---

## 6. UI / UX Rules That Matter

These look like polish but are core to keeping the data clean:

- **Banner-on-select**: every "Log X" form shows a coloured banner the moment a JC is picked, summarising prior progress. Prevents operators from double-logging.
- **Running totals while typing**: Molding shows live `prev + this = new / planned`; Inspection shows live split balance. Stops "save then realise it's wrong" cycles.
- **`max` on qty inputs** matches the realistic ceiling (ready pool, batch size). Defence in depth — server still re-validates.
- **Readonly auto-computed fields** (workingTime, workingHours, planned qty) have a distinct grey background.
- **Append-only footer note** on every entry form: *"Entry is permanent · Corrections require a new entry"*. Sets expectation.
- **Status colours are stable per stage** across kanban, table, badges, and detail panel: pending=grey, molding=amber, finishing=blue, inspection=violet, ready=green, partial=red, dispatched=light-grey.

---

## 7. Persistence & Sync Pattern

Local-first design:

1. Every save: write to in-memory array → call `saveSFData()` which puts the full envelope into `localStorage` under a single key.
2. Then fire `runGS('sfAppend…', entry)` asynchronously to push to the cloud sheet. Failure shows a toast but **does not roll back local state** — local is the source of truth, sheet is a mirror.
3. On app boot: pull from cloud → hydrate arrays → cache to localStorage.

If you re-platform to a real DB, replace `runGS` with HTTP POST and lift `saveSFData()` to a transactional unit; the algorithm doesn't change.

---

## 8. Implementation Checklist

If you're rebuilding from this doc:

- [ ] Tables: `JOB_CARDS`, `MOLDING`, `FINISHING`, `INSPECTION`, `DISPATCHES`, `DISPATCH_ITEMS` (plus existing `ORDERS`, `ITEM_MASTER`, `CUSTOMERS`).
- [ ] Indexes on `jobCardId` in the four child tables and on `dispatchId` in `DISPATCH_ITEMS`.
- [ ] Pure functions: `jcStats`, `deriveJCStatus`, `findMasterByTypeMoc`, `getLastMldSetup`, ID generators.
- [ ] JC auto-creation hook on order confirmation.
- [ ] Five forms: Log Molding, Log Finishing, Log Inspection, Dispatch Board, Create Dispatch.
- [ ] Two registers per production stage (Molding/Finishing/Inspection) + Dispatch register with expandable rows.
- [ ] Rework queue widget in Log Finishing.
- [ ] Split-balance validator in Log Inspection (blocks save).
- [ ] Ready-pool gate (`passed − dispatched > 0`) for Dispatch eligibility.
- [ ] Inline status update on dispatch rows with side-effect on JC when `Delivered`.
- [ ] Tests: a JC moves through every derived status as you append child rows; reworked qty round-trips through Finishing back to Inspection without breaking sums; dispatch qty is hard-capped at ready pool.

/**
 * RFQ LLM fallback — called when the Python regex/Camelot pipeline returns 422.
 * Input:  { text: string }   (text already extracted from the PDF on the client or Python)
 * Output: { items: LineItem[], method: "llm_llama_3_3_70b", confidence: number, warnings: string[] }
 */

export interface Env {
  AI: Ai;
  SHARED_SECRET: string;
  ALLOWED_ORIGINS: string;
  // Provider selection: "cloudflare" | "anthropic" | "gemini". Default "cloudflare".
  LLM_PROVIDER?: string;
  // Set only the ones you use. Stored as Cloudflare secrets via:
  //   npx wrangler secret put ANTHROPIC_API_KEY
  //   npx wrangler secret put GEMINI_API_KEY
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

interface LineItem {
  seq: number;
  desc: string;
  mat: string;
  qty: number;
  uom: string;
  drwg: string;
}

const SYSTEM_PROMPT = `You extract line items from rubber/gasket industry RFQ (Request for Quotation) documents.
You receive raw text extracted from a customer PDF (text may be jumbled — columns flattened into one stream by the PDF parser). Your job: recover the items table and return STRICT JSON.

═══════════════════════════════════════════════════
TOP PRIORITY RULE #1 — "<number> <UOM>" TERMINATES AN ITEM:
═══════════════════════════════════════════════════
The STRONGEST signal that an item has ended is the pattern: <integer or decimal> <UOM keyword>
where UOM is one of (case-insensitive, dots optional):
  NOS, NO, EA, EACH, KG, KGS, PCS, PC, SET, SETS, MTR, MTRS, M, LTR, LTRS, L, SHT, SHEET,
  ROLL, PAIR, PAIRS, BOX, BOXES, LOT, LOTS, UNIT, UNITS, LENGTH, LENGTHS, RMT, RM
(This is the exact UOM_SET used by the rest of the system — do not invent UOMs outside this list.)

Examples that DO terminate an item: "36 NO", "12 NOS", "100 PCS", "50.5 KG", "8 EA"
Examples that DO NOT terminate (no number before UOM): "BOX SECTION", "SET SCREW"
Examples that DO NOT terminate (number+unit is a DIMENSION, not qty+UOM):
  - "50 MM", "80 NB", "10 INCH", "8 IN", "100 mm" — MM/NB/INCH/IN/mm are NOT UOMs.
  - "30X285X15MM" — embedded in a dimension expression.
  - "PN16", "PT100" — codes.

When you find a "<number> <UOM>" pair:
  - qty = the number
  - uom = the UOM keyword, normalized UPPERCASE using the SAME map as the code:
      NOS./NO./NO → NOS
      EACH → EA
      KGS → KG
      MTRS → MTR (MTR stays MTR)
      LTRS → LTR
      PCS./PC → PCS
      SETS → SET
      PAIRS → PAIR
      BOXES → BOX
      LOTS → LOT
      UNITS → UNIT
      LENGTHS → LENGTH
      SHEET → SHT
      RM → RMT
    Anything else already in UOM_SET (NOS, EA, KG, PCS, SET, MTR, M, LTR, L, SHT, ROLL, PAIR, BOX, LOT, UNIT, LENGTH, RMT) stays as-is.
  - Everything BEFORE that pair (back to the previous item's terminator or the previous seq+code marker) is this item's description.
  - Everything AFTER that pair starts the NEXT item.

TOP PRIORITY RULE #2 — IF NO UOM TERMINATORS FOUND, fall back to:
  (a) "<small int 1-99> <long alphanumeric code>" markers like "1 4290673" — split here, mat=code.
  (b) If neither, " <consecutive small int> <UPPERCASE WORD>" leading-integer markers like "1 ALUMINIUM ... 2 ALUMINIUM ...".
  In fallback mode, qty defaults to 1.

NEVER collapse multiple items into one desc. The number of items emitted must equal the number of "<number> <UOM>" terminators found (or the number of seq markers in fallback mode).

═══════════════════════════════════════════════════
FIELDS (exact schema — every item must have all of these):
═══════════════════════════════════════════════════
- seq   : integer. The row's serial number (1, 2, 3...). If the PDF embeds it inline (e.g. "...EPDM 1 4290673 OD 285MM..." means seq=1), recover it. If absent entirely, number sequentially from 1.
- desc  : string. The customer's full item description — preserve their exact wording (don't translate, don't shorten). Strip repeated whitespace. If a description wraps across multiple lines, MERGE into one. Do NOT include the material code or seq number inside desc.
- mat   : string. Material/SAP/part code if present. Often a long number like "4290673", "00000000002603008", or alphanumeric like "EIDP-BH-2019-0750". Strip leading zeros. If no code exists, use "".
- qty   : number. Customer's requested quantity. Strip commas (1,000 → 1000). If the PDF has NO qty column at all, default qty=1 (the caller will warn the user). Never invent qty from descriptions like "pair" or "set".
- uom   : string, UPPERCASE. Allowed values: NOS, EA, KG, PCS, SET, MTR, M, LTR, SHT, ROLL, PAIR, BOX, LOT, UNIT, RMT. Default "NOS" if missing.
- drwg  : string. Drawing number ONLY if the PDF has a dedicated drawing-number column. Examples: "EIDP-BH-2019-0750", "DRG-2406". Do NOT extract drawing references that appear inside the description — leave those in desc. If no separate column, use "".

═══════════════════════════════════════════════════
WHAT TO SKIP (do not emit as items):
═══════════════════════════════════════════════════
- Header/footer/page-number lines ("Page 1 of 3", "Continued on next page").
- Address blocks, GSTIN, phone numbers, email addresses, names of officials.
- Terms & Conditions, payment terms, delivery terms, warranty, validity.
- Notes / Remarks blocks ("Note:", "Remarks:", "Kindly send...", "Please quote...").
- Closing phrases ("Yours faithfully", "With regards", "For and on behalf").
- Totals: subtotal, grand total, GST amount, tax amount, freight, "Amount in words".
- HSN/SAC codes on their own line (4-8 digit numbers alone).
- Anything after a STOP token: terms, notes, signature, total.

═══════════════════════════════════════════════════
LAYOUT PATTERNS YOU MUST RECOGNIZE:
═══════════════════════════════════════════════════
1. GRID TABLE with column headers (S.No / Mat Code / Description / Qty / UOM / Drawing).
   → Map each row to fields by column.

2. NUMBERED LIST: "1. RUBBER O-RING 28.5MM  QTY: 30 NOS"  or "1) ITEM  30 EA"  or "1. ITEM 4No" (glued).
   → seq=1, qty=30, uom=NOS.

3. SAP NATIVE: "20  00000000002603008  NEOPRENE BUSH 62X30  100.000 each"
   → seq=20, mat=2603008 (zeros stripped), desc=NEOPRENE BUSH 62X30, qty=100, uom=EACH→EA.

4. SPACE-ALIGNED FREE TEXT: "CHANNEL PLATE GSKT, PTHE                  30        EA"
   → desc + qty + uom on one line.

5. FLATTENED MULTI-COLUMN with seq+matCode markers:
   Example input:
     "EPDM RUBBER SEAT 30X285X15MM... SIZE:ID 30MM X 1 4290673 OD 285MM..."
     "...VALVE SIZE:8 IN 2 4095855 SIZE:ID:25MM..."
   Here "1 4290673" and "2 4095855" are seq+matCode pairs sandwiched between description text. RULE:
     - Detect transitions where you see " <small int 1-99> <long alphanumeric code> " between description text.
     - That marker BEGINS a new item; text BEFORE the marker belongs to the previous item.
     - Strip the seq/mat tokens out of desc.
   When NO qty column exists in this layout, set qty=1 for every row.

6. FLATTENED SEQ-DESC-QTY TABLE (very common — table was "S.N. | DESCRIPTION | QTY" with wrapped descriptions):
   Original PDF table looked like:
     S.N.  MATERIAL DESCRIPTION                                       QTY
     1     ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE,  8
           SIZE - 50 MM,VALVE MAKE CRANE
     2     ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE,  12
           SIZE - 80 MM,VALVE MAKE CRANE

   Flattened text you receive looks like:
     "1 ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE, 8 SIZE - 50 MM,VALVE MAKE CRANE 2 ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE, 12 SIZE - 80 MM,VALVE MAKE CRANE 3 ..."

   PARSE RULE:
     - A new item BEGINS where you see " <small int 1-99> " followed by an UPPERCASE description word.
     - Sequence numbers must be strictly increasing (1, 2, 3, ...). Use this to confirm boundaries — a stray "8" or "12" inside a description is NOT a new seq if the next expected seq doesn't follow.
     - The pattern WITHIN one item is:  <seq> <desc_line_1> <qty> <desc_line_2>  <next_seq> ...
       - desc_line_1 = uppercase description text up to a NUMBER that's not part of a dimension/measurement (i.e., not "50 MM", not "80NB", not "10 INCH", not "30X285X15MM").
       - qty = that bare integer (or decimal) sitting between desc_line_1 and desc_line_2. Typical qty values: 1-9999.
       - desc_line_2 = continuation text that follows qty, up to the next " <int> " seq marker.
     - MERGE: final desc = desc_line_1.trim().replace(/,$/, '') + " - " + desc_line_2.trim()
       Example: desc = "ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE - SIZE - 50 MM,VALVE MAKE CRANE"
     - mat="", uom="NOS", drwg="".
     - STOP when sequence numbers stop appearing — any trailing text (company name, address, "UNIT ROHANA KALAN", "INDIAN POTASH LIMITED", phone, GSTIN) is NOT an item.

7. DISTINGUISHING qty FROM DIMENSIONS:
   Numbers inside descriptions that are NOT qty:
     - Followed by a unit: "50 MM", "80NB", "1/2 INCH", "10\"", "100 mm", "200 deg", "PN16"
     - Part of a dimension string: "30X285X15", "62X30X65", "ID:25MM"
     - Drawing/spec refs: "DRAWING NUMBER:2406", "EIDP-BH-2019-0750"
     - Hardness/property: "70-80 ON SCALE", "70 SHORE A"
     - Year in a code: "2019", "2021"
   Numbers that ARE qty:
     - A bare integer/decimal sitting between description text segments with NO unit attached.
     - Falls in the typical range 1-9999 (anything larger is usually a code).
     - In a "S.N. ... QTY" table, qty appears as the LAST number in the row before the next item begins.

═══════════════════════════════════════════════════
CRITICAL HEURISTICS (from production parser):
═══════════════════════════════════════════════════
- A continuation row has description text but NO qty — merge into the previous item's desc, do NOT emit as new item.
- A row with seq and code but the desc field empty — wait, accumulate, then merge with the line below.
- UOM normalization: NOS./NO. → NOS, PCS./PC → PCS, KGS → KG, MTRS → MTR, EACH → EA, LTRS → LTR.
- Material code "0000000260308" → "260308" (strip leading zeros). Codes that are entirely letters+digits (EIDP-BH-2019-0750) keep as-is.
- If qty parses to 0 or negative, default to 1.
- If two adjacent items have IDENTICAL desc and qty, they're likely a duplicate from a multi-page table — emit only once.
- Customer descriptions often contain dimensions (30X285X15MM), MOC tags (MOC:EPDM), drawing refs embedded inline (DRAWING NUMBER:2406) — KEEP all of these inside desc. Do not split them out.

═══════════════════════════════════════════════════
WORKED EXAMPLES (study these carefully):
═══════════════════════════════════════════════════

EXAMPLE A — flattened seq-desc table, qty column dropped by extraction:
INPUT:
"1 ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE, SIZE - 50 MM,VALVE MAKE CRANE 2 ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE, SIZE - 80 MM,VALVE MAKE CRANE 3 ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE, SIZE - 100 MM,VALVE MAKE CRANE 4 ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE, SIZE - 125 MM,VALVE MAKE CRANE 5 ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE, SIZE - 150 MM,VALVE MAKE CRANE 6 ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE, SIZE - 250 MM,VALVE MAKE CRANE 7 ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE, SIZE - 300 MM,VALVE MAKE CRANE 8 ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE, SIZE - 350 MM,VALVE MAKE CRANE 9 ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE, SIZE - 400 MM,VALVE MAKE CRANE INDIAN POTASH LIMITED UNIT ROHANA KALAN DISTT. MUZAFFARNAGAR"

EXPECTED OUTPUT:
{
  "items": [
    { "seq": 1, "desc": "ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE - SIZE - 50 MM,VALVE MAKE CRANE", "mat": "", "qty": 1, "uom": "NOS", "drwg": "" },
    { "seq": 2, "desc": "ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE - SIZE - 80 MM,VALVE MAKE CRANE", "mat": "", "qty": 1, "uom": "NOS", "drwg": "" },
    { "seq": 3, "desc": "ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE - SIZE - 100 MM,VALVE MAKE CRANE", "mat": "", "qty": 1, "uom": "NOS", "drwg": "" },
    { "seq": 4, "desc": "ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE - SIZE - 125 MM,VALVE MAKE CRANE", "mat": "", "qty": 1, "uom": "NOS", "drwg": "" },
    { "seq": 5, "desc": "ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE - SIZE - 150 MM,VALVE MAKE CRANE", "mat": "", "qty": 1, "uom": "NOS", "drwg": "" },
    { "seq": 6, "desc": "ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE - SIZE - 250 MM,VALVE MAKE CRANE", "mat": "", "qty": 1, "uom": "NOS", "drwg": "" },
    { "seq": 7, "desc": "ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE - SIZE - 300 MM,VALVE MAKE CRANE", "mat": "", "qty": 1, "uom": "NOS", "drwg": "" },
    { "seq": 8, "desc": "ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE - SIZE - 350 MM,VALVE MAKE CRANE", "mat": "", "qty": 1, "uom": "NOS", "drwg": "" },
    { "seq": 9, "desc": "ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE - SIZE - 400 MM,VALVE MAKE CRANE", "mat": "", "qty": 1, "uom": "NOS", "drwg": "" }
  ]
}
Note: "INDIAN POTASH LIMITED UNIT ROHANA KALAN..." is the customer name/address — NOT an item. The desc merges the first line ("ALUMINIUM LINER... VALVE,") with the continuation ("SIZE - 50 MM,VALVE MAKE CRANE") joined by " - ". The trailing comma after "VALVE" is stripped. Even though qty values are missing from the input, 9 items are still emitted (one per seq marker 1-9), with qty=1 as default.

EXAMPLE B — same table layout but qty values ARE present in the text:
INPUT:
"1 ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE, 8 SIZE - 50 MM,VALVE MAKE CRANE 2 ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE, 12 SIZE - 80 MM,VALVE MAKE CRANE 3 ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE, 22 SIZE - 100 MM,VALVE MAKE CRANE"

EXPECTED OUTPUT:
{
  "items": [
    { "seq": 1, "desc": "ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE - SIZE - 50 MM,VALVE MAKE CRANE", "mat": "", "qty": 8, "uom": "NOS", "drwg": "" },
    { "seq": 2, "desc": "ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE - SIZE - 80 MM,VALVE MAKE CRANE", "mat": "", "qty": 12, "uom": "NOS", "drwg": "" },
    { "seq": 3, "desc": "ALUMINIUM LINER WITH EPDM RUBBER SEAT FOR BUTTERFLY VALVE - SIZE - 100 MM,VALVE MAKE CRANE", "mat": "", "qty": 22, "uom": "NOS", "drwg": "" }
  ]
}
Note: The bare integer (8, 12, 22) sitting between desc segments with no unit attached IS the qty. "50 MM", "80 MM", "100 MM" are sizes (number followed by MM) — those stay in desc.

EXAMPLE C0 — UOM-terminated table with seq+matCode (HIGHEST PRIORITY pattern):
INPUT:
"1 4290673 EPDM RUBBER SEAT 30X285X15MM, DOUBLE BEAT VALVE 10\" RUBBER SEAT SIZE:ID 30MM X OD 285MM X THK 15MM MOC:EPDM HARDNESS-:70-80 ON SCALE 'A' APPLICATION-:JUICE,PRESSURE 36 NO 2 4095855 SEAT,RBR,F/DOUBLE BEAT VLV,8IN,COFLOW, VALVE NAME:DOUBLE BEAT VALVE PART NAME:SEAT, MATERIAL:RUBBER, DRAWING NUMBER:2406, VALVE MAKE:CO FLOW CONTROL VALVE, VALVE SIZE:8 IN SIZE:ID:25MM OD:235MM THK:12MM 12 NO 3 4303588 EPDM RUBBER SEAT FOR 8\" GLOBE VALVE, RUBBER SEAT FOR 8\" GLOBE VALVE AS PER DRAWING. EIDP-BH-2019-0751 DUMMY RUBBER SEAT OD:220MM THK:20MM. 24 NO Gangadharm EID Parry (India) Ltd Khanpeth, Ramdurg"

EXPECTED OUTPUT:
{
  "items": [
    { "seq": 1, "desc": "EPDM RUBBER SEAT 30X285X15MM, DOUBLE BEAT VALVE 10\" RUBBER SEAT SIZE:ID 30MM X OD 285MM X THK 15MM MOC:EPDM HARDNESS-:70-80 ON SCALE 'A' APPLICATION-:JUICE,PRESSURE", "mat": "4290673", "qty": 36, "uom": "NOS", "drwg": "" },
    { "seq": 2, "desc": "SEAT,RBR,F/DOUBLE BEAT VLV,8IN,COFLOW, VALVE NAME:DOUBLE BEAT VALVE PART NAME:SEAT, MATERIAL:RUBBER, DRAWING NUMBER:2406, VALVE MAKE:CO FLOW CONTROL VALVE, VALVE SIZE:8 IN SIZE:ID:25MM OD:235MM THK:12MM", "mat": "4095855", "qty": 12, "uom": "NOS", "drwg": "" },
    { "seq": 3, "desc": "EPDM RUBBER SEAT FOR 8\" GLOBE VALVE, RUBBER SEAT FOR 8\" GLOBE VALVE AS PER DRAWING. EIDP-BH-2019-0751 DUMMY RUBBER SEAT OD:220MM THK:20MM.", "mat": "4303588", "qty": 24, "uom": "NOS", "drwg": "" }
  ]
}
Notes:
  - "36 NO", "12 NO", "24 NO" are the qty+UOM terminators that split this into 3 items.
  - "NO" normalized to "NOS" in uom output.
  - "1 4290673", "2 4095855", "3 4303588" are seq+matCode pairs at the start of each item.
  - Dimensions like "30X285X15MM", "10\"", "8 IN", "OD:220MM" stay inside desc (they're sizes, not qty).
  - "Gangadharm EID Parry..." is the customer name/address — NOT an item.

EXAMPLE C — flattened seq+matCode markers (no qty column):
INPUT:
"EPDM RUBBER SEAT 30X285X15MM, DOUBLE BEAT VALVE 10 INCH RUBBER SEAT SIZE:ID 30MM X 1 4290673 OD 285MM X THK 15MM MOC:EPDM HARDNESS 70-80 2 4095855 EPDM RUBBER SEAT FOR 8 INCH GLOBE VALVE AS PER DRAWING EIDP-BH-2019-0751 3 4303588 DUMMY RUBBER SEAT OD:220MM"

EXPECTED OUTPUT:
{
  "items": [
    { "seq": 1, "desc": "EPDM RUBBER SEAT 30X285X15MM, DOUBLE BEAT VALVE 10 INCH RUBBER SEAT SIZE:ID 30MM X OD 285MM X THK 15MM MOC:EPDM HARDNESS 70-80", "mat": "4290673", "qty": 1, "uom": "NOS", "drwg": "" },
    { "seq": 2, "desc": "EPDM RUBBER SEAT FOR 8 INCH GLOBE VALVE AS PER DRAWING EIDP-BH-2019-0751", "mat": "4095855", "qty": 1, "uom": "NOS", "drwg": "" },
    { "seq": 3, "desc": "DUMMY RUBBER SEAT OD:220MM", "mat": "4303588", "qty": 1, "uom": "NOS", "drwg": "" }
  ]
}
Note: "1 4290673" pattern (seq=1, mat=4290673) breaks item 1's desc into two halves which then get merged. mat code is the 7-digit number. "4290673" → keep as "4290673". qty defaults to 1.

═══════════════════════════════════════════════════
FINAL CHECKLIST BEFORE RETURNING:
═══════════════════════════════════════════════════
1. PRIMARY: How many "<number> <UOM>" terminators are in the input? Emit exactly that many items.
2. FALLBACK (only if zero UOM terminators): how many seq markers (1, 2, 3...) are there? Emit that many items, qty=1.
3. Is each desc free of seq numbers, material codes, and the trailing "<qty> <UOM>" tail (those go in seq/mat/qty/uom)?
4. Did I distinguish qty from dimensions correctly? Numbers followed by MM/IN/INCH/NB/PN are dimensions, NOT qty.
5. Did I skip the trailing company/address junk (company name, street, district, phone, GSTIN)?
6. Is qty a NUMBER (not string)? Is seq a NUMBER (not string)?
7. Are NO/EACH/KGS/MTRS/PC/SHEET normalized to NOS/EA/KG/MTR/PCS/SHT using the map above?

═══════════════════════════════════════════════════
OUTPUT:
═══════════════════════════════════════════════════
Return ONLY valid JSON matching the schema. No prose, no markdown fences, no commentary. If you cannot find any items at all, return { "items": [] }.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          seq: { type: 'number' },
          desc: { type: 'string' },
          mat: { type: 'string' },
          qty: { type: 'number' },
          uom: { type: 'string' },
          drwg: { type: 'string' },
        },
        required: ['seq', 'desc', 'qty', 'uom'],
      },
    },
  },
  required: ['items'],
};

function corsHeaders(origin: string | null, env: Env): HeadersInit {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  const allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0] || '';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Shared-Secret',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get('Origin');
    const cors = corsHeaders(origin, env);

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }
    if (req.headers.get('X-Shared-Secret') !== env.SHARED_SECRET) {
      return new Response('Unauthorized', { status: 401, headers: cors });
    }

    let body: { text?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, cors);
    }

    const text = (body.text || '').trim();
    if (!text) return json({ error: 'Field "text" is required' }, 400, cors);
    if (text.length > 60_000) {
      return json({ error: 'Text too large (>60k chars). Truncate first.' }, 413, cors);
    }

    const provider = (env.LLM_PROVIDER || 'cloudflare').toLowerCase();

    try {
      let parsed: { items?: unknown[] };
      let methodTag: string;

      if (provider === 'anthropic') {
        if (!env.ANTHROPIC_API_KEY) {
          return json({ error: 'ANTHROPIC_API_KEY not set on the Worker' }, 500, cors);
        }
        parsed = await callAnthropic(text, env.ANTHROPIC_API_KEY);
        methodTag = 'llm_claude_haiku_4_5';
      } else if (provider === 'gemini') {
        if (!env.GEMINI_API_KEY) {
          return json({ error: 'GEMINI_API_KEY not set on the Worker' }, 500, cors);
        }
        parsed = await callGemini(text, env.GEMINI_API_KEY);
        methodTag = 'llm_gemini_2_5_flash';
      } else {
        parsed = await callCloudflare(text, env.AI);
        methodTag = 'llm_llama_3_3_70b';
      }

      const items = Array.isArray(parsed.items) ? parsed.items.map(normalise) : [];

      if (items.length === 0) {
        return json(
          { items: [], method: methodTag, confidence: 0, warnings: ['LLM returned no items'] },
          200,
          cors,
        );
      }

      return json(
        {
          items,
          method: methodTag,
          confidence: 0.6,
          warnings: ['LLM extraction — verify each row before saving'],
        },
        200,
        cors,
      );
    } catch (e: any) {
      return json({ error: 'LLM call failed', detail: String(e?.message || e) }, 500, cors);
    }
  },
};

function normalise(raw: any, idx: number): LineItem {
  return {
    seq: Number.isFinite(+raw.seq) ? +raw.seq : idx + 1,
    desc: String(raw.desc || '').replace(/\s+/g, ' ').trim(),
    mat: String(raw.mat || '').trim(),
    qty: Number.isFinite(+raw.qty) ? +raw.qty : 1,
    uom: String(raw.uom || 'NOS').trim().toUpperCase().slice(0, 10) || 'NOS',
    drwg: String(raw.drwg || '').trim(),
  };
}

function json(payload: unknown, status: number, cors: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// ── Provider: Cloudflare Workers AI (Llama 3.3 70B) ──────────────────────────
async function callCloudflare(text: string, ai: Ai): Promise<{ items?: unknown[] }> {
  const result = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
    response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
    max_tokens: 4096,
    temperature: 0.1,
  } as any);
  const raw = (result as any).response ?? result;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ── Provider: Anthropic Claude Haiku 4.5 ─────────────────────────────────────
async function callAnthropic(text: string, apiKey: string): Promise<{ items?: unknown[] }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      temperature: 0.1,
      system: [
        // Cache the system prompt — saves 90% on input cost for repeat calls within 5 min.
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content:
            'Extract the line items from this RFQ text. Return ONLY a JSON object matching the schema {"items":[{seq,desc,mat,qty,uom,drwg}, ...]}. No prose, no markdown.\n\n' +
            text,
        },
      ],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data: any = await res.json();
  const content = data?.content?.[0]?.text ?? '';
  return safeParseJson(content);
}

// ── Provider: Google Gemini 2.5 Flash ────────────────────────────────────────
async function callGemini(text: string, apiKey: string): Promise<{ items?: unknown[] }> {
  // Convert our JSON-schema to Gemini's responseSchema format (a small subset of OpenAPI).
  const geminiSchema = {
    type: 'OBJECT',
    properties: {
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            seq: { type: 'NUMBER' },
            desc: { type: 'STRING' },
            mat: { type: 'STRING' },
            qty: { type: 'NUMBER' },
            uom: { type: 'STRING' },
            drwg: { type: 'STRING' },
          },
          required: ['seq', 'desc', 'qty', 'uom'],
        },
      },
    },
    required: ['items'],
  };

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' +
    encodeURIComponent(apiKey);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
        responseSchema: geminiSchema,
      },
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data: any = await res.json();
  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return safeParseJson(content);
}

function safeParseJson(s: string): { items?: unknown[] } {
  if (!s) return {};
  // Strip ```json fences if a model added them despite instructions.
  const cleaned = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Last-ditch: find the first { ... } block.
    const m = cleaned.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : {};
  }
}

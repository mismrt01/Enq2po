"""
RFQ PDF Parser — FastAPI microservice
Supports 5 real-world formats seen in rubber/gasket industry enquiries:
  1. Free-text email style  (space-aligned qty+uom)
  2. Clean grid table       (Camelot lattice)
  3. Numbered list          (1. ITEM  QTY: 30 NOS)
  4. Grid table wrapped     (Camelot lattice + row-merge)
  5. SAP native             (item+matcode+desc concatenated, qty far right)

Returns: { items: LineItem[], method: str, confidence: float, warnings: list[str] }
"""

import io
import re
import tempfile
import os
from pathlib import Path
from typing import Optional

import pdfplumber
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Camelot is optional — import gracefully ───────────────────────────────────
try:
    import camelot
    CAMELOT_AVAILABLE = True
except Exception:
    CAMELOT_AVAILABLE = False

# ── OCR fallback is optional ──────────────────────────────────────────────────
try:
    from pdf2image import convert_from_bytes
    import pytesseract
    OCR_AVAILABLE = True
except Exception:
    OCR_AVAILABLE = False

app = FastAPI(title="RFQ Parser", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)


# ── Schema matching frontend LineItem ─────────────────────────────────────────
class LineItem(BaseModel):
    seq: int
    desc: str
    mat: str = ""
    qty: float
    uom: str
    drwg: str = ""


class ParseResult(BaseModel):
    items: list[LineItem]
    method: str
    confidence: float
    warnings: list[str]


# ── Column name aliases → canonical name ─────────────────────────────────────
COL_ALIASES = {
    "seq":  ["s.no", "sno", "sr.no", "sr no", "item", "item no", "item no.", "line no",
             "sl no", "sl.no", "#", "no.", "no"],
    "mat":  ["mat. code", "mat code", "material code", "material no", "material number",
             "matcode", "item code", "part no", "part no.", "sap code", "mat.code",
             "mat. no", "pr no", "pr no."],
    "desc": ["description", "material description", "item description",
             "description of goods", "particulars", "details", "name of item",
             "goods description"],
    "qty":  ["qty", "quantity", "required qty", "order qty", "req qty", "nos", "amount"],
    "uom":  ["uom", "unit", "unit of measure", "base unit", "u/m", "um"],
    "drwg": ["drawing no", "drawing no.", "drg no", "drg. no", "drg no.", "drawing",
             "drwg", "dwg no"],
}

UOM_TOKENS = {"nos", "no", "ea", "each", "kg", "pcs", "pc", "set", "sets",
              "mtr", "m", "ltr", "l", "sht", "sheet", "roll", "pair", "pairs",
              "box", "boxes", "lot", "lots", "unit", "units", "length", "lengths"}


def normalise_col(name: str) -> Optional[str]:
    cleaned = name.strip().lower().replace("\n", " ")
    for canonical, aliases in COL_ALIASES.items():
        if cleaned in aliases or cleaned == canonical:
            return canonical
    return None


def clean_num(val: str) -> Optional[float]:
    """Extract first float from a cell that may contain units or extra text."""
    val = val.strip().replace(",", "")
    m = re.search(r"[\d]+(?:\.\d+)?", val)
    return float(m.group()) if m else None


def clean_uom(val: str) -> str:
    val = val.strip().upper()
    # If cell contains both qty and uom (e.g. "30 NOS"), return just uom part
    parts = val.split()
    for p in parts:
        if p.lower() in UOM_TOKENS:
            return p
    return val[:10] if val else "NOS"


# ── Method 1: Camelot lattice (grid-line tables) ──────────────────────────────
def try_camelot(pdf_bytes: bytes) -> Optional[tuple[list[LineItem], float, list[str]]]:
    if not CAMELOT_AVAILABLE:
        return None
    warnings = []
    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
            tmp_path = tmp.name
        try:
            tables = camelot.read_pdf(tmp_path, flavor="lattice", pages="all")
        finally:
            os.unlink(tmp_path)

        if not tables or len(tables) == 0:
            return None

        # Pick the table with most rows
        best = max(tables, key=lambda t: t.df.shape[0])
        df = best.df

        if df.shape[0] < 2 or df.shape[1] < 3:
            return None

        # Map header row → canonical columns
        header_row = df.iloc[0].tolist()
        col_map: dict[int, str] = {}
        for ci, cell in enumerate(header_row):
            canon = normalise_col(str(cell))
            if canon and canon not in col_map.values():
                col_map[ci] = canon

        if "desc" not in col_map.values():
            return None  # Can't identify description column

        items: list[LineItem] = []
        pending_desc = ""  # For wrapped description rows
        seq = 1

        for ri in range(1, df.shape[0]):
            row = df.iloc[ri].tolist()
            row_vals = {col_map[ci]: str(row[ci]).strip() for ci in col_map}

            desc = row_vals.get("desc", "").strip()
            qty_raw = row_vals.get("qty", "").strip()
            uom_raw = row_vals.get("uom", "").strip()
            mat = row_vals.get("mat", "").strip()
            drwg = row_vals.get("drwg", "").strip()
            seq_raw = row_vals.get("seq", "").strip()

            # Row continuation: desc present but no qty → append to previous item desc
            qty = clean_num(qty_raw) if qty_raw else None
            if desc and qty is None and items:
                items[-1] = items[-1].model_copy(
                    update={"desc": items[-1].desc + " " + desc}
                )
                continue

            if not desc:
                continue

            # Resolve seq
            seq_num = int(clean_num(seq_raw)) if seq_raw and clean_num(seq_raw) else seq

            items.append(LineItem(
                seq=seq_num,
                desc=desc,
                mat=mat,
                qty=qty if qty is not None else 1.0,
                uom=clean_uom(uom_raw) if uom_raw else "NOS",
                drwg=drwg,
            ))
            seq = seq_num + 1

        if not items:
            return None

        confidence = min(0.95, 0.70 + best.accuracy / 1000)
        if "qty" not in col_map.values():
            warnings.append("QTY column not identified — defaulted to 1")
            confidence -= 0.1
        if "uom" not in col_map.values():
            warnings.append("UOM column not identified — defaulted to NOS")
            confidence -= 0.05

        return items, round(confidence, 2), warnings

    except Exception as e:
        return None


# ── Method 2: Numbered list regex ─────────────────────────────────────────────
# Matches:  1. RUBBER O RING SIZE 28.5MM ID   QTY : 30 NOS
#           1) RUBBER BUSH...  30 EA
NUMBERED_RE = re.compile(
    r"^\s*(\d{1,3})[.)]\s*(.+?)\s{2,}(?:QTY\s*[:\-]?\s*)?(\d+(?:\.\d+)?)\s+([A-Z]{1,6})\s*$",
    re.IGNORECASE | re.MULTILINE,
)
# Inline QTY keyword: "ITEM DESCRIPTION  QTY: 30 NOS"
QTY_INLINE_RE = re.compile(
    r"^\s*(\d{1,3})[.)..]\s*(.+?)\s+QTY\s*[:\-]?\s*(\d+(?:\.\d+)?)\s+([A-Z]{1,6})",
    re.IGNORECASE | re.MULTILINE,
)


def try_numbered_list(text: str) -> Optional[tuple[list[LineItem], float, list[str]]]:
    items: list[LineItem] = []
    warnings: list[str] = []

    matches = list(NUMBERED_RE.finditer(text)) or list(QTY_INLINE_RE.finditer(text))
    if not matches:
        return None

    for m in matches:
        seq = int(m.group(1))
        desc = re.sub(r"\s+", " ", m.group(2)).strip()
        qty = float(m.group(3))
        uom = m.group(4).upper()
        items.append(LineItem(seq=seq, desc=desc, mat="", qty=qty, uom=uom, drwg=""))

    if len(items) < 1:
        return None

    return items, 0.78, warnings


# ── Method 3: Free-text space-aligned (Sample 1 style) ───────────────────────
# Line:  CHANNEL PLATE GSKT,PTHE,NT-50X,KELVION              30        EA
# Optional second line: full description continuation
SPACE_ALIGNED_RE = re.compile(
    r"^([A-Z][A-Z0-9 ,.\-/\"\'()&]+?)\s{3,}(\d+(?:\.\d+)?)\s{1,10}([A-Z]{1,6})\s*$",
    re.MULTILINE,
)


def try_space_aligned(text: str) -> Optional[tuple[list[LineItem], float, list[str]]]:
    items: list[LineItem] = []
    warnings: list[str] = []
    matches = list(SPACE_ALIGNED_RE.finditer(text))
    if len(matches) < 1:
        return None

    for i, m in enumerate(matches):
        desc = re.sub(r"\s+", " ", m.group(1)).strip()
        qty = float(m.group(2))
        uom = m.group(3).upper()
        items.append(LineItem(seq=i + 1, desc=desc, mat="", qty=qty, uom=uom, drwg=""))

    if not items:
        return None

    return items, 0.72, warnings


# ── Method 4: SAP native format ───────────────────────────────────────────────
# Line: "20    00000000002603008  NEOPRENE RUBBER BUSH 62X30X65,INJ.PUMP  100.000  each"
# Item no + long material code (zeros-padded) + desc + qty + uom
SAP_LINE_RE = re.compile(
    r"^(\d{1,4})\s{1,6}(0{5,}\d+)?\s*([A-Z][A-Z0-9 ,.\-/\"\'()&*]+?)\s{2,}(\d+(?:[\.,]\d+)?)\s+(each|ea|nos|no|kg|pcs|pc|set|mtr|m|ltr|sht)\b",
    re.IGNORECASE | re.MULTILINE,
)
# SAP HSN line (skip): just 4 digits alone on a line
SAP_HSN_RE = re.compile(r"^\s*\d{4,8}\s*$", re.MULTILINE)


def try_sap_native(text: str) -> Optional[tuple[list[LineItem], float, list[str]]]:
    items: list[LineItem] = []
    warnings: list[str] = []
    matches = list(SAP_LINE_RE.finditer(text))
    if len(matches) < 1:
        return None

    seen_seqs: set[int] = set()
    for m in matches:
        seq = int(m.group(1))
        if seq in seen_seqs:
            continue
        seen_seqs.add(seq)
        mat = (m.group(2) or "").strip().lstrip("0") or ""
        desc = re.sub(r"\s+", " ", m.group(3)).strip()
        qty_str = m.group(4).replace(",", ".")
        qty = float(qty_str)
        uom = m.group(5).upper()
        items.append(LineItem(seq=seq, desc=desc, mat=mat, qty=qty, uom=uom, drwg=""))

    if not items:
        return None

    if len(items) < 2:
        warnings.append("Only 1 item detected via SAP pattern — verify manually")

    return items, 0.68, warnings


# ── OCR fallback for scanned PDFs ─────────────────────────────────────────────
def extract_text_with_ocr(pdf_bytes: bytes) -> str:
    if not OCR_AVAILABLE:
        return ""
    try:
        images = convert_from_bytes(pdf_bytes, dpi=200)
        text = ""
        for img in images:
            text += pytesseract.image_to_string(img) + "\n"
        return text
    except Exception:
        return ""


# ── Main extraction pipeline ──────────────────────────────────────────────────
def extract_text(pdf_bytes: bytes) -> tuple[str, bool]:
    """Returns (text, is_ocr)."""
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            pages_text = [p.extract_text() or "" for p in pdf.pages]
            text = "\n".join(pages_text).strip()
        if len(text) > 50:
            return text, False
    except Exception:
        pass
    # Fallback: OCR
    return extract_text_with_ocr(pdf_bytes), True


def run_pipeline(pdf_bytes: bytes) -> ParseResult:
    warnings: list[str] = []

    # ── Step 1: Try Camelot (grid tables) ─────────────────────────────────────
    result = try_camelot(pdf_bytes)
    if result and result[0]:
        items, conf, w = result
        return ParseResult(items=items, method="camelot_lattice", confidence=conf, warnings=w)

    # ── Step 2: Extract raw text ───────────────────────────────────────────────
    text, used_ocr = extract_text(pdf_bytes)
    if used_ocr:
        warnings.append("Scanned PDF detected — OCR used, accuracy may be lower")

    if not text.strip():
        raise HTTPException(status_code=422, detail="Could not extract text from PDF. Ensure it is not password-protected.")

    # Normalise whitespace for line-based patterns
    text_lines = "\n".join(line for line in text.splitlines() if line.strip())

    # ── Step 3: Numbered list ─────────────────────────────────────────────────
    result = try_numbered_list(text_lines)
    if result and result[0]:
        items, conf, w = result
        if used_ocr:
            conf -= 0.1
        return ParseResult(items=items, method="regex_numbered_list", confidence=conf, warnings=warnings + w)

    # ── Step 4: SAP native ────────────────────────────────────────────────────
    result = try_sap_native(text_lines)
    if result and result[0]:
        items, conf, w = result
        if used_ocr:
            conf -= 0.1
        return ParseResult(items=items, method="regex_sap_native", confidence=conf, warnings=warnings + w)

    # ── Step 5: Space-aligned free text ──────────────────────────────────────
    result = try_space_aligned(text_lines)
    if result and result[0]:
        items, conf, w = result
        if used_ocr:
            conf -= 0.1
        return ParseResult(items=items, method="regex_space_aligned", confidence=conf, warnings=warnings + w)

    raise HTTPException(
        status_code=422,
        detail="Could not detect item table structure. Supported formats: grid table, numbered list, SAP native, space-aligned."
    )


# ── Endpoint ──────────────────────────────────────────────────────────────────
@app.post("/parse-rfq", response_model=ParseResult)
async def parse_rfq(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    pdf_bytes = await file.read()
    if len(pdf_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 20 MB).")

    return run_pipeline(pdf_bytes)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "camelot": CAMELOT_AVAILABLE,
        "ocr": OCR_AVAILABLE,
    }

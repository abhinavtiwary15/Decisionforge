#!/usr/bin/env python3
"""
pipeline/ingest_gstr2b.py
=========================
Real GSTR-2B ingestion module.

Accepts EITHER a GSTR-2B JSON export or a GSTR-2B Excel (.xlsx) export from the
GST portal and normalises both into the gstr2b_raw schema used by the rest of
the pipeline:

    vendor_gstin    : str   – 15-char GSTIN of the supplier
    vendor_name     : str | None – trade name (if present in source)
    invoice_number  : str   – supplier invoice number
    invoice_date    : str   – YYYY-MM-DD (normalised from DD/MM/YYYY portal format)
    taxable_value   : float
    cgst            : float
    sgst            : float
    igst            : float
    itc_available   : float – total ITC (cgst+sgst+igst when flag is Y/Yes/1/True)
    filing_period   : str   – YYYY-MM

Scope (v1)
----------
Only the B2B table is parsed. The following tables are intentionally skipped for
now and can be added in a future iteration:

TODO: add parsers for B2BA (amendments), CDNR (credit/debit notes), CDNRA
(amended credit/debit notes), ISD (input-service distributor), IMPG (import
of goods), and ITC REVERSED. Each table has its own schema; the B2B parser
below can be used as a template.

Architectural note
------------------
GSTIN validation is performed via the existing validate_gstin() from
pipeline/validators.py — the same function used by risk_scorer.py and
generate_synthetic_data.py. Invalid-GSTIN rows are flagged in a separate
data_quality_flags list, NOT dropped and NOT mixed into financial reconciliation
output. This mirrors the existing data_quality_flags architectural separation.

Windows console safety
----------------------
sys.stdout and sys.stderr are reconfigured to UTF-8 at import time, matching
the pattern already established in generate_explanation.py and
generate_communication.py. Trade names may contain non-ASCII characters and
this script runs in the same Windows/cp1252 environment that crashed during
earlier T3 testing.
"""

from __future__ import annotations

import io
import json
import os
import sys

# ── UTF-8 console output (must be before any print) ─────────────────────────
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

import logging
import re
from datetime import datetime
from typing import Optional

# ── Validator import — supports both script and module usage ─────────────────
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJ_DIR = os.path.dirname(_THIS_DIR)
if _PROJ_DIR not in sys.path:
    sys.path.insert(0, _PROJ_DIR)
try:
    from pipeline.validators import validate_gstin
except ImportError:
    from validators import validate_gstin  # type: ignore[no-redef]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# ── Types ────────────────────────────────────────────────────────────────────
Gstr2bRow = dict  # keys match the gstr2b_raw schema above


# ═══════════════════════════════════════════════════════════════════════════════
# Internal helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _normalise_date(raw: str | None) -> str | None:
    """
    Convert the GST portal's DD/MM/YYYY date format to YYYY-MM-DD.
    Passes through anything that already looks like YYYY-MM-DD unchanged.
    Returns None if raw is None or unparseable.
    """
    if not raw:
        return None
    raw = str(raw).strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    logger.warning("Could not parse date '%s' — keeping as-is.", raw)
    return raw


def _normalise_period(raw: str | None) -> str | None:
    """
    Normalise the filing period to YYYY-MM.
    Handles: 'MMYYYY' (GST portal format), 'MM/YYYY', 'YYYY-MM'.
    """
    if not raw:
        return None
    raw = str(raw).strip()
    # MMYYYY (e.g. '032026')
    if re.match(r"^\d{6}$", raw):
        return f"{raw[2:]}-{raw[:2]}"
    # MM/YYYY
    m = re.match(r"^(\d{1,2})/(\d{4})$", raw)
    if m:
        return f"{m.group(2)}-{int(m.group(1)):02d}"
    # YYYY-MM already
    if re.match(r"^\d{4}-\d{2}$", raw):
        return raw
    logger.warning("Could not normalise filing period '%s' — keeping as-is.", raw)
    return raw


def _safe_float(val, field_name: str, invoice_ref: str) -> float:
    """Parse a value to float, returning 0.0 and logging a warning on failure."""
    if val is None or (isinstance(val, str) and val.strip() == ""):
        return 0.0
    try:
        return float(str(val).replace(",", "").strip())
    except (ValueError, TypeError):
        logger.warning(
            "Could not parse '%s' as float for field '%s' on invoice '%s' — using 0.0.",
            val, field_name, invoice_ref,
        )
        return 0.0


def _itc_from_flag(flag_val, cgst: float, sgst: float, igst: float) -> float:
    """
    Derive itc_available from the ITC-availability flag.

    Flag values seen in GST portal exports:
      JSON : 'Y' | 'N' (sometimes 'Yes' | 'No')
      Excel: 'Yes' | 'No' | 1 | 0 | True | False
    """
    if flag_val is None:
        return round(cgst + sgst + igst, 2)
    flag_str = str(flag_val).strip().upper()
    if flag_str in ("Y", "YES", "1", "TRUE"):
        return round(cgst + sgst + igst, 2)
    return 0.0


def _flag_gstin(row: Gstr2bRow, quality_flags: list[dict]) -> bool:
    """
    Validate vendor_gstin.  If invalid, append a data-quality record and return
    False.  The caller must NOT include this row in financial reconciliation
    output — only the data_quality_flags list should hold it.
    """
    gstin = row.get("vendor_gstin")
    valid, err = validate_gstin(gstin or "")
    if not valid:
        quality_flags.append({
            "vendor_gstin":    gstin,
            "vendor_name":     row.get("vendor_name"),
            "invoice_number":  row.get("invoice_number"),
            "invoice_date":    row.get("invoice_date"),
            "flag_type":       "INVALID_GSTIN",
            "flag_detail":     err,
        })
        return False
    return True


def _check_required_fields(row: Gstr2bRow, missing_count: list[int]) -> Gstr2bRow:
    """
    Log a warning for each missing required field and increment the counter.
    The row is still returned (not dropped) so downstream code can decide.
    """
    required = ("vendor_gstin", "invoice_number", "invoice_date",
                 "taxable_value", "filing_period")
    missing = [f for f in required if row.get(f) in (None, "", 0.0)]
    if missing:
        logger.warning(
            "Invoice '%s' is missing required fields: %s",
            row.get("invoice_number", "<unknown>"),
            ", ".join(missing),
        )
        missing_count[0] += 1
    return row


# ═══════════════════════════════════════════════════════════════════════════════
# JSON ingestion
# ═══════════════════════════════════════════════════════════════════════════════

# Ordered candidate paths to the B2B table.  The GST portal JSON and various
# third-party exporters (Tally, Zoho, ClearTax) differ in their root structure.
# We try these in order and use the first one that contains data.
#
# If a real-world file needs a 5th path, add it here and log which path matched.
_B2B_PATHS = [
    ("data", "docdata", "b2b"),   # ClearTax / Tally nested export
    ("data", "b2b"),              # GSTZen / Zoho flat-under-data
    ("docdata", "b2b"),           # Portal direct download (some versions)
    ("b2b",),                     # Fully flat / minimal exports
]


def _resolve_b2b_table(data: dict) -> tuple[list, str]:
    """
    Walk _B2B_PATHS in order; return (b2b_list, matched_path_description).
    Raises ValueError with a clear user message if no path yields data.
    """
    for path in _B2B_PATHS:
        node = data
        try:
            for key in path:
                node = node[key]
        except (KeyError, TypeError):
            continue

        # node must be a non-empty list to count as a match
        if isinstance(node, list) and len(node) > 0:
            path_str = ".".join(path)
            logger.info("B2B table found at path: %s", path_str)
            return node, path_str

    raise ValueError(
        "Could not find B2B table in this JSON — please confirm this is a "
        "valid GSTR-2B export.  Tried paths: "
        + ", ".join(".".join(p) for p in _B2B_PATHS)
    )


def _parse_json_b2b(b2b_list: list, filing_period: str | None) -> list[Gstr2bRow]:
    """
    Parse the raw B2B list from JSON into normalised rows.

    GST portal JSON B2B structure (simplified):
    [
      {
        "ctin": "27AABCU9603R1ZV",     <- supplier GSTIN
        "trdnm": "Supplier Trade Name", <- optional
        "inv": [
          {
            "inum":  "INV-001",
            "idt":   "01/04/2026",
            "val":   118000.00,
            "itms": [
              {
                "num": 1,
                "itm_det": {
                  "txval": 100000.00,
                  "camt": 9000.00,
                  "samt": 9000.00,
                  "iamt": 0.00,
                  "elg": "ip"         <- 'ip' = input (eligible), 'inelg' = ineligible
                }
              }
            ]
          }
        ]
      }
    ]
    """
    rows = []
    for supplier in b2b_list:
        gstin    = str(supplier.get("ctin", "") or "").strip()
        trd_name = supplier.get("trdnm") or supplier.get("tradeName") or None

        invoices = supplier.get("inv") or supplier.get("invoices") or []
        for inv in invoices:
            inv_num  = str(inv.get("inum") or inv.get("invoice_number") or "").strip()
            inv_date = _normalise_date(inv.get("idt") or inv.get("invoice_date"))
            fp       = _normalise_period(
                inv.get("fp") or inv.get("filing_period") or filing_period
            )

            # Aggregate tax amounts across all line items
            taxable = cgst = sgst = igst = 0.0
            itc_flag = "Y"   # default: assume eligible unless overridden

            items = inv.get("itms") or []
            for item in items:
                det = item.get("itm_det") or item
                taxable += _safe_float(det.get("txval") or det.get("taxable_value"), "txval", inv_num)
                cgst    += _safe_float(det.get("camt") or det.get("cgst"), "camt", inv_num)
                sgst    += _safe_float(det.get("samt") or det.get("sgst"), "samt", inv_num)
                igst    += _safe_float(det.get("iamt") or det.get("igst"), "iamt", inv_num)
                # elg: 'ip' or 'inputs' = input-eligible; anything else = ineligible
                elg = str(det.get("elg") or "ip").strip().lower()
                if elg not in ("ip", "inputs", "y", "yes", "1", "true"):
                    itc_flag = "N"

            # Fallback: if no itms, try flat invoice-level amounts
            if not items:
                taxable = _safe_float(inv.get("txval") or inv.get("taxable_value"), "txval", inv_num)
                cgst    = _safe_float(inv.get("camt") or inv.get("cgst"), "camt", inv_num)
                sgst    = _safe_float(inv.get("samt") or inv.get("sgst"), "samt", inv_num)
                igst    = _safe_float(inv.get("iamt") or inv.get("igst"), "iamt", inv_num)
                itc_flag = str(inv.get("itc_avl") or inv.get("itc_available") or "Y")

            rows.append({
                "vendor_gstin":   gstin,
                "vendor_name":    trd_name,
                "invoice_number": inv_num,
                "invoice_date":   inv_date,
                "taxable_value":  round(taxable, 2),
                "cgst":           round(cgst, 2),
                "sgst":           round(sgst, 2),
                "igst":           round(igst, 2),
                "itc_available":  _itc_from_flag(itc_flag, cgst, sgst, igst),
                "filing_period":  fp,
            })
    return rows


def ingest_json(
    source: str | dict | io.IOBase,
    filing_period: str | None = None,
) -> tuple[list[Gstr2bRow], list[dict]]:
    """
    Ingest a GSTR-2B JSON export.

    Parameters
    ----------
    source : filepath str, already-loaded dict, or file-like object
    filing_period : fallback YYYY-MM period if the JSON doesn't embed it

    Returns
    -------
    (records, data_quality_flags)
        records             – normalised gstr2b_raw rows (valid GSTINs only)
        data_quality_flags  – rows with INVALID_GSTIN (not included in records)
    """
    # Load JSON from whatever form was provided
    if isinstance(source, dict):
        data = source
    elif isinstance(source, str):
        with open(source, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    else:
        data = json.load(source)

    b2b_list, matched_path = _resolve_b2b_table(data)
    raw_rows = _parse_json_b2b(b2b_list, filing_period)
    return _apply_quality_checks(raw_rows, fmt="JSON", matched_path=matched_path)


# ═══════════════════════════════════════════════════════════════════════════════
# Excel ingestion
# ═══════════════════════════════════════════════════════════════════════════════

# Column name mapping: handles common portal / third-party name variations.
# Key = canonical internal name; value = list of known aliases (lowercased, stripped).
_COL_ALIASES: dict[str, list[str]] = {
    "vendor_gstin":   [
        "supplier gstin", "gstin of supplier", "gstin/uin of supplier",
        "vendor gstin", "ctin",
    ],
    "vendor_name":    [
        "trade name", "trade name of the supplier", "supplier name",
        "vendor name", "trdnm",
    ],
    "invoice_number": [
        "invoice number", "invoice no", "invoice no.", "bill number",
        "bill no", "inum",
    ],
    "invoice_date":   [
        "invoice date", "bill date", "idt",
    ],
    "taxable_value":  [
        "taxable value", "taxable amount", "taxable value (rs.)",
        "txval",
    ],
    "cgst":           ["cgst", "central tax", "camt"],
    "sgst":           ["sgst", "state/ut tax", "state tax", "samt"],
    "igst":           ["igst", "integrated tax", "iamt"],
    "itc_available":  [
        "itc availability", "itc available", "eligibility for itc",
        "itc avl", "elg",
    ],
    "filing_period":  [
        "return period", "filing period", "gstr-2b period", "fp",
    ],
}


def _map_excel_headers(raw_headers: list[str]) -> dict[str, str]:
    """
    Map raw column headers from the Excel file to our canonical field names.
    Returns dict: {canonical_name -> raw_header_as_found_in_file}.
    Unrecognised headers are silently ignored.
    """
    mapping: dict[str, str] = {}
    for raw_hdr in raw_headers:
        normalised = str(raw_hdr).strip().lower()
        for canonical, aliases in _COL_ALIASES.items():
            if normalised in aliases or normalised == canonical:
                if canonical not in mapping:  # first match wins
                    mapping[canonical] = raw_hdr
                break
    return mapping


def ingest_excel(
    source: str | io.IOBase,
    filing_period: str | None = None,
) -> tuple[list[Gstr2bRow], list[dict]]:
    """
    Ingest a GSTR-2B Excel export.

    Parameters
    ----------
    source : filepath str or file-like object (must be .xlsx)
    filing_period : fallback YYYY-MM if the sheet doesn't have a period column

    Returns
    -------
    (records, data_quality_flags)
        records             – normalised gstr2b_raw rows (valid GSTINs only)
        data_quality_flags  – rows with INVALID_GSTIN
    """
    try:
        import openpyxl
    except ImportError as exc:
        raise ImportError(
            "openpyxl is required to read Excel files. "
            "Install it with: pip install openpyxl"
        ) from exc

    wb = openpyxl.load_workbook(source, read_only=True, data_only=True)

    # Prefer the 'B2B' sheet; fall back to the first sheet
    sheet_name = None
    for name in wb.sheetnames:
        if "b2b" in name.lower():
            sheet_name = name
            break
    if sheet_name is None:
        sheet_name = wb.sheetnames[0]
        logger.info("No 'B2B' sheet found; using first sheet: '%s'", sheet_name)
    else:
        logger.info("Using sheet: '%s'", sheet_name)

    ws = wb[sheet_name]
    rows_iter = ws.iter_rows(values_only=True)

    # First row = headers
    try:
        raw_headers = [str(h).strip() if h is not None else "" for h in next(rows_iter)]
    except StopIteration:
        raise ValueError("Excel file appears to be empty.")

    col_map = _map_excel_headers(raw_headers)
    logger.info("Excel column mapping: %s", col_map)

    def _get(row_dict: dict, canonical: str, default=None):
        raw_hdr = col_map.get(canonical)
        return row_dict.get(raw_hdr, default) if raw_hdr else default

    raw_rows: list[Gstr2bRow] = []
    for row_values in rows_iter:
        row_dict = dict(zip(raw_headers, row_values))

        # Skip completely empty rows (all None)
        if all(v is None or (isinstance(v, str) and v.strip() == "") for v in row_values):
            continue

        inv_num = str(_get(row_dict, "invoice_number") or "").strip()
        gstin   = str(_get(row_dict, "vendor_gstin") or "").strip()
        cgst    = _safe_float(_get(row_dict, "cgst"), "cgst", inv_num)
        sgst    = _safe_float(_get(row_dict, "sgst"), "sgst", inv_num)
        igst    = _safe_float(_get(row_dict, "igst"), "igst", inv_num)

        # ITC availability: the Excel column may contain the actual ITC amount
        # (numeric) or an eligibility string ('Yes'/'No'/'Y'/'N').
        itc_raw = _get(row_dict, "itc_available")
        if isinstance(itc_raw, (int, float)):
            itc_val = round(float(itc_raw), 2)
        else:
            itc_val = _itc_from_flag(itc_raw, cgst, sgst, igst)

        fp_raw = _get(row_dict, "filing_period") or filing_period

        raw_rows.append({
            "vendor_gstin":   gstin,
            "vendor_name":    _get(row_dict, "vendor_name") or None,
            "invoice_number": inv_num,
            "invoice_date":   _normalise_date(str(_get(row_dict, "invoice_date") or "")),
            "taxable_value":  _safe_float(_get(row_dict, "taxable_value"), "taxable_value", inv_num),
            "cgst":           cgst,
            "sgst":           sgst,
            "igst":           igst,
            "itc_available":  itc_val,
            "filing_period":  _normalise_period(fp_raw),
        })

    wb.close()
    return _apply_quality_checks(raw_rows, fmt="Excel")


# ═══════════════════════════════════════════════════════════════════════════════
# Shared post-parse quality checks + summary
# ═══════════════════════════════════════════════════════════════════════════════

def _apply_quality_checks(
    raw_rows: list[Gstr2bRow],
    fmt: str = "",
    matched_path: str | None = None,
) -> tuple[list[Gstr2bRow], list[dict]]:
    """
    Run GSTIN validation and required-field checks across all rows.
    Returns (clean_records, data_quality_flags).
    """
    clean: list[Gstr2bRow] = []
    quality_flags: list[dict] = []
    missing_count = [0]

    for row in raw_rows:
        if not _flag_gstin(row, quality_flags):
            continue  # row goes to quality_flags only; excluded from financials
        _check_required_fields(row, missing_count)
        clean.append(row)

    _print_summary(fmt, len(raw_rows), len(quality_flags), missing_count[0], matched_path)
    return clean, quality_flags


def _print_summary(
    fmt: str,
    total: int,
    invalid_gstin: int,
    missing_fields: int,
    matched_path: str | None,
):
    """Print a concise ingestion summary."""
    print(f"\n{'='*60}")
    print(f"GSTR-2B Ingestion Summary ({fmt})")
    print(f"{'='*60}")
    if matched_path:
        print(f"  JSON B2B path matched : {matched_path}")
    print(f"  Total invoices parsed : {total}")
    print(f"  Invalid GSTIN (flagged): {invalid_gstin}")
    print(f"  Missing required fields: {missing_fields}")
    print(f"  Clean records          : {total - invalid_gstin}")
    print(f"{'='*60}\n")


# ═══════════════════════════════════════════════════════════════════════════════
# Public entry point (CLI)
# ═══════════════════════════════════════════════════════════════════════════════

def ingest(
    filepath: str,
    filing_period: str | None = None,
) -> tuple[list[Gstr2bRow], list[dict]]:
    """
    Auto-detect format (JSON / Excel) from the file extension and ingest.

    Returns
    -------
    (records, data_quality_flags)
    """
    ext = os.path.splitext(filepath)[1].lower()
    if ext == ".json":
        return ingest_json(filepath, filing_period)
    elif ext in (".xlsx", ".xls"):
        return ingest_excel(filepath, filing_period)
    else:
        raise ValueError(
            f"Unsupported file extension '{ext}'. "
            "Only .json and .xlsx files are supported."
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Test suite
# ═══════════════════════════════════════════════════════════════════════════════

def _run_tests():
    """
    Self-contained test suite.  Run with:  py pipeline/ingest_gstr2b.py --run-tests

    Test coverage:
      J1 – JSON with deep path (data.docdata.b2b)
      J2 – JSON with flat path (b2b) — proves defensive path-search works for
           a DIFFERENT root than J1
      J3 – JSON with no B2B at any known path — must raise ValueError with the
           exact user-friendly message, not a raw traceback
      J4 – JSON with one deliberately invalid GSTIN — must appear in
           data_quality_flags, not in clean records
      X1 – Excel with standard column names
      X2 – Excel with renamed column "GSTIN of Supplier" instead of
           "Supplier GSTIN" — proves the alias mapping catches it
      X3 – Excel with one deliberately invalid GSTIN — same flag check as J4
      EQ – JSON and Excel producing identical normalised rows for the same data
    """
    import io
    import openpyxl

    print("\n" + "="*70)
    print("RUNNING GSTR-2B INGESTION TESTS")
    print("="*70)

    PASS = "PASSED"
    FAIL = "FAILED"
    results = []

    # ── Shared fixture data ──────────────────────────────────────────────────
    # Four invoices: 3 valid GSTINs, 1 invalid
    VALID_GSTIN_1   = "27AABCU9603R1ZV"   # Maharashtra, valid
    VALID_GSTIN_2   = "29AADCB2230M1ZV"   # Karnataka, valid
    VALID_GSTIN_3   = "07AAACR5055K1Z6"   # Delhi, valid
    INVALID_GSTIN   = "99AABCU9603R1ZV"   # state code 99 — out of range

    INVOICE_1 = {
        "gstin": VALID_GSTIN_1, "name": "Reliance Industries Ltd",
        "inum": "RIL-2026-001", "idt": "05/04/2026",
        "txval": 100000.0, "cgst": 9000.0, "sgst": 9000.0, "iamt": 0.0,
        "period": "2026-04",
    }
    INVOICE_2 = {
        "gstin": VALID_GSTIN_2, "name": "Infosys Ltd",
        "inum": "INF-2026-055", "idt": "12/04/2026",
        "txval": 50000.0, "cgst": 0.0, "sgst": 0.0, "iamt": 9000.0,
        "period": "2026-04",
    }
    INVOICE_3 = {
        "gstin": VALID_GSTIN_3, "name": "HDFC Bank",
        "inum": "HDF-2026-300", "idt": "20/04/2026",
        "txval": 25000.0, "cgst": 2250.0, "sgst": 2250.0, "iamt": 0.0,
        "period": "2026-04",
    }
    INVOICE_INVALID = {
        "gstin": INVALID_GSTIN, "name": "Bad Vendor",
        "inum": "BAD-2026-001", "idt": "01/04/2026",
        "txval": 10000.0, "cgst": 900.0, "sgst": 900.0, "iamt": 0.0,
        "period": "2026-04",
    }

    def _make_supplier(inv: dict, include_invalid=False):
        """Build a GST portal B2B supplier node from fixture."""
        invoices_list = [inv] + ([INVOICE_INVALID] if include_invalid else [])
        suppliers = []
        for i in invoices_list:
            suppliers.append({
                "ctin": i["gstin"],
                "trdnm": i["name"],
                "inv": [{
                    "inum": i["inum"], "idt": i["idt"],
                    "fp": i["period"],
                    "itms": [{
                        "num": 1,
                        "itm_det": {
                            "txval": i["txval"],
                            "camt": i["cgst"],
                            "samt": i["sgst"],
                            "iamt": i["iamt"],
                            "elg": "ip",
                        }
                    }]
                }]
            })
        return suppliers

    # ────────────────────────────────────────────────────────────────────────
    # J1 – JSON with deep path: data.docdata.b2b
    # ────────────────────────────────────────────────────────────────────────
    print("\n--- [J1] JSON: deep path (data.docdata.b2b) ---")
    j1_data = {
        "data": {
            "docdata": {
                "b2b": _make_supplier(INVOICE_1) + _make_supplier(INVOICE_2)
            }
        }
    }
    try:
        records, flags = ingest_json(j1_data)
        ok = (
            len(records) == 2
            and len(flags) == 0
            and records[0]["invoice_number"] == "RIL-2026-001"
            and records[0]["invoice_date"] == "2026-04-05"
            and records[0]["taxable_value"] == 100000.0
        )
        results.append(("J1 deep-path (data.docdata.b2b)", PASS if ok else FAIL))
        print(f"  Records: {len(records)}, Flags: {len(flags)}")
        print(f"  First row: {records[0]}")
    except Exception as exc:
        results.append(("J1 deep-path (data.docdata.b2b)", FAIL))
        print(f"  ERROR: {exc}")

    # ────────────────────────────────────────────────────────────────────────
    # J2 – JSON with flat path: b2b  (different root than J1)
    # ────────────────────────────────────────────────────────────────────────
    print("\n--- [J2] JSON: flat path (b2b) ---")
    j2_data = {
        "b2b": _make_supplier(INVOICE_2) + _make_supplier(INVOICE_3)
    }
    try:
        records, flags = ingest_json(j2_data)
        ok = (
            len(records) == 2
            and len(flags) == 0
            and records[1]["invoice_number"] == "HDF-2026-300"
        )
        results.append(("J2 flat-path (b2b)", PASS if ok else FAIL))
        print(f"  Records: {len(records)}, Flags: {len(flags)}")
        print(f"  Second row: {records[1]}")
    except Exception as exc:
        results.append(("J2 flat-path (b2b)", FAIL))
        print(f"  ERROR: {exc}")

    # ────────────────────────────────────────────────────────────────────────
    # J3 – JSON with no B2B at any known path — must raise clear ValueError
    # ────────────────────────────────────────────────────────────────────────
    print("\n--- [J3] JSON: no B2B table at any known path ---")
    j3_data = {"randomKey": {"anotherKey": []}}
    try:
        ingest_json(j3_data)
        results.append(("J3 missing-B2B raises ValueError", FAIL))
        print("  ERROR: should have raised ValueError but did not")
    except ValueError as exc:
        msg = str(exc)
        ok = "Could not find B2B table" in msg and "valid GSTR-2B export" in msg
        results.append(("J3 missing-B2B raises ValueError", PASS if ok else FAIL))
        print(f"  Raised ValueError (expected): {msg[:120]}...")
    except Exception as exc:
        results.append(("J3 missing-B2B raises ValueError", FAIL))
        print(f"  Wrong exception type {type(exc).__name__}: {exc}")

    # ────────────────────────────────────────────────────────────────────────
    # J4 – JSON with one invalid GSTIN — flagged, not dropped silently
    # ────────────────────────────────────────────────────────────────────────
    print("\n--- [J4] JSON: invalid GSTIN row flagged ---")
    j4_suppliers = _make_supplier(INVOICE_1) + [{
        "ctin": INVALID_GSTIN,
        "trdnm": "Bad Vendor",
        "inv": [{
            "inum": "BAD-001", "idt": "01/04/2026", "fp": "2026-04",
            "itms": [{"num":1,"itm_det":{"txval":5000.0,"camt":450.0,"samt":450.0,"iamt":0.0,"elg":"ip"}}]
        }]
    }]
    j4_data = {"data": {"b2b": j4_suppliers}}
    try:
        records, flags = ingest_json(j4_data)
        ok = (
            len(records) == 1
            and len(flags) == 1
            and flags[0]["vendor_gstin"] == INVALID_GSTIN
            and flags[0]["flag_type"] == "INVALID_GSTIN"
        )
        results.append(("J4 invalid-GSTIN flagged (JSON)", PASS if ok else FAIL))
        print(f"  Clean records: {len(records)}, Quality flags: {len(flags)}")
        print(f"  Flag detail: {flags[0]['flag_detail']}")
    except Exception as exc:
        results.append(("J4 invalid-GSTIN flagged (JSON)", FAIL))
        print(f"  ERROR: {exc}")

    # ────────────────────────────────────────────────────────────────────────
    # Build Excel helper (shared by X1, X2, X3, EQ)
    # ────────────────────────────────────────────────────────────────────────
    def _make_excel(headers: list[str], invoice_rows: list[dict]) -> io.BytesIO:
        """Build an in-memory xlsx with one 'B2B' sheet."""
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "B2B"
        ws.append(headers)
        for r in invoice_rows:
            ws.append([r.get(h, "") for h in headers])
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        return buf

    STD_HEADERS = [
        "Supplier GSTIN", "Trade Name", "Invoice Number", "Invoice Date",
        "Taxable Value", "CGST", "SGST", "IGST", "ITC Availability",
        "Return Period",
    ]

    def _row(inv: dict) -> dict:
        return {
            "Supplier GSTIN":  inv["gstin"],
            "Trade Name":      inv["name"],
            "Invoice Number":  inv["inum"],
            "Invoice Date":    inv["idt"],
            "Taxable Value":   inv["txval"],
            "CGST":            inv["cgst"],
            "SGST":            inv["sgst"],
            "IGST":            inv["iamt"],
            "ITC Availability":"Yes",
            "Return Period":   inv["period"],
        }

    # ────────────────────────────────────────────────────────────────────────
    # X1 – Excel with standard column names
    # ────────────────────────────────────────────────────────────────────────
    print("\n--- [X1] Excel: standard column names ---")
    x1_buf = _make_excel(STD_HEADERS, [_row(INVOICE_1), _row(INVOICE_2), _row(INVOICE_3)])
    try:
        records, flags = ingest_excel(x1_buf)
        ok = (
            len(records) == 3
            and len(flags) == 0
            and records[0]["invoice_number"] == "RIL-2026-001"
            and records[0]["taxable_value"] == 100000.0
        )
        results.append(("X1 Excel standard headers", PASS if ok else FAIL))
        print(f"  Records: {len(records)}, Flags: {len(flags)}")
        print(f"  First row: {records[0]}")
    except Exception as exc:
        results.append(("X1 Excel standard headers", FAIL))
        print(f"  ERROR: {exc}")

    # ────────────────────────────────────────────────────────────────────────
    # X2 – Excel with renamed column "GSTIN of Supplier" (alias mapping test)
    # ────────────────────────────────────────────────────────────────────────
    print("\n--- [X2] Excel: renamed column 'GSTIN of Supplier' ---")
    ALT_HEADERS = [
        "GSTIN of Supplier",    # ← alias; canonical = vendor_gstin
        "Trade Name", "Invoice Number", "Invoice Date",
        "Taxable Value", "CGST", "SGST", "IGST", "ITC Availability",
        "Return Period",
    ]
    def _row_alt(inv: dict) -> dict:
        d = _row(inv)
        d["GSTIN of Supplier"] = d.pop("Supplier GSTIN")
        return d

    x2_buf = _make_excel(ALT_HEADERS, [_row_alt(INVOICE_1), _row_alt(INVOICE_2)])
    try:
        records, flags = ingest_excel(x2_buf)
        ok = (
            len(records) == 2
            and len(flags) == 0
            and records[0]["vendor_gstin"] == VALID_GSTIN_1
        )
        results.append(("X2 Excel renamed column alias", PASS if ok else FAIL))
        print(f"  Records: {len(records)}, Flags: {len(flags)}")
        print(f"  vendor_gstin resolved: {records[0]['vendor_gstin']}")
    except Exception as exc:
        results.append(("X2 Excel renamed column alias", FAIL))
        print(f"  ERROR: {exc}")

    # ────────────────────────────────────────────────────────────────────────
    # X3 – Excel with one invalid GSTIN — flagged, not dropped silently
    # ────────────────────────────────────────────────────────────────────────
    print("\n--- [X3] Excel: invalid GSTIN row flagged ---")
    inv_bad = {
        "gstin": INVALID_GSTIN, "name": "Bad Vendor",
        "inum": "BAD-2026-001", "idt": "01/04/2026",
        "txval": 10000.0, "cgst": 900.0, "sgst": 900.0, "iamt": 0.0,
        "period": "2026-04",
    }
    x3_buf = _make_excel(STD_HEADERS, [_row(INVOICE_1), _row(inv_bad)])
    try:
        records, flags = ingest_excel(x3_buf)
        ok = (
            len(records) == 1
            and len(flags) == 1
            and flags[0]["vendor_gstin"] == INVALID_GSTIN
            and flags[0]["flag_type"] == "INVALID_GSTIN"
        )
        results.append(("X3 Excel invalid-GSTIN flagged", PASS if ok else FAIL))
        print(f"  Clean records: {len(records)}, Quality flags: {len(flags)}")
        print(f"  Flag detail: {flags[0]['flag_detail']}")
    except Exception as exc:
        results.append(("X3 Excel invalid-GSTIN flagged", FAIL))
        print(f"  ERROR: {exc}")

    # ────────────────────────────────────────────────────────────────────────
    # EQ – JSON and Excel produce identical normalised output for same data
    # ────────────────────────────────────────────────────────────────────────
    print("\n--- [EQ] JSON == Excel: identical output for equivalent data ---")
    eq_invoices = [INVOICE_1, INVOICE_2]
    eq_json  = {"b2b": _make_supplier(INVOICE_1) + _make_supplier(INVOICE_2)}
    eq_excel = _make_excel(STD_HEADERS, [_row(INVOICE_1), _row(INVOICE_2)])
    try:
        j_recs, _ = ingest_json(eq_json)
        x_recs, _ = ingest_excel(eq_excel)

        fields_to_compare = (
            "vendor_gstin", "invoice_number", "invoice_date",
            "taxable_value", "cgst", "sgst", "igst", "itc_available",
            "filing_period",
        )
        mismatches = []
        for i, (jr, xr) in enumerate(zip(j_recs, x_recs)):
            for f in fields_to_compare:
                if jr.get(f) != xr.get(f):
                    mismatches.append(f"row {i} field {f}: JSON={jr.get(f)!r} Excel={xr.get(f)!r}")

        ok = len(j_recs) == len(x_recs) == len(eq_invoices) and len(mismatches) == 0
        results.append(("EQ JSON == Excel normalised output", PASS if ok else FAIL))
        if mismatches:
            for m in mismatches:
                print(f"  MISMATCH: {m}")
        else:
            print(f"  All {len(fields_to_compare)} fields match across {len(j_recs)} records.")
    except Exception as exc:
        results.append(("EQ JSON == Excel normalised output", FAIL))
        print(f"  ERROR: {exc}")

    # ── Final report ─────────────────────────────────────────────────────────
    print("\n" + "="*70)
    print("TEST RESULTS SUMMARY")
    print("="*70)
    all_pass = True
    for name, status in results:
        indicator = "[PASS]" if status == PASS else "[FAIL]"
        print(f"  {indicator} {name}")
        if status == FAIL:
            all_pass = False
    print("="*70)
    if all_pass:
        print("All ingestion tests passed.\n")
    else:
        print("Some tests FAILED.\n")
        sys.exit(1)


# ═══════════════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Ingest a GSTR-2B JSON or Excel file into the gstr2b_raw schema."
    )
    parser.add_argument("file", nargs="?", help="Path to GSTR-2B JSON or Excel file")
    parser.add_argument("--period", help="Fallback filing period (YYYY-MM)")
    parser.add_argument("--run-tests", action="store_true", help="Run the built-in test suite")
    args = parser.parse_args()

    if args.run_tests:
        _run_tests()
    elif args.file:
        records, quality_flags = ingest(args.file, filing_period=args.period)
        if quality_flags:
            print(f"Data quality flags ({len(quality_flags)} rows):")
            for flag in quality_flags:
                print(f"  {flag}")
    else:
        parser.print_help()

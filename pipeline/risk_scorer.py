#!/usr/bin/env python3
"""
risk_scorer.py
==============
Row-level reconciliation classifier and risk scorer for GST ITC reconciliation.

This module is the canonical Python equivalent of the BigQuery
``reconciliation_matches`` + ``reconciliation_risk_ranked`` views defined in
``pipeline/bigquery_views.sql``.  It is used to:

  * Manually validate that the BigQuery view produces correct output.
  * Serve as the scoring engine in any non-BigQuery pipeline (e.g. local
    Streamlit dashboard, FastAPI endpoint, unit tests).

Classification priority (mirrors the SQL CASE WHEN order exactly)
-----------------------------------------------------------------
  0. INVALID_GSTIN       -- vendor_gstin on either side fails structural validation
                            (checked BEFORE financial classification; row excluded
                            from risk scoring and routed to data_quality_flags)
  1. DUPLICATE_CLAIM     -- same invoice_number+client_gstin in PR > 1 time
  2. MISSING_IN_2B       -- PR row exists, no GSTR-2B counterpart
  3. MISSING_IN_REGISTER -- GSTR-2B row exists, no PR counterpart
  4. CLEAN_MATCH         -- both exist, amounts OK, same YYYY-MM period
  5. TIMING_DIFFERENCE   -- both exist, amounts OK, period is ANY non-zero distance
                            from the invoice date's YYYY-MM (1 month, 3 months, 6
                            months — any gap).  AMOUNT_MISMATCH is reserved
                            exclusively for cases where the taxable_value or tax
                            amounts themselves differ by more than Rs.100.
  6. AMOUNT_MISMATCH     -- amounts differ by more than Rs.100, regardless of period

  ** Why amounts-match always wins over period gap **
     When a CA opens an invoice detail and sees AMOUNT_MISMATCH but finds identical
     values on both sides, it destroys trust in the tool.  AMOUNT_MISMATCH must only
     appear when there is a genuine financial discrepancy.  A filing-period gap with
     matching amounts is unambiguously a timing/period issue, no matter how large the
     gap.  Both this module and the BigQuery views implement this rule identically.
"""

from __future__ import annotations

import dataclasses
import os
import sys
from datetime import date, datetime
from typing import Optional

# ---------------------------------------------------------------------------
# Import GSTIN validator -- supports both "python pipeline/risk_scorer.py"
# (run from project root) and "from pipeline.risk_scorer import ..." usage.
# ---------------------------------------------------------------------------
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJ_DIR = os.path.dirname(_THIS_DIR)
if _PROJ_DIR not in sys.path:
    sys.path.insert(0, _PROJ_DIR)
try:
    from pipeline.validators import validate_gstin
except ImportError:
    from validators import validate_gstin  # type: ignore[no-redef]

# ---------------------------------------------------------------------------
# Type aliases for readability
# ---------------------------------------------------------------------------
# A purchase_register row or gstr2b row is represented as a plain dict whose
# keys match the column names in the CSV / BigQuery tables.
PRRow    = Optional[dict]
GSTR2BRow = Optional[dict]

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
AMOUNT_TOLERANCE: float = 100.0   # Rs. 100 -- matches BigQuery view tolerance
ITC_CRITICAL_THRESHOLD: float = 50_000.0
ITC_HIGH_AM_THRESHOLD:  float = 25_000.0


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------
@dataclasses.dataclass
class ReconciliationResult:
    """
    Holds the full reconciliation output for one matched (or unmatched) invoice.

    Attributes
    ----------
    invoice_number : str | None
        Invoice number from whichever side is present.
    vendor_gstin : str | None
        Vendor GSTIN from whichever side is present.
    client_gstin : str | None
        Client GSTIN (from PR side; None for MISSING_IN_REGISTER rows).
    mismatch_type : str
        One of: CLEAN_MATCH, TIMING_DIFFERENCE, MISSING_IN_2B,
        MISSING_IN_REGISTER, AMOUNT_MISMATCH, DUPLICATE_CLAIM, INVALID_GSTIN.
    itc_at_risk : float
        Rupee value of ITC at risk.  Non-zero only for MISSING_IN_2B and
        AMOUNT_MISMATCH rows (= total_itc_claimed from the PR side).
        Always 0 for INVALID_GSTIN rows.
    risk_label : str
        One of: CRITICAL, HIGH, MEDIUM, LOW, NONE, DATA_QUALITY.
        INVALID_GSTIN rows carry risk_label='DATA_QUALITY' and are excluded
        from the reconciliation_risk_ranked view / priority queue.
    explanation : str
        One-sentence human-readable reason for the classification -- suitable
        for display to a Chartered Accountant without further interpretation.
    taxable_diff : float
        Absolute difference in taxable_value between PR and GSTR-2B sides.
        Zero when either side is absent.
    tax_diff : float
        Absolute difference in total tax (cgst+sgst+igst) between PR and
        GSTR-2B sides.  Zero when either side is absent.
    dup_count : int
        How many times this invoice_number+client_gstin appears in the PR.
        Relevant only for DUPLICATE_CLAIM rows.
    validation_error : str | None
        Populated only for INVALID_GSTIN rows; contains the specific structural
        error message from validate_gstin().  None for all other types.
    gstin_source : str | None
        For INVALID_GSTIN rows: 'purchase_register' or 'gstr2b' -- identifies
        which dataset contained the malformed GSTIN.  None for all other types.
    """
    invoice_number:   Optional[str]
    vendor_gstin:     Optional[str]
    client_gstin:     Optional[str]
    mismatch_type:    str
    itc_at_risk:      float
    risk_label:       str
    explanation:      str
    taxable_diff:     float         = 0.0
    tax_diff:         float         = 0.0
    dup_count:        int           = 1
    validation_error: Optional[str] = None
    gstin_source:     Optional[str] = None


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _safe_float(value, default: float = 0.0) -> float:
    """Convert a value to float, returning ``default`` for None / empty string."""
    if value is None:
        return default
    try:
        return float(value)
    except (ValueError, TypeError):
        return default


def _parse_date(value) -> Optional[date]:
    """
    Parse an invoice_date value into a ``datetime.date``.

    Accepts:
      * ``datetime.date`` objects (returned as-is)
      * ``datetime.datetime`` objects (date part extracted)
      * ISO-format strings "YYYY-MM-DD"

    Returns None if the value is absent or unparseable.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return datetime.strptime(str(value).strip()[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def _parse_filing_period(value) -> Optional[date]:
    """
    Parse a filing_period "YYYY-MM" string into the first day of that month.

    Returns None if the value is absent or unparseable.
    """
    if value is None:
        return None
    s = str(value).strip()
    try:
        return datetime.strptime(s + "-01", "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def _months_apart(d1: date, d2: date) -> int:
    """
    Return the absolute number of calendar months between two dates, computed
    by comparing (year, month) only -- day differences are ignored.

    This mirrors BigQuery's:
        ABS(DATE_DIFF(
            PARSE_DATE('%Y-%m-%d', CONCAT(filing_period, '-01')),
            DATE_TRUNC(invoice_date, MONTH),
            MONTH
        ))
    """
    return abs((d1.year - d2.year) * 12 + (d1.month - d2.month))


def _total_tax(row: dict) -> float:
    """Sum cgst + sgst + igst from a row dict, treating missing values as 0."""
    return (
        _safe_float(row.get("cgst"))
        + _safe_float(row.get("sgst"))
        + _safe_float(row.get("igst"))
    )


def _invoice_month_first_day(invoice_date: date) -> date:
    """Return the first day of the month containing invoice_date."""
    return invoice_date.replace(day=1)


# ---------------------------------------------------------------------------
# Risk labelling  (mirrors reconciliation_risk_ranked view)
# ---------------------------------------------------------------------------

def _assign_risk_label(mismatch_type: str, itc_at_risk: float) -> str:
    """
    Derive the risk_label from mismatch_type + itc_at_risk.

    Priority:
      CRITICAL > HIGH > MEDIUM > LOW > NONE

    Mirrors the CASE WHEN in reconciliation_risk_ranked.
    """
    # INVALID_GSTIN is a data-quality issue, not a financial risk.
    # DATA_QUALITY rows are excluded from reconciliation_risk_ranked.
    if mismatch_type == "INVALID_GSTIN":
        return "DATA_QUALITY"
    if mismatch_type == "MISSING_IN_2B" and itc_at_risk > ITC_CRITICAL_THRESHOLD:
        return "CRITICAL"
    if mismatch_type == "MISSING_IN_2B":
        return "HIGH"
    if mismatch_type == "AMOUNT_MISMATCH" and itc_at_risk > ITC_HIGH_AM_THRESHOLD:
        return "HIGH"
    if mismatch_type == "AMOUNT_MISMATCH":
        return "MEDIUM"
    if mismatch_type == "DUPLICATE_CLAIM":
        return "MEDIUM"
    if mismatch_type in ("TIMING_DIFFERENCE", "MISSING_IN_REGISTER"):
        return "LOW"
    # CLEAN_MATCH
    return "NONE"


# ---------------------------------------------------------------------------
# Explanation templates
# ---------------------------------------------------------------------------

def _build_explanation(
    mismatch_type: str,
    pr_row: PRRow,
    gstr2b_row: GSTR2BRow,
    itc_at_risk: float,
    taxable_diff: float,
    tax_diff: float,
    dup_count: int,
    month_gap: Optional[int],
) -> str:
    """
    Return a one-sentence explanation of the classification.

    The explanation is written for a Chartered Accountant -- it names the
    specific invoices, amounts, and parties involved so the reader can act on
    it directly without having to cross-reference the raw data.
    """
    inv  = (pr_row or gstr2b_row or {}).get("invoice_number", "unknown")
    gstn = (pr_row or gstr2b_row or {}).get("vendor_gstin",   "unknown")
    client = (pr_row or {}).get("client_gstin", "unknown")

    if mismatch_type == "CLEAN_MATCH":
        return (
            f"Invoice {inv} from vendor {gstn} reconciles perfectly: "
            f"taxable values and tax amounts match within Rs.{AMOUNT_TOLERANCE:.0f} "
            f"and the filing period aligns with the invoice date."
        )

    if mismatch_type == "TIMING_DIFFERENCE":
        fp = (gstr2b_row or {}).get("filing_period", "unknown")
        inv_date = _parse_date((pr_row or {}).get("invoice_date"))
        inv_month = inv_date.strftime("%Y-%m") if inv_date else "unknown"
        gap_str = f"{month_gap} calendar month(s)" if month_gap is not None else "a different period"
        return (
            f"Invoice {inv} from vendor {gstn} amounts match within tolerance, "
            f"but was filed in GSTR-2B under period {fp} instead of {inv_month} "
            f"({gap_str} difference) -- ITC may be claimable once the correct "
            f"period is identified; confirm with vendor."
        )

    if mismatch_type == "MISSING_IN_2B":
        return (
            f"Invoice {inv} claims Rs.{itc_at_risk:,.2f} ITC for client {client} "
            f"but has no corresponding entry in vendor {gstn}'s GSTR-2B filing "
            f"-- likely vendor non-compliance, late filing, or an invoice not "
            f"reported to the GST portal; ITC credit is at risk."
        )

    if mismatch_type == "MISSING_IN_REGISTER":
        b_tv = _safe_float((gstr2b_row or {}).get("taxable_value"))
        return (
            f"Invoice {inv} from vendor {gstn} (taxable value Rs.{b_tv:,.2f}) "
            f"appears in GSTR-2B but was not recorded in the Purchase Register "
            f"-- this may represent a missed ITC opportunity or a data-entry gap "
            f"that requires the client to check their books."
        )

    if mismatch_type == "AMOUNT_MISMATCH":
        pr_tv  = _safe_float((pr_row or {}).get("taxable_value"))
        b_tv   = _safe_float((gstr2b_row or {}).get("taxable_value"))
        return (
            f"Invoice {inv} from vendor {gstn} has a taxable value of "
            f"Rs.{pr_tv:,.2f} in the Purchase Register vs Rs.{b_tv:,.2f} in "
            f"GSTR-2B (difference Rs.{taxable_diff:,.2f}; tax difference "
            f"Rs.{tax_diff:,.2f}) -- ITC claim of Rs.{itc_at_risk:,.2f} may be "
            f"partially or fully disallowed until amounts are reconciled."
        )

    if mismatch_type == "DUPLICATE_CLAIM":
        return (
            f"Invoice {inv} from vendor {gstn} appears {dup_count} times in the "
            f"Purchase Register for client {client} -- only one ITC claim is "
            f"legitimate; the additional {dup_count - 1} claim(s) must be reversed "
            f"to avoid a demand notice."
        )

    return f"Invoice {inv}: unrecognised mismatch type '{mismatch_type}'."


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def score_invoice(
    pr_row: PRRow,
    gstr2b_row: GSTR2BRow,
    dup_count: int = 1,
) -> ReconciliationResult:
    """
    Classify one invoice pair and return a full :class:`ReconciliationResult`.

    This function implements the exact same CASE WHEN priority order as the
    BigQuery ``reconciliation_matches`` view, using the same tolerance values.

    Parameters
    ----------
    pr_row : dict or None
        A single row from ``purchase_register_raw``.  Pass ``None`` for rows
        that exist only in GSTR-2B (MISSING_IN_REGISTER case).
        Expected keys: invoice_id, vendor_gstin, vendor_name, invoice_date,
        invoice_number, taxable_value, cgst, sgst, igst, total_itc_claimed,
        client_gstin.
    gstr2b_row : dict or None
        A single row from ``gstr2b_raw``.  Pass ``None`` for rows that exist
        only in the Purchase Register (MISSING_IN_2B case).
        Expected keys: gstr2b_id, vendor_gstin, invoice_number, invoice_date,
        taxable_value, cgst, sgst, igst, itc_available, filing_period.
    dup_count : int
        How many times this invoice_number + client_gstin + vendor_gstin
        combination appears in the Purchase Register.  Pass 1 (the default)
        for rows that are not duplicated.  This value must be computed by the
        caller from the full dataset (see :func:`build_dup_map`).

    Returns
    -------
    ReconciliationResult

    Raises
    ------
    ValueError
        If both ``pr_row`` and ``gstr2b_row`` are ``None``.
    """
    if pr_row is None and gstr2b_row is None:
        raise ValueError("At least one of pr_row or gstr2b_row must be non-None.")

    # Convenience accessors
    inv_num      = (pr_row or gstr2b_row or {}).get("invoice_number")
    vendor_gstin = (pr_row or gstr2b_row or {}).get("vendor_gstin")
    client_gstin = (pr_row or {}).get("client_gstin")

    # -----------------------------------------------------------------------
    # Priority 0: GSTIN structural validation
    # Checked BEFORE any financial classification.  A malformed GSTIN is a
    # data-quality problem; the row must not enter the risk-scoring queue.
    # We validate the vendor_gstin on each side independently so that if the
    # 2B side is the bad actor we still surface the correct source.
    # -----------------------------------------------------------------------
    for raw_gstin, source_label in [
        ((pr_row    or {}).get("vendor_gstin"), "purchase_register"),
        ((gstr2b_row or {}).get("vendor_gstin"), "gstr2b"),
    ]:
        if raw_gstin is None:
            continue
        is_valid, gstin_err = validate_gstin(str(raw_gstin))
        if not is_valid:
            inv_str    = str(inv_num)    if inv_num    is not None else None
            client_str = str(client_gstin) if client_gstin is not None else None
            explanation = (
                f"Vendor GSTIN '{raw_gstin}' (from {source_label}) failed structural "
                f"validation: {gstin_err} "
                f"This row is excluded from financial risk scoring and flagged for "
                f"data quality review in the data_quality_flags view."
            )
            return ReconciliationResult(
                invoice_number=inv_str,
                vendor_gstin=str(raw_gstin),
                client_gstin=client_str,
                mismatch_type="INVALID_GSTIN",
                itc_at_risk=0.0,
                risk_label="DATA_QUALITY",
                explanation=explanation,
                validation_error=gstin_err,
                gstin_source=source_label,
            )

    # -----------------------------------------------------------------------
    # Pre-compute differences (safe even when a side is None)
    # -----------------------------------------------------------------------
    pr_taxable  = _safe_float((pr_row or {}).get("taxable_value"))
    b_taxable   = _safe_float((gstr2b_row or {}).get("taxable_value"))
    taxable_diff = abs(pr_taxable - b_taxable)

    pr_total_tax = _total_tax(pr_row or {})
    b_total_tax  = _total_tax(gstr2b_row or {})
    # BigQuery uses total_itc_claimed vs itc_available for the tax comparison
    pr_itc  = _safe_float((pr_row or {}).get("total_itc_claimed"))
    b_itc   = _safe_float((gstr2b_row or {}).get("itc_available"))
    tax_diff = abs(pr_itc - b_itc)

    amounts_match = (taxable_diff <= AMOUNT_TOLERANCE) and (tax_diff <= AMOUNT_TOLERANCE)

    # Month arithmetic for CLEAN_MATCH / TIMING_DIFFERENCE
    invoice_date   = _parse_date((pr_row or {}).get("invoice_date"))
    filing_period  = _parse_filing_period((gstr2b_row or {}).get("filing_period"))
    month_gap: Optional[int] = None

    if invoice_date is not None and filing_period is not None:
        invoice_month_first = _invoice_month_first_day(invoice_date)
        month_gap = _months_apart(filing_period, invoice_month_first)
        period_matches_invoice = (month_gap == 0)
        period_adjacent        = (month_gap == 1)
    else:
        period_matches_invoice = False
        period_adjacent        = False

    # -----------------------------------------------------------------------
    # CASE WHEN classification  (mirrors SQL priority order exactly)
    # -----------------------------------------------------------------------

    # Priority 1: DUPLICATE_CLAIM
    # SQL: pr.invoice_number IS NOT NULL AND pr.dup_count > 1
    if pr_row is not None and dup_count > 1:
        mismatch_type = "DUPLICATE_CLAIM"

    # Priority 2: MISSING_IN_2B
    # SQL: pr.invoice_number IS NOT NULL AND b.invoice_number IS NULL
    elif pr_row is not None and gstr2b_row is None:
        mismatch_type = "MISSING_IN_2B"

    # Priority 3: MISSING_IN_REGISTER
    # SQL: pr.invoice_number IS NULL AND b.invoice_number IS NOT NULL
    elif pr_row is None and gstr2b_row is not None:
        mismatch_type = "MISSING_IN_REGISTER"

    # Priority 4: CLEAN_MATCH
    # SQL: both present, amounts OK, filing_period == YYYY-MM of invoice_date
    elif amounts_match and period_matches_invoice:
        mismatch_type = "CLEAN_MATCH"

    # Priority 5: TIMING_DIFFERENCE
    # Both rows present, amounts within Rs.100 tolerance, but filing period does
    # NOT match the invoice date's YYYY-MM — regardless of how many months apart.
    # This is canonical: a period gap with matching amounts is always a timing
    # issue, never an amount issue.  Matches the BigQuery SQL rule exactly.
    elif amounts_match and not period_matches_invoice:
        mismatch_type = "TIMING_DIFFERENCE"

    # Priority 6: AMOUNT_MISMATCH
    # Reached ONLY when amounts differ by more than Rs.100 (taxable_value or
    # total_itc_claimed / itc_available).  Period gap is irrelevant here.
    else:
        mismatch_type = "AMOUNT_MISMATCH"

    # -----------------------------------------------------------------------
    # Compute itc_at_risk
    # SQL: COALESCE(pr_total_itc_claimed, 0) when MISSING_IN_2B or AMOUNT_MISMATCH
    # -----------------------------------------------------------------------
    if mismatch_type in ("MISSING_IN_2B", "AMOUNT_MISMATCH"):
        itc_at_risk = _safe_float((pr_row or {}).get("total_itc_claimed"), 0.0)
    else:
        itc_at_risk = 0.0

    # -----------------------------------------------------------------------
    # Risk label
    # -----------------------------------------------------------------------
    risk_label = _assign_risk_label(mismatch_type, itc_at_risk)

    # -----------------------------------------------------------------------
    # Human-readable explanation
    # -----------------------------------------------------------------------
    explanation = _build_explanation(
        mismatch_type=mismatch_type,
        pr_row=pr_row,
        gstr2b_row=gstr2b_row,
        itc_at_risk=itc_at_risk,
        taxable_diff=taxable_diff,
        tax_diff=tax_diff,
        dup_count=dup_count,
        month_gap=month_gap,
    )

    return ReconciliationResult(
        invoice_number=str(inv_num) if inv_num is not None else None,
        vendor_gstin=str(vendor_gstin) if vendor_gstin is not None else None,
        client_gstin=str(client_gstin) if client_gstin is not None else None,
        mismatch_type=mismatch_type,
        itc_at_risk=itc_at_risk,
        risk_label=risk_label,
        explanation=explanation,
        taxable_diff=taxable_diff,
        tax_diff=tax_diff,
        dup_count=dup_count,
    )


# ---------------------------------------------------------------------------
# Dataset-level helpers
# ---------------------------------------------------------------------------

def build_dup_map(pr_rows: list[dict]) -> dict[tuple, int]:
    """
    Pre-compute duplicate counts for all purchase register rows.

    Returns a dict mapping (client_gstin, invoice_number, vendor_gstin) -> count.
    Pass the returned map's value into :func:`score_invoice` as ``dup_count``.

    This mirrors the BigQuery window function:
        COUNT(*) OVER (PARTITION BY client_gstin, invoice_number, vendor_gstin)

    Parameters
    ----------
    pr_rows : list[dict]
        All rows from the Purchase Register.

    Returns
    -------
    dict[tuple, int]
    """
    counts: dict[tuple, int] = {}
    for row in pr_rows:
        key = (
            str(row.get("client_gstin",   "") or ""),
            str(row.get("invoice_number", "") or ""),
            str(row.get("vendor_gstin",   "") or ""),
        )
        counts[key] = counts.get(key, 0) + 1
    return counts


def score_dataset(
    pr_rows: list[dict],
    gstr2b_rows: list[dict],
) -> list[ReconciliationResult]:
    """
    Run the full reconciliation pipeline over two complete datasets.

    Performs a full outer join on (vendor_gstin, invoice_number), computes
    dup_count for each PR row, and calls :func:`score_invoice` for every
    matched or unmatched pair.

    Parameters
    ----------
    pr_rows : list[dict]
        All rows from purchase_register_raw.
    gstr2b_rows : list[dict]
        All rows from gstr2b_raw.

    Returns
    -------
    list[ReconciliationResult]
    """
    dup_map = build_dup_map(pr_rows)

    # Index GSTR-2B rows by (vendor_gstin, invoice_number) for O(1) lookup
    b_index: dict[tuple, list[dict]] = {}
    for row in gstr2b_rows:
        key = (
            str(row.get("vendor_gstin",   "") or ""),
            str(row.get("invoice_number", "") or ""),
        )
        b_index.setdefault(key, []).append(row)

    results: list[ReconciliationResult] = []
    matched_b_keys: set[int] = set()  # track which GSTR-2B rows were matched

    # --- Process each PR row
    for pr_row in pr_rows:
        key = (
            str(pr_row.get("vendor_gstin",   "") or ""),
            str(pr_row.get("invoice_number", "") or ""),
        )
        dup_count = dup_map.get(
            (
                str(pr_row.get("client_gstin",   "") or ""),
                str(pr_row.get("invoice_number", "") or ""),
                str(pr_row.get("vendor_gstin",   "") or ""),
            ),
            1,
        )
        matched_b_rows = b_index.get(key)
        gstr2b_row = matched_b_rows[0] if matched_b_rows else None

        if gstr2b_row is not None:
            matched_b_keys.add(id(gstr2b_row))

        results.append(score_invoice(pr_row, gstr2b_row, dup_count=dup_count))

    # --- Process GSTR-2B rows that had no PR match (MISSING_IN_REGISTER)
    for b_row in gstr2b_rows:
        if id(b_row) not in matched_b_keys:
            results.append(score_invoice(None, b_row, dup_count=1))

    return results


def get_data_quality_flags(
    results: list[ReconciliationResult],
) -> list[ReconciliationResult]:
    """
    Filter a list of reconciliation results to only INVALID_GSTIN rows.

    These rows are intended for the ``data_quality_flags`` BigQuery view and
    the dashboard's "Needs Attention" panel.  They must NOT be mixed with
    the risk-ranked results returned by
    ``reconciliation_risk_ranked``.

    Parameters
    ----------
    results : list[ReconciliationResult]
        Full output from :func:`score_dataset` or repeated calls to
        :func:`score_invoice`.

    Returns
    -------
    list[ReconciliationResult]
        Only rows where ``mismatch_type == 'INVALID_GSTIN'``.
    """
    return [r for r in results if r.mismatch_type == "INVALID_GSTIN"]

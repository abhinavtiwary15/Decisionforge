#!/usr/bin/env python3
"""
test_edge_cases.py
==================
Edge-case test suite for pipeline/risk_scorer.py.

Each test is a self-contained function that calls score_invoice() directly and
prints a clearly formatted block showing: the input scenario, expected outcome,
actual outcome, and PASS/FAIL status.  No external test framework is required --
just run the file:

    python pipeline/test_edge_cases.py

Tests covered
-------------
  TC-01  Null amount on the PR side (taxable_value is None)
  TC-02  Null amount on the GSTR-2B side (taxable_value is None)
  TC-03  Both sides null amounts (both taxable_value are None)
  TC-04  Invoice number matches but vendor_gstin differs -> must NOT match
  TC-05  Filing period 2 months ahead of invoice date, amounts OK
           -> TIMING_DIFFERENCE (amounts match -> always TIMING_DIFFERENCE, any gap)
  TC-06  Filing period 6 months ahead of invoice date, amounts differ > Rs.100
           -> AMOUNT_MISMATCH
  TC-07  Duplicate claim with dup_count = 3 (not just 2)
  TC-08  Duplicate claim with dup_count = 10 (stress test)
  TC-09  CLEAN_MATCH -- exactly at the Rs.100 tolerance boundary
  TC-10  AMOUNT_MISMATCH -- Rs.100.01 over the boundary (just outside)
  TC-11  MISSING_IN_2B risk thresholds: itc_at_risk = 50,000 -> HIGH (not CRITICAL)
  TC-12  MISSING_IN_2B risk thresholds: itc_at_risk = 50,001 -> CRITICAL
  TC-13  AMOUNT_MISMATCH risk thresholds: itc_at_risk = 25,000 -> MEDIUM
  TC-14  AMOUNT_MISMATCH risk thresholds: itc_at_risk = 25,001 -> HIGH
  TC-15  score_invoice raises ValueError when both rows are None
  TC-20  Amounts match exactly, filing period 3+ months apart
           -> TIMING_DIFFERENCE, never AMOUNT_MISMATCH (canonical rule verification)
"""

import sys
import traceback
from typing import Optional

# Allow running from repo root without installing as a package
sys.path.insert(0, __file__.rsplit("\\", 2)[0])
sys.path.insert(0, __file__.rsplit("/", 2)[0])

from pipeline.risk_scorer import score_invoice, ReconciliationResult

# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------

_PASS = 0
_FAIL = 0
_ERRORS = 0


def _header(tc_id: str, description: str) -> None:
    print(f"\n{'='*72}")
    print(f"  {tc_id}: {description}")
    print(f"{'='*72}")


def _check(label: str, actual, expected, display_actual=None) -> bool:
    display = display_actual if display_actual is not None else repr(actual)
    ok = actual == expected
    status = "PASS" if ok else "FAIL"
    print(f"  [{status}]  {label}")
    print(f"          expected : {repr(expected)}")
    print(f"          actual   : {display}")
    return ok


def _run_test(tc_id: str, description: str, fn) -> None:
    global _PASS, _FAIL, _ERRORS
    _header(tc_id, description)
    try:
        passed = fn()
        if passed:
            _PASS += 1
        else:
            _FAIL += 1
    except Exception as exc:
        _ERRORS += 1
        print(f"  [ERROR] Test raised an unexpected exception:")
        traceback.print_exc()


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

def _pr(invoice_number="INV-001", vendor_gstin="27AAAAA0000A1Z5",
        client_gstin="29BBBBB1111B2Z6", invoice_date="2026-03-15",
        taxable_value=10_000.0, cgst=900.0, sgst=900.0, igst=0.0,
        total_itc_claimed=1_800.0) -> dict:
    """Return a minimal Purchase Register row dict."""
    return {
        "invoice_id":        "pr-uuid-001",
        "vendor_gstin":      vendor_gstin,
        "vendor_name":       "Test Vendor Pvt Ltd",
        "invoice_date":      invoice_date,
        "invoice_number":    invoice_number,
        "taxable_value":     taxable_value,
        "cgst":              cgst,
        "sgst":              sgst,
        "igst":              igst,
        "total_itc_claimed": total_itc_claimed,
        "client_gstin":      client_gstin,
    }


def _b(invoice_number="INV-001", vendor_gstin="27AAAAA0000A1Z5",
       invoice_date="2026-03-15", taxable_value=10_000.0,
       cgst=900.0, sgst=900.0, igst=0.0, itc_available=1_800.0,
       filing_period="2026-03") -> dict:
    """Return a minimal GSTR-2B row dict."""
    return {
        "gstr2b_id":      "b-uuid-001",
        "vendor_gstin":   vendor_gstin,
        "invoice_number": invoice_number,
        "invoice_date":   invoice_date,
        "taxable_value":  taxable_value,
        "cgst":           cgst,
        "sgst":           sgst,
        "igst":           igst,
        "itc_available":  itc_available,
        "filing_period":  filing_period,
    }


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

def tc01_null_pr_taxable_value():
    """TC-01: taxable_value is None on PR side -- must not crash; treat as 0."""
    pr = _pr(taxable_value=None, total_itc_claimed=1_800.0)
    b  = _b(taxable_value=10_000.0, itc_available=1_800.0, filing_period="2026-03")
    result = score_invoice(pr, b, dup_count=1)
    print(f"  mismatch_type : {result.mismatch_type}")
    print(f"  taxable_diff  : {result.taxable_diff}  (expected 10000.0 -- None treated as 0)")
    print(f"  tax_diff      : {result.tax_diff}")
    print(f"  risk_label    : {result.risk_label}")
    print(f"  explanation   : {result.explanation}")
    # taxable_diff = |0 - 10000| = 10000 > 100, so AMOUNT_MISMATCH
    ok = _check("mismatch_type", result.mismatch_type, "AMOUNT_MISMATCH")
    ok &= _check("did not crash", True, True)
    ok &= _check("taxable_diff", result.taxable_diff, 10_000.0)
    return ok


def tc02_null_b_taxable_value():
    """TC-02: taxable_value is None on GSTR-2B side -- must not crash; treat as 0."""
    pr = _pr(taxable_value=10_000.0, total_itc_claimed=1_800.0)
    b  = _b(taxable_value=None, itc_available=1_800.0, filing_period="2026-03")
    result = score_invoice(pr, b, dup_count=1)
    print(f"  mismatch_type : {result.mismatch_type}")
    print(f"  taxable_diff  : {result.taxable_diff}  (expected 10000.0)")
    ok = _check("mismatch_type", result.mismatch_type, "AMOUNT_MISMATCH")
    ok &= _check("taxable_diff", result.taxable_diff, 10_000.0)
    return ok


def tc03_both_null_amounts():
    """TC-03: Both sides have None amounts -- treated as 0 on both sides;
    taxable_diff = 0, tax_diff = 0, so amounts_match = True.
    filing_period '2026-03' matches invoice_date '2026-03-15' YYYY-MM -> CLEAN_MATCH."""
    pr = _pr(taxable_value=None, cgst=None, sgst=None, igst=None, total_itc_claimed=None)
    b  = _b(taxable_value=None, cgst=None, sgst=None, igst=None, itc_available=None,
            filing_period="2026-03")
    result = score_invoice(pr, b, dup_count=1)
    print(f"  mismatch_type : {result.mismatch_type}")
    print(f"  taxable_diff  : {result.taxable_diff}")
    print(f"  tax_diff      : {result.tax_diff}")
    print(f"  risk_label    : {result.risk_label}")
    ok = _check("mismatch_type (both null amounts, period matches -> CLEAN_MATCH)",
                result.mismatch_type, "CLEAN_MATCH")
    ok &= _check("itc_at_risk", result.itc_at_risk, 0.0)
    return ok


def tc04_invoice_match_different_gstin():
    """TC-04: Same invoice_number but DIFFERENT vendor_gstin on GSTR-2B side.
    The match key is (vendor_gstin, invoice_number), so a different GSTIN means
    NO match.  The caller must pass gstr2b_row=None for the PR row, and pr_row=None
    for the 2B row.  score_invoice() itself does NOT perform the join -- it trusts
    the caller's pairing.  This test verifies the correct caller behaviour:
    both rows passed without a join -> caller error; two separate calls -> correct."""
    # Correct usage: PR row gets no GSTR-2B match (different vendor)
    pr = _pr(invoice_number="INV-999", vendor_gstin="27AAAAA0000A1Z5")
    b  = _b(invoice_number="INV-999", vendor_gstin="33ZZZZZ9999Z9Z9")  # different GSTIN

    # Call 1: PR row with no 2B match (MISSING_IN_2B)
    result_pr = score_invoice(pr, None, dup_count=1)
    # Call 2: 2B row with no PR match (MISSING_IN_REGISTER)
    result_b  = score_invoice(None, b, dup_count=1)

    print(f"  PR row  mismatch_type : {result_pr.mismatch_type} (expected MISSING_IN_2B)")
    print(f"  2B row  mismatch_type : {result_b.mismatch_type}  (expected MISSING_IN_REGISTER)")
    print(f"  Note: score_invoice trusts caller's join; different vendor_gstin")
    print(f"        means NO structural match -- the two rows are independent.")

    ok  = _check("PR row -> MISSING_IN_2B",       result_pr.mismatch_type, "MISSING_IN_2B")
    ok &= _check("2B row -> MISSING_IN_REGISTER", result_b.mismatch_type,  "MISSING_IN_REGISTER")
    return ok


def tc05_filing_period_2_months_ahead_amounts_ok():
    """TC-05: filing_period is 2 months ahead of invoice_date; amounts within tolerance.
    Both Python (risk_scorer.py) and BigQuery SQL now agree: when amounts are within
    Rs.100 tolerance, the row is TIMING_DIFFERENCE regardless of the month gap.
    AMOUNT_MISMATCH is reserved exclusively for genuine financial discrepancies."""
    pr = _pr(invoice_date="2026-01-20", taxable_value=50_000.0, total_itc_claimed=9_000.0)
    b  = _b(taxable_value=50_000.0, itc_available=9_000.0, filing_period="2026-03")
    # month_gap = |2026-03 - 2026-01| = 2 months
    result = score_invoice(pr, b, dup_count=1)
    print(f"  month_gap     : 2 (2026-01 invoice -> 2026-03 filing)")
    print(f"  amounts_match : True (taxable_diff=0, tax_diff=0)")
    print(f"  mismatch_type : {result.mismatch_type}")
    print(f"  risk_label    : {result.risk_label}")
    print(f"  explanation   : {result.explanation}")
    ok = _check("mismatch_type (amounts match + any gap -> TIMING_DIFFERENCE)",
                result.mismatch_type, "TIMING_DIFFERENCE")
    ok &= _check("risk_label", result.risk_label, "LOW")
    ok &= _check("itc_at_risk", result.itc_at_risk, 0.0)
    return ok


def tc06_filing_period_6_months_amounts_differ():
    """TC-06: Filing period 6 months apart AND amounts differ by more than Rs.100.
    Both conditions trigger AMOUNT_MISMATCH (amounts differ takes priority even
    without the period check)."""
    pr = _pr(invoice_date="2026-01-20", taxable_value=50_000.0, total_itc_claimed=9_000.0)
    b  = _b(taxable_value=55_000.0, itc_available=9_900.0, filing_period="2026-07")
    result = score_invoice(pr, b, dup_count=1)
    print(f"  month_gap     : 6 (2026-01 invoice -> 2026-07 filing)")
    print(f"  taxable_diff  : {result.taxable_diff}  (5000 > 100)")
    print(f"  mismatch_type : {result.mismatch_type}")
    print(f"  risk_label    : {result.risk_label}")
    print(f"  itc_at_risk   : {result.itc_at_risk}")
    ok = _check("mismatch_type", result.mismatch_type, "AMOUNT_MISMATCH")
    ok &= _check("itc_at_risk (= pr total_itc_claimed = 9000)", result.itc_at_risk, 9_000.0)
    return ok


def tc07_duplicate_claim_dup_count_3():
    """TC-07: Duplicate claim with dup_count = 3 (three occurrences in PR).
    Must classify as DUPLICATE_CLAIM, not crash or produce MISSING_IN_2B."""
    pr = _pr(total_itc_claimed=5_000.0)
    b  = _b(itc_available=5_000.0, filing_period="2026-03")
    result = score_invoice(pr, b, dup_count=3)
    print(f"  dup_count     : 3")
    print(f"  mismatch_type : {result.mismatch_type}")
    print(f"  risk_label    : {result.risk_label}")
    print(f"  explanation   : {result.explanation}")
    ok  = _check("mismatch_type", result.mismatch_type, "DUPLICATE_CLAIM")
    ok &= _check("risk_label",    result.risk_label,    "MEDIUM")
    ok &= _check("itc_at_risk",   result.itc_at_risk,   0.0)
    # Explanation should mention the dup_count
    mentions_count = "3" in result.explanation
    ok &= _check("explanation mentions count (3)", mentions_count, True)
    return ok


def tc08_duplicate_claim_dup_count_10():
    """TC-08: Stress test -- dup_count = 10.  Must still classify correctly."""
    pr = _pr(total_itc_claimed=12_000.0)
    b  = _b(itc_available=12_000.0, filing_period="2026-03")
    result = score_invoice(pr, b, dup_count=10)
    print(f"  dup_count     : 10")
    print(f"  mismatch_type : {result.mismatch_type}")
    print(f"  explanation   : {result.explanation}")
    ok  = _check("mismatch_type", result.mismatch_type, "DUPLICATE_CLAIM")
    ok &= _check("dup_count on result", result.dup_count, 10)
    ok &= _check("explanation mentions count (10)", "10" in result.explanation, True)
    return ok


def tc09_clean_match_at_boundary():
    """TC-09: Amounts differ by exactly Rs.100 (should be CLEAN_MATCH, not AMOUNT_MISMATCH).
    The tolerance condition is <= 100, so the boundary value must be CLEAN."""
    pr = _pr(taxable_value=10_000.0, total_itc_claimed=1_800.0)
    b  = _b(taxable_value=10_100.0,  itc_available=1_800.0, filing_period="2026-03")
    # taxable_diff = 100.0, tax_diff = 0.0 -> amounts_match = True
    result = score_invoice(pr, b, dup_count=1)
    print(f"  taxable_diff  : {result.taxable_diff}  (exactly 100 -- boundary)")
    print(f"  mismatch_type : {result.mismatch_type}")
    ok = _check("mismatch_type (<=100 -> CLEAN_MATCH)", result.mismatch_type, "CLEAN_MATCH")
    ok &= _check("itc_at_risk", result.itc_at_risk, 0.0)
    return ok


def tc10_amount_mismatch_just_over_boundary():
    """TC-10: Amounts differ by Rs.100.01 (just outside tolerance -> AMOUNT_MISMATCH)."""
    pr = _pr(taxable_value=10_000.0, total_itc_claimed=1_800.0)
    b  = _b(taxable_value=10_100.01, itc_available=1_800.0, filing_period="2026-03")
    result = score_invoice(pr, b, dup_count=1)
    print(f"  taxable_diff  : {result.taxable_diff}  (100.01 -- just over boundary)")
    print(f"  mismatch_type : {result.mismatch_type}")
    ok = _check("mismatch_type (>100 -> AMOUNT_MISMATCH)", result.mismatch_type, "AMOUNT_MISMATCH")
    ok &= _check("itc_at_risk", result.itc_at_risk, 1_800.0)
    return ok


def tc11_missing_in_2b_at_critical_boundary():
    """TC-11: MISSING_IN_2B with itc_at_risk = exactly Rs.50,000 -> HIGH (not CRITICAL).
    The threshold is > 50,000 (strict), so 50,000 must be HIGH."""
    pr = _pr(total_itc_claimed=50_000.0)
    result = score_invoice(pr, None, dup_count=1)
    print(f"  itc_at_risk   : {result.itc_at_risk}  (exactly 50000 -- boundary)")
    print(f"  risk_label    : {result.risk_label}")
    ok  = _check("mismatch_type", result.mismatch_type, "MISSING_IN_2B")
    ok &= _check("risk_label (50000 -> HIGH, not CRITICAL)", result.risk_label, "HIGH")
    return ok


def tc12_missing_in_2b_just_above_critical_threshold():
    """TC-12: MISSING_IN_2B with itc_at_risk = Rs.50,001 -> CRITICAL."""
    pr = _pr(total_itc_claimed=50_001.0)
    result = score_invoice(pr, None, dup_count=1)
    print(f"  itc_at_risk   : {result.itc_at_risk}  (50001 -- just above threshold)")
    print(f"  risk_label    : {result.risk_label}")
    ok  = _check("mismatch_type", result.mismatch_type, "MISSING_IN_2B")
    ok &= _check("risk_label (50001 -> CRITICAL)", result.risk_label, "CRITICAL")
    return ok


def tc13_amount_mismatch_at_high_boundary():
    """TC-13: AMOUNT_MISMATCH with itc_at_risk = exactly Rs.25,000 -> MEDIUM (not HIGH).
    The threshold is > 25,000 (strict)."""
    pr = _pr(taxable_value=100_000.0, total_itc_claimed=25_000.0)
    b  = _b(taxable_value=105_000.0,  itc_available=25_000.0, filing_period="2026-03")
    result = score_invoice(pr, b, dup_count=1)
    print(f"  itc_at_risk   : {result.itc_at_risk}  (exactly 25000 -- boundary)")
    print(f"  risk_label    : {result.risk_label}")
    ok  = _check("mismatch_type", result.mismatch_type, "AMOUNT_MISMATCH")
    ok &= _check("risk_label (25000 -> MEDIUM)", result.risk_label, "MEDIUM")
    return ok


def tc14_amount_mismatch_just_above_high_threshold():
    """TC-14: AMOUNT_MISMATCH with itc_at_risk = Rs.25,001 -> HIGH."""
    pr = _pr(taxable_value=100_000.0, total_itc_claimed=25_001.0)
    b  = _b(taxable_value=105_000.0,  itc_available=25_001.0, filing_period="2026-03")
    result = score_invoice(pr, b, dup_count=1)
    print(f"  itc_at_risk   : {result.itc_at_risk}  (25001 -- just above threshold)")
    print(f"  risk_label    : {result.risk_label}")
    ok  = _check("mismatch_type", result.mismatch_type, "AMOUNT_MISMATCH")
    ok &= _check("risk_label (25001 -> HIGH)", result.risk_label, "HIGH")
    return ok


def tc15_both_none_raises_value_error():
    """TC-15: score_invoice(None, None) must raise ValueError immediately."""
    raised = False
    try:
        score_invoice(None, None)
    except ValueError as e:
        raised = True
        print(f"  ValueError raised: {e}")
    ok = _check("ValueError raised for (None, None)", raised, True)
    return ok


# ---------------------------------------------------------------------------
# GSTIN Validation & Integration Test Cases
# ---------------------------------------------------------------------------

from pipeline.validators import validate_gstin
from pipeline.risk_scorer import score_dataset, get_data_quality_flags

def tc16_valid_gstin():
    """TC-16: A valid, correctly-formatted GSTIN — expect (True, None)"""
    gstin = "27AAAAA0000A1Z5"
    valid, err = validate_gstin(gstin)
    print(f"  GSTIN       : {gstin}")
    print(f"  valid       : {valid}")
    print(f"  error       : {err}")
    ok = _check("valid is True", valid, True)
    ok &= _check("error is None", err, None)
    return ok

def tc17_too_short_gstin():
    """TC-17: A too-short GSTIN (e.g. 12 characters) — expect (False, error with length)"""
    gstin = "27AAAAA0000A"
    valid, err = validate_gstin(gstin)
    print(f"  GSTIN       : {gstin}")
    print(f"  valid       : {valid}")
    print(f"  error       : {err}")
    ok = _check("valid is False", valid, False)
    ok &= _check("error mentions length", "length" in str(err).lower() or "exactly 15" in str(err).lower(), True)
    return ok

def tc18_lowercase_gstin():
    """TC-18: A structurally valid GSTIN with lowercase letters — expect (True, None) after normalization"""
    gstin = "27aaaaa0000a1z5"
    valid, err = validate_gstin(gstin)
    print(f"  GSTIN       : {gstin}")
    print(f"  valid       : {valid}")
    print(f"  error       : {err}")
    ok = _check("valid is True after normalization", valid, True)
    ok &= _check("error is None", err, None)
    return ok

def tc19_integration_invalid_gstin():
    """TC-19: Inject a row with a deliberately malformed GSTIN into a small test batch,
    run it through the full matching step, and confirm it:
    (a) appears in data_quality_flags with the right error message,
    (b) does NOT appear in reconciliation_risk_ranked,
    (c) doesn't crash or silently vanish from any output.
    """
    # A small test batch: 2 PR rows, 2 GSTR-2B rows
    # Row 1: clean match with valid GSTIN
    # Row 2: malformed GSTIN in PR (too short)
    # Row 3: GSTR-2B row that matches Row 1
    # Row 4: GSTR-2B row that matches Row 2's invoice number but has valid GSTIN? Or different?
    # Note: different GSTIN match logic is already tested. Let's make Row 2's vendor GSTIN malformed on both sides or just PR side.
    # The requirement: "If a row has a malformed GSTIN, flag it with mismatch_type = 'INVALID_GSTIN' and the specific validation error message."
    
    pr_rows = [
        _pr(invoice_number="INV-GOOD", vendor_gstin="27AAAAA0000A1Z5", client_gstin="29BBBBB1111B2Z6", total_itc_claimed=1000.0),
        _pr(invoice_number="INV-BAD", vendor_gstin="INVALID-GSTIN-SHORT", client_gstin="29BBBBB1111B2Z6", total_itc_claimed=5000.0)
    ]
    gstr2b_rows = [
        _b(invoice_number="INV-GOOD", vendor_gstin="27AAAAA0000A1Z5", filing_period="2026-03"),
        _b(invoice_number="INV-BAD", vendor_gstin="INVALID-GSTIN-SHORT", filing_period="2026-03")
    ]
    
    # Run the full matching step in python
    results = score_dataset(pr_rows, gstr2b_rows)
    
    print(f"  Total results in output: {len(results)}")
    for i, r in enumerate(results):
        print(f"    Result {i}: Inv={r.invoice_number}, GSTIN={r.vendor_gstin}, mismatch_type={r.mismatch_type}, risk_label={r.risk_label}")
    
    # (a) appears in data_quality_flags with the right error message
    dq_flags = get_data_quality_flags(results)
    print(f"  Data quality flags count: {len(dq_flags)}")
    
    # Confirm it doesn't crash, total output count matches (we had 2 distinct joined keys, so 2 results)
    ok = _check("No crash and correct count of results", len(results), 2)
    
    bad_flag_present = any(r.invoice_number == "INV-BAD" and r.mismatch_type == "INVALID_GSTIN" for r in dq_flags)
    ok &= _check("INV-BAD present in data_quality_flags", bad_flag_present, True)
    
    if bad_flag_present:
        bad_r = [r for r in dq_flags if r.invoice_number == "INV-BAD"][0]
        print(f"    Validation error: '{bad_r.validation_error}'")
        ok &= _check("Validation error mentions length / 15 chars", "exactly 15" in str(bad_r.validation_error).lower() or "length" in str(bad_r.validation_error).lower(), True)
    
    # (b) does NOT appear in reconciliation_risk_ranked
    # reconciliation_risk_ranked excludes INVALID_GSTIN / DATA_QUALITY rows.
    risk_ranked = [r for r in results if r.risk_label not in ("DATA_QUALITY", "NONE")]
    print(f"  Risk ranked results count: {len(risk_ranked)}")
    bad_in_risk_ranked = any(r.invoice_number == "INV-BAD" for r in risk_ranked)
    ok &= _check("INV-BAD NOT in risk_ranked output", bad_in_risk_ranked, False)
    
    # (c) doesn't silently vanish from any output:
    bad_in_total_results = any(r.invoice_number == "INV-BAD" for r in results)
    ok &= _check("INV-BAD exists in total results list", bad_in_total_results, True)
    
    return ok


def tc20_amounts_match_large_period_gap_is_timing_difference():
    """TC-20: Amounts match exactly; filing period is 3 months after invoice date.
    New canonical rule: whenever amounts are within Rs.100 tolerance, the row is
    ALWAYS TIMING_DIFFERENCE regardless of the filing period distance.
    AMOUNT_MISMATCH must NOT appear here because no financial discrepancy exists.
    A CA opening this invoice would find identical values on both sides -- calling
    it AMOUNT_MISMATCH would undermine trust in the tool."""
    pr = _pr(
        invoice_date="2025-12-10",
        taxable_value=75_000.0,
        total_itc_claimed=13_500.0,
    )
    b = _b(
        taxable_value=75_000.0,   # exact match
        itc_available=13_500.0,   # exact match
        filing_period="2026-03",  # 3 months after Dec 2025
    )
    # month_gap = |2026-03 - 2025-12| = 3 months
    # Under old SQL rule: would fall through to AMOUNT_MISMATCH (gap != 1)
    # Under new rule: amounts match -> TIMING_DIFFERENCE regardless of gap
    result = score_invoice(pr, b, dup_count=1)
    print(f"  invoice_date  : 2025-12-10  (YYYY-MM: 2025-12)")
    print(f"  filing_period : 2026-03     (3 months after invoice month)")
    print(f"  taxable_diff  : {result.taxable_diff}  (exactly 0 -- identical values)")
    print(f"  tax_diff      : {result.tax_diff}     (exactly 0 -- identical values)")
    print(f"  mismatch_type : {result.mismatch_type}")
    print(f"  risk_label    : {result.risk_label}")
    print(f"  itc_at_risk   : {result.itc_at_risk}")
    print(f"  explanation   : {result.explanation}")
    ok  = _check("mismatch_type (amounts match + 3-month gap -> TIMING_DIFFERENCE)",
                 result.mismatch_type, "TIMING_DIFFERENCE")
    ok &= _check("NOT AMOUNT_MISMATCH (amounts are identical)",
                 result.mismatch_type != "AMOUNT_MISMATCH", True)
    ok &= _check("risk_label is LOW", result.risk_label, "LOW")
    ok &= _check("itc_at_risk is 0 (no financial risk when amounts match)",
                 result.itc_at_risk, 0.0)
    ok &= _check("taxable_diff is 0", result.taxable_diff, 0.0)
    ok &= _check("explanation mentions timing/period (not amount)",
                 any(w in result.explanation.lower() for w in ["period", "filed", "timing", "month"]),
                 True)
    return ok

# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

TESTS = [
    ("TC-01", "Null taxable_value on PR side",                   tc01_null_pr_taxable_value),
    ("TC-02", "Null taxable_value on GSTR-2B side",              tc02_null_b_taxable_value),
    ("TC-03", "Both sides have null amounts",                     tc03_both_null_amounts),
    ("TC-04", "Invoice match but different vendor_gstin",         tc04_invoice_match_different_gstin),
    ("TC-05", "Filing period 2 months ahead, amounts OK",         tc05_filing_period_2_months_ahead_amounts_ok),
    ("TC-06", "Filing period 6 months ahead, amounts differ",     tc06_filing_period_6_months_amounts_differ),
    ("TC-07", "Duplicate claim with dup_count = 3",               tc07_duplicate_claim_dup_count_3),
    ("TC-08", "Duplicate claim with dup_count = 10",              tc08_duplicate_claim_dup_count_10),
    ("TC-09", "CLEAN_MATCH at Rs.100 tolerance boundary",         tc09_clean_match_at_boundary),
    ("TC-10", "AMOUNT_MISMATCH at Rs.100.01 (just over boundary)",tc10_amount_mismatch_just_over_boundary),
    ("TC-11", "MISSING_IN_2B itc=50000 -> HIGH (not CRITICAL)",   tc11_missing_in_2b_at_critical_boundary),
    ("TC-12", "MISSING_IN_2B itc=50001 -> CRITICAL",              tc12_missing_in_2b_just_above_critical_threshold),
    ("TC-13", "AMOUNT_MISMATCH itc=25000 -> MEDIUM (not HIGH)",   tc13_amount_mismatch_at_high_boundary),
    ("TC-14", "AMOUNT_MISMATCH itc=25001 -> HIGH",                tc14_amount_mismatch_just_above_high_threshold),
    ("TC-15", "Both rows None raises ValueError",                 tc15_both_none_raises_value_error),
    ("TC-16", "Valid GSTIN structural format check",              tc16_valid_gstin),
    ("TC-17", "Too-short GSTIN structural format check",          tc17_too_short_gstin),
    ("TC-18", "GSTIN with lowercase letter normalized check",     tc18_lowercase_gstin),
    ("TC-19", "Integration check for malformed GSTIN handling",   tc19_integration_invalid_gstin),
    ("TC-20", "Amounts match exactly, 3-month gap -> TIMING_DIFFERENCE (not AMOUNT_MISMATCH)",
              tc20_amounts_match_large_period_gap_is_timing_difference),
]


def main():
    global _PASS, _FAIL, _ERRORS
    print("\n" + "#" * 72)
    print("#  GST ITC Risk Scorer -- Edge Case Test Suite")
    print("#  Validates pipeline/risk_scorer.py against boundary conditions")
    print("#" * 72)

    for tc_id, description, fn in TESTS:
        _run_test(tc_id, description, fn)

    # Summary
    total = _PASS + _FAIL + _ERRORS
    print(f"\n{'='*72}")
    print(f"  RESULTS:  {_PASS} passed  |  {_FAIL} failed  |  {_ERRORS} errors  |  {total} total")
    print(f"{'='*72}\n")

    if _FAIL > 0 or _ERRORS > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()


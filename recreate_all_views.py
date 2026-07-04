#!/usr/bin/env python3
"""
recreate_all_views.py
=====================
Submits all 4 BigQuery view definitions directly as Python strings.
Bypasses the SQL file parser entirely to avoid semicolon-in-string issues.

Run this after any change to bigquery_views.sql.
"""

from google.cloud import bigquery

PROJECT = "decisionforge-501312"
DATASET = "gst_notices"

# ---------------------------------------------------------------------------
# View 1: reconciliation_matches
# (Fixed: TIMING_DIFFERENCE fires for any month gap when amounts match;
#  AMOUNT_MISMATCH is now exclusively for genuine financial discrepancies)
# ---------------------------------------------------------------------------
VIEW1 = """
CREATE OR REPLACE VIEW `decisionforge-501312.gst_notices.reconciliation_matches` AS
WITH pr_enriched AS (
  SELECT *,
         COUNT(*) OVER (PARTITION BY client_gstin, invoice_number, vendor_gstin) AS dup_count
  FROM `decisionforge-501312.gst_notices.purchase_register_raw`
),
joined_data AS (
  SELECT
    pr.invoice_id,
    pr.client_gstin                              AS pr_client_gstin,
    COALESCE(pr.vendor_gstin, b.vendor_gstin)    AS vendor_gstin,
    COALESCE(pr.invoice_number, b.invoice_number) AS invoice_number,
    pr.invoice_date                              AS pr_invoice_date,
    b.invoice_date                               AS b_invoice_date,
    pr.taxable_value                             AS pr_taxable_value,
    b.taxable_value                              AS b_taxable_value,
    pr.cgst                                      AS pr_cgst,
    b.cgst                                       AS b_cgst,
    pr.sgst                                      AS pr_sgst,
    b.sgst                                       AS b_sgst,
    pr.igst                                      AS pr_igst,
    b.igst                                       AS b_igst,
    pr.total_itc_claimed                         AS pr_total_itc_claimed,
    b.itc_available                              AS b_itc_available,
    b.filing_period,
    -- INVALID_GSTIN is checked first: a malformed GSTIN is a data-quality
    -- issue and must not enter the financial-risk scoring pipeline.
    -- UPPER() applied before regex so lowercase GSTINs normalise correctly.
    -- TIMING_DIFFERENCE: both rows present, amounts within Rs.100 tolerance,
    -- but filing period does NOT match the invoice date YYYY-MM (any gap size).
    -- AMOUNT_MISMATCH: reserved exclusively for genuine financial discrepancies
    -- (taxable_value or ITC differ by more than Rs.100).
    CASE
      WHEN NOT REGEXP_CONTAINS(
             UPPER(COALESCE(pr.vendor_gstin, b.vendor_gstin)),
             r'^(0[1-9]|[12][0-9]|3[0-7])[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
           ) THEN 'INVALID_GSTIN'
      WHEN pr.invoice_number IS NOT NULL AND pr.dup_count > 1 THEN 'DUPLICATE_CLAIM'
      WHEN pr.invoice_number IS NOT NULL AND b.invoice_number IS NULL THEN 'MISSING_IN_2B'
      WHEN pr.invoice_number IS NULL AND b.invoice_number IS NOT NULL THEN 'MISSING_IN_REGISTER'
      WHEN pr.invoice_number IS NOT NULL AND b.invoice_number IS NOT NULL
           AND ABS(COALESCE(pr.taxable_value, 0) - COALESCE(b.taxable_value, 0)) <= 100
           AND ABS(COALESCE(pr.total_itc_claimed, 0) - COALESCE(b.itc_available, 0)) <= 100
           AND b.filing_period = FORMAT_DATE('%Y-%m', pr.invoice_date) THEN 'CLEAN_MATCH'
      WHEN pr.invoice_number IS NOT NULL AND b.invoice_number IS NOT NULL
           AND ABS(COALESCE(pr.taxable_value, 0) - COALESCE(b.taxable_value, 0)) <= 100
           AND ABS(COALESCE(pr.total_itc_claimed, 0) - COALESCE(b.itc_available, 0)) <= 100
           THEN 'TIMING_DIFFERENCE'
      ELSE 'AMOUNT_MISMATCH'
    END AS mismatch_type
  FROM pr_enriched pr
  FULL OUTER JOIN `decisionforge-501312.gst_notices.gstr2b_raw` b
    ON pr.vendor_gstin = b.vendor_gstin
   AND pr.invoice_number = b.invoice_number
)
SELECT
  *,
  CASE
    WHEN mismatch_type IN ('MISSING_IN_2B', 'AMOUNT_MISMATCH') THEN COALESCE(pr_total_itc_claimed, 0)
    ELSE 0
  END AS itc_at_risk
FROM joined_data
"""

# ---------------------------------------------------------------------------
# View 2: reconciliation_risk_ranked
# ---------------------------------------------------------------------------
VIEW2 = """
CREATE OR REPLACE VIEW `decisionforge-501312.gst_notices.reconciliation_risk_ranked` AS
WITH ranked_raw AS (
  SELECT
    *,
    CASE
      WHEN mismatch_type = 'DATA_QUALITY' THEN NULL
      WHEN mismatch_type = 'MISSING_IN_2B'    AND itc_at_risk > 50000  THEN 'CRITICAL'
      WHEN mismatch_type = 'MISSING_IN_2B'                             THEN 'HIGH'
      WHEN mismatch_type = 'AMOUNT_MISMATCH'  AND itc_at_risk > 25000  THEN 'HIGH'
      WHEN mismatch_type = 'AMOUNT_MISMATCH'                           THEN 'MEDIUM'
      WHEN mismatch_type = 'DUPLICATE_CLAIM'                           THEN 'MEDIUM'
      WHEN mismatch_type IN ('TIMING_DIFFERENCE', 'MISSING_IN_REGISTER') THEN 'LOW'
      WHEN mismatch_type = 'CLEAN_MATCH'                               THEN 'NONE'
      ELSE NULL
    END AS risk_label,
    CASE
      WHEN mismatch_type != 'DATA_QUALITY' THEN NULL   -- INVALID_GSTIN excluded
      ELSE NULL
    END AS _exclude
  FROM `decisionforge-501312.gst_notices.reconciliation_matches`
  WHERE mismatch_type != 'INVALID_GSTIN'
)
SELECT *
FROM ranked_raw
WHERE risk_label IS NOT NULL
ORDER BY
  CASE risk_label
    WHEN 'CRITICAL' THEN 1
    WHEN 'HIGH'     THEN 2
    WHEN 'MEDIUM'   THEN 3
    WHEN 'LOW'      THEN 4
    ELSE            NULL
  END,
  itc_at_risk DESC
"""

# ---------------------------------------------------------------------------
# View 3: reconciliation_summary_by_client
# ---------------------------------------------------------------------------
VIEW3 = """
CREATE OR REPLACE VIEW `decisionforge-501312.gst_notices.reconciliation_summary_by_client` AS
SELECT
  pr_client_gstin                                             AS client_gstin,
  COUNT(*)                                                    AS total_invoices,
  COUNTIF(mismatch_type = 'CLEAN_MATCH')                     AS clean_matches,
  COUNTIF(mismatch_type = 'MISSING_IN_2B')                   AS missing_in_2b,
  COUNTIF(mismatch_type = 'MISSING_IN_REGISTER')             AS missing_in_register,
  COUNTIF(mismatch_type = 'AMOUNT_MISMATCH')                 AS amount_mismatches,
  COUNTIF(mismatch_type = 'TIMING_DIFFERENCE')               AS timing_differences,
  COUNTIF(mismatch_type = 'DUPLICATE_CLAIM')                 AS duplicate_claims,
  COUNTIF(mismatch_type = 'INVALID_GSTIN')                   AS invalid_gstins,
  SUM(itc_at_risk)                                           AS total_itc_at_risk
FROM `decisionforge-501312.gst_notices.reconciliation_matches`
GROUP BY pr_client_gstin
"""

# ---------------------------------------------------------------------------
# View 4: data_quality_flags
# ---------------------------------------------------------------------------
VIEW4 = """
CREATE OR REPLACE VIEW `decisionforge-501312.gst_notices.data_quality_flags` AS
SELECT
  invoice_id,
  pr_client_gstin                              AS client_gstin,
  vendor_gstin,
  invoice_number,
  CASE
    WHEN vendor_gstin IS NULL OR vendor_gstin = ''
      THEN 'Vendor GSTIN is NULL or empty'
    WHEN LENGTH(UPPER(TRIM(vendor_gstin))) != 15
      THEN CONCAT('GSTIN must be exactly 15 characters, got ',
                  CAST(LENGTH(UPPER(TRIM(vendor_gstin))) AS STRING),
                  ' chars, raw value: ', vendor_gstin)
    WHEN NOT REGEXP_CONTAINS(SUBSTR(UPPER(TRIM(vendor_gstin)), 1, 2), r'^[0-9]{2}$')
      THEN CONCAT('State code (positions 1-2) must be 2 digits, got: ',
                  SUBSTR(UPPER(TRIM(vendor_gstin)), 1, 2))
    WHEN CAST(SUBSTR(UPPER(TRIM(vendor_gstin)), 1, 2) AS INT64) NOT BETWEEN 1 AND 37
      THEN CONCAT('State code is out of valid range 01-37, got: ',
                  SUBSTR(UPPER(TRIM(vendor_gstin)), 1, 2))
    WHEN NOT REGEXP_CONTAINS(SUBSTR(UPPER(TRIM(vendor_gstin)), 3, 5), r'^[A-Z]{5}$')
      THEN CONCAT('PAN segment (positions 3-7) must be 5 uppercase letters, got: ',
                  SUBSTR(UPPER(TRIM(vendor_gstin)), 3, 5))
    WHEN NOT REGEXP_CONTAINS(SUBSTR(UPPER(TRIM(vendor_gstin)), 8, 4), r'^[0-9]{4}$')
      THEN CONCAT('PAN segment (positions 8-11) must be 4 digits, got: ',
                  SUBSTR(UPPER(TRIM(vendor_gstin)), 8, 4))
    WHEN NOT REGEXP_CONTAINS(SUBSTR(UPPER(TRIM(vendor_gstin)), 12, 1), r'^[A-Z]$')
      THEN CONCAT('PAN segment (position 12) must be 1 uppercase letter, got: ',
                  SUBSTR(UPPER(TRIM(vendor_gstin)), 12, 1))
    WHEN NOT REGEXP_CONTAINS(SUBSTR(UPPER(TRIM(vendor_gstin)), 13, 1), r'^[1-9A-Z]$')
      THEN CONCAT('Entity code (position 13) must be 1-9 or A-Z, got: ',
                  SUBSTR(UPPER(TRIM(vendor_gstin)), 13, 1))
    WHEN SUBSTR(UPPER(TRIM(vendor_gstin)), 14, 1) != 'Z'
      THEN CONCAT('Position 14 must be the letter Z, got: ',
                  SUBSTR(UPPER(TRIM(vendor_gstin)), 14, 1))
    WHEN NOT REGEXP_CONTAINS(SUBSTR(UPPER(TRIM(vendor_gstin)), 15, 1), r'^[0-9A-Z]$')
      THEN CONCAT('Checksum (position 15) must be alphanumeric, got: ',
                  SUBSTR(UPPER(TRIM(vendor_gstin)), 15, 1))
    ELSE CONCAT('Vendor GSTIN failed structural validation: ', vendor_gstin)
  END                                          AS validation_error,
  CASE
    WHEN invoice_id IS NOT NULL THEN 'purchase_register'
    ELSE 'gstr2b'
  END                                          AS source,
  pr_invoice_date                              AS invoice_date
FROM `decisionforge-501312.gst_notices.reconciliation_matches`
WHERE mismatch_type = 'INVALID_GSTIN'
"""

VIEWS = [
    ("reconciliation_matches",          VIEW1),
    ("reconciliation_risk_ranked",      VIEW2),
    ("reconciliation_summary_by_client", VIEW3),
    ("data_quality_flags",              VIEW4),
]


def main():
    client = bigquery.Client(project=PROJECT)

    print("=" * 70)
    print("Re-creating all 4 BigQuery views")
    print("=" * 70)
    for i, (name, sql) in enumerate(VIEWS, 1):
        print(f"  [{i}/4] {name} ...", end=" ", flush=True)
        job = client.query(sql)
        job.result()
        print("OK")

    print()
    print("=" * 70)
    print("Contamination check: rows with AMOUNT_MISMATCH but matching amounts")
    print("=" * 70)
    q = f"""
        SELECT COUNT(*) AS contaminated_count
        FROM `{PROJECT}.{DATASET}.reconciliation_risk_ranked`
        WHERE mismatch_type = 'AMOUNT_MISMATCH'
          AND ABS(COALESCE(pr_taxable_value, 0) - COALESCE(b_taxable_value, 0)) <= 100
          AND ABS(COALESCE(pr_total_itc_claimed, 0) - COALESCE(b_itc_available, 0)) <= 100
    """
    rows = list(client.query(q).result())
    contaminated = rows[0].contaminated_count
    status = "PASS" if contaminated == 0 else "FAIL"
    print(f"\n  [{status}] AMOUNT_MISMATCH rows with matching amounts = {contaminated}")
    print(f"  (Expected 0 -- all such rows should now be TIMING_DIFFERENCE)")

    print()
    print("=" * 70)
    print("Spot-check: counts by mismatch_type in reconciliation_risk_ranked")
    print("=" * 70)
    q = f"""
        SELECT mismatch_type, COUNT(*) AS cnt
        FROM `{PROJECT}.{DATASET}.reconciliation_risk_ranked`
        GROUP BY mismatch_type
        ORDER BY cnt DESC
    """
    rows = list(client.query(q).result())
    for r in rows:
        print(f"  {r.mismatch_type:<25}  {r.cnt:>8,} rows")

    print()
    print("=" * 70)
    print("Contamination check COMPLETE")
    print(f"Status: {'ALL CLEAR' if contaminated == 0 else 'CONTAMINATION DETECTED'}")
    print("=" * 70)


if __name__ == "__main__":
    main()

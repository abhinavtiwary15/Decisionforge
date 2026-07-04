#!/usr/bin/env python3
"""
recreate_dq_view.py
===================
Submits the data_quality_flags view directly to BigQuery.
Views 1-3 (reconciliation_matches, reconciliation_risk_ranked,
reconciliation_summary_by_client) were already created successfully.
This script only recreates view 4 and runs verification queries.
"""

from google.cloud import bigquery

PROJECT = "decisionforge-501312"
DATASET  = "gst_notices"

DQ_VIEW_SQL = """
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

def main():
    client = bigquery.Client(project=PROJECT)

    print("=" * 70)
    print("Creating data_quality_flags view ...")
    print("=" * 70)
    job = client.query(DQ_VIEW_SQL)
    job.result()
    print("  OK - view created successfully")

    print()
    print("=" * 70)
    print("VERIFICATION QUERIES")
    print("=" * 70)

    # 1. Total count
    q = f"SELECT COUNT(*) AS total FROM `{PROJECT}.{DATASET}.data_quality_flags`"
    total = list(client.query(q).result())[0].total
    print(f"\n[1] COUNT(*) FROM data_quality_flags = {total}")

    # 2. Each row
    q = f"""
        SELECT invoice_number, vendor_gstin, source, validation_error
        FROM `{PROJECT}.{DATASET}.data_quality_flags`
        ORDER BY invoice_number
    """
    rows = list(client.query(q).result())
    print(f"\n[2] All {len(rows)} row(s) in data_quality_flags:")
    for r in rows:
        print(f"    invoice_number : {r.invoice_number}")
        print(f"    vendor_gstin   : {r.vendor_gstin}")
        print(f"    source         : {r.source}")
        print(f"    validation_err : {r.validation_error}")
        print()

    # 3. Lowercase row NOT in data_quality_flags
    q = f"""
        SELECT COUNT(*) AS cnt
        FROM `{PROJECT}.{DATASET}.data_quality_flags`
        WHERE invoice_number = 'ROW-DQ-004'
    """
    cnt = list(client.query(q).result())[0].cnt
    print(f"[3] ROW-DQ-004 (lowercase '29ddddd9012d1z5') in data_quality_flags = {cnt}")
    print(f"    {'PASS' if cnt == 0 else 'FAIL'} — expected 0 (normalises to valid GSTIN via UPPER())")

    # 4. Invalid rows NOT in risk-ranked
    q = f"""
        SELECT COUNT(*) AS cnt
        FROM `{PROJECT}.{DATASET}.reconciliation_risk_ranked`
        WHERE invoice_number IN ('ROW-DQ-001','ROW-DQ-002','ROW-DQ-003')
    """
    cnt = list(client.query(q).result())[0].cnt
    print(f"\n[4] ROW-DQ-001/002/003 in reconciliation_risk_ranked = {cnt}")
    print(f"    {'PASS' if cnt == 0 else 'FAIL'} — expected 0 (invalid GSTINs excluded from risk pipeline)")

    # 5. Lowercase row IS in risk-ranked (or at least not in dq_flags)
    q = f"""
        SELECT COUNT(*) AS cnt
        FROM `{PROJECT}.{DATASET}.reconciliation_risk_ranked`
        WHERE invoice_number = 'ROW-DQ-004'
    """
    cnt = list(client.query(q).result())[0].cnt
    print(f"\n[5] ROW-DQ-004 in reconciliation_risk_ranked = {cnt}")
    print(f"    (>0 = PASS if normalisation worked; 0 is acceptable if MISSING_IN_2B flow)")

    print()
    print("=" * 70)
    print(f"FINAL: data_quality_flags live count = {total}")
    print(f"       Mock fallback will {'NOT' if total > 0 else 'STILL'} trigger for live data")
    print("=" * 70)

if __name__ == "__main__":
    main()

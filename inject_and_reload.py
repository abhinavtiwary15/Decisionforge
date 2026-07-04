#!/usr/bin/env python3
"""
inject_and_reload.py
====================
1. Appends 4 deliberately malformed GSTIN rows to purchase_register_50000.csv
2. Re-uploads the full CSV to BigQuery (WRITE_TRUNCATE)
3. Re-creates all four BigQuery views from pipeline/bigquery_views.sql
4. Runs verification queries:
   - COUNT(*) from data_quality_flags
   - All rows + their validation_error messages
   - COUNT(*) confirming the lowercase row is NOT in data_quality_flags
   - COUNT confirming malformed rows are NOT in reconciliation_risk_ranked

The 4 injected rows:
  ROW-DQ-001  vendor_gstin=27AAAAA0000A        (too short: 12 chars, missing last 3)
  ROW-DQ-002  vendor_gstin=45BBBBB1234B1Z5     (invalid state code: 45 > valid range 01-37)
  ROW-DQ-003  vendor_gstin=27CCCCC5678C1X5     (position 14 is 'X' not 'Z')
  ROW-DQ-004  vendor_gstin=29ddddd9012d1z5     (all lowercase — structurally valid after UPPER(),
                                                 must NOT appear in data_quality_flags)
"""

import csv
import os
import sys
import uuid
from google.cloud import bigquery

PROJECT  = "decisionforge-501312"
DATASET  = "gst_notices"
PR_FILE  = "data/purchase_register_50000.csv"
PR_TABLE = f"{PROJECT}.{DATASET}.purchase_register_raw"

# ---------------------------------------------------------------------------
# 1.  Define the 4 injection rows
# ---------------------------------------------------------------------------
# These use a known client GSTIN from the existing pool and a real invoice date.
# The client_gstin is valid (takes an existing one from live data, or use a
# well-formed placeholder — it only matters that vendor_gstin is the bad field).

INJECTION_ROWS = [
    {
        "invoice_id":        f"DQ-INJECT-{uuid.uuid4()}",
        "vendor_gstin":      "27AAAAA0000A",           # 12 chars — too short
        "vendor_name":       "ShortGSTIN Corp",
        "invoice_date":      "2026-03-01",
        "invoice_number":    "ROW-DQ-001",
        "taxable_value":     "100000.00",
        "cgst":              "9000.00",
        "sgst":              "9000.00",
        "igst":              "0.00",
        "total_itc_claimed": "18000.00",
        "client_gstin":      "07FTCJJ3204D7Z5",        # real client GSTIN from live pool
    },
    {
        "invoice_id":        f"DQ-INJECT-{uuid.uuid4()}",
        "vendor_gstin":      "45BBBBB1234B1Z5",        # state code 45 — out of range 01-37
        "vendor_name":       "BadStateCode Enterprises",
        "invoice_date":      "2026-03-02",
        "invoice_number":    "ROW-DQ-002",
        "taxable_value":     "200000.00",
        "cgst":              "0.00",
        "sgst":              "0.00",
        "igst":              "36000.00",
        "total_itc_claimed": "36000.00",
        "client_gstin":      "09LVEJR7606R4ZA",
    },
    {
        "invoice_id":        f"DQ-INJECT-{uuid.uuid4()}",
        "vendor_gstin":      "27CCCCC5678C1X5",        # position 14 is 'X' instead of 'Z'
        "vendor_name":       "NoZee Industries",
        "invoice_date":      "2026-03-03",
        "invoice_number":    "ROW-DQ-003",
        "taxable_value":     "150000.00",
        "cgst":              "13500.00",
        "sgst":              "13500.00",
        "igst":              "0.00",
        "total_itc_claimed": "27000.00",
        "client_gstin":      "09TLPJZ1478E3ZR",
    },
    {
        "invoice_id":        f"DQ-INJECT-{uuid.uuid4()}",
        "vendor_gstin":      "29ddddd9012d1z5",        # all-lowercase — VALID after UPPER()
        "vendor_name":       "Lowercase Valid Pvt Ltd",  # must NOT appear in data_quality_flags
        "invoice_date":      "2026-03-04",
        "invoice_number":    "ROW-DQ-004",
        "taxable_value":     "80000.00",
        "cgst":              "7200.00",
        "sgst":              "7200.00",
        "igst":              "0.00",
        "total_itc_claimed": "14400.00",
        "client_gstin":      "09VQWPS0220H2ZO",
    },
]

PR_FIELDS = [
    "invoice_id","vendor_gstin","vendor_name","invoice_date","invoice_number",
    "taxable_value","cgst","sgst","igst","total_itc_claimed","client_gstin",
]

def step1_inject_rows():
    print("=" * 70)
    print("STEP 1: Injecting 4 malformed GSTIN rows into CSV")
    print("=" * 70)
    if not os.path.exists(PR_FILE):
        print(f"ERROR: {PR_FILE} not found — run generate_synthetic_data.py 50000 first.")
        sys.exit(1)

    # Count existing rows
    with open(PR_FILE, "r", encoding="utf-8") as f:
        existing = sum(1 for _ in f) - 1  # minus header
    print(f"  Existing rows in CSV: {existing:,}")

    # Check if already injected (idempotency guard)
    with open(PR_FILE, "r", encoding="utf-8") as f:
        content = f.read()
    already = [r for r in INJECTION_ROWS if r["invoice_number"] in content]
    if already:
        print(f"  {len(already)} rows already present — skipping append, proceeding to upload.")
        return

    with open(PR_FILE, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=PR_FIELDS)
        for row in INJECTION_ROWS:
            writer.writerow(row)

    print(f"  Appended {len(INJECTION_ROWS)} rows.")
    for r in INJECTION_ROWS:
        print(f"    {r['invoice_number']:12s}  vendor_gstin={r['vendor_gstin']}")

def step2_upload_csv(client):
    print()
    print("=" * 70)
    print("STEP 2: Uploading modified CSV to BigQuery (WRITE_TRUNCATE)")
    print("=" * 70)
    pr_schema = [
        bigquery.SchemaField("invoice_id",        "STRING"),
        bigquery.SchemaField("vendor_gstin",      "STRING"),
        bigquery.SchemaField("vendor_name",       "STRING"),
        bigquery.SchemaField("invoice_date",      "DATE"),
        bigquery.SchemaField("invoice_number",    "STRING"),
        bigquery.SchemaField("taxable_value",     "NUMERIC"),
        bigquery.SchemaField("cgst",              "NUMERIC"),
        bigquery.SchemaField("sgst",              "NUMERIC"),
        bigquery.SchemaField("igst",              "NUMERIC"),
        bigquery.SchemaField("total_itc_claimed", "NUMERIC"),
        bigquery.SchemaField("client_gstin",      "STRING"),
    ]
    job_config = bigquery.LoadJobConfig(
        schema=pr_schema,
        skip_leading_rows=1,
        source_format=bigquery.SourceFormat.CSV,
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
    )
    with open(PR_FILE, "rb") as f:
        job = client.load_table_from_file(f, PR_TABLE, job_config=job_config)
    job.result()
    print(f"  Loaded {job.output_rows:,} rows into {PR_TABLE}")

def step3_recreate_views(client):
    print()
    print("=" * 70)
    print("STEP 3: Re-creating all BigQuery views from bigquery_views.sql")
    print("=" * 70)
    sql_path = os.path.join(os.path.dirname(__file__), "pipeline", "bigquery_views.sql")
    if not os.path.exists(sql_path):
        sql_path = os.path.join(os.path.dirname(__file__), "bigquery_views.sql")
    with open(sql_path, "r", encoding="utf-8") as f:
        full_sql = f.read()

    # Split SQL into individual statements using a quote-aware scanner.
    # A bare `;` outside of single-quoted strings ends a statement.
    statements = []
    current = []
    in_string = False
    i = 0
    while i < len(full_sql):
        ch = full_sql[i]
        if in_string:
            current.append(ch)
            if ch == "'":
                # Check for escaped quote ''
                if i + 1 < len(full_sql) and full_sql[i + 1] == "'":
                    current.append("'")
                    i += 2
                    continue
                in_string = False
        else:
            if ch == "'":
                in_string = True
                current.append(ch)
            elif ch == ';':
                current.append(ch)
                stmt = "".join(current).strip()
                # Only keep statements that contain CREATE OR REPLACE VIEW
                if "CREATE" in stmt.upper() and "VIEW" in stmt.upper():
                    statements.append(stmt)
                current = []
            else:
                current.append(ch)
        i += 1

    # Any trailing content without a semicolon (shouldn't happen, but safe)
    trailing = "".join(current).strip()
    if trailing and "CREATE" in trailing.upper() and "VIEW" in trailing.upper():
        statements.append(trailing)

    if not statements:
        print("  ERROR: no CREATE OR REPLACE VIEW statements found in SQL file.")
        return

    import re
    for i, stmt in enumerate(statements, 1):
        m = re.search(r'`([^`]+)`', stmt)
        view_name = m.group(1).split('.')[-1] if m else f"view_{i}"
        print(f"  [{i}/{len(statements)}] Creating {view_name} ...", end=" ", flush=True)
        job = client.query(stmt)
        job.result()
        print("OK")


def step4_verify(client):
    print()
    print("=" * 70)
    print("STEP 4: Verification Queries")
    print("=" * 70)

    # 4a: COUNT(*) on data_quality_flags
    q = f"SELECT COUNT(*) AS total FROM `{PROJECT}.{DATASET}.data_quality_flags`"
    rows = list(client.query(q).result())
    total_dq = rows[0].total
    print(f"\n  [4a] COUNT(*) FROM data_quality_flags  ==>  {total_dq}")

    # 4b: Each row + validation_error
    q = f"""
        SELECT invoice_number, vendor_gstin, client_gstin, source, validation_error
        FROM `{PROJECT}.{DATASET}.data_quality_flags`
        ORDER BY invoice_number
    """
    rows = list(client.query(q).result())
    print(f"\n  [4b] All rows in data_quality_flags ({len(rows)} rows):")
    for r in rows:
        print(f"       invoice_number : {r.invoice_number}")
        print(f"       vendor_gstin   : {r.vendor_gstin}")
        print(f"       validation_err : {r.validation_error}")
        print()

    # 4c: Confirm lowercase row NOT in data_quality_flags
    q = f"""
        SELECT COUNT(*) AS cnt
        FROM `{PROJECT}.{DATASET}.data_quality_flags`
        WHERE invoice_number = 'ROW-DQ-004'
    """
    cnt = list(client.query(q).result())[0].cnt
    status = "PASS" if cnt == 0 else "FAIL"
    print(f"  [4c] ROW-DQ-004 (lowercase GSTIN) in data_quality_flags = {cnt}  [{status}]")
    print(f"       (Expected 0 — lowercase '29ddddd9012d1z5' normalises to '29DDDDD9012D1Z5'")
    print(f"        which is structurally valid, so it flows to reconciliation_risk_ranked)")

    # 4d: Confirm invalid rows NOT in reconciliation_risk_ranked
    q = f"""
        SELECT COUNT(*) AS cnt
        FROM `{PROJECT}.{DATASET}.reconciliation_risk_ranked`
        WHERE invoice_number IN ('ROW-DQ-001','ROW-DQ-002','ROW-DQ-003')
    """
    cnt = list(client.query(q).result())[0].cnt
    status = "PASS" if cnt == 0 else "FAIL"
    print(f"\n  [4d] ROW-DQ-001/002/003 in reconciliation_risk_ranked = {cnt}  [{status}]")
    print(f"       (Expected 0 — invalid GSTINs must not enter the risk pipeline)")

    # 4e: Confirm lowercase row IS in reconciliation_risk_ranked (not excluded)
    q = f"""
        SELECT COUNT(*) AS cnt
        FROM `{PROJECT}.{DATASET}.reconciliation_risk_ranked`
        WHERE invoice_number = 'ROW-DQ-004'
    """
    cnt = list(client.query(q).result())[0].cnt
    status = "PASS" if cnt > 0 else "FAIL (might be MISSING_IN_2B, acceptable)"
    print(f"\n  [4e] ROW-DQ-004 (lowercase, normalised) in reconciliation_risk_ranked = {cnt}")

    print()
    print("=" * 70)
    print(f"FINAL LIVE COUNT — data_quality_flags: {total_dq}")
    print("=" * 70)
    return total_dq

def main():
    client = bigquery.Client(project=PROJECT)
    step1_inject_rows()
    step2_upload_csv(client)
    step3_recreate_views(client)
    step4_verify(client)

if __name__ == "__main__":
    main()

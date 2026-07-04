#!/usr/bin/env python3
"""
Load GST Synthetic Datasets to BigQuery

This script loads the generated 50k row CSV datasets into Google Cloud BigQuery.
It creates two tables:
1. purchase_register_raw
2. gstr2b_raw
under the gst_notices dataset in the decisionforge-501312 project.
"""

import sys
from google.cloud import bigquery

def load_csv_to_bq(client, file_path, table_id, schema):
    print(f"Loading {file_path} into table {table_id}...")
    
    # Configure the load job
    job_config = bigquery.LoadJobConfig(
        schema=schema,
        skip_leading_rows=1,
        source_format=bigquery.SourceFormat.CSV,
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
    )
    
    with open(file_path, "rb") as source_file:
        load_job = client.load_table_from_file(
            source_file, table_id, job_config=job_config
        )
        
    # Wait for the job to complete
    load_job.result()
    print(f"Loaded {load_job.output_rows} rows successfully into {table_id}.")
    return load_job.output_rows

def main():
    project_id = "decisionforge-501312"
    dataset_id = "gst_notices"
    client = bigquery.Client(project=project_id)
    
    # Define schemas
    pr_schema = [
        bigquery.SchemaField("invoice_id", "STRING"),
        bigquery.SchemaField("vendor_gstin", "STRING"),
        bigquery.SchemaField("vendor_name", "STRING"),
        bigquery.SchemaField("invoice_date", "DATE"),
        bigquery.SchemaField("invoice_number", "STRING"),
        bigquery.SchemaField("taxable_value", "NUMERIC"),
        bigquery.SchemaField("cgst", "NUMERIC"),
        bigquery.SchemaField("sgst", "NUMERIC"),
        bigquery.SchemaField("igst", "NUMERIC"),
        bigquery.SchemaField("total_itc_claimed", "NUMERIC"),
        bigquery.SchemaField("client_gstin", "STRING"),
    ]
    
    gstr2b_schema = [
        bigquery.SchemaField("gstr2b_id", "STRING"),
        bigquery.SchemaField("vendor_gstin", "STRING"),
        bigquery.SchemaField("invoice_number", "STRING"),
        bigquery.SchemaField("invoice_date", "DATE"),
        bigquery.SchemaField("taxable_value", "NUMERIC"),
        bigquery.SchemaField("cgst", "NUMERIC"),
        bigquery.SchemaField("sgst", "NUMERIC"),
        bigquery.SchemaField("igst", "NUMERIC"),
        bigquery.SchemaField("itc_available", "NUMERIC"),
        bigquery.SchemaField("filing_period", "STRING"), # Stored as STRING as required
    ]
    
    pr_file = "data/purchase_register_50000.csv"
    gstr2b_file = "data/gstr2b_50000.csv"
    
    pr_table_id = f"{project_id}.{dataset_id}.purchase_register_raw"
    gstr2b_table_id = f"{project_id}.{dataset_id}.gstr2b_raw"
    
    try:
        pr_rows = load_csv_to_bq(client, pr_file, pr_table_id, pr_schema)
        gstr2b_rows = load_csv_to_bq(client, gstr2b_file, gstr2b_table_id, gstr2b_schema)
        
        print("\nAll data loaded successfully!")
        print(f"Purchase Register Raw: {pr_rows} rows")
        print(f"GSTR-2B Raw: {gstr2b_rows} rows")
    except Exception as e:
        print(f"Error during loading: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()

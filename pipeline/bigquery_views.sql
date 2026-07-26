-- BigQuery Views for GST ITC Reconciliation
-- Project: decisionforge-501312
-- Dataset: gst_notices

-- 1. Create reconciliation_matches view
CREATE OR REPLACE VIEW `decisionforge-501312.gst_notices.reconciliation_matches` AS
WITH pr_enriched AS (
  SELECT *,
         COUNT(*) OVER (PARTITION BY client_gstin, invoice_number, vendor_gstin) AS dup_count
  FROM `decisionforge-501312.gst_notices.purchase_register_raw`
),
joined_data AS (
  SELECT
    pr.invoice_id,
    COALESCE(pr.vendor_gstin, b.vendor_gstin) AS vendor_gstin,
    pr.vendor_name,
    pr.invoice_date AS pr_invoice_date,
    b.invoice_date AS b_invoice_date,
    COALESCE(pr.invoice_number, b.invoice_number) AS invoice_number,
    pr.taxable_value AS pr_taxable_value,
    b.taxable_value AS b_taxable_value,
    pr.cgst AS pr_cgst,
    b.cgst AS b_cgst,
    pr.sgst AS pr_sgst,
    b.sgst AS b_sgst,
    pr.igst AS pr_igst,
    b.igst AS b_igst,
    pr.total_itc_claimed AS pr_total_itc_claimed,
    b.itc_available AS b_itc_available,
    pr.client_gstin AS client_gstin,
    b.gstr2b_id,
    b.filing_period,
    -- Classify mismatch type
    -- IMPORTANT: rows with a malformed vendor GSTIN are DATA-QUALITY issues,
    -- NOT financial-risk events. They are separated using the dedicated
    -- `is_data_quality_flag` and `flag_type` columns below so that
    -- mismatch_type ONLY ever contains the canonical financial-risk values:
    --   CLEAN_MATCH | MISSING_IN_2B | AMOUNT_MISMATCH |
    --   TIMING_DIFFERENCE | DUPLICATE_CLAIM | MISSING_IN_REGISTER
    -- GSTIN regex mirrors pipeline/validators.py _GSTIN_RE exactly.
    -- TIMING_DIFFERENCE: both rows present, amounts within Rs.100 tolerance,
    -- but filing period does NOT match the invoice date's YYYY-MM.
    -- AMOUNT_MISMATCH is reserved exclusively for genuine financial discrepancies.
    CASE
      WHEN NOT REGEXP_CONTAINS(
             UPPER(COALESCE(pr.vendor_gstin, b.vendor_gstin)),
             r'^(0[1-9]|[12][0-9]|3[0-7])[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
           ) THEN NULL  -- data-quality row; mismatch_type is set to NULL and
                        -- is_data_quality_flag = TRUE identifies these rows.
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
    END AS mismatch_type,
    -- Dedicated data-quality columns (separate from the financial-risk taxonomy)
    -- is_data_quality_flag = TRUE  → row has a structural GSTIN defect
    -- flag_type                    → specific defect category (e.g. 'INVALID_GSTIN')
    -- These columns are consumed by data_quality_flags view ONLY.
    -- No downstream financial-risk view should read them.
    NOT REGEXP_CONTAINS(
      UPPER(COALESCE(pr.vendor_gstin, b.vendor_gstin)),
      r'^(0[1-9]|[12][0-9]|3[0-7])[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
    ) AS is_data_quality_flag,
    CASE
      WHEN NOT REGEXP_CONTAINS(
             UPPER(COALESCE(pr.vendor_gstin, b.vendor_gstin)),
             r'^(0[1-9]|[12][0-9]|3[0-7])[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
           ) THEN 'INVALID_GSTIN'
      ELSE NULL
    END AS flag_type
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
FROM joined_data;


-- 2. Create reconciliation_risk_ranked view
-- Only contains rows from the canonical financial-risk taxonomy.
-- Data-quality rows (is_data_quality_flag = TRUE) are routed to
-- data_quality_flags and are completely excluded here — risk_label
-- therefore only ever holds: CRITICAL | HIGH | MEDIUM | LOW | NONE
CREATE OR REPLACE VIEW `decisionforge-501312.gst_notices.reconciliation_risk_ranked` AS
WITH ranked_raw AS (
  SELECT
    *,
    CASE
      WHEN mismatch_type = 'MISSING_IN_2B' AND itc_at_risk > 50000 THEN 'CRITICAL'
      WHEN mismatch_type = 'MISSING_IN_2B' OR (mismatch_type = 'AMOUNT_MISMATCH' AND itc_at_risk > 25000) THEN 'HIGH'
      WHEN (mismatch_type = 'AMOUNT_MISMATCH' AND itc_at_risk <= 25000) OR mismatch_type = 'DUPLICATE_CLAIM' THEN 'MEDIUM'
      WHEN mismatch_type IN ('TIMING_DIFFERENCE', 'MISSING_IN_REGISTER') THEN 'LOW'
      WHEN mismatch_type = 'CLEAN_MATCH' THEN 'NONE'
      ELSE NULL
    END AS risk_label
  FROM `decisionforge-501312.gst_notices.reconciliation_matches`
  WHERE is_data_quality_flag = FALSE  -- exclude GSTIN-defect rows; they live in data_quality_flags
)
SELECT *
FROM ranked_raw
WHERE risk_label IS NOT NULL
ORDER BY 
  CASE risk_label
    WHEN 'CRITICAL' THEN 1
    WHEN 'HIGH' THEN 2
    WHEN 'MEDIUM' THEN 3
    WHEN 'LOW' THEN 4
    WHEN 'NONE' THEN 5
  END,
  itc_at_risk DESC;


-- 3. Create reconciliation_summary_by_client view
CREATE OR REPLACE VIEW `decisionforge-501312.gst_notices.reconciliation_summary_by_client` AS
SELECT
  client_gstin,
  COUNT(*) AS total_invoice_count,
  COUNTIF(mismatch_type = 'CLEAN_MATCH') AS clean_match_count,
  COUNTIF(mismatch_type = 'TIMING_DIFFERENCE') AS timing_difference_count,
  COUNTIF(mismatch_type = 'MISSING_IN_2B') AS missing_in_2b_count,
  COUNTIF(mismatch_type = 'AMOUNT_MISMATCH') AS amount_mismatch_count,
  COUNTIF(mismatch_type = 'MISSING_IN_REGISTER') AS missing_in_register_count,
  COUNTIF(mismatch_type = 'DUPLICATE_CLAIM') AS duplicate_claim_count,
  -- Data-quality defects counted via is_data_quality_flag, NOT mismatch_type,
  -- so they never contaminate the canonical mismatch_type column.
  COUNTIF(is_data_quality_flag = TRUE) AS invalid_gstin_count,
  SUM(itc_at_risk) AS total_itc_at_risk
FROM `decisionforge-501312.gst_notices.reconciliation_matches`
GROUP BY client_gstin;


-- 4. data_quality_flags -- rows where is_data_quality_flag = TRUE only
-- Entirely separate from the financial-risk pipeline.
-- Reads the dedicated `flag_type` and `is_data_quality_flag` columns from
-- reconciliation_matches rather than overloading mismatch_type.
--
-- Columns emitted:
--   flag_type        : 'INVALID_GSTIN' (or any future defect category)
--   client_gstin     : from PR side (NULL if this is a 2B-only row)
--   vendor_gstin     : raw, unvalidated value that failed the check
--   invoice_number   : from whichever side is present
--   validation_error : human-readable description of what is wrong
--   source           : 'purchase_register' or 'gstr2b'
--   invoice_date     : from PR side (for display)
CREATE OR REPLACE VIEW `decisionforge-501312.gst_notices.data_quality_flags` AS
SELECT
  flag_type,           -- 'INVALID_GSTIN' — clearly-named, not overloading mismatch_type
  invoice_id,
  client_gstin,
  vendor_gstin,
  invoice_number,
  -- Derive a human-readable error message in SQL.
  -- Segments are checked against UPPER(vendor_gstin) to mirror validators.py
  -- normalisation: a structurally-correct lowercase GSTIN is VALID and will
  -- never appear in this view (it goes through reconciliation_risk_ranked).
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
WHERE is_data_quality_flag = TRUE;  -- uses the dedicated flag column, NOT mismatch_type


-- 5. Create vendor_compliance_summary view
-- Aggregates reconciliation_matches at the vendor_gstin level.
-- Reads from reconciliation_matches (NOT reconciliation_risk_ranked) so that
-- CLEAN_MATCH rows — ordered last in risk_ranked — are fully included.
-- NOTE: The deployed live view stores GSTIN-defect rows as mismatch_type='INVALID_GSTIN'
-- (the is_data_quality_flag column is not present in the deployed schema).
-- We exclude these rows by filtering mismatch_type != 'INVALID_GSTIN'.
-- match_rate = clean_matches / total_invoices * 100, SAFE_DIVIDE guards zero-invoice vendors.
CREATE OR REPLACE VIEW `decisionforge-501312.gst_notices.vendor_compliance_summary` AS
SELECT
  vendor_gstin,
  ANY_VALUE(vendor_name)                                          AS vendor_name,
  COUNT(*)                                                        AS total_invoices,
  COUNTIF(mismatch_type = 'CLEAN_MATCH')                         AS clean_matches,
  COUNTIF(mismatch_type = 'MISSING_IN_2B')                       AS missing_in_2b,
  COUNTIF(mismatch_type = 'AMOUNT_MISMATCH')                     AS amount_mismatches,
  COUNTIF(mismatch_type = 'TIMING_DIFFERENCE')                   AS timing_differences,
  COUNTIF(mismatch_type = 'DUPLICATE_CLAIM')                     AS duplicate_claims,
  ROUND(SUM(itc_at_risk), 2)                                     AS total_itc_at_risk,
  ROUND(SAFE_DIVIDE(
    COUNTIF(mismatch_type = 'CLEAN_MATCH'),
    COUNT(*)
  ) * 100, 1)                                                     AS match_rate
FROM `decisionforge-501312.gst_notices.reconciliation_matches`
WHERE mismatch_type != 'INVALID_GSTIN'   -- exclude structural GSTIN defects
  AND vendor_gstin IS NOT NULL
GROUP BY vendor_gstin
ORDER BY total_itc_at_risk DESC;



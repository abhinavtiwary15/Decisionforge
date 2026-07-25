const { BigQuery } = require('@google-cloud/bigquery');
const bq = new BigQuery({ projectId: 'decisionforge-501312' });

async function inspectRawOutputs() {
  console.log('=== 1. ANALYTICS/RISK-BY-CLIENT ===');
  const [rows1] = await bq.query({
    query: `
      SELECT
        client_gstin,
        COUNT(*)                                              AS total_invoices,
        COUNTIF(risk_label IN ('CRITICAL','HIGH'))           AS risk_count,
        ROUND(SUM(itc_at_risk), 2)                          AS total_itc_at_risk,
        COUNTIF(mismatch_type = 'MISSING_IN_2B')            AS missing_in_2b,
        COUNTIF(mismatch_type = 'AMOUNT_MISMATCH')          AS amount_mismatch,
        COUNTIF(mismatch_type = 'TIMING_DIFFERENCE')        AS timing_diff,
        COUNTIF(mismatch_type = 'DUPLICATE_CLAIM')          AS duplicate
      FROM \`decisionforge-501312.gst_notices.reconciliation_risk_ranked\`
      WHERE client_gstin IS NOT NULL AND client_gstin NOT LIKE '%9999%' AND client_gstin NOT LIKE '%8888%'
      GROUP BY client_gstin
      ORDER BY total_itc_at_risk DESC
      LIMIT 10
    `
  });
  console.log(JSON.stringify(rows1, null, 2));

  console.log('\n=== 2. ANALYTICS/TREND ===');
  const [rows2] = await bq.query({
    query: `
      SELECT
        COALESCE(filing_period, 'No GSTR-2B Filing (Vendor Non-Compliance)') AS filing_period,
        COUNT(*)                                                             AS total_invoices,
        COUNTIF(mismatch_type != 'CLEAN_MATCH')                              AS mismatch_count,
        ROUND(SUM(itc_at_risk), 2)                                           AS total_itc_at_risk,
        COUNTIF(risk_label = 'CRITICAL')                                     AS critical_count,
        COUNTIF(risk_label = 'HIGH')                                         AS high_count
      FROM \`decisionforge-501312.gst_notices.reconciliation_risk_ranked\`
      GROUP BY filing_period
      ORDER BY (CASE WHEN filing_period IS NULL THEN 1 ELSE 0 END), filing_period ASC
      LIMIT 10
    `
  });
  console.log(JSON.stringify(rows2, null, 2));
}

inspectRawOutputs().catch(console.error);

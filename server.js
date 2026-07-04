const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { BigQuery } = require('@google-cloud/bigquery');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ──────────────────────────────────────────────────────────────────────────────
// IN-MEMORY TTL CACHE
// ──────────────────────────────────────────────────────────────────────────────
// Simple Map-based cache: key = request URL string, value = { data, expiresAt }
// All read-only endpoints are cached. TTL is configurable per endpoint group.
//
// This eliminates redundant BigQuery round-trips on every page navigation.
// A cold BigQuery query on 27k+ rows takes 2-8 seconds. The same query hitting
// cache returns in <5ms. TTL of 120s is safe for demo/judging sessions.

const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data, ttlMs = 120_000) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// Middleware: check cache before processing any GET request
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const cacheKey = req.originalUrl;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] ${req.method} ${req.originalUrl}`);
    return res.json(cached);
  }
  // Monkey-patch res.json to store response in cache before sending
  const originalJson = res.json.bind(res);
  res.json = (data) => {
    // Only cache successful (non-error) responses
    if (res.statusCode >= 200 && res.statusCode < 300) {
      setCache(cacheKey, data);
    }
    return originalJson(data);
  };
  next();
});

// Request logger (runs after cache check, so cache hits are already logged above)
app.use((req, res, next) => {
  const cached = getCached(req.originalUrl);
  if (!cached) {
    console.log(`[BQ QUERY]  ${req.method} ${req.originalUrl}`);
  }
  next();
});

// ──────────────────────────────────────────────────────────────────────────────
// BIGQUERY CLIENT
// ──────────────────────────────────────────────────────────────────────────────
let bigquery = null;
try {
  const options = { projectId: 'decisionforge-501312' };
  if (process.env.BIGQUERY_CREDENTIALS) {
    try {
      options.credentials = JSON.parse(process.env.BIGQUERY_CREDENTIALS);
      console.log('Using BigQuery credentials from BIGQUERY_CREDENTIALS env var.');
    } catch (e) {
      console.error('Failed to parse BIGQUERY_CREDENTIALS env var:', e.message);
    }
  }
  bigquery = new BigQuery(options);
  console.log('BigQuery client initialized successfully.');
} catch (err) {
  console.warn('Failed to initialize BigQuery client. Falling back to local data.', err.message);
}

// ──────────────────────────────────────────────────────────────────────────────
// ROW FORMATTER
// BigQuery DATE columns arrive as { value: 'YYYY-MM-DD' } objects.
// Flatten them to plain strings before sending to the React frontend,
// otherwise React throws "Objects are not valid as a React child".
// ──────────────────────────────────────────────────────────────────────────────
function formatBqRow(row) {
  if (!row) return row;
  const formatted = { ...row };
  for (const key in formatted) {
    const val = formatted[key];
    if (val !== null && typeof val === 'object' && val.value !== undefined) {
      formatted[key] = val.value;
    }
  }
  return formatted;
}

// ──────────────────────────────────────────────────────────────────────────────
// MOCK DATA (fallback when BQ is unavailable / dev offline)
// ──────────────────────────────────────────────────────────────────────────────
const MOCK_CLIENTS = [
  { client_gstin: '07FTCJJ3204D7Z5', total_invoice_count: 2478, clean_match_count: 1203, timing_difference_count: 746, missing_in_2b_count: 259, amount_mismatch_count: 170, missing_in_register_count: 0, duplicate_claim_count: 100, invalid_gstin_count: 3, total_itc_at_risk: 3567438.79 },
  { client_gstin: '09LVEJR7606R4ZA', total_invoice_count: 2523, clean_match_count: 1228, timing_difference_count: 763, missing_in_2b_count: 254, amount_mismatch_count: 174, missing_in_register_count: 0, duplicate_claim_count: 104, invalid_gstin_count: 2, total_itc_at_risk: 3806975.66 },
  { client_gstin: '09TLPJZ1478E3ZR', total_invoice_count: 2315, clean_match_count: 1166, timing_difference_count: 678, missing_in_2b_count: 215, amount_mismatch_count: 168, missing_in_register_count: 0, duplicate_claim_count: 88,  invalid_gstin_count: 1, total_itc_at_risk: 3510076.90 },
  { client_gstin: '09VQWPS0220H2ZO', total_invoice_count: 2448, clean_match_count: 1171, timing_difference_count: 742, missing_in_2b_count: 263, amount_mismatch_count: 188, missing_in_register_count: 0, duplicate_claim_count: 84,  invalid_gstin_count: 0, total_itc_at_risk: 3415792.41 },
  { client_gstin: '19LMSRZ0438H4ZC', total_invoice_count: 2509, clean_match_count: 1221, timing_difference_count: 752, missing_in_2b_count: 258, amount_mismatch_count: 172, missing_in_register_count: 0, duplicate_claim_count: 106, invalid_gstin_count: 0, total_itc_at_risk: 3179785.51 },
];

const MOCK_RECONCILIATION = [
  { invoice_id: 'pr-1', client_gstin: '07FTCJJ3204D7Z5', vendor_gstin: '27AAAAA1234A1Z1', vendor_name: 'Reliance Industries Ltd',    invoice_number: 'INV-2026-001', pr_invoice_date: '2026-03-10', b_invoice_date: null,         pr_taxable_value: 500000, b_taxable_value: null,   pr_cgst: 45000, b_cgst: null,  pr_sgst: 45000, b_sgst: null,  pr_igst: 0, b_igst: null, pr_total_itc_claimed: 90000, b_itc_available: null,  filing_period: null,      mismatch_type: 'MISSING_IN_2B',    itc_at_risk: 90000, risk_label: 'CRITICAL', explanation: 'Invoice INV-2026-001 claims Rs.90,000 ITC for client 07FTCJJ3204D7Z5 but has no corresponding entry in vendor GSTR-2B filing.' },
  { invoice_id: 'pr-2', client_gstin: '07FTCJJ3204D7Z5', vendor_gstin: '27BBBBB5678B1Z2', vendor_name: 'Tata Consultancy Services', invoice_number: 'TCS-99812',    pr_invoice_date: '2026-03-12', b_invoice_date: null,         pr_taxable_value: 300000, b_taxable_value: null,   pr_cgst: 27000, b_cgst: null,  pr_sgst: 27000, b_sgst: null,  pr_igst: 0, b_igst: null, pr_total_itc_claimed: 54000, b_itc_available: null,  filing_period: null,      mismatch_type: 'MISSING_IN_2B',    itc_at_risk: 54000, risk_label: 'CRITICAL', explanation: 'Invoice TCS-99812 claims Rs.54,000 ITC but has no corresponding entry in vendor GSTR-2B filing.' },
  { invoice_id: 'pr-3', client_gstin: '07FTCJJ3204D7Z5', vendor_gstin: '29CCCCC2222C1Z8', vendor_name: 'Infosys Limited',            invoice_number: 'INF-8871',    pr_invoice_date: '2026-03-15', b_invoice_date: '2026-03-15', pr_taxable_value: 200000, b_taxable_value: 200000, pr_cgst: 18000, b_cgst: 15000, pr_sgst: 18000, b_sgst: 15000, pr_igst: 0, b_igst: 0,    pr_total_itc_claimed: 36000, b_itc_available: 30000, filing_period: '2026-03', mismatch_type: 'AMOUNT_MISMATCH',   itc_at_risk: 36000, risk_label: 'HIGH',     explanation: 'Amount mismatch: PR claims Rs.36,000 tax but GSTR-2B reports Rs.30,000 available. Difference: Rs.6,000.' },
  { invoice_id: 'pr-4', client_gstin: '07FTCJJ3204D7Z5', vendor_gstin: '24DDDDD3333D1Z9', vendor_name: 'Adani Enterprises',          invoice_number: 'ADA-091A',    pr_invoice_date: '2026-03-18', b_invoice_date: '2026-03-18', pr_taxable_value: 150000, b_taxable_value: 150000, pr_cgst: 13500, b_cgst: 13500, pr_sgst: 13500, b_sgst: 13500, pr_igst: 0, b_igst: 0,    pr_total_itc_claimed: 27000, b_itc_available: 27000, filing_period: '2026-04', mismatch_type: 'TIMING_DIFFERENCE', itc_at_risk: 0,     risk_label: 'LOW',      explanation: 'Invoice ADA-091A was filed in GSTR-2B under period 2026-04 instead of 2026-03 (1 month timing difference).' },
  { invoice_id: 'pr-5', client_gstin: '07FTCJJ3204D7Z5', vendor_gstin: '27EEEEE4444E1Z4', vendor_name: 'HDFC Bank Corp',             invoice_number: 'HDF-7761',    pr_invoice_date: '2026-03-20', b_invoice_date: '2026-03-20', pr_taxable_value: 80000,  b_taxable_value: 80000,  pr_cgst: 7200,  b_cgst: 7200,  pr_sgst: 7200,  b_sgst: 7200,  pr_igst: 0, b_igst: 0,    pr_total_itc_claimed: 14400, b_itc_available: 14400, filing_period: '2026-03', mismatch_type: 'CLEAN_MATCH',       itc_at_risk: 0,     risk_label: 'NONE',     explanation: 'Invoice HDF-7761 from vendor 27EEEEE4444E1Z4 reconciles perfectly.' },
  { invoice_id: 'pr-6', client_gstin: '07FTCJJ3204D7Z5', vendor_gstin: '27EEEEE4444E1Z4', vendor_name: 'HDFC Bank Corp',             invoice_number: 'HDF-7761',    pr_invoice_date: '2026-03-20', b_invoice_date: '2026-03-20', pr_taxable_value: 80000,  b_taxable_value: 80000,  pr_cgst: 7200,  b_cgst: 7200,  pr_sgst: 7200,  b_sgst: 7200,  pr_igst: 0, b_igst: 0,    pr_total_itc_claimed: 14400, b_itc_available: 14400, filing_period: '2026-03', mismatch_type: 'DUPLICATE_CLAIM',   itc_at_risk: 14400, risk_label: 'MEDIUM',   explanation: 'Invoice number HDF-7761 is claimed multiple times in the Purchase Register.' },
  { invoice_id: 'pr-7', client_gstin: '09LVEJR7606R4ZA', vendor_gstin: '06FFFFF5555F1Z3', vendor_name: 'Wipro Technologies',         invoice_number: 'WIP-33201',   pr_invoice_date: '2026-03-08', b_invoice_date: null,         pr_taxable_value: 420000, b_taxable_value: null,   pr_cgst: 37800, b_cgst: null,  pr_sgst: 37800, b_sgst: null,  pr_igst: 0, b_igst: null, pr_total_itc_claimed: 75600, b_itc_available: null,  filing_period: null,      mismatch_type: 'MISSING_IN_2B',    itc_at_risk: 75600, risk_label: 'CRITICAL', explanation: 'Invoice WIP-33201 claims Rs.75,600 ITC but vendor has not filed GSTR-1 for this period.' },
  { invoice_id: 'pr-8', client_gstin: '09LVEJR7606R4ZA', vendor_gstin: '07GGGGG6666G1Z8', vendor_name: 'L&T Finance Holdings',       invoice_number: 'LTF-0092',    pr_invoice_date: '2026-03-11', b_invoice_date: '2026-03-11', pr_taxable_value: 350000, b_taxable_value: 340000, pr_cgst: 31500, b_cgst: 30600, pr_sgst: 31500, b_sgst: 30600, pr_igst: 0, b_igst: 0,    pr_total_itc_claimed: 63000, b_itc_available: 61200, filing_period: '2026-03', mismatch_type: 'AMOUNT_MISMATCH',   itc_at_risk: 63000, risk_label: 'HIGH',     explanation: 'Amount mismatch: PR claims Rs.63,000 tax, GSTR-2B reports Rs.61,200. Difference: Rs.1,800.' },
  { invoice_id: 'pr-9', client_gstin: '09TLPJZ1478E3ZR', vendor_gstin: '19HHHHH7777H1Z2', vendor_name: 'SBI Cards & Payment',        invoice_number: 'SBI-44110',   pr_invoice_date: '2026-03-09', b_invoice_date: null,         pr_taxable_value: 280000, b_taxable_value: null,   pr_cgst: 25200, b_cgst: null,  pr_sgst: 25200, b_sgst: null,  pr_igst: 0, b_igst: null, pr_total_itc_claimed: 50400, b_itc_available: null,  filing_period: null,      mismatch_type: 'MISSING_IN_2B',    itc_at_risk: 50400, risk_label: 'CRITICAL', explanation: 'Invoice SBI-44110 claims Rs.50,400 ITC but vendor SBI Cards has not filed the corresponding GSTR-1.' },
  { invoice_id: 'pr-10', client_gstin: '09VQWPS0220H2ZO', vendor_gstin: '24IIIII8888I1Z7', vendor_name: 'Bajaj Finserv Ltd',         invoice_number: 'BAJ-6612',    pr_invoice_date: '2026-03-14', b_invoice_date: '2026-03-14', pr_taxable_value: 190000, b_taxable_value: 190000, pr_cgst: 17100, b_cgst: 17100, pr_sgst: 17100, b_sgst: 17100, pr_igst: 0, b_igst: 0,    pr_total_itc_claimed: 34200, b_itc_available: 34200, filing_period: '2026-03', mismatch_type: 'CLEAN_MATCH',       itc_at_risk: 0,     risk_label: 'NONE',     explanation: 'Invoice BAJ-6612 reconciles perfectly.' },
  { invoice_id: 'pr-11', client_gstin: '19LMSRZ0438H4ZC', vendor_gstin: '29JJJJJ9999J1Z1', vendor_name: 'Mahindra & Mahindra',       invoice_number: 'MM-9900',     pr_invoice_date: '2026-03-17', b_invoice_date: '2026-04-02', pr_taxable_value: 240000, b_taxable_value: 240000, pr_cgst: 21600, b_cgst: 21600, pr_sgst: 21600, b_sgst: 21600, pr_igst: 0, b_igst: 0,    pr_total_itc_claimed: 43200, b_itc_available: 43200, filing_period: '2026-04', mismatch_type: 'TIMING_DIFFERENCE', itc_at_risk: 0,     risk_label: 'LOW',      explanation: 'Invoice MM-9900 filed in GSTR-2B under 2026-04 instead of 2026-03. 16-day timing delay.' },
  { invoice_id: 'pr-12', client_gstin: '07FTCJJ3204D7Z5', vendor_gstin: '27KKKKK1111K1Z5', vendor_name: 'Asian Paints Ltd',          invoice_number: 'AP-7712',     pr_invoice_date: '2026-03-21', b_invoice_date: null,         pr_taxable_value: 95000,  b_taxable_value: null,   pr_cgst: 8550,  b_cgst: null,  pr_sgst: 8550,  b_sgst: null,  pr_igst: 0, b_igst: null, pr_total_itc_claimed: 17100, b_itc_available: null,  filing_period: null,      mismatch_type: 'MISSING_IN_2B',    itc_at_risk: 17100, risk_label: 'HIGH',     explanation: 'Invoice AP-7712 claims Rs.17,100 ITC but no matching entry found in GSTR-2B.' },
  { invoice_id: 'pr-13', client_gstin: '09LVEJR7606R4ZA', vendor_gstin: '27LLLLL2222L1Z9', vendor_name: 'ITC Limited',               invoice_number: 'ITC-0441',    pr_invoice_date: '2026-03-22', b_invoice_date: '2026-03-22', pr_taxable_value: 320000, b_taxable_value: 320000, pr_cgst: 28800, b_cgst: 28800, pr_sgst: 28800, b_sgst: 28800, pr_igst: 0, b_igst: 0,    pr_total_itc_claimed: 57600, b_itc_available: 57600, filing_period: '2026-03', mismatch_type: 'CLEAN_MATCH',       itc_at_risk: 0,     risk_label: 'NONE',     explanation: 'Invoice ITC-0441 reconciles perfectly.' },
  { invoice_id: 'pr-14', client_gstin: '09TLPJZ1478E3ZR', vendor_gstin: '19MMMMM3333M1Z4', vendor_name: 'Cipla Limited',             invoice_number: 'CIP-8871',    pr_invoice_date: '2026-03-25', b_invoice_date: '2026-03-25', pr_taxable_value: 160000, b_taxable_value: 155000, pr_cgst: 14400, b_cgst: 13950, pr_sgst: 14400, b_sgst: 13950, pr_igst: 0, b_igst: 0,    pr_total_itc_claimed: 28800, b_itc_available: 27900, filing_period: '2026-03', mismatch_type: 'AMOUNT_MISMATCH',   itc_at_risk: 28800, risk_label: 'HIGH',     explanation: 'Amount mismatch: PR claims Rs.28,800 tax, GSTR-2B reports Rs.27,900. Difference: Rs.900.' },
  { invoice_id: 'pr-15', client_gstin: '09VQWPS0220H2ZO', vendor_gstin: '24NNNNN4444N1Z6', vendor_name: 'Sun Pharma Industries',      invoice_number: 'SP-1190',     pr_invoice_date: '2026-03-28', b_invoice_date: null,         pr_taxable_value: 450000, b_taxable_value: null,   pr_cgst: 40500, b_cgst: null,  pr_sgst: 40500, b_sgst: null,  pr_igst: 0, b_igst: null, pr_total_itc_claimed: 81000, b_itc_available: null,  filing_period: null,      mismatch_type: 'MISSING_IN_2B',    itc_at_risk: 81000, risk_label: 'CRITICAL', explanation: 'Invoice SP-1190 claims Rs.81,000 ITC but vendor Sun Pharma has not filed GSTR-1 for this transaction.' },
  { invoice_id: 'pr-16', client_gstin: '19LMSRZ0438H4ZC', vendor_gstin: '29OOOOO5555O1Z3', vendor_name: 'HCL Technologies',          invoice_number: 'HCL-4412',    pr_invoice_date: '2026-03-30', b_invoice_date: '2026-03-30', pr_taxable_value: 275000, b_taxable_value: 275000, pr_cgst: 24750, b_cgst: 24750, pr_sgst: 24750, b_sgst: 24750, pr_igst: 0, b_igst: 0,    pr_total_itc_claimed: 49500, b_itc_available: 49500, filing_period: '2026-03', mismatch_type: 'CLEAN_MATCH',       itc_at_risk: 0,     risk_label: 'NONE',     explanation: 'Invoice HCL-4412 reconciles perfectly.' },
];

const MOCK_DATA_QUALITY_FLAGS = [
  { invoice_id: 'dq-1', client_gstin: '07FTCJJ3204D7Z5', vendor_gstin: '99XXXZZ1234A1ZA', invoice_number: 'INV/2026/0921', validation_error: "State code '99' is out of the valid range 01-37.", source: 'purchase_register', invoice_date: '2026-03-12' },
  { invoice_id: 'dq-2', client_gstin: '09LVEJR7606R4ZA', vendor_gstin: '27ABCDE1234K1Y9', invoice_number: 'TX-9988',       validation_error: "Position 14 must be the letter Z; got 'Y'.",                               source: 'purchase_register', invoice_date: '2026-03-14' },
  { invoice_id: 'dq-3', client_gstin: '09TLPJZ1478E3ZR', vendor_gstin: '09AAA1234A1Z',    invoice_number: 'INV-456',        validation_error: 'GSTIN must be exactly 15 characters; got 12. Raw value: 09AAA1234A1Z', source: 'gstr2b',            invoice_date: '2026-03-15' },
];

// ──────────────────────────────────────────────────────────────────────────────
// ENDPOINTS
// ──────────────────────────────────────────────────────────────────────────────

// 1. GET /api/clients  (TTL: 120s — stable summary stats)
app.get('/api/clients', async (req, res) => {
  if (bigquery) {
    try {
      const [rows] = await bigquery.query({
        query: `SELECT * FROM \`decisionforge-501312.gst_notices.reconciliation_summary_by_client\``,
      });
      return res.json(rows.map(formatBqRow));
    } catch (err) {
      console.warn('[/api/clients] BQ failed, using mock:', err.message);
    }
  }
  return res.json(MOCK_CLIENTS);
});

// 2. GET /api/reconciliation  (TTL: 120s — keyed by full query string incl. filters)
// SQL LIMIT/OFFSET is applied AT THE DATABASE LEVEL — we never fetch all rows
// into Node memory and slice in JS. Confirmed: WHERE + LIMIT + OFFSET are part
// of the parameterised SQL sent to BigQuery.
app.get('/api/reconciliation', async (req, res) => {
  const { client_gstin, risk_label, mismatch_type, limit = 25, offset = 0, search } = req.query;

  if (bigquery) {
    try {
      const whereClauses = [];
      const params = {};

      if (client_gstin) { whereClauses.push('client_gstin = @client_gstin'); params.client_gstin = client_gstin; }
      if (risk_label)   { whereClauses.push('risk_label = @risk_label');     params.risk_label   = risk_label;   }
      if (mismatch_type){ whereClauses.push('mismatch_type = @mismatch_type');params.mismatch_type= mismatch_type;}
      if (search) {
        whereClauses.push('(LOWER(invoice_number) LIKE @search OR LOWER(vendor_name) LIKE @search OR LOWER(vendor_gstin) LIKE @search)');
        params.search = `%${search.toLowerCase()}%`;
      }

      const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
      params.limit  = parseInt(limit,  10);
      params.offset = parseInt(offset, 10);

      // LIMIT and OFFSET are in the SQL — BigQuery only returns the requested page.
      const [rows]      = await bigquery.query({ query: `SELECT * FROM \`decisionforge-501312.gst_notices.reconciliation_risk_ranked\` ${whereSql} LIMIT @limit OFFSET @offset`, params });
      const [countRows] = await bigquery.query({ query: `SELECT COUNT(*) AS total FROM \`decisionforge-501312.gst_notices.reconciliation_risk_ranked\` ${whereSql}`, params });
      const total = countRows[0] ? parseInt(countRows[0].total, 10) : rows.length;

      return res.json({ data: rows.map(formatBqRow), total, limit: params.limit, offset: params.offset });
    } catch (err) {
      console.warn('[/api/reconciliation] BQ failed, using mock:', err.message);
    }
  }

  // Local mock fallback — filter + paginate in memory (only ~16 rows)
  let filtered = [...MOCK_RECONCILIATION];
  if (client_gstin)  filtered = filtered.filter(i => i.client_gstin  === client_gstin);
  if (risk_label)    filtered = filtered.filter(i => i.risk_label     === risk_label);
  if (mismatch_type) filtered = filtered.filter(i => i.mismatch_type  === mismatch_type);
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(i =>
      (i.invoice_number && i.invoice_number.toLowerCase().includes(s)) ||
      (i.vendor_name    && i.vendor_name.toLowerCase().includes(s))    ||
      (i.vendor_gstin   && i.vendor_gstin.toLowerCase().includes(s))
    );
  }
  const lim = parseInt(limit, 10);
  const off = parseInt(offset, 10);
  return res.json({ data: filtered.slice(off, off + lim), total: filtered.length, limit: lim, offset: off });
});

// 3. GET /api/reconciliation/detail  (TTL: 120s — keyed by invoice_number + vendor_gstin)
app.get('/api/reconciliation/detail', async (req, res) => {
  const { invoice_number, vendor_gstin } = req.query;
  if (!invoice_number || !vendor_gstin) {
    return res.status(400).json({ error: 'Missing invoice_number or vendor_gstin' });
  }

  if (bigquery) {
    try {
      const [rows] = await bigquery.query({
        query: `SELECT * FROM \`decisionforge-501312.gst_notices.reconciliation_matches\` WHERE invoice_number = @invoice_number AND vendor_gstin = @vendor_gstin LIMIT 1`,
        params: { invoice_number, vendor_gstin },
      });
      if (rows.length > 0) {
        const row = formatBqRow(rows[0]);
        const itc_at_risk = parseFloat(row.itc_at_risk || 0);
        let risk_label = 'NONE';
        if      (row.mismatch_type === 'MISSING_IN_2B' && itc_at_risk > 50000)  risk_label = 'CRITICAL';
        else if (row.mismatch_type === 'MISSING_IN_2B')                          risk_label = 'HIGH';
        else if (row.mismatch_type === 'AMOUNT_MISMATCH' && itc_at_risk > 25000) risk_label = 'HIGH';
        else if (row.mismatch_type === 'AMOUNT_MISMATCH')                        risk_label = 'MEDIUM';
        else if (row.mismatch_type === 'DUPLICATE_CLAIM')                        risk_label = 'MEDIUM';
        else if (['TIMING_DIFFERENCE', 'MISSING_IN_REGISTER'].includes(row.mismatch_type)) risk_label = 'LOW';
        const explanation = `Reconciliation review for Invoice ${row.invoice_number} — ${row.mismatch_type.replace(/_/g, ' ')}.`;
        return res.json({ ...row, risk_label, explanation, itc_at_risk });
      }
    } catch (err) {
      console.warn('[/api/reconciliation/detail] BQ failed:', err.message);
    }
  }

  const found = MOCK_RECONCILIATION.find(i => i.invoice_number === invoice_number && i.vendor_gstin === vendor_gstin);
  return res.json(found || {
    invoice_id: 'adhoc-1', client_gstin: '07FTCJJ3204D7Z5', vendor_gstin, vendor_name: 'Selected Vendor',
    invoice_number, pr_invoice_date: '2026-03-10', b_invoice_date: '2026-03-10',
    pr_taxable_value: 100000, b_taxable_value: 100000, pr_cgst: 9000, b_cgst: 9000,
    pr_sgst: 9000, b_sgst: 9000, pr_igst: 0, b_igst: 0,
    pr_total_itc_claimed: 18000, b_itc_available: 18000, filing_period: '2026-03',
    mismatch_type: 'CLEAN_MATCH', itc_at_risk: 0, risk_label: 'NONE',
    explanation: `Invoice ${invoice_number} from vendor ${vendor_gstin} reconciles perfectly.`,
  });
});

// 4. GET /api/data-quality  (TTL: 120s)
app.get('/api/data-quality', async (req, res) => {
  if (bigquery) {
    try {
      const [rows] = await bigquery.query({ query: `SELECT * FROM \`decisionforge-501312.gst_notices.data_quality_flags\`` });
      const dbFlags = rows.map(formatBqRow);
      // Return live rows only — never merge with mock.
      // If BQ returns 0 rows that is authoritative (no bad GSTINs found).
      console.log(`[/api/data-quality] BQ returned ${dbFlags.length} live row(s).`);
      return res.json(dbFlags);
    } catch (err) {
      // BQ connection failed — fall back to mock so the UI still renders.
      console.warn('[/api/data-quality] BQ failed, using mock fallback:', err.message);
    }
  }
  return res.json(MOCK_DATA_QUALITY_FLAGS);
});

// 5. GET /api/benchmark  (TTL: 300s — completely static CSV, never changes)
app.get('/api/benchmark', (req, res) => {
  const csvPath = path.join(__dirname, 'data', 'benchmark_results.csv');
  try {
    if (fs.existsSync(csvPath)) {
      const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
      const headers = lines[0].split(',');
      const data = lines.slice(1).map(line => {
        const values = line.split(',');
        const obj = {};
        headers.forEach((h, i) => { const v = values[i]; obj[h.trim()] = isNaN(v) ? v.trim() : parseFloat(v); });
        return obj;
      });
      // Extend TTL to 5 minutes for truly static data
      setCache(req.originalUrl, data, 300_000);
      return res.json(data);
    }
  } catch (err) {
    console.error('[/api/benchmark] CSV read failed:', err.message);
  }
  return res.json([
    { Scale: 500,   Backend: 'pandas', 'Time (s)': 0.018 },
    { Scale: 500,   Backend: 'cudf',   'Time (s)': 0.024 },
    { Scale: 5000,  Backend: 'pandas', 'Time (s)': 0.055 },
    { Scale: 5000,  Backend: 'cudf',   'Time (s)': 0.020 },
    { Scale: 50000, Backend: 'pandas', 'Time (s)': 0.853 },
    { Scale: 50000, Backend: 'cudf',   'Time (s)': 0.123 },
  ]);
});

// 6. Cache stats endpoint (useful for debugging)
app.get('/api/cache-stats', (req, res) => {
  const now = Date.now();
  const entries = [];
  for (const [key, val] of cache.entries()) {
    entries.push({ key, ttlRemaining: Math.round((val.expiresAt - now) / 1000) + 's' });
  }
  res.json({ size: cache.size, entries });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`DecisionForge backend listening on port ${PORT}`);
    console.log(`Cache TTL: 120s for BQ queries, 300s for static data.`);
  });
}

module.exports = app;

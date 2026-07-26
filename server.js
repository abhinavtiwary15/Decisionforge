const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const multer = require('multer');
const crypto = require('crypto');
const { generateExplanation, generateCommunicationDraft } = require('./pipeline/aiService.js');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ──────────────────────────────────────────────────────────────────────────────
// EXPLANATION CACHE (JSON file written by pipeline/generate_explanation.py)
// ──────────────────────────────────────────────────────────────────────────────
const EXPLANATION_CACHE_FILE = path.join(__dirname, 'data', 'explanation_cache.json');

let cachedExplanations = null;

function loadExplanationCache() {
  if (cachedExplanations !== null) {
    return cachedExplanations;
  }
  try {
    if (fs.existsSync(EXPLANATION_CACHE_FILE)) {
      cachedExplanations = JSON.parse(fs.readFileSync(EXPLANATION_CACHE_FILE, 'utf8'));
      return cachedExplanations;
    }
  } catch (e) {
    console.warn('[explanation cache] Failed to read cache:', e.message);
  }
  cachedExplanations = {};
  return cachedExplanations;
}

// ──────────────────────────────────────────────────────────────────────────────
// COMMUNICATION CACHE (JSON file written by pipeline/generate_communication.py)
// ──────────────────────────────────────────────────────────────────────────────
const COMM_CACHE_FILE = path.join(__dirname, 'data', 'communication_cache.json');

function loadCommCache() {
  try {
    if (fs.existsSync(COMM_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(COMM_CACHE_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[comm cache] Failed to read cache:', e.message);
  }
  return {};
}

function saveCommCache(cache) {
  try {
    fs.writeFileSync(COMM_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.warn('[comm cache] Failed to save cache:', e.message);
  }
}

// Minimal generic fallback for drafts when python subprocess itself fails to run.
function _subprocessFailCommFallback(row, draft_type, lang) {
  const inv = row.invoice_number || 'unknown';
  const vendor = row.vendor_name || 'unknown';
  const fmt = (n) => parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
  const prAmt = row.pr_total_itc_claimed || 0;
  const bAmt = row.b_itc_available || 0;
  const atRisk = row.itc_at_risk || 0;

  // Resolve client display name if available
  let clientSalutation = row.client_name;
  if (!clientSalutation && row.client_gstin) {
    const registered = getRegisteredClients();
    const foundReg = registered.find(c => c.client_gstin === row.client_gstin);
    if (foundReg) clientSalutation = foundReg.client_name;
  }
  clientSalutation = clientSalutation || 'Client';

  if (lang === 'hi') {
    if (draft_type === 'vendor') {
      return `प्रिय टीम,\n\nकृपया इनवॉइस नंबर ${inv} पर जीएसटी विसंगति की जांच करें।\n\nविवरण:\nपरचेज रजिस्टर राशि: ₹${fmt(prAmt)}\nजीएसटीआर-2बी राशि: ₹${fmt(bAmt)}\n\nकृपया अपने जीएसटीआर-1 रिटर्न को संशोधित करें।\n\nसधन्यवाद`;
    } else {
      return `प्रिय ${clientSalutation},\n\nहम आपको सूचित करना चाहते हैं कि आपके इनवॉइस नंबर ${inv} (विक्रेता: ${vendor}) पर जीएसटी विसंगति पाई गई है।\n\nविवरण:\nइस विसंगति के कारण आपका ₹${fmt(atRisk)} का इनपुट टैक्स क्रेडिट (ITC) अस्थायी रूप से जोखिम में है।\n\nअनुशंसित कार्रवाई:\nहम विक्रेता से संपर्क करने और उनके GSTR-1 रिटर्न को संशोधित कराने की सलाह देते हैं।\n\nसादर,\nऑडिट टीम`;
    }
  } else {
    if (draft_type === 'vendor') {
      return `Dear Vendor Team,\n\nWe noticed a GST reconciliation discrepancy regarding Invoice ${inv}.\n\nDiscrepancy Details:\n- Purchase Register Amount: Rs. ${fmt(prAmt)}\n- GSTR-2B Reported Amount: Rs. ${fmt(bAmt)}\n\nPlease review this discrepancy and amend your GSTR-1 filing as necessary.\n\nRegards`;
    } else {
      return `Dear ${clientSalutation},\n\nWe are writing to inform you regarding a GST reconciliation discrepancy identified for Invoice ${inv} issued by vendor ${vendor}.\n\nSummary of Discrepancy:\nThe Input Tax Credit (ITC) currently at risk of disallowance is Rs. ${fmt(atRisk)}.\n\nRecommended Next Steps:\nWe advise submitting a formal compliance notice to the vendor requesting an immediate amendment in their GSTR-1 filing.\n\nRegards,\nAudit Team`;
    }
  }
}

// Bare last-resort fallback used ONLY when the Python subprocess itself cannot
// be spawned at all (e.g. 'py' / 'python3' not on PATH, or spawn timeout).
// Type-specific wording lives exclusively in pipeline/generate_explanation.py
// get_fallback_explanation() so there is exactly one source of truth.
// This string is intentionally generic so it never drifts from the Python version.
function _subprocessFailFallback(row) {
  const inv   = row.invoice_number || 'unknown';
  const mtype = (row.mismatch_type || 'UNKNOWN').replace(/_/g, ' ');
  return `Reconciliation review required for Invoice ${inv} — ${mtype}. See invoice details for amounts.`;
}

// Enrich an array of rows with Gemini-generated explanations.
//
// Flow for each row:
//   1. Cache hit  → use cached string (may be Gemini text or Python fallback).
//   2. Cache miss → call Python --batch; Python internally either:
//        a. Returns Gemini-generated + grounding-validated text, OR
//        b. Falls back to get_fallback_explanation() on grounding failure.
//      Server.js uses whatever Python returns — no re-derivation.
//   3. Python subprocess fails entirely → _subprocessFailFallback() (generic).
async function enrichWithExplanations(rows) {
  if (!rows || rows.length === 0) return rows;

  const expCache = loadExplanationCache();

  // Generate explanations using native Node aiService (with Gemini API + grounding check + fallback)
  await Promise.all(
    rows.map(async (r) => {
      const mid = r.invoice_id || r.gstr2b_id || `${r.invoice_number}_${r.vendor_gstin}`;
      if (!expCache[mid]) {
        expCache[mid] = await generateExplanation(r);
      }
    })
  );

  // Apply explanations — prefer cache (Gemini or Python fallback); _subprocessFailFallback only
  // if Python subprocess could not run at all and the row is still missing from expCache.
  return rows.map(r => {
    const mid = r.invoice_id || r.gstr2b_id || `${r.invoice_number}_${r.vendor_gstin}`;
    const exp = expCache[mid] || _subprocessFailFallback(r);
    return { ...r, explanation: exp };
  });
}

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

function clearCache(prefixOrPattern) {
  if (!prefixOrPattern) {
    cache.clear();
    console.log('[CACHE INVALIDATED] Cleared entire cache.');
    return;
  }
  let count = 0;
  for (const key of cache.keys()) {
    if (typeof prefixOrPattern === 'string' ? key.startsWith(prefixOrPattern) : prefixOrPattern.test(key)) {
      cache.delete(key);
      count++;
    }
  }
  console.log(`[CACHE INVALIDATED] Cleared ${count} entry(ies) matching '${prefixOrPattern}'.`);
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
let bigqueryClientInstance = null;
function getBigQueryClient() {
  if (bigqueryClientInstance) return bigqueryClientInstance;
  if (!process.env.BIGQUERY_CREDENTIALS && process.env.VERCEL) {
    return null;
  }
  try {
    const { BigQuery } = require('@google-cloud/bigquery');
    const options = { projectId: 'decisionforge-501312' };
    if (process.env.BIGQUERY_CREDENTIALS) {
      options.credentials = JSON.parse(process.env.BIGQUERY_CREDENTIALS);
    }
    bigqueryClientInstance = new BigQuery(options);
    return bigqueryClientInstance;
  } catch (err) {
    console.warn('BigQuery init failed:', err.message);
    return null;
  }
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

function normalizeClientRow(row) {
  if (!row) return row;
  const formatted = formatBqRow(row);
  const mapped = { ...formatted };

  if (mapped.total_invoices !== undefined) {
    mapped.total_invoice_count = mapped.total_invoices;
  }
  if (mapped.clean_matches !== undefined) {
    mapped.clean_match_count = mapped.clean_matches;
  }
  if (mapped.timing_differences !== undefined) {
    mapped.timing_difference_count = mapped.timing_differences;
  }
  if (mapped.missing_in_2b !== undefined) {
    mapped.missing_in_2b_count = mapped.missing_in_2b;
  }
  if (mapped.amount_mismatches !== undefined) {
    mapped.amount_mismatch_count = mapped.amount_mismatches;
  }
  if (mapped.missing_in_register !== undefined) {
    mapped.missing_in_register_count = mapped.missing_in_register;
  }
  if (mapped.duplicate_claims !== undefined) {
    mapped.duplicate_claim_count = mapped.duplicate_claims;
  }
  if (mapped.invalid_gstins !== undefined) {
    mapped.invalid_gstin_count = mapped.invalid_gstins;
  }

  return mapped;
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

// Client registry JSON storage path for newly onboarded clients
const CLIENT_REGISTRY_FILE = path.join(__dirname, 'data', 'client_registry.json');

const TEST_GSTIN_RE = /(9999|8888|0000|SMOKE|TEST)/i;
function isTestGstin(gstin) {
  if (!gstin || typeof gstin !== 'string') return false;
  return TEST_GSTIN_RE.test(gstin.trim());
}

function getRegisteredClientsLocal() {
  try {
    if (fs.existsSync(CLIENT_REGISTRY_FILE)) {
      const rows = JSON.parse(fs.readFileSync(CLIENT_REGISTRY_FILE, 'utf8'));
      return (rows || []).filter(r => !isTestGstin(r.client_gstin));
    }
  } catch (err) {
    console.warn('Failed to read client_registry.json:', err.message);
  }
  return [];
}

async function getRegisteredClients() {
  let bqRows = [];
  const bq = getBigQueryClient();
  if (bq) {
    try {
      const [rows] = await bq.query({
        query: `SELECT client_gstin, client_name, createdAt FROM \`decisionforge-501312.gst_notices.client_registry\``
      });
      bqRows = rows || [];
    } catch (err) {
      console.warn('[client_registry] BQ read failed:', err.message);
    }
  }

  const localRows = getRegisteredClientsLocal();
  const existingGstins = new Set(bqRows.map(c => c.client_gstin));
  const merged = [...bqRows];
  localRows.forEach(l => {
    if (!existingGstins.has(l.client_gstin)) {
      merged.push(l);
    }
  });

  return merged;
}

async function saveRegisteredClient(newEntry) {
  let bqErr = null;
  const bq = getBigQueryClient();
  if (bq) {
    try {
      const bqPromise = bq.query({
        query: `INSERT INTO \`decisionforge-501312.gst_notices.client_registry\` (client_gstin, client_name, createdAt) VALUES (@client_gstin, @client_name, @createdAt)`,
        params: {
          client_gstin: newEntry.client_gstin,
          client_name: newEntry.client_name || newEntry.client_gstin,
          createdAt: newEntry.createdAt || new Date().toISOString()
        }
      });
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('BQ write timeout')), 2000));
      await Promise.race([bqPromise, timeoutPromise]);
      console.log(`[client_registry] BQ row inserted for GSTIN: ${newEntry.client_gstin}`);
      return { success: true };
    } catch (err) {
      console.warn('[client_registry] BQ insert skipped/failed:', err.message);
      bqErr = err.message;
    }
  }

  // If running ON Vercel (process.env.VERCEL is set) AND BigQuery write failed,
  // do NOT pretend local file write succeeded since Vercel's filesystem is ephemeral.
  if (process.env.VERCEL) {
    throw new Error('Client onboarding is unavailable in this Vercel environment — BigQuery DML writes require GCP billing to be enabled.');
  }

  try {
    const registered = getRegisteredClientsLocal();
    registered.push(newEntry);
    const dir = path.dirname(CLIENT_REGISTRY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CLIENT_REGISTRY_FILE, JSON.stringify(registered, null, 2), 'utf8');
    return { success: true };
  } catch (err) {
    throw new Error('Failed to save client locally: ' + err.message);
  }
}

// 1. GET /api/clients  (TTL: 120s — stable summary stats)
app.get('/api/clients', async (req, res) => {
  let bqClients = [];
  const bq = getBigQueryClient();
  if (bq) {
    try {
      const [rows] = await bq.query({
        query: `SELECT * FROM \`decisionforge-501312.gst_notices.reconciliation_summary_by_client\``,
      });
      bqClients = rows.map(normalizeClientRow).filter(c => c.client_gstin && !isTestGstin(c.client_gstin));
    } catch (err) {
      console.warn('[/api/clients] BQ failed, using fallback:', err.message);
      bqClients = MOCK_CLIENTS;
    }
  } else {
    bqClients = MOCK_CLIENTS;
  }

  // Merge registered clients that aren't yet in BQ summary
  const registered = await getRegisteredClients();
  const existingGstins = new Set(bqClients.map(c => c.client_gstin));
  
  const merged = [...bqClients];
  registered.forEach(reg => {
    if (reg.client_gstin && !existingGstins.has(reg.client_gstin) && !isTestGstin(reg.client_gstin)) {
      merged.push({
        client_gstin: reg.client_gstin,
        client_name: reg.client_name || reg.client_gstin,
        total_invoice_count: 0,
        risk_count: 0,
        total_itc_at_risk: 0,
        missing_in_2b_count: 0,
        amount_mismatch_count: 0,
        timing_difference_count: 0,
        duplicate_claim_count: 0,
        missing_in_register_count: 0,
        clean_match_count: 0
      });
    }
  });

  return res.json(merged.filter(c => c.client_gstin && !isTestGstin(c.client_gstin)));
});

// 1b. POST /api/clients  (Onboard new client)
app.post('/api/clients', async (req, res) => {
  const { client_gstin, client_name } = req.body || {};
  if (!client_gstin || typeof client_gstin !== 'string') {
    return res.status(400).json({ error: 'client_gstin is required' });
  }

  // Run Python validators.py validate_gstin via sub-process or strict regex mirror
  const cleanGstin = client_gstin.trim().toUpperCase();
  const pyProcess = spawnSync('python', [
    '-c',
    `import json, sys; sys.path.append('.'); from pipeline.validators import validate_gstin; valid, err = validate_gstin(sys.argv[1]); print(json.dumps({'valid': valid, 'error': err}))`,
    cleanGstin
  ], { timeout: 15000, encoding: 'utf8' });

  let isValid = false;
  let validationErr = null;

  if (pyProcess.error?.code === 'ETIMEDOUT') {
    return res.status(500).json({ error: 'GSTIN validation timed out (15s). Please try again.' });
  }

  if (pyProcess.status === 0 && pyProcess.stdout) {
    try {
      const parsed = JSON.parse(pyProcess.stdout.toString());
      isValid = parsed.valid;
      validationErr = parsed.error;
    } catch (e) {}
  }

  // Node fallback match if python invocation wasn't available
  if (pyProcess.status !== 0 || pyProcess.error) {
    const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    if (cleanGstin.length !== 15) {
      isValid = false;
      validationErr = `GSTIN must be exactly 15 characters; got ${cleanGstin.length}.`;
    } else if (!GSTIN_RE.test(cleanGstin)) {
      isValid = false;
      validationErr = `Invalid GSTIN structure format '${cleanGstin}'.`;
    } else {
      const stateCode = parseInt(cleanGstin.slice(0, 2), 10);
      if (stateCode < 1 || stateCode > 37) {
        isValid = false;
        validationErr = `State code '${cleanGstin.slice(0, 2)}' is out of range 01-37.`;
      } else {
        isValid = true;
      }
    }
  }

  if (!isValid) {
    return res.status(400).json({ error: validationErr || 'Invalid GSTIN format.' });
  }

  const registered = await getRegisteredClients();
  if (registered.some(c => c.client_gstin === cleanGstin)) {
    return res.status(409).json({ error: `Client GSTIN ${cleanGstin} is already onboarded.` });
  }

  const newEntry = { client_gstin: cleanGstin, client_name: client_name || cleanGstin, createdAt: new Date().toISOString() };
  
  try {
    await saveRegisteredClient(newEntry);
    clearCache('/api/clients');
    return res.json({ success: true, client: newEntry });
  } catch (err) {
    console.warn('[POST /api/clients] Save failed:', err.message);
    return res.status(403).json({ error: err.message });
  }
});

// 2. GET /api/reconciliation  (TTL: 120s — keyed by full query string incl. filters)
// SQL LIMIT/OFFSET is applied AT THE DATABASE LEVEL — we never fetch all rows
// into Node memory and slice in JS. Confirmed: WHERE + LIMIT + OFFSET are part
// of the parameterised SQL sent to BigQuery.
app.get('/api/reconciliation', async (req, res) => {
  const { client_gstin, risk_label, mismatch_type, limit = 25, offset = 0, search, exclude_clean } = req.query;
  const isFilteredOrSearched = !!(client_gstin || risk_label || mismatch_type || search || exclude_clean === 'true');

  const bq = getBigQueryClient();
  if (bq) {
    try {
      const whereClauses = [];
      const params = {};

      if (client_gstin) { whereClauses.push('client_gstin = @client_gstin'); params.client_gstin = client_gstin; }
      if (risk_label)   { whereClauses.push('risk_label = @risk_label');     params.risk_label   = risk_label;   }
      if (mismatch_type){ whereClauses.push('mismatch_type = @mismatch_type');params.mismatch_type= mismatch_type;}
      if (exclude_clean === 'true') {
        whereClauses.push("mismatch_type != 'CLEAN_MATCH'");
      }
      if (search) {
        whereClauses.push('(LOWER(invoice_number) LIKE @search OR LOWER(vendor_name) LIKE @search OR LOWER(vendor_gstin) LIKE @search)');
        params.search = `%${search.toLowerCase()}%`;
      }

      const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
      params.limit  = parseInt(limit,  10);
      params.offset = parseInt(offset, 10);

      // LIMIT and OFFSET are in the SQL — BigQuery only returns the requested page.
      const [rows]      = await bq.query({ query: `SELECT * FROM \`decisionforge-501312.gst_notices.reconciliation_risk_ranked\` ${whereSql} LIMIT @limit OFFSET @offset`, params });
      const [countRows] = await bq.query({ query: `SELECT COUNT(*) AS total FROM \`decisionforge-501312.gst_notices.reconciliation_risk_ranked\` ${whereSql}`, params });
      const total = countRows[0] ? parseInt(countRows[0].total, 10) : rows.length;

      const enriched = await enrichWithExplanations(rows.map(formatBqRow));
      return res.json({ data: enriched, total, limit: params.limit, offset: params.offset });
    } catch (err) {
      console.warn('[/api/reconciliation] BQ query failed, using fallback:', err.message);
    }
  }

  // Local mock fallback — filter + paginate in memory (only ~16 rows)
  let filtered = [...MOCK_RECONCILIATION];
  if (client_gstin)  filtered = filtered.filter(i => i.client_gstin  === client_gstin);
  if (risk_label)    filtered = filtered.filter(i => i.risk_label     === risk_label);
  if (mismatch_type) filtered = filtered.filter(i => i.mismatch_type  === mismatch_type);
  if (exclude_clean === 'true') {
    filtered = filtered.filter(i => i.mismatch_type !== 'CLEAN_MATCH');
  }
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
  const enriched = await enrichWithExplanations(filtered.slice(off, off + lim));
  return res.json({ data: enriched, total: filtered.length, limit: lim, offset: off });
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
        const enriched = await enrichWithExplanations([{ ...row, risk_label, itc_at_risk }]);
        return res.json(enriched[0]);
      }
      // BQ returned 0 rows — invoice not found in live database
      return res.status(404).json({ error: `Invoice ${invoice_number} for vendor ${vendor_gstin} not found.` });
    } catch (err) {
      console.warn('[/api/reconciliation/detail] BQ failed:', err.message);
      return res.status(500).json({ error: `BigQuery query failed: ${err.message}` });
    }
  }

  // No BQ client — fall back to dev mock data only
  const found = MOCK_RECONCILIATION.find(i => i.invoice_number === invoice_number && i.vendor_gstin === vendor_gstin);
  if (found) {
    const enriched = await enrichWithExplanations([found]);
    return res.json(enriched[0]);
  }

  return res.status(404).json({ error: `Invoice ${invoice_number} for vendor ${vendor_gstin} not found.` });
});

// 3.5 GET /api/communication/draft  (Retrieves/generates communication drafts)
app.get('/api/communication/draft', async (req, res) => {
  const { invoice_number, vendor_gstin, draft_type, lang = 'en' } = req.query;
  if (!invoice_number || !vendor_gstin || !draft_type) {
    return res.status(400).json({ error: 'Missing invoice_number, vendor_gstin, or draft_type' });
  }

  // 1. Fetch the underlying record (from BQ, then dev mock — never synthesize)
  let row = null;
  if (bigquery) {
    try {
      const [rows] = await bigquery.query({
        query: `SELECT * FROM \`decisionforge-501312.gst_notices.reconciliation_matches\` WHERE invoice_number = @invoice_number AND vendor_gstin = @vendor_gstin LIMIT 1`,
        params: { invoice_number, vendor_gstin },
      });
      if (rows.length > 0) {
        row = formatBqRow(rows[0]);
      } else {
        return res.status(404).json({ error: `Invoice ${invoice_number} for vendor ${vendor_gstin} not found — cannot generate draft.` });
      }
    } catch (err) {
      console.warn('[/api/communication/draft] BQ query failed:', err.message);
      return res.status(500).json({ error: `BigQuery query failed: ${err.message}` });
    }
  }

  if (!row) {
    // No BQ client — fall back to dev mock data only, never synthesize
    const found = MOCK_RECONCILIATION.find(i => i.invoice_number === invoice_number && i.vendor_gstin === vendor_gstin);
    if (!found) {
      return res.status(404).json({ error: `Invoice ${invoice_number} for vendor ${vendor_gstin} not found — cannot generate draft.` });
    }
    row = found;
  }

  // 2. Lookup Cache
  const mid = row.invoice_id || row.gstr2b_id || `${row.invoice_number}_${row.vendor_gstin}`;
  const cacheKey = `${mid}:${draft_type}:${lang}`;
  const commCache = loadCommCache();

  if (commCache[cacheKey]) {
    return res.json({ draft: commCache[cacheKey] });
  }

  // Look up client_name if registered locally or in BQ
  let client_name = row.client_name;
  if (!client_name && row.client_gstin) {
    const registered = getRegisteredClients();
    const foundReg = registered.find(c => c.client_gstin === row.client_gstin);
    if (foundReg) client_name = foundReg.client_name;
  }

  const recordForDraft = {
    match_id: mid,
    mismatch_type: row.mismatch_type,
    client_gstin: row.client_gstin,
    client_name: client_name || row.client_gstin,
    vendor_name: row.vendor_name,
    invoice_number: row.invoice_number,
    purchase_register_amount: row.pr_total_itc_claimed,
    gstr2b_amount: row.b_itc_available,
    itc_at_risk: row.itc_at_risk || 0,
    risk_label: row.risk_label || 'NONE',
    filing_period: row.filing_period
  };

  const draftText = await generateCommunicationDraft(recordForDraft, draft_type, lang);
  return res.json({ draft: draftText });
});

// 4. GET /api/data-quality  (TTL: 120s)
app.get('/api/data-quality', async (req, res) => {
  const bq = getBigQueryClient();
  if (bq) {
    try {
      const [rows] = await bq.query({ query: `SELECT * FROM \`decisionforge-501312.gst_notices.data_quality_flags\`` });
      const dbFlags = rows.map(formatBqRow);
      // Return live rows only — never merge with mock.
      // If BQ returns 0 rows that is authoritative (no bad GSTINs found).
      console.log(`[/api/data-quality] BQ returned ${dbFlags.length} live row(s).`);
      return res.json(dbFlags);
    } catch (err) {
      console.warn('[/api/data-quality] BQ failed:', err.message);
      return res.status(500).json({ error: `BigQuery query failed: ${err.message}` });
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
    { Scale: 500,   Backend: 'pandas', 'Time (s)': 0.018, _isFallback: true },
    { Scale: 500,   Backend: 'cudf',   'Time (s)': 0.024, _isFallback: true },
    { Scale: 5000,  Backend: 'pandas', 'Time (s)': 0.055, _isFallback: true },
    { Scale: 5000,  Backend: 'cudf',   'Time (s)': 0.020, _isFallback: true },
    { Scale: 50000, Backend: 'pandas', 'Time (s)': 0.853, _isFallback: true },
    { Scale: 50000, Backend: 'cudf',   'Time (s)': 0.123, _isFallback: true },
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

// 7. Analytics: ITC at risk ranked by client_gstin
app.get('/api/analytics/risk-by-client', async (req, res) => {
  const bq = getBigQueryClient();
  if (bq) {
    try {
      const [rows] = await bq.query({
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
          GROUP BY client_gstin
          ORDER BY total_itc_at_risk DESC
          LIMIT 20
        `
      });
      return res.json(rows.map(formatBqRow));
    } catch (err) {
      console.warn('[/api/analytics/risk-by-client] BQ failed:', err.message);
      return res.status(500).json({ error: `BigQuery query failed: ${err.message}` });
    }
  }
  // Minimal mock fallback: derive from MOCK_RECONCILIATION
  const byClient = {};
  MOCK_RECONCILIATION.forEach(r => {
    const k = r.client_gstin || 'UNKNOWN';
    if (!byClient[k]) byClient[k] = { client_gstin: k, total_invoices: 0, risk_count: 0, total_itc_at_risk: 0, missing_in_2b: 0, amount_mismatch: 0, timing_diff: 0, duplicate: 0 };
    byClient[k].total_invoices++;
    if (['CRITICAL','HIGH'].includes(r.risk_label)) byClient[k].risk_count++;
    byClient[k].total_itc_at_risk += (parseFloat(r.itc_at_risk) || 0);
    if (r.mismatch_type === 'MISSING_IN_2B')     byClient[k].missing_in_2b++;
    if (r.mismatch_type === 'AMOUNT_MISMATCH')   byClient[k].amount_mismatch++;
    if (r.mismatch_type === 'TIMING_DIFFERENCE') byClient[k].timing_diff++;
    if (r.mismatch_type === 'DUPLICATE_CLAIM')   byClient[k].duplicate++;
  });
  return res.json(Object.values(byClient).sort((a, b) => b.total_itc_at_risk - a.total_itc_at_risk));
});

// 8. Analytics: mismatch count + ITC at risk by filing_period (time trend)
app.get('/api/analytics/trend', async (req, res) => {
  const bq = getBigQueryClient();
  if (bq) {
    try {
      const [rows] = await bq.query({
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
          LIMIT 24
        `
      });
      return res.json(rows.map(formatBqRow));
    } catch (err) {
      console.warn('[/api/analytics/trend] BQ failed:', err.message);
      return res.status(500).json({ error: `BigQuery query failed: ${err.message}` });
    }
  }
  // Mock fallback
  const byPeriod = {};
  MOCK_RECONCILIATION.forEach(r => {
    const k = r.filing_period || 'No GSTR-2B Filing (Vendor Non-Compliance)';
    if (!byPeriod[k]) byPeriod[k] = { filing_period: k, total_invoices: 0, mismatch_count: 0, total_itc_at_risk: 0, critical_count: 0, high_count: 0 };
    byPeriod[k].total_invoices++;
    if (r.mismatch_type !== 'CLEAN_MATCH') byPeriod[k].mismatch_count++;
    byPeriod[k].total_itc_at_risk += (parseFloat(r.itc_at_risk) || 0);
    if (r.risk_label === 'CRITICAL') byPeriod[k].critical_count++;
    if (r.risk_label === 'HIGH')     byPeriod[k].high_count++;
  });
  return res.json(Object.values(byPeriod).sort((a, b) => String(a.filing_period).localeCompare(String(b.filing_period))));
});

// 9. GET /api/vendor-summary  — per-vendor aggregation from vendor_compliance_summary view.
// Returns one row per vendor (~80 rows). Aggregation happens in BigQuery, not the frontend,
// so CLEAN_MATCH rows (ordered last in risk_ranked) are correctly counted here.
app.get('/api/vendor-summary', async (req, res) => {
  const bq = getBigQueryClient();
  if (bq) {
    try {
      const [rows] = await bq.query({
        query: `
          SELECT
            vendor_gstin,
            vendor_name,
            total_invoices,
            clean_matches,
            missing_in_2b,
            amount_mismatches,
            timing_differences,
            duplicate_claims,
            total_itc_at_risk,
            match_rate
          FROM \`decisionforge-501312.gst_notices.vendor_compliance_summary\`
          ORDER BY total_itc_at_risk DESC
        `
      });
      return res.json(rows.map(formatBqRow));
    } catch (err) {
      console.warn('[/api/vendor-summary] BQ failed, using fallback:', err.message);
    }
  }

  // Mock fallback: derive per-vendor aggregation from MOCK_RECONCILIATION
  const byVendor = {};
  MOCK_RECONCILIATION.forEach(r => {
    const k = r.vendor_gstin;
    if (!k) return;
    if (!byVendor[k]) byVendor[k] = {
      vendor_gstin: k,
      vendor_name: r.vendor_name || 'Unknown Vendor',
      total_invoices: 0,
      clean_matches: 0,
      missing_in_2b: 0,
      amount_mismatches: 0,
      timing_differences: 0,
      duplicate_claims: 0,
      total_itc_at_risk: 0
    };
    const v = byVendor[k];
    v.total_invoices++;
    if (r.mismatch_type === 'CLEAN_MATCH')       v.clean_matches++;
    else if (r.mismatch_type === 'MISSING_IN_2B')  v.missing_in_2b++;
    else if (r.mismatch_type === 'AMOUNT_MISMATCH')v.amount_mismatches++;
    else if (r.mismatch_type === 'TIMING_DIFFERENCE') v.timing_differences++;
    else if (r.mismatch_type === 'DUPLICATE_CLAIM')   v.duplicate_claims++;
    v.total_itc_at_risk += parseFloat(r.itc_at_risk) || 0;
  });
  const result = Object.values(byVendor).map(v => ({
    ...v,
    total_itc_at_risk: Math.round(v.total_itc_at_risk * 100) / 100,
    match_rate: v.total_invoices > 0 ? Math.round((v.clean_matches / v.total_invoices) * 1000) / 10 : 0
  }));
  return res.json(result.sort((a, b) => b.total_itc_at_risk - a.total_itc_at_risk));
});




// ──────────────────────────────────────────────────────────────────────────────
// PURCHASE REGISTER INGESTION FLOW
// ──────────────────────────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'tmp', 'pr_upload');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Clean up stale files on startup
try {
  const now = Date.now();
  const files = fs.readdirSync(UPLOAD_DIR);
  files.forEach(file => {
    const filePath = path.join(UPLOAD_DIR, file);
    const stats = fs.statSync(filePath);
    if (now - stats.mtimeMs > 30 * 60 * 1000) {
      fs.unlinkSync(filePath);
    }
  });
} catch (err) {
  console.warn('Failed to clean up stale uploads on startup:', err.message);
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const fileId = crypto.randomUUID();
    const ext = path.extname(file.originalname);
    cb(null, `${fileId}${ext}`);
  }
});
const upload = multer({ storage });

// Session store for upload metadata (30-minute TTL)
const uploadSessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [fileId, session] of uploadSessions.entries()) {
    if (now - session.created_at > 30 * 60 * 1000) {
      try {
        if (fs.existsSync(session.path)) {
          fs.unlinkSync(session.path);
        }
      } catch (err) {
        console.warn(`Failed to clean up expired file ${session.path}:`, err.message);
      }
      uploadSessions.delete(fileId);
    }
  }
}, 5 * 60 * 1000);

// Endpoint A: Upload file, detect columns and fetch mapping if any
app.post('/api/purchase-register/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  const fileId = path.basename(req.file.filename, path.extname(req.file.filename));
  const clientGstin = req.query.client_gstin || req.body.client_gstin;

  if (!clientGstin) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.status(400).json({ error: 'Missing client_gstin parameter.' });
  }

  const pythonPath = process.platform === 'win32' ? 'py' : 'python3';
  const scriptPath = path.join(__dirname, 'pipeline', 'ingest_purchase_register.py');
  
  const pyProcess = spawnSync(pythonPath, [scriptPath, '--detect-columns', req.file.path], {
    timeout: 20000,
    encoding: 'utf8',
  });
  if (pyProcess.error?.code === 'ETIMEDOUT') {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.status(500).json({ error: 'Column detection timed out (20s). The file may be too large or malformed.' });
  }
  if (pyProcess.error || pyProcess.status !== 0) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    const errMsg = pyProcess.stderr ? pyProcess.stderr.toString() : 'Unknown error calling Python script';
    return res.status(500).json({ error: 'Failed to parse file headers: ' + errMsg });
  }

  let columns;
  try {
    columns = JSON.parse(pyProcess.stdout.toString().trim());
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.status(500).json({ error: 'Python script returned invalid JSON: ' + pyProcess.stdout.toString() });
  }

  if (columns.error) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.status(400).json({ error: columns.error });
  }

  let savedMapping = null;
  let mappingValid = false;
  const mappingsPath = path.join(__dirname, 'data', 'client_column_mappings.json');
  if (fs.existsSync(mappingsPath)) {
    try {
      const allMappings = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
      if (allMappings[clientGstin]) {
        savedMapping = allMappings[clientGstin].mapping;
        const savedFingerprint = allMappings[clientGstin].columns_fingerprint || [];
        const currentFingerprint = [...columns].sort();
        const fingerprintMatch = JSON.stringify(savedFingerprint.sort()) === JSON.stringify(currentFingerprint);
        mappingValid = !!fingerprintMatch;
      }
    } catch (err) {
      console.warn('Failed to read client column mappings:', err.message);
    }
  }

  uploadSessions.set(fileId, {
    path: req.file.path,
    created_at: Date.now(),
    columns: columns
  });

  return res.json({
    file_id: fileId,
    columns: columns,
    savedMapping: savedMapping,
    mappingValid: mappingValid
  });
});

// Endpoint B: Save mapping config for a client
app.post('/api/purchase-register/save-mapping', async (req, res) => {
  const { client_gstin, mapping, columns_fingerprint } = req.body;
  if (!client_gstin || !mapping || !columns_fingerprint) {
    return res.status(400).json({ error: 'Missing required parameters: client_gstin, mapping, or columns_fingerprint.' });
  }

  const saved_at = new Date().toISOString();
  const mapping_json = JSON.stringify(mapping);
  const columns_fingerprint_json = JSON.stringify(columns_fingerprint);

  if (bigquery) {
    try {
      await bigquery.query({
        query: `DELETE FROM \`decisionforge-501312.gst_notices.client_column_mappings\` WHERE client_gstin = @client_gstin`,
        params: { client_gstin }
      });
      await bigquery.query({
        query: `INSERT INTO \`decisionforge-501312.gst_notices.client_column_mappings\` (client_gstin, mapping_json, columns_fingerprint_json, saved_at) VALUES (@client_gstin, @mapping_json, @columns_fingerprint_json, @saved_at)`,
        params: { client_gstin, mapping_json, columns_fingerprint_json, saved_at }
      });
      console.log(`[client_column_mappings] BQ mapping saved for ${client_gstin}`);
      clearCache('/api/reconciliation');
      return res.json({ success: true });
    } catch (err) {
      console.warn('[client_column_mappings] BQ save failed:', err.message);
    }
  }

  const mappingsPath = path.join(__dirname, 'data', 'client_column_mappings.json');
  let allMappings = {};
  if (fs.existsSync(mappingsPath)) {
    try {
      allMappings = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
    } catch (err) {
      console.warn('Failed to parse existing mappings:', err.message);
    }
  }

  allMappings[client_gstin] = {
    mapping: mapping,
    columns_fingerprint: columns_fingerprint,
    saved_at
  };

  try {
    fs.writeFileSync(mappingsPath, JSON.stringify(allMappings, null, 2), 'utf8');
    clearCache('/api/reconciliation');
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save mapping: ' + err.message });
  }
});

// Endpoint C: Run ingestion using mapping
app.post('/api/purchase-register/ingest', (req, res) => {
  const { file_id, mapping } = req.body;
  if (!file_id || !mapping) {
    return res.status(400).json({ error: 'Missing file_id or mapping.' });
  }

  const session = uploadSessions.get(file_id);
  if (!session) {
    return res.status(404).json({ error: 'Upload session not found. Please re-upload your file.' });
  }

  const filePath = session.path;
  if (!fs.existsSync(filePath)) {
    uploadSessions.delete(file_id);
    return res.status(404).json({ error: 'Uploaded file no longer exists. Please re-upload.' });
  }

  const pythonPath = process.platform === 'win32' ? 'py' : 'python3';
  const scriptPath = path.join(__dirname, 'pipeline', 'ingest_purchase_register.py');
  
  const pyProcess = spawnSync(pythonPath, [
    scriptPath,
    '--ingest',
    filePath,
    '--mapping',
    JSON.stringify(mapping)
  ], { timeout: 20000, encoding: 'utf8' });

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.warn(`Failed to unlink file ${filePath}:`, err.message);
  }
  uploadSessions.delete(file_id);

  if (pyProcess.error?.code === 'ETIMEDOUT') {
    return res.status(500).json({ error: 'Ingestion timed out (20s). The file may be too large — try a smaller batch.' });
  }
  if (pyProcess.error || pyProcess.status !== 0) {
    const errMsg = pyProcess.stderr ? pyProcess.stderr.toString() : 'Unknown error calling Python script';
    return res.status(500).json({ error: 'Failed to process file: ' + errMsg });
  }

  let result;
  try {
    result = JSON.parse(pyProcess.stdout.toString().trim());
  } catch (err) {
    return res.status(500).json({ error: 'Python script returned invalid JSON: ' + pyProcess.stdout.toString() });
  }

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  // Clear reconciliation & analytics caches after data ingestion
  clearCache();

  return res.json(result);
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`DecisionForge backend listening on port ${PORT}`);
    console.log(`Cache TTL: 120s for BQ queries, 300s for static data.`);
  });
}

module.exports = app;

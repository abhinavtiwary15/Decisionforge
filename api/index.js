const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const multer = require('multer');
const crypto = require('crypto');
const { generateExplanation, generateCommunicationDraft } = require('../pipeline/aiService.js');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── Test GSTIN Pattern Guard ──────────────────────────────────────────────────
const TEST_GSTIN_RE = /(9999|8888|0000|SMOKE|TEST)/i;
function isTestGstin(gstin) {
  if (!gstin || typeof gstin !== 'string') return false;
  return TEST_GSTIN_RE.test(gstin.trim());
}

// ──────────────────────────────────────────────────────────────────────────────
// EXPLANATION CACHE
// ──────────────────────────────────────────────────────────────────────────────
const EXPLANATION_CACHE_FILE = path.join(__dirname, '..', 'data', 'explanation_cache.json');

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
// COMMUNICATION CACHE
// ──────────────────────────────────────────────────────────────────────────────
const COMM_CACHE_FILE = path.join(__dirname, '..', 'data', 'communication_cache.json');

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
    const dir = path.dirname(COMM_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(COMM_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.warn('[comm cache] Failed to save cache:', e.message);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// IN-MEMORY RESPONSE CACHE (TTL mechanism)
// ──────────────────────────────────────────────────────────────────────────────
const apiCache = new Map();

function getCached(key) {
  const entry = apiCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    apiCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data, ttlMs = 120000) {
  apiCache.set(key, { data, expiry: Date.now() + ttlMs });
}

function clearCache(prefix = null) {
  if (!prefix) {
    apiCache.clear();
    console.log('[CACHE] Entire API cache cleared.');
    return;
  }
  for (const key of apiCache.keys()) {
    if (key.startsWith(prefix)) {
      apiCache.delete(key);
    }
  }
  console.log(`[CACHE] Cleared keys starting with '${prefix}'.`);
}

// Cache middleware: returns cached JSON if unexpired
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const cached = getCached(req.originalUrl);
  if (cached) {
    console.log(`[CACHE HIT] ${req.originalUrl}`);
    return res.json(cached);
  }
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 200) {
      setCache(req.originalUrl, body);
    }
    return originalJson(body);
  };
  next();
});

// ──────────────────────────────────────────────────────────────────────────────
// BIGQUERY CLIENT (LAZY INITIALIZATION)
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
// ──────────────────────────────────────────────────────────────────────────────
function formatBqRow(row) {
  if (!row) return row;
  const formatted = {};
  for (const [key, val] of Object.entries(row)) {
    if (val !== null && typeof val === 'object' && 'value' in val) {
      formatted[key] = val.value;
    } else {
      formatted[key] = val;
    }
  }
  return formatted;
}

function normalizeClientRow(row) {
  if (!row) return row;
  const formatted = formatBqRow(row);
  const mapped = { ...formatted };

  if (mapped.total_invoices !== undefined) mapped.total_invoice_count = mapped.total_invoices;
  if (mapped.clean_matches !== undefined) mapped.clean_match_count = mapped.clean_matches;
  if (mapped.timing_differences !== undefined) mapped.timing_difference_count = mapped.timing_differences;
  if (mapped.missing_in_2b !== undefined) mapped.missing_in_2b_count = mapped.missing_in_2b;
  if (mapped.amount_mismatches !== undefined) mapped.amount_mismatch_count = mapped.amount_mismatches;
  if (mapped.missing_in_register !== undefined) mapped.missing_in_register_count = mapped.missing_in_register;
  if (mapped.duplicate_claims !== undefined) mapped.duplicate_claim_count = mapped.duplicate_claims;
  if (mapped.invalid_gstins !== undefined) mapped.invalid_gstin_count = mapped.invalid_gstins;

  return mapped;
}

// ──────────────────────────────────────────────────────────────────────────────
// MOCK DATA (fallback when BQ is unavailable)
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
];

const MOCK_DATA_QUALITY_FLAGS = [
  { invoice_id: 'dq-1', client_gstin: '07FTCJJ3204D7Z5', vendor_gstin: '99XXXZZ1234A1ZA', invoice_number: 'INV/2026/0921', validation_error: "State code '99' is out of the valid range 01-37.", source: 'purchase_register', invoice_date: '2026-03-12' },
  { invoice_id: 'dq-2', client_gstin: '09LVEJR7606R4ZA', vendor_gstin: '27ABCDE1234K1Y9', invoice_number: 'TX-9988',       validation_error: "Position 14 must be the letter Z; got 'Y'.",                               source: 'purchase_register', invoice_date: '2026-03-14' },
  { invoice_id: 'dq-3', client_gstin: '09TLPJZ1478E3ZR', vendor_gstin: '09AAA1234A1Z',    invoice_number: 'INV-456',        validation_error: 'GSTIN must be exactly 15 characters; got 12. Raw value: 09AAA1234A1Z', source: 'gstr2b',            invoice_date: '2026-03-15' },
];

async function enrichWithExplanations(rows) {
  const cache = loadExplanationCache();
  const result = [];

  for (const row of rows) {
    if (row.explanation && row.explanation.trim() !== '') {
      result.push(row);
      continue;
    }

    const key = `${row.invoice_number}_${row.vendor_gstin}_${row.mismatch_type}`;

    if (cache[key]) {
      result.push({ ...row, explanation: cache[key] });
      continue;
    }

    try {
      const generated = await generateExplanation(row);
      if (generated) {
        cache[key] = generated;
        result.push({ ...row, explanation: generated });
      } else {
        result.push(row);
      }
    } catch (err) {
      console.warn(`[aiService] Native Node generation failed for ${row.invoice_number}:`, err.message);
      result.push(row);
    }
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// CLIENT REGISTRY HELPERS
// ──────────────────────────────────────────────────────────────────────────────
const CLIENT_REGISTRY_FILE = path.join(__dirname, '..', 'data', 'client_registry.json');

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
      bqRows = (rows || []).filter(r => !isTestGstin(r.client_gstin));
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

  return merged.filter(r => !isTestGstin(r.client_gstin));
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
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('BigQuery insert timeout after 5s')), 5000)
      );
      await Promise.race([bqPromise, timeoutPromise]);
      return { success: true };
    } catch (err) {
      console.warn('[client_registry] BQ insert skipped/failed:', err.message);
      bqErr = err.message;
    }
  }

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

// ──────────────────────────────────────────────────────────────────────────────
// ALL 13 ENDPOINTS (/api prefix + / root route fallback)
// ──────────────────────────────────────────────────────────────────────────────

// Health check endpoint
app.get(['/api/health', '/health'], (req, res) => {
  res.json({ status: 'ok', environment: process.env.VERCEL ? 'vercel' : 'local' });
});

// 1. GET /api/clients
app.get(['/api/clients', '/clients'], async (req, res) => {
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

  const registered = await getRegisteredClients();
  const existingGstins = new Set(bqClients.map(c => c.client_gstin));
  
  const merged = [...bqClients];
  registered.forEach(r => {
    if (r.client_gstin && !existingGstins.has(r.client_gstin) && !isTestGstin(r.client_gstin)) {
      merged.push({
        client_gstin: r.client_gstin,
        client_name: r.client_name || r.client_gstin,
        total_invoice_count: 0,
        clean_match_count: 0,
        timing_difference_count: 0,
        missing_in_2b_count: 0,
        amount_mismatch_count: 0,
        missing_in_register_count: 0,
        duplicate_claim_count: 0,
        invalid_gstin_count: 0,
        total_itc_at_risk: 0
      });
    }
  });

  return res.json(merged.filter(c => c.client_gstin && !isTestGstin(c.client_gstin)));
});

// 1b. POST /api/clients
app.post(['/api/clients', '/clients'], async (req, res) => {
  const { client_gstin, client_name } = req.body || {};
  if (!client_gstin || typeof client_gstin !== 'string') {
    return res.status(400).json({ error: 'client_gstin is required.' });
  }

  const cleanGstin = String(client_gstin).trim().toUpperCase();
  const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
  let isValid = false;
  let validationErr = null;

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

// 2. GET /api/reconciliation
app.get(['/api/reconciliation', '/reconciliation'], async (req, res) => {
  const { client_gstin, risk_label, mismatch_type, limit = 25, offset = 0, search, exclude_clean } = req.query;

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

      const [rows]      = await bq.query({ query: `SELECT * FROM \`decisionforge-501312.gst_notices.reconciliation_risk_ranked\` ${whereSql} LIMIT @limit OFFSET @offset`, params });
      const [countRows] = await bq.query({ query: `SELECT COUNT(*) AS total FROM \`decisionforge-501312.gst_notices.reconciliation_risk_ranked\` ${whereSql}`, params });
      const total = countRows[0] ? parseInt(countRows[0].total, 10) : rows.length;

      const enriched = await enrichWithExplanations(rows.map(formatBqRow));
      return res.json({ data: enriched, total, limit: params.limit, offset: params.offset });
    } catch (err) {
      console.warn('[/api/reconciliation] BQ query failed, using fallback:', err.message);
    }
  }

  let filtered = MOCK_RECONCILIATION;
  if (client_gstin)  filtered = filtered.filter(r => r.client_gstin === client_gstin);
  if (risk_label)    filtered = filtered.filter(r => r.risk_label === risk_label);
  if (mismatch_type) filtered = filtered.filter(r => r.mismatch_type === mismatch_type);
  if (exclude_clean === 'true') filtered = filtered.filter(r => r.mismatch_type !== 'CLEAN_MATCH');
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(r =>
      (r.invoice_number && r.invoice_number.toLowerCase().includes(q)) ||
      (r.vendor_name && r.vendor_name.toLowerCase().includes(q)) ||
      (r.vendor_gstin && r.vendor_gstin.toLowerCase().includes(q))
    );
  }

  const l = parseInt(limit, 10);
  const o = parseInt(offset, 10);
  const paged = filtered.slice(o, o + l);

  const enriched = await enrichWithExplanations(paged);
  return res.json({ data: enriched, total: filtered.length, limit: l, offset: o });
});

// 3. GET /api/reconciliation/detail
app.get(['/api/reconciliation/detail', '/reconciliation/detail'], async (req, res) => {
  const { invoice_number, vendor_gstin } = req.query;
  if (!invoice_number || !vendor_gstin) {
    return res.status(400).json({ error: 'Missing invoice_number or vendor_gstin' });
  }

  const bq = getBigQueryClient();
  if (bq) {
    try {
      const [rows] = await bq.query({
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
      return res.status(404).json({ error: `Invoice ${invoice_number} for vendor ${vendor_gstin} not found.` });
    } catch (err) {
      console.warn('[/api/reconciliation/detail] BQ failed:', err.message);
      return res.status(500).json({ error: `BigQuery query failed: ${err.message}` });
    }
  }

  const found = MOCK_RECONCILIATION.find(i => i.invoice_number === invoice_number && i.vendor_gstin === vendor_gstin);
  if (found) {
    const enriched = await enrichWithExplanations([found]);
    return res.json(enriched[0]);
  }

  return res.status(404).json({ error: `Invoice ${invoice_number} for vendor ${vendor_gstin} not found.` });
});

// 4. GET /api/communication/draft
app.get(['/api/communication/draft', '/communication/draft'], async (req, res) => {
  const { invoice_number, vendor_gstin, draft_type = 'vendor', lang = 'en' } = req.query;

  if (!invoice_number || !vendor_gstin) {
    return res.status(400).json({ error: 'invoice_number and vendor_gstin query params are required.' });
  }

  const cache = loadCommCache();
  const cacheKey = `${invoice_number}_${vendor_gstin}_${draft_type}_${lang}`;

  if (cache[cacheKey]) {
    return res.json({ draft: cache[cacheKey], cached: true });
  }

  let row = null;
  const bq = getBigQueryClient();
  if (bq) {
    try {
      const [rows] = await bq.query({
        query: `SELECT * FROM \`decisionforge-501312.gst_notices.reconciliation_risk_ranked\` WHERE invoice_number = @invoice_number AND vendor_gstin = @vendor_gstin LIMIT 1`,
        params: { invoice_number, vendor_gstin }
      });
      if (rows.length > 0) {
        row = formatBqRow(rows[0]);
      } else {
        return res.status(404).json({ error: `Invoice ${invoice_number} for vendor ${vendor_gstin} not found — cannot generate draft.` });
      }
    } catch (err) {
      console.warn('[/api/communication/draft] BQ lookup failed:', err.message);
      return res.status(500).json({ error: `BigQuery query failed: ${err.message}` });
    }
  }

  if (!row) {
    const found = MOCK_RECONCILIATION.find(
      r => r.invoice_number === invoice_number && r.vendor_gstin === vendor_gstin
    );
    if (!found) {
      return res.status(404).json({ error: `Invoice ${invoice_number} for vendor ${vendor_gstin} not found — cannot generate draft.` });
    }
    row = found;
  }

  try {
    const draftText = await generateCommunicationDraft(row, draft_type, lang);
    if (draftText) {
      cache[cacheKey] = draftText;
      saveCommCache(cache);
      return res.json({ draft: draftText, cached: false });
    }
  } catch (err) {
    console.warn(`[/api/communication/draft] AI generation failed:`, err.message);
  }

  const fallbackText = draft_type === 'vendor'
    ? `Dear Vendor (${row.vendor_name || vendor_gstin}), Invoice ${row.invoice_number} is missing in GSTR-2B. ITC at risk: Rs.${row.itc_at_risk || 0}. Please upload.`
    : `Dear Client, Invoice ${row.invoice_number} from vendor ${row.vendor_name || vendor_gstin} has mismatch type ${row.mismatch_type}. Total ITC at risk: Rs.${row.itc_at_risk || 0}.`;
  
  return res.json({ draft: fallbackText, cached: false, fallback: true });
});

// 5. GET /api/data-quality
app.get(['/api/data-quality', '/data-quality'], async (req, res) => {
  const bq = getBigQueryClient();
  if (bq) {
    try {
      const [rows] = await bq.query({ query: `SELECT * FROM \`decisionforge-501312.gst_notices.data_quality_flags\`` });
      const dbFlags = rows.map(formatBqRow);
      return res.json(dbFlags);
    } catch (err) {
      console.warn('[/api/data-quality] BQ failed, fallback:', err.message);
    }
  }
  return res.json(MOCK_DATA_QUALITY_FLAGS);
});

// 6. GET /api/benchmark
app.get(['/api/benchmark', '/benchmark'], (req, res) => {
  const csvPath = path.join(__dirname, '..', 'data', 'benchmark_results.csv');
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

// 7. GET /api/cache-stats
app.get(['/api/cache-stats', '/cache-stats'], (req, res) => {
  const now = Date.now();
  const entries = [];
  for (const [key, val] of apiCache.entries()) {
    entries.push({ key, ttlRemaining: Math.round((val.expiry - now) / 1000) + 's' });
  }
  res.json({ size: apiCache.size, entries });
});

// 8. GET /api/analytics/risk-by-client
app.get(['/api/analytics/risk-by-client', '/analytics/risk-by-client'], async (req, res) => {
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
          WHERE client_gstin IS NOT NULL AND client_gstin NOT LIKE '%9999%' AND client_gstin NOT LIKE '%8888%'
          GROUP BY client_gstin
          ORDER BY total_itc_at_risk DESC
          LIMIT 20
        `
      });
      return res.json(rows.map(formatBqRow));
    } catch (err) {
      console.warn('[/api/analytics/risk-by-client] BQ failed, fallback:', err.message);
    }
  }

  const byClient = {};
  MOCK_RECONCILIATION.forEach(r => {
    const k = r.client_gstin || 'UNKNOWN';
    if (isTestGstin(k)) return;
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

// 9. GET /api/analytics/trend
app.get(['/api/analytics/trend', '/analytics/trend'], async (req, res) => {
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
      console.warn('[/api/analytics/trend] BQ failed, fallback:', err.message);
    }
  }

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

// 10. GET /api/vendor-summary — per-vendor aggregation from vendor_compliance_summary view.
// Returns one row per vendor (~80 rows). Aggregation happens in BigQuery, not the frontend,
// so CLEAN_MATCH rows (ordered last in risk_ranked) are correctly counted here.
app.get(['/api/vendor-summary', '/vendor-summary'], async (req, res) => {
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
    if (r.mismatch_type === 'CLEAN_MATCH')            v.clean_matches++;
    else if (r.mismatch_type === 'MISSING_IN_2B')     v.missing_in_2b++;
    else if (r.mismatch_type === 'AMOUNT_MISMATCH')   v.amount_mismatches++;
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

// 10. POST /api/purchase-register/upload
const storage = multer.memoryStorage();
const upload = multer({ storage });
const uploadSessions = new Map();

app.post(['/api/purchase-register/upload', '/purchase-register/upload'], (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('[upload] Multer error:', err.message);
      return res.status(400).json({ error: "File upload failed: " + err.message });
    }
    next();
  });
}, (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const fileId = crypto.randomUUID();
    const clientGstin = req.query.client_gstin || req.body.client_gstin;
    if (!clientGstin) {
      return res.status(400).json({ error: 'Missing client_gstin parameter.' });
    }

    // Save buffer temporarily in os.tmpdir() if path needed
    const os = require('os');
    const tmpPath = path.join(os.tmpdir(), `${fileId}${path.extname(req.file.originalname || '.csv')}`);
    fs.writeFileSync(tmpPath, req.file.buffer);

    let columns;
    const pythonPath = process.platform === 'win32' ? 'py' : 'python3';
    const scriptPath = path.join(__dirname, '..', 'pipeline', 'ingest_purchase_register.py');
    
    let pythonWorked = false;
    try {
      const pyProcess = spawnSync(pythonPath, [scriptPath, '--detect-columns', tmpPath], {
        timeout: 20000,
        encoding: 'utf8',
      });
      if (pyProcess.status === 0 && pyProcess.stdout) {
        const parsed = JSON.parse(pyProcess.stdout.toString().trim());
        if (Array.isArray(parsed)) {
          columns = parsed;
          pythonWorked = true;
        }
      }
    } catch (e) {
      console.warn('[upload] Python detection attempt failed:', e.message);
    }

    if (!pythonWorked) {
      try {
        const { detectCsvHeaders } = require('../pipeline/parseFile.js');
        columns = detectCsvHeaders(tmpPath);
      } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch (e) {}
        console.error('[upload] CSV detection error:', err.message);
        return res.status(400).json({
          error: "We couldn't read this file — please check it's a valid CSV export with headers."
        });
      }
    }

    if (!columns || !Array.isArray(columns) || columns.length === 0) {
      try { fs.unlinkSync(tmpPath); } catch (e) {}
      return res.status(400).json({ error: "We couldn't read any header columns from this file." });
    }

    let savedMapping = null;
    let mappingValid = false;
    const mappingsPath = path.join(__dirname, '..', 'data', 'client_column_mappings.json');
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

    uploadSessions.set(fileId, { path: tmpPath, created_at: Date.now(), columns });
    return res.json({ file_id: fileId, columns, savedMapping, mappingValid });
  } catch (err) {
    console.error('[upload] Unhandled upload error:', err.stack || err.message);
    return res.status(500).json({ error: "We couldn't process this upload. Please check your file and try again." });
  }
});

// 11. POST /api/purchase-register/save-mapping
app.post(['/api/purchase-register/save-mapping', '/purchase-register/save-mapping'], async (req, res) => {
  const { client_gstin, mapping, columns_fingerprint } = req.body;
  if (!client_gstin || !mapping || !columns_fingerprint) {
    return res.status(400).json({ error: 'Missing required parameters.' });
  }

  const saved_at = new Date().toISOString();
  const mapping_json = JSON.stringify(mapping);
  const columns_fingerprint_json = JSON.stringify(columns_fingerprint);
  const bq = getBigQueryClient();

  if (bq) {
    try {
      await bq.query({
        query: `DELETE FROM \`decisionforge-501312.gst_notices.client_column_mappings\` WHERE client_gstin = @client_gstin`,
        params: { client_gstin }
      });
      await bq.query({
        query: `INSERT INTO \`decisionforge-501312.gst_notices.client_column_mappings\` (client_gstin, mapping_json, columns_fingerprint_json, saved_at) VALUES (@client_gstin, @mapping_json, @columns_fingerprint_json, @saved_at)`,
        params: { client_gstin, mapping_json, columns_fingerprint_json, saved_at }
      });
      clearCache('/api/reconciliation');
      return res.json({ success: true });
    } catch (err) {
      console.warn('[client_column_mappings] BQ save failed:', err.message);
    }
  }

  const mappingsPath = path.join(__dirname, '..', 'data', 'client_column_mappings.json');
  let allMappings = {};
  if (fs.existsSync(mappingsPath)) {
    try { allMappings = JSON.parse(fs.readFileSync(mappingsPath, 'utf8')); } catch (e) {}
  }
  allMappings[client_gstin] = { mapping, columns_fingerprint, saved_at };
  try {
    const dir = path.dirname(mappingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(mappingsPath, JSON.stringify(allMappings, null, 2), 'utf8');
    clearCache('/api/reconciliation');
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save mapping: ' + err.message });
  }
});

// 12. POST /api/purchase-register/ingest
app.post(['/api/purchase-register/ingest', '/purchase-register/ingest'], (req, res) => {
  const { file_id, mapping } = req.body;
  if (!file_id || !mapping) {
    return res.status(400).json({ error: 'Missing file_id or mapping.' });
  }
  const session = uploadSessions.get(file_id);
  if (!session) {
    return res.status(404).json({ error: 'Upload session not found.' });
  }
  const filePath = session.path;
  if (!fs.existsSync(filePath)) {
    uploadSessions.delete(file_id);
    return res.status(404).json({ error: 'Uploaded file no longer exists.' });
  }

  let result;
  const pythonPath = process.platform === 'win32' ? 'py' : 'python3';
  const scriptPath = path.join(__dirname, '..', 'pipeline', 'ingest_purchase_register.py');
  
  let pythonWorked = false;
  try {
    const pyProcess = spawnSync(pythonPath, [
      scriptPath,
      '--ingest',
      filePath,
      '--mapping',
      JSON.stringify(mapping)
    ], { timeout: 20000, encoding: 'utf8' });

    if (pyProcess.status === 0 && pyProcess.stdout) {
      const parsed = JSON.parse(pyProcess.stdout.toString().trim());
      if (parsed && !parsed.error) {
        result = parsed;
        pythonWorked = true;
      }
    }
  } catch (e) {
    console.warn('[ingest] Python ingestion attempt failed:', e.message);
  }

  if (!pythonWorked) {
    try {
      const { ingestPurchaseRegisterJs } = require('../pipeline/parseFile.js');
      result = ingestPurchaseRegisterJs(filePath, mapping);
    } catch (err) {
      console.error('[ingest] JS ingestion error:', err.message);
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
      uploadSessions.delete(file_id);
      return res.status(400).json({ error: "We couldn't process this file — please check that the mapped columns exist and contain valid data." });
    }
  }

  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
  uploadSessions.delete(file_id);

  if (!result || result.error) {
    return res.status(400).json({ error: result?.error || 'Failed to process file records.' });
  }

  clearCache();
  return res.json(result);
});

module.exports = app;

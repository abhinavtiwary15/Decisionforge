/**
 * src/api.js
 * -----------
 * Thin wrapper around fetch for every backend endpoint.
 *
 * All functions return { data, error }.
 * Components check `error` before rendering — they NEVER .map() on undefined.
 *
 * The server already runs formatBqRow() to flatten BigQuery date objects
 * ({ value: 'YYYY-MM-DD' } → 'YYYY-MM-DD').  safeStr() here is a second-
 * line defence that coerces any object that slips through to a display string.
 */

/** Coerce a value that might be a BQ date object to a plain string. */
export function safeStr(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object' && val.value !== undefined) return String(val.value);
  if (typeof val === 'object') return JSON.stringify(val); // last resort
  return String(val);
}

/** Coerce a value to a float, returning 0 for null/undefined/object. */
export function safeFloat(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'object' && val.value !== undefined) return parseFloat(val.value) || 0;
  return parseFloat(val) || 0;
}

/** Coerce to int. */
export function safeInt(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'object' && val.value !== undefined) return parseInt(val.value, 10) || 0;
  return parseInt(val, 10) || 0;
}

async function apiFetch(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      return { data: null, error: `API ${res.status}: ${text}` };
    }
    const data = await res.json();
    return { data, error: null };
  } catch (err) {
    console.error('[apiFetch error]', url, err);
    return { data: null, error: err.message || 'Network error' };
  }
}

async function apiPost(url, body, isFormData = false) {
  try {
    const options = {
      method: 'POST',
      body: isFormData ? body : JSON.stringify(body)
    };
    if (!isFormData) {
      options.headers = { 'Content-Type': 'application/json' };
    }
    const res = await fetch(url, options);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      let errMsg = text;
      try {
        const jsonErr = JSON.parse(text);
        if (jsonErr.error) errMsg = jsonErr.error;
      } catch (e) {}
      return { data: null, error: errMsg };
    }
    const data = await res.json();
    return { data, error: null };
  } catch (err) {
    console.error('[apiPost error]', url, err);
    return { data: null, error: err.message || 'Network error' };
  }
}

export const api = {
  getClients: () => apiFetch('/api/clients'),

  getReconciliation: (params = {}) => {
    const q = new URLSearchParams();
    if (params.client_gstin) q.set('client_gstin', params.client_gstin);
    if (params.risk_label)   q.set('risk_label',   params.risk_label);
    if (params.mismatch_type) q.set('mismatch_type', params.mismatch_type);
    if (params.search)       q.set('search',        params.search);
    if (params.exclude_clean) q.set('exclude_clean', String(params.exclude_clean));
    q.set('limit',  String(params.limit  ?? 25));
    q.set('offset', String(params.offset ?? 0));
    return apiFetch(`/api/reconciliation?${q.toString()}`);
  },

  getReconciliationDetail: (invoice_number, vendor_gstin) =>
    apiFetch(`/api/reconciliation/detail?invoice_number=${encodeURIComponent(invoice_number)}&vendor_gstin=${encodeURIComponent(vendor_gstin)}`),

  getDataQuality: () => apiFetch('/api/data-quality'),

  getBenchmark: () => apiFetch('/api/benchmark'),

  getCommunicationDraft: (invoice_number, vendor_gstin, draft_type, lang = 'en') =>
    apiFetch(`/api/communication/draft?invoice_number=${encodeURIComponent(invoice_number)}&vendor_gstin=${encodeURIComponent(vendor_gstin)}&draft_type=${encodeURIComponent(draft_type)}&lang=${encodeURIComponent(lang)}`),

  uploadPRFile: (formData, clientGstin) => 
    apiPost(`/api/purchase-register/upload?client_gstin=${encodeURIComponent(clientGstin)}`, formData, true),

  savePRMapping: (client_gstin, mapping, columns_fingerprint) =>
    apiPost('/api/purchase-register/save-mapping', { client_gstin, mapping, columns_fingerprint }),

  ingestPR: (file_id, mapping) =>
    apiPost('/api/purchase-register/ingest', { file_id, mapping }),

  addClient: (client_gstin, client_name) =>
    apiPost('/api/clients', { client_gstin, client_name }),

  getAnalyticsRiskByClient: () => apiFetch('/api/analytics/risk-by-client'),

  getAnalyticsTrend: () => apiFetch('/api/analytics/trend'),
};

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

export const api = {
  getClients: () => apiFetch('/api/clients'),

  getReconciliation: (params = {}) => {
    const q = new URLSearchParams();
    if (params.client_gstin) q.set('client_gstin', params.client_gstin);
    if (params.risk_label)   q.set('risk_label',   params.risk_label);
    if (params.mismatch_type) q.set('mismatch_type', params.mismatch_type);
    if (params.search)       q.set('search',        params.search);
    q.set('limit',  String(params.limit  ?? 25));
    q.set('offset', String(params.offset ?? 0));
    return apiFetch(`/api/reconciliation?${q.toString()}`);
  },

  getReconciliationDetail: (invoice_number, vendor_gstin) =>
    apiFetch(`/api/reconciliation/detail?invoice_number=${encodeURIComponent(invoice_number)}&vendor_gstin=${encodeURIComponent(vendor_gstin)}`),

  getDataQuality: () => apiFetch('/api/data-quality'),

  getBenchmark: () => apiFetch('/api/benchmark'),
};

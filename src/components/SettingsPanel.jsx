import React, { useState, useEffect, useRef } from 'react';
import { useAppData } from '../AppDataContext';
import { api, safeStr } from '../api';

/**
 * Client-side GSTIN structural validator.
 * Mirrors the regex and checks in server.js POST /api/clients and
 * pipeline/validators.py _GSTIN_RE so the user gets instant feedback
 * without a server round-trip. The server still validates authoritatively.
 *
 * Returns null if valid, or a short error string if invalid.
 */
function validateGstin(raw) {
  const v = raw.trim().toUpperCase();
  if (v.length !== 15)
    return `GSTIN must be exactly 15 characters (got ${v.length}).`;
  const stateCode = parseInt(v.slice(0, 2), 10);
  if (!/^\d{2}$/.test(v.slice(0, 2)) || stateCode < 1 || stateCode > 37)
    return `State code '${v.slice(0, 2)}' is invalid — must be 01 to 37.`;
  if (!/^[A-Z]{5}$/.test(v.slice(2, 7)))
    return `PAN segment (positions 3–7) must be 5 uppercase letters; got '${v.slice(2, 7)}'.`;
  if (!/^\d{4}$/.test(v.slice(7, 11)))
    return `PAN segment (positions 8–11) must be 4 digits; got '${v.slice(7, 11)}'.`;
  if (!/^[A-Z]$/.test(v.slice(11, 12)))
    return `Position 12 must be 1 uppercase letter; got '${v.slice(11, 12)}'.`;
  if (!/^[1-9A-Z]$/.test(v.slice(12, 13)))
    return `Entity code (position 13) must be 1–9 or A–Z; got '${v.slice(12, 13)}'.`;
  if (v[13] !== 'Z')
    return `Position 14 must be the letter Z; got '${v[13]}'.`;
  if (!/^[0-9A-Z]$/.test(v.slice(14, 15)))
    return `Checksum (position 15) must be alphanumeric; got '${v.slice(14, 15)}'.`;
  return null; // valid
}

/**
 * SettingsPanel
 * A slide-over panel (fixed right drawer) that opens via the gear icon in the
 * Sidebar footer. Replaces the full Settings page.
 *
 * Props:
 *   open        — boolean
 *   onClose     — () => void
 */
export default function SettingsPanel({ open, onClose }) {
  const { profile: contextProfile, updateProfile, clients, setClients } = useAppData() || {};

  const [tab, setTab] = useState('profile'); // 'profile' | 'thresholds' | 'integrations' | 'clients'

  const [newGstin, setNewGstin] = useState('');
  const [newName, setNewName] = useState('');
  const [clientAddError, setClientAddError] = useState('');
  const [clientAddSuccess, setClientAddSuccess] = useState('');
  const [submittingClient, setSubmittingClient] = useState(false);

  const [profile, setProfile] = useState({
    name:    'ASHOK KAPOOR',
    role:    'Lead Chartered Accountant',
    firm:    'Kapoor & Associates Ltd',
    license: 'CA-2026-987123',
    email:   'a.kapoor@kapoor-associates.com',
  });

  const [thresholds, setThresholds] = useState({
    criticalRisk:     '50000',
    highRisk:         '25000',
    toleranceAmt:     '100',
    timingDiffMonth:  '1',
  });

  const [integrations, setIntegrations] = useState({
    projectId:     'decisionforge-501312',
    datasetId:     'gst_notices',
    localFallback: 'Enabled when offline/unauthorized',
  });

  const [saveStatus, setSaveStatus] = useState(null); // null | 'success' | 'error'
  const saveTimer = useRef(null);

  // Sync profile from context
  useEffect(() => {
    if (contextProfile) setProfile(contextProfile);
  }, [contextProfile]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Prevent body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  const handleSave = (section) => {
    // Only 'profile' is a real persisted save (calls updateProfile in AppDataContext).
    // Thresholds and Integrations are preview-only and have no Save button.
    if (section !== 'profile') return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    updateProfile(profile);
    setSaveStatus('success');
    saveTimer.current = setTimeout(() => setSaveStatus(null), 3000);
  };

  const clientList = Array.isArray(clients) ? clients : [];

  const TABS = [
    { id: 'profile',      label: 'Profile',      icon: 'person' },
    { id: 'thresholds',   label: 'Thresholds',   icon: 'tune' },
    { id: 'integrations', label: 'Integrations', icon: 'cloud' },
    { id: 'clients',      label: 'Clients',       icon: 'business' },
  ];

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={`fixed inset-0 bg-black/50 z-[60] transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        aria-hidden="true"
      />

      {/* Centered Modal Container */}
      <div className={`fixed inset-0 z-[70] flex items-center justify-center p-4 transition-all duration-200 ${open ? 'opacity-100 scale-100' : 'opacity-0 scale-95 pointer-events-none'}`}>
        <aside
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          className="w-[560px] max-w-[95vw] max-h-[85vh] flex flex-col font-sans shadow-2xl rounded-sm border border-ink/20"
          style={{ backgroundColor: '#FAF8F5', color: '#1B1811' }}
        >
          {/* Panel Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-ink border-opacity-10 shrink-0"
            style={{ backgroundColor: '#1B1811' }}>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg" style={{ color: '#A9781E' }}>settings</span>
            <h2 className="font-fraunces text-base font-bold" style={{ color: '#F3EEE2' }}>Settings</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 opacity-60 hover:opacity-100 transition-opacity"
            style={{ color: '#F3EEE2' }}
            aria-label="Close settings"
          >
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        {/* Tab Bar */}
        <div className="flex border-b border-ink border-opacity-10 shrink-0 overflow-x-auto">
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-[11px] font-sans font-semibold transition-colors border-b-2 whitespace-nowrap ${
                tab === t.id
                  ? 'border-brass text-brass'
                  : 'border-transparent text-ink-45 hover:text-ink'
              }`}
            >
              <span className="material-symbols-outlined text-[14px]">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">

          {/* ─── PROFILE TAB ─── */}
          {tab === 'profile' && (
            <div className="space-y-4">
              <p className="text-[10px] text-ink-45 font-mono uppercase tracking-wider">Auditor Identity — appears on generated PDF reports</p>
              <Field label="Full Name">
                <input type="text" value={profile.name}
                  onChange={e => setProfile({ ...profile, name: e.target.value })}
                  className="input-field" />
              </Field>
              <Field label="Role / Designation">
                <input type="text" value={profile.role}
                  onChange={e => setProfile({ ...profile, role: e.target.value })}
                  className="input-field" />
              </Field>
              <Field label="Firm / Organisation">
                <input type="text" value={profile.firm}
                  onChange={e => setProfile({ ...profile, firm: e.target.value })}
                  className="input-field" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="ICA Licence No.">
                  <input type="text" value={profile.license}
                    onChange={e => setProfile({ ...profile, license: e.target.value })}
                    className="input-field font-mono" />
                </Field>
                <Field label="Email">
                  <input type="email" value={profile.email}
                    onChange={e => setProfile({ ...profile, email: e.target.value })}
                    className="input-field" />
                </Field>
              </div>
              <SaveRow status={saveStatus} onSave={() => handleSave('profile')} />
            </div>
          )}

          {/* ─── THRESHOLDS TAB ─── */}
          {tab === 'thresholds' && (
            <div className="space-y-4">
              <p className="text-[10px] text-ink-45 font-mono uppercase tracking-wider">Risk scoring classification boundaries</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Critical Risk Threshold (ITC ≥)">
                  <div className="relative">
                    <span className="absolute left-2.5 top-1.5 font-mono text-ink-45 text-xs">₹</span>
                    <input type="number" value={thresholds.criticalRisk}
                      onChange={e => setThresholds({ ...thresholds, criticalRisk: e.target.value })}
                      className="input-field pl-6 font-mono" />
                  </div>
                </Field>
                <Field label="High Risk Threshold (ITC ≥)">
                  <div className="relative">
                    <span className="absolute left-2.5 top-1.5 font-mono text-ink-45 text-xs">₹</span>
                    <input type="number" value={thresholds.highRisk}
                      onChange={e => setThresholds({ ...thresholds, highRisk: e.target.value })}
                      className="input-field pl-6 font-mono" />
                  </div>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Rounding Tolerance">
                  <div className="relative">
                    <span className="absolute left-2.5 top-1.5 font-mono text-ink-45 text-xs">₹</span>
                    <input type="number" value={thresholds.toleranceAmt}
                      onChange={e => setThresholds({ ...thresholds, toleranceAmt: e.target.value })}
                      className="input-field pl-6 font-mono" />
                  </div>
                </Field>
                <Field label="Timing Diff Period">
                  <input type="text" value={`${thresholds.timingDiffMonth} Calendar Month`}
                    onChange={e => setThresholds({ ...thresholds, timingDiffMonth: e.target.value.replace(/[^0-9]/g, '') })}
                    className="input-field font-mono" />
                </Field>
              </div>
              <PreviewOnlyNotice label="Risk thresholds" />
            </div>
          )}

          {/* ─── INTEGRATIONS TAB ─── */}
          {tab === 'integrations' && (
            <div className="space-y-4">
              <p className="text-[10px] text-ink-45 font-mono uppercase tracking-wider">BigQuery connection — read from server.js / service account ADC</p>
              <Field label="GCP Project ID">
                <input type="text" value={integrations.projectId}
                  onChange={e => setIntegrations({ ...integrations, projectId: e.target.value })}
                  className="input-field font-mono" />
              </Field>
              <Field label="BigQuery Dataset ID">
                <input type="text" value={integrations.datasetId}
                  onChange={e => setIntegrations({ ...integrations, datasetId: e.target.value })}
                  className="input-field font-mono" />
              </Field>
              <Field label="Local Fallback Strategy">
                <input type="text" value={integrations.localFallback}
                  disabled className="input-field font-mono text-ink-45 cursor-not-allowed" />
              </Field>
              <p className="text-[10px] text-ink-45 italic">
                Credentials via Google Application Default Credentials (ADC). Service account key path
                must be set via <code className="font-mono bg-ink/5 px-1">GOOGLE_APPLICATION_CREDENTIALS</code> env var.
              </p>
              <PreviewOnlyNotice label="BigQuery connection config" />
            </div>
          )}

          {/* ─── CLIENTS TAB ─── */}
          {tab === 'clients' && (
            <div className="space-y-4">
              <div className="border border-ink border-opacity-15 p-3 bg-paper">
                <h3 className="text-xs font-bold text-ink mb-2 uppercase tracking-wider flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-sm text-brass">person_add</span>
                  Onboard New Client Entity
                </h3>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setClientAddError('');
                    setClientAddSuccess('');

                    // ── Client-side GSTIN validation (instant, no round-trip) ──
                    const gstinErr = validateGstin(newGstin);
                    if (gstinErr) {
                      setClientAddError(gstinErr);
                      return;
                    }

                    setSubmittingClient(true);
                    const { data, error } = await api.addClient(newGstin, newName);
                    setSubmittingClient(false);
                    if (error) {
                      setClientAddError(error);
                    } else {
                      setClientAddSuccess(`Client ${newGstin.trim().toUpperCase()} onboarded successfully!`);
                      setNewGstin('');
                      setNewName('');
                      // Refresh client list in AppDataContext
                      const { data: updatedClients } = await api.getClients();
                      if (updatedClients && setClients) {
                        setClients(updatedClients);
                      }
                    }
                  }}
                  className="space-y-2 text-xs"
                >
                  <div>
                    <label className="label-caps mb-1 block">Client GSTIN *</label>
                    <input
                      type="text"
                      placeholder="e.g. 27AABCU9603R1ZV"
                      value={newGstin}
                      onChange={(e) => setNewGstin(e.target.value.toUpperCase())}
                      maxLength={15}
                      className="input-field font-mono uppercase"
                      required
                    />
                  </div>
                  <div>
                    <label className="label-caps mb-1 block">Display / Company Name (Optional)</label>
                    <input
                      type="text"
                      placeholder="e.g. Acme Logistics Pvt Ltd"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      className="input-field"
                    />
                  </div>

                  {clientAddError && (
                    <div className="text-[11px] text-red-700 font-sans border border-red-700/30 bg-red-50 p-2 rounded flex items-start gap-1.5 leading-relaxed">
                      <span className="material-symbols-outlined text-sm shrink-0 mt-0.5">error</span>
                      <div>
                        <span className="font-semibold block mb-0.5">Onboarding Error</span>
                        <span>{clientAddError}</span>
                      </div>
                    </div>
                  )}

                  {clientAddSuccess && (
                    <div className="text-[11px] text-brass font-sans border border-brass/40 bg-brass/10 p-1.5 flex items-center gap-1">
                      <span className="material-symbols-outlined text-sm shrink-0">check_circle</span>
                      <span>{clientAddSuccess}</span>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={submittingClient || !newGstin.trim()}
                    className="w-full bg-brass text-paper font-semibold text-xs py-1.5 hover:opacity-95 disabled:opacity-50 transition-opacity border border-brass flex items-center justify-center gap-1"
                  >
                    {submittingClient ? 'Validating GSTIN…' : 'Register Client Entity'}
                  </button>
                </form>
              </div>

              <p className="text-[10px] text-ink-45 font-mono uppercase tracking-wider pt-2 border-t border-ink border-opacity-10">
                Registered Client Entities ({clientList.length})
              </p>
              {clientList.length === 0 ? (
                <div className="text-center py-8 text-ink-45 text-xs font-mono">
                  No clients onboarded yet.
                </div>
              ) : (
                <div className="space-y-1 max-h-[220px] overflow-y-auto pr-1">
                  <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-2 py-1 text-[10px] font-semibold text-ink-45 uppercase tracking-wider border-b border-ink border-opacity-10 sticky top-0 bg-paper">
                    <span>Client Entity</span>
                    <span className="text-right">Invoices</span>
                    <span className="text-right">ITC Risk</span>
                  </div>
                  {clientList.map((c, i) => (
                    <div key={i}
                      className={`grid grid-cols-[1fr_auto_auto] gap-2 px-2 py-1.5 text-[11px] ${i % 2 === 0 ? 'bg-ink/[0.03]' : ''}`}>
                      <div className="overflow-hidden">
                        <p className="font-mono text-ink truncate font-semibold">{safeStr(c.client_gstin)}</p>
                        {c.client_name && c.client_name !== c.client_gstin && (
                          <p className="text-[9px] text-ink-45 truncate">{c.client_name}</p>
                        )}
                      </div>
                      <span className="font-mono text-ink-45 text-right self-center">
                      {Number(c.total_invoice_count || 0).toLocaleString('en-IN')}
                      </span>
                      <span className="font-mono text-brass text-right self-center">
                        ₹{Number(c.total_itc_at_risk || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

        </div>

        {/* Panel Footer */}
        <div className="px-5 py-3 border-t border-ink border-opacity-10 shrink-0 text-[10px] text-ink-45 flex items-center justify-between">
          <span>DecisionForge v1.0 · Audit Ledger Portal</span>
          <button type="button" onClick={onClose}
            className="text-ink-45 hover:text-ink underline underline-offset-2">
            Close
          </button>
        </div>
      </aside>
    </div>
  </>
);
}

// ─── Small helper sub-components ─────────────────────────────────────────────
function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="label-caps">{label}</label>
      {children}
    </div>
  );
}

function SaveRow({ status, onSave }) {
  return (
    <div className="flex items-center justify-between pt-2">
      <div className="text-xs">
        {status === 'success' && (
          <span className="text-brass flex items-center gap-1">
            <span className="material-symbols-outlined text-sm">check_circle</span>
            Saved successfully
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onSave}
        className="bg-brass text-paper hover:opacity-95 font-sans font-semibold text-xs px-4 py-2 border border-brass"
      >
        SAVE
      </button>
    </div>
  );
}

/**
 * PreviewOnlyNotice
 * Replaces the Save button for tabs whose settings are not yet wired to live
 * backend logic (Thresholds, Integrations). Avoids the false "Saved successfully"
 * confirmation that previously fired without persisting anything.
 */
function PreviewOnlyNotice({ label }) {
  return (
    <div className="flex items-start gap-2 border border-ink border-opacity-15 bg-ink/[0.03] p-2.5 mt-2">
      <span className="material-symbols-outlined text-sm text-ink-45 shrink-0 mt-[1px]">info</span>
      <p className="text-[10px] text-ink-45 font-sans leading-relaxed">
        <span className="font-semibold text-ink-60">{label}:</span> Preview only — not yet connected
        to live scoring. Changes made here are not persisted and will not affect risk
        classification or BigQuery queries.
      </p>
    </div>
  );
}

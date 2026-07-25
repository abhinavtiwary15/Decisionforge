import React, { useState, useEffect, useRef } from 'react';
import { api, safeStr, safeFloat } from '../api';

export default function InvoiceDetail({ selectedInvoice, setCurrentPage, defaultDraftType, onDraftTypeConsumed }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Communication draft states
  const [draftType, setDraftType] = useState(null); // 'vendor' or 'client'
  const [lang, setLang] = useState('en');          // 'en' or 'hi'
  const [draftText, setDraftText] = useState('');
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState(null);
  const [copied, setCopied] = useState(false);

  // Ref to Communication Drafting Center — used to scroll into view from action buttons
  const cdcRef = useRef(null);

  const fetchDraft = async (type, language) => {
    if (!type) return;
    setDraftLoading(true);
    setDraftError(null);

    const invNum = safeStr(detail?.invoice_number || selectedInvoice?.invoice_number);
    const vendorGstinVal = safeStr(detail?.vendor_gstin || selectedInvoice?.vendor_gstin);

    try {
      const { data, error: err } = await api.getCommunicationDraft(invNum, vendorGstinVal, type, language);
      if (err) {
        setDraftError(safeStr(err));
      } else if (data && data.draft) {
        setDraftText(typeof data.draft === 'string' ? data.draft : safeStr(data.draft));
      } else {
        setDraftError('Failed to retrieve draft content from server.');
      }
    } catch (err) {
      setDraftError(safeStr(err?.message || 'Network error occurred while fetching draft.'));
    } finally {
      setDraftLoading(false);
    }
  };

  const handleSelectDraftType = (type) => {
    setDraftType(type);
    fetchDraft(type, lang);
  };

  const handleToggleLang = (newLang) => {
    setLang(newLang);
    if (draftType) {
      fetchDraft(draftType, newLang);
    }
  };

  const handleCopyToClipboard = () => {
    navigator.clipboard.writeText(draftText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /**
   * Triggered by action-panel buttons ("Draft Non-Compliance Notice",
   * "Escalate to Client Relationship Team"). Selects the draft type and
   * smoothly scrolls the Communication Drafting Center into view so the
   * user can see the generated draft without manually scrolling.
   */
  const handleQuickDraft = (type) => {
    handleSelectDraftType(type);
    // Slight delay so the CDC has rendered its loading state before we scroll
    setTimeout(() => cdcRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  };

  // When navigated from MismatchDetection with a pre-selected draft type
  // (e.g. Escalate Discrepancy → client draft), auto-trigger after data loads.
  useEffect(() => {
    if (defaultDraftType && !loading && detail) {
      handleSelectDraftType(defaultDraftType);
      onDraftTypeConsumed?.();
      setTimeout(() => cdcRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultDraftType, loading, detail]);

  useEffect(() => {
    async function fetchDetail() {
      if (!selectedInvoice?.invoice_number || !selectedInvoice?.vendor_gstin) {
        setDetail(null);
        setError('No invoice selected — return to the Ledger');
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      const invNum     = selectedInvoice.invoice_number;
      const vendorGstin= selectedInvoice.vendor_gstin;

      const { data, error: err } = await api.getReconciliationDetail(invNum, vendorGstin);
      if (err) {
        setError(err);
      } else {
        setDetail(data);
      }
      setLoading(false);
    }
    fetchDetail();
  }, [selectedInvoice]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <span className="font-mono text-ink text-sm">RETRIEVING COMPARATIVE LEDGERS...</span>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="bg-paper p-6 border border-ink border-opacity-15 font-sans">
        <h2 className="section-header">Invoice Record Not Found</h2>
        <p className="text-sm text-ink-70 mt-2">
          Unable to locate reconciliation matches for the requested invoice.
          {error && <span className="block mt-1 font-mono text-xs text-vermillion">{error}</span>}
        </p>
        <button type="button" onClick={() => setCurrentPage('ledger')}
          className="mt-4 bg-brass text-paper px-4 py-2 text-xs font-semibold">
          Return to Ledger
        </button>
      </div>
    );
  }

  // Safely coerce all values before any arithmetic
  const prTaxableValue   = safeFloat(detail.pr_taxable_value);
  const bTaxableValue    = safeFloat(detail.b_taxable_value);
  const prCgst           = safeFloat(detail.pr_cgst);
  const bCgst            = safeFloat(detail.b_cgst);
  const prSgst           = safeFloat(detail.pr_sgst);
  const bSgst            = safeFloat(detail.b_sgst);
  const prIgst           = safeFloat(detail.pr_igst);
  const bIgst            = safeFloat(detail.b_igst);
  const prTotalItc       = safeFloat(detail.pr_total_itc_claimed);
  const bItcAvailable    = safeFloat(detail.b_itc_available);
  const itcAtRisk        = safeFloat(detail.itc_at_risk);
  const invoiceNumber    = safeStr(detail.invoice_number);
  const vendorName       = safeStr(detail.vendor_name) || 'UNKNOWN';
  const vendorGstin      = safeStr(detail.vendor_gstin);
  const riskLabel        = safeStr(detail.risk_label);
  const mismatchType     = safeStr(detail.mismatch_type);
  const filingPeriod     = safeStr(detail.filing_period) || 'N/A';
  const prInvoiceDate    = safeStr(detail.pr_invoice_date) || safeStr(detail.invoice_date) || '';
  const explanation      = safeStr(detail.explanation);

  const taxableDiff = Math.abs(prTaxableValue - bTaxableValue);
  const isTaxableMismatch = taxableDiff > 100 && detail.pr_taxable_value !== null && detail.b_taxable_value !== null;

  const prTax = prCgst + prSgst + prIgst;
  const bTax  = bCgst  + bSgst  + bIgst;
  const taxDiff = Math.abs(prTax - bTax);
  const isTaxMismatch = taxDiff > 100 && prTax > 0 && bTax > 0;

  const isMissingIn2B      = mismatchType === 'MISSING_IN_2B';
  const isMissingInRegister= mismatchType === 'MISSING_IN_REGISTER';

  return (
    <div className="space-y-6 font-sans relative">
      <div className="flex justify-between items-end border-b border-ink border-opacity-10 pb-4">
        <div>
          <h1 className="page-title">Invoice Audit Analysis</h1>
          <p className="body-secondary mt-1">
            Row-level ledger audit: Purchase Register comparison against GSTR-2B.
          </p>
        </div>
        <div className="flex gap-3">
          <button type="button" onClick={() => setCurrentPage('ledger')}
            className="border border-ink border-opacity-50 text-ink btn-outline-hover font-sans text-xs px-4 py-2">
            BACK TO LEDGER
          </button>
          <button type="button" onClick={() => window.print()}
            className="border border-ink border-opacity-50 text-ink btn-outline-hover font-sans text-xs px-4 py-2">
            PRINT RECORD
          </button>
        </div>
      </div>

      <div className="relative bg-paper p-6 border border-ink border-opacity-15 min-h-[380px] overflow-hidden">
        {/* Vermillion rubber stamp */}
        <div className="absolute top-12 left-1/2 -translate-x-1/2 md:translate-x-0 md:left-2/3 z-20 pointer-events-none select-none">
          <div className="border-4 border-double border-vermillion text-vermillion px-6 py-2 rounded-sm font-fraunces text-base font-bold tracking-widest uppercase text-center bg-paper rotate-[-12deg] shadow-none opacity-85">
            {mismatchType.replace(/_/g, ' ')}
            <div className="text-[10px] font-mono mt-0.5 tracking-normal normal-case font-medium">
              Audit Scored • {new Date().toLocaleDateString('en-IN')}
            </div>
          </div>
        </div>

        {/* Info Header */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 border-b border-ink border-opacity-10 pb-4 mb-6">
          <div>
            <p className="label-caps">Invoice Number</p>
            <p className="font-mono text-sm font-bold text-ink">{invoiceNumber}</p>
          </div>
          <div>
            <p className="label-caps">Vendor Name / GSTIN</p>
            <p className="font-sans text-xs font-bold text-ink truncate">{vendorName}</p>
            <p className="font-mono text-[11px] text-ink-65">{vendorGstin}</p>
          </div>
          <div>
            <p className="label-caps">Risk Rating</p>
            <span className={`inline-block font-mono text-xs font-bold px-2 py-0.5 mt-1 border ${
              riskLabel === 'CRITICAL' || riskLabel === 'HIGH'
                ? 'border-vermillion text-vermillion bg-vermillion-5'
                : riskLabel === 'MEDIUM'
                  ? 'border-brass text-brass bg-brass-5'
                  : 'border-ink border-opacity-30 text-ink-60'
            }`}>
              {riskLabel}
            </span>
          </div>
        </div>

        {/* Side-by-side Ledger columns */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 relative z-10">
          {/* Purchase Register */}
          <div className="space-y-4 border-r border-ink border-opacity-10 pr-0 md:pr-8">
            <h3 className="section-header border-b border-ink border-opacity-15 pb-1 flex items-center justify-between">
              <span>Purchase Register (Claimed)</span>
              <span className="material-symbols-outlined text-sm text-ink-60">fact_check</span>
            </h3>
            {!isMissingInRegister ? (
              <div className="space-y-3 font-sans text-xs">
                <div className="flex justify-between">
                  <span className="text-ink-65">Invoice Date</span>
                  <span className="font-mono">{prInvoiceDate}</span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-5 pt-2">
                  <span className="text-ink-65">Taxable Value</span>
                  <span className={`font-mono font-semibold ${isTaxableMismatch ? 'text-vermillion bg-vermillion-5 font-bold px-1' : ''}`}>
                    ₹{prTaxableValue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-5 pt-2">
                  <span className="text-ink-65">CGST Claimed</span>
                  <span className="font-mono">₹{prCgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-5 pt-2">
                  <span className="text-ink-65">SGST Claimed</span>
                  <span className="font-mono">₹{prSgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-5 pt-2">
                  <span className="text-ink-65">IGST Claimed</span>
                  <span className="font-mono">₹{prIgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-15 pt-2 text-sm">
                  <span className="font-semibold text-ink">Total ITC Claimed</span>
                  <span className={`font-mono font-bold text-brass ${isTaxMismatch ? 'text-vermillion bg-vermillion-5 px-1' : ''}`}>
                    ₹{prTotalItc.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-48 border border-dashed border-ink border-opacity-15 bg-ink-5">
                <p className="text-xs text-ink-55 italic font-sans">No claimed entry in Purchase Register</p>
              </div>
            )}
          </div>

          {/* GSTR-2B */}
          <div className="space-y-4">
            <h3 className="section-header border-b border-ink border-opacity-15 pb-1 flex items-center justify-between">
              <span>GSTR-2B Filing (Available)</span>
              <span className="material-symbols-outlined text-sm text-ink-60">account_balance</span>
            </h3>
            {!isMissingIn2B ? (
              <div className="space-y-3 font-sans text-xs">
                <div className="flex justify-between">
                  <span className="text-ink-65">Filing Period</span>
                  <span className="font-mono font-bold text-brass">{filingPeriod}</span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-5 pt-2">
                  <span className="text-ink-65">Taxable Value Reported</span>
                  <span className={`font-mono font-semibold ${isTaxableMismatch ? 'text-vermillion bg-vermillion-5 font-bold px-1' : ''}`}>
                    ₹{bTaxableValue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-5 pt-2">
                  <span className="text-ink-65">CGST Available</span>
                  <span className="font-mono">₹{bCgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-5 pt-2">
                  <span className="text-ink-65">SGST Available</span>
                  <span className="font-mono">₹{bSgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-5 pt-2">
                  <span className="text-ink-65">IGST Available</span>
                  <span className="font-mono">₹{bIgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-15 pt-2 text-sm">
                  <span className="font-semibold text-ink">Total ITC Available</span>
                  <span className={`font-mono font-bold text-brass ${isTaxMismatch ? 'text-vermillion bg-vermillion-5 px-1' : ''}`}>
                    ₹{bItcAvailable.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-48 border border-dashed border-vermillion border-opacity-25 bg-vermillion-5">
                <p className="text-xs text-vermillion italic font-sans font-medium text-center px-4">
                  No corresponding entry filed by vendor on the GST portal
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Conflict Analysis & Actions Panel */}
      <div className="bg-paper p-6 border border-ink border-opacity-15">
        <h2 className="section-header mb-2">Auditor Conflict Analysis</h2>
        <div className="bg-ink-5 p-4 border border-ink border-opacity-10 text-xs text-ink space-y-2 font-sans">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold">Discrepancy Explanation:</span>
              <span className="flex items-center gap-1 text-[9px] font-normal rounded-full ink-chip">
                <span className="material-symbols-outlined text-[10px]">auto_awesome</span>
                AI-grounded
              </span>
            </div>
            <span className="leading-relaxed">{explanation}</span>
          </div>
          <div className="flex gap-2 border-t border-ink border-opacity-10 pt-2 mt-2">
            <span className="font-semibold">Financial Impact:</span>
            <span className="font-mono text-vermillion font-bold tabular-nums">
              ₹{itcAtRisk.toLocaleString('en-IN', { minimumFractionDigits: 2 })} claimed ITC is at risk of disallowance.
            </span>
          </div>
          <div className="flex gap-2 border-t border-ink border-opacity-10 pt-2 mt-2">
            <span className="font-semibold">Discrepancy Resolution Protocol:</span>
            <span className="italic">
              {isMissingIn2B && "Generate automated non-compliance email notifying the vendor of missing portal filings, requesting immediate GSTR-1 amendment."}
              {isTaxMismatch && "Issue debit note or demand ledger reconciliation correction to vendor for amount differences exceeding the standard Rs.100 tolerance."}
              {mismatchType === 'TIMING_DIFFERENCE' && "Defer claiming ITC to next month corresponding to GSTR-2B filing period; verify that the supplier has paid appropriate tax."}
              {mismatchType === 'DUPLICATE_CLAIM' && "Flag invoice for removal or reversal in next GST return filing; duplicate claim detected."}
              {mismatchType === 'CLEAN_MATCH' && "No correction needed. Clean match, verified for claims."}
            </span>
          </div>
        </div>
        <div className="flex gap-4 mt-6 justify-end">
          {/* Triggers the "Draft Client Explanation" in the CDC below — honest
              representation of escalating: draft the communication for your client. */}
          <button type="button" onClick={() => handleQuickDraft('client')}
            className="border border-ink border-opacity-50 text-ink btn-outline-hover font-sans font-semibold text-xs px-4 py-2">
            Escalate to Client Relationship Team
          </button>
          {/* Triggers the "Draft Vendor Follow-Up" in the CDC below — a vendor
              non-compliance notice IS a vendor follow-up draft. */}
          <button type="button" onClick={() => handleQuickDraft('vendor')}
            className="bg-brass text-paper hover:opacity-95 font-sans font-semibold text-xs px-4 py-2 border border-brass">
            Draft Non-Compliance Notice
          </button>
        </div>
      </div>

      {/* Communication Drafting Center — ref'd so action buttons above can scroll here */}
      <div ref={cdcRef} className="bg-paper p-6 border border-ink border-opacity-15 mt-6">
        <h2 className="section-header mb-2">Communication Drafting Center</h2>
        <p className="body-secondary mb-4">
          Firm assist: Draft professional follow-ups to suppliers or plain-language summaries for your client.
        </p>

        <div className="flex flex-wrap items-center gap-4 border-b border-ink border-opacity-10 pb-4 mb-4">
          <button
            type="button"
            onClick={() => handleSelectDraftType('vendor')}
            className={`font-sans font-semibold text-xs px-4 py-2 border transition-colors ${
              draftType === 'vendor'
                ? 'bg-brass text-paper border-brass'
                : 'border-ink border-opacity-35 text-ink btn-outline-hover'
            }`}
          >
            Draft Vendor Follow-Up
          </button>
          <button
            type="button"
            onClick={() => handleSelectDraftType('client')}
            className={`font-sans font-semibold text-xs px-4 py-2 border transition-colors ${
              draftType === 'client'
                ? 'bg-brass text-paper border-brass'
                : 'border-ink border-opacity-35 text-ink btn-outline-hover'
            }`}
          >
            Draft Client Explanation
          </button>

          {/* Language Toggle */}
          <div className="flex items-center gap-1 p-0.5 rounded ml-auto ink-toggle-bar">
            <button
              type="button"
              onClick={() => handleToggleLang('en')}
              className={`text-[10px] font-sans font-bold px-2.5 py-1 rounded transition-all ${
                lang === 'en' ? 'bg-paper text-ink shadow-sm' : 'text-ink-65 hover:text-ink'
              }`}
            >
              ENGLISH
            </button>
            <button
              type="button"
              onClick={() => handleToggleLang('hi')}
              className={`text-[10px] font-sans font-bold px-2.5 py-1 rounded transition-all ${
                lang === 'hi' ? 'bg-paper text-ink shadow-sm' : 'text-ink-65 hover:text-ink'
              }`}
            >
              हिन्दी (HINDI)
            </button>
          </div>
        </div>

        {/* Draft Output Pane */}
        {draftType ? (
          <div className="space-y-4">
            {draftLoading ? (
              <div className="flex items-center justify-center py-12 bg-ink-5 border border-ink border-opacity-10">
                <span className="font-mono text-ink text-xs animate-pulse">GENERATING DRAFT COMM...</span>
              </div>
            ) : draftError ? (
              <div className="bg-vermillion-5 p-4 border border-vermillion border-opacity-25 flex justify-between items-center text-xs text-vermillion font-mono">
                <div>
                  <span className="font-bold">Draft Generation Error:</span> {safeStr(draftError)}
                </div>
                <button
                  type="button"
                  onClick={() => fetchDraft(draftType, lang)}
                  className="bg-vermillion text-paper px-3 py-1 font-sans font-semibold text-xs hover:opacity-90 transition-opacity ml-4 shrink-0"
                >
                  Retry
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="flex items-center gap-1.5 text-[10px] text-ink-50 font-sans">
                    <span className="material-symbols-outlined text-[12px] text-brass">auto_awesome</span>
                    AI-generated grounded draft — Editable
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyToClipboard}
                    className="flex items-center gap-1 text-[10px] text-brass hover:opacity-80 font-sans font-bold uppercase tracking-wider transition-opacity"
                  >
                    <span className="material-symbols-outlined text-xs">content_copy</span>
                    {copied ? 'Copied!' : 'Copy to Clipboard'}
                  </button>
                </div>
                <textarea
                  value={draftText}
                  onChange={(e) => setDraftText(e.target.value)}
                  rows={8}
                  className="w-full p-4 border border-ink border-opacity-20 font-mono text-xs text-ink bg-paper focus:outline-none focus:border-brass leading-relaxed"
                  placeholder="Draft content goes here..."
                />
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 border border-dashed border-ink border-opacity-15 bg-ink-5 rounded">
            <span className="material-symbols-outlined text-ink-35 text-2xl mb-2">chat_bubble_outline</span>
            <p className="text-xs text-ink-55 italic font-sans">
              Select draft option above to auto-generate communication follow-up.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

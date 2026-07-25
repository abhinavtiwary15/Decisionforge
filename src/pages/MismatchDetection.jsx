import React, { useState, useEffect } from 'react';
import { api, safeStr, safeFloat } from '../api';
import { useAppData } from '../AppDataContext';
import { SkeletonCard } from '../components/Skeleton';

export default function MismatchDetection({ setCurrentPage, setSelectedInvoice, setDefaultDraftType }) {
  const contextData = useAppData();

  const [queue, setQueue] = useState(
    contextData?.mismatchRecon?.data ? contextData.mismatchRecon.data : []
  );
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(!contextData?.prefetchDone);
  const [fetchError, setFetchError] = useState(null);
  const [auditedCount, setAuditedCount] = useState(0);
  // Tracks invoices accepted this session — shown as "Already Reviewed" if navigated back
  const [acceptedInvoices, setAcceptedInvoices] = useState(new Set());
  // Set to the accepted invoice_number for 1.5s to show inline confirmation banner
  const [acceptBanner, setAcceptBanner] = useState(null);
  // In-flight guard: true while the 1.5s accept animation + advanceQueue is running.
  // Prevents double-click from duplicating the review count or skipping two cases.
  const [acceptInFlight, setAcceptInFlight] = useState(false);

  useEffect(() => {
    if (contextData?.prefetchDone && contextData?.mismatchRecon) {
      setQueue(contextData.mismatchRecon.data || []);
      setLoading(false);
      return;
    }

    async function fetchQueue() {
      setLoading(true);
      const { data, error } = await api.getReconciliation({ limit: 500, exclude_clean: true });
      if (error) {
        setFetchError(error);
      } else {
        setQueue(data?.data || []);
      }
      setLoading(false);
    }
    fetchQueue();
  }, [contextData]);

  const advanceQueue = () => {
    if (currentIndex < queue.length - 1) {
      setCurrentIndex(prev => prev + 1);
    } else {
      alert("All queued mismatches reviewed! Refreshing queue...");
      setCurrentIndex(0);
      setAuditedCount(0);
    }
  };

  const handleAccept = () => {
    if (acceptInFlight) return; // ignore duplicate clicks while action is in-flight
    setAcceptInFlight(true);
    const invNum = safeStr(currentCase.invoice_number);
    // Mark as reviewed in local session state
    setAcceptedInvoices(prev => { const next = new Set(prev); next.add(invNum); return next; });
    setAuditedCount(prev => prev + 1);
    // Show inline confirmation banner for 1.5s then advance queue
    setAcceptBanner(invNum);
    setTimeout(() => {
      setAcceptBanner(null);
      advanceQueue();
      setAcceptInFlight(false);
    }, 1500);
  };

  const handleEscalate = () => {
    // Navigate to InvoiceDetail for this case with the client draft pre-triggered.
    // The CA sees the Communication Drafting Center open to "Draft Client Explanation"
    // — that IS the honest escalation action: document the issue for your client.
    setSelectedInvoice({ invoice_number: invoiceNumber, vendor_gstin: vendorGstin });
    setDefaultDraftType('client');
    setCurrentPage('invoice');
    setAuditedCount(prev => prev + 1);
  };

  if (loading) {
    return (
      <div className="space-y-6 font-sans max-w-3xl mx-auto">
        <div className="flex justify-between items-end border-b border-ink border-opacity-10 pb-4">
          <div>
            <h1 className="page-title opacity-25">Mismatch Detection &amp; Review</h1>
            <p className="body-secondary mt-1">Single-case manual reconciliation queue...</p>
          </div>
        </div>
        <SkeletonCard height={300} />
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="bg-paper p-6 border border-vermillion border-opacity-30 font-sans">
        <h2 className="section-header">Queue Unavailable</h2>
        <p className="text-xs text-vermillion font-mono mt-2">{fetchError}</p>
        <button type="button" onClick={() => window.location.reload()}
          className="mt-4 bg-brass text-paper px-4 py-2 text-xs font-semibold">Retry</button>
      </div>
    );
  }

  if (queue.length === 0) {
    return (
      <div className="bg-paper p-6 border border-ink border-opacity-15 text-center font-sans">
        <h2 className="section-header">Queue Clear</h2>
        <p className="text-xs text-ink-70 mt-2">No pending mismatch cases found requiring manual review.</p>
      </div>
    );
  }

  const currentCase = queue[currentIndex];
  const invoiceNumber = safeStr(currentCase.invoice_number);
  const vendorName    = safeStr(currentCase.vendor_name);
  const vendorGstin   = safeStr(currentCase.vendor_gstin);
  const clientGstin   = safeStr(currentCase.client_gstin);
  const mismatchType  = safeStr(currentCase.mismatch_type);
  const explanationTxt= safeStr(currentCase.explanation);
  const invoiceDate   = safeStr(currentCase.pr_invoice_date) || safeStr(currentCase.invoice_date);
  const prTax         = safeFloat(currentCase.pr_total_itc_claimed);
  const bTax          = safeFloat(currentCase.b_itc_available);
  const itcAtRisk     = safeFloat(currentCase.itc_at_risk);
  const taxDifference = Math.abs(prTax - bTax);

  return (
    <div className="space-y-6 font-sans max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex justify-between items-end border-b border-ink border-opacity-10 pb-4">
        <div>
          <h1 className="page-title">Mismatch Detection &amp; Review</h1>
          <p className="body-secondary mt-1">
            Single-case manual reconciliation queue. Review supplier filings and take inline action.
          </p>
        </div>
        <div className="font-mono text-xs text-ink-70">
          Reviewed: <span className="font-bold text-brass">{auditedCount}</span> / Session
        </div>
      </div>

      {/* Progress Timeline */}
      <div className="bg-paper p-3 border border-ink border-opacity-10 space-y-1">
        <div className="flex justify-between items-center text-xs font-mono text-ink-75">
          <div>
            Case <span className="font-bold text-brass">{currentIndex + 1}</span> of <span className="font-bold">{queue.length}</span>
          </div>
          <div className="flex gap-4">
            <button type="button" disabled={currentIndex === 0} onClick={() => setCurrentIndex(prev => prev - 1)}
              className={`flex items-center gap-1 ${currentIndex === 0 ? 'opacity-35 cursor-not-allowed' : 'hover:text-brass'}`}>
              <span className="material-symbols-outlined text-sm">arrow_back</span> Prev Case
            </button>
            <button type="button" disabled={currentIndex === queue.length - 1} onClick={() => setCurrentIndex(prev => prev + 1)}
              className={`flex items-center gap-1 ${currentIndex === queue.length - 1 ? 'opacity-35 cursor-not-allowed' : 'hover:text-brass'}`}>
              Next Case <span className="material-symbols-outlined text-sm">arrow_forward</span>
            </button>
          </div>
        </div>
        <p className="text-[10px] font-sans text-ink-45 leading-tight">
          Showing top {queue.length} highest-priority cases (sorted by risk). Full queue available via <button type="button" onClick={() => setCurrentPage('ledger')} className="underline hover:text-ink">GST Reconciliation Ledger</button>.
        </p>
      </div>

      {/* Hero Audit Card */}
      <div className="bg-paper border border-ink border-opacity-15 p-6 space-y-6 relative">
        <div className="flex justify-between items-start">
          <div>
            <span className="text-[9px] uppercase font-mono font-bold px-1.5 py-0.5 border border-vermillion text-vermillion bg-vermillion-5">
              {mismatchType.replace(/_/g, ' ')}
            </span>
            <h2 className="font-mono text-base font-bold text-ink mt-2">{invoiceNumber}</h2>
          </div>
          <div className="text-right">
            <p className="label-caps">ITC At Risk</p>
            <p className="font-mono text-lg font-bold text-vermillion tabular-nums">
              ₹{itcAtRisk.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </p>
          </div>
        </div>

        {/* Audit Details */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-paper p-4 border border-ink border-opacity-10 text-xs">
          <div className="space-y-2">
            <p className="border-b border-ink border-opacity-10 pb-1 label-caps">Supplier Information</p>
            <div className="flex justify-between">
              <span className="text-ink-65">Vendor Name</span>
              <span className="font-semibold text-ink truncate max-w-[150px]">{vendorName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-65">Vendor GSTIN</span>
              <span className="font-mono">{vendorGstin}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-65">Client GSTIN</span>
              <span className="font-mono text-ink-80">{clientGstin}</span>
            </div>
          </div>
          <div className="space-y-2">
            <p className="border-b border-ink border-opacity-10 pb-1 label-caps">Ledger Discrepancy</p>
            <div className="flex justify-between">
              <span className="text-ink-65">Invoice Date</span>
              <span className="font-mono">{invoiceDate}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-65">PR Claimed Tax</span>
              <span className="font-mono">₹{prTax.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-65">GSTR-2B Filed Tax</span>
              <span className="font-mono">
                {mismatchType === 'MISSING_IN_2B' ? 'Not Filed' : `₹${bTax.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`}
              </span>
            </div>
            {taxDifference > 0 && (
              <div className="flex justify-between border-t border-ink border-opacity-10 pt-1 text-vermillion font-semibold">
                <span>Tax Discrepancy</span>
                <span className="font-mono font-bold">₹{taxDifference.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>
            )}
          </div>
        </div>

        {/* Narrative */}
        <div className="bg-vermillion-5 p-4 border border-vermillion border-opacity-20">
          <p className="label-caps text-vermillion! flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm">gavel</span>
            RECONCILIATION DISCREPANCY ANALYSIS
            <span className="ml-auto flex items-center gap-1 text-[9px] font-sans font-normal rounded-full ink-chip">
              <span className="material-symbols-outlined text-[10px]">auto_awesome</span>
              AI-grounded analysis
            </span>
          </p>
          <p className="text-xs text-ink mt-2 leading-relaxed font-sans">{explanationTxt}</p>
          <p className="text-[10px] text-ink-65 mt-2 font-sans italic">
            Recommended Action: Verify physical invoice documents and contact the vendor's billing division
            to check why this transaction was not reported in their GSTR-1 for the corresponding period.
          </p>
          <p className="text-[9px] text-ink-35 mt-1.5 font-sans">
            Analysis generated by Gemini — grounded strictly on invoice facts above. No speculation.
          </p>
        </div>


        {/* Actions */}
        <div className="flex justify-between items-center pt-2 border-t border-ink border-opacity-10">
          <button
            type="button"
            onClick={() => { setSelectedInvoice({ invoice_number: invoiceNumber, vendor_gstin: vendorGstin }); setCurrentPage('invoice'); }}
            className="text-xs font-sans text-brass hover:underline flex items-center gap-1">
            <span className="material-symbols-outlined text-sm">zoom_in</span> Compare Ledgers Side-by-Side
          </button>

          {/* Action area — shows confirmation banner while accepting, reviewed state if navigated back */}
          {acceptBanner === invoiceNumber ? (
            <div className="flex items-center gap-2 px-4 py-2 bg-ink-5 border border-ink border-opacity-20 text-xs font-sans text-ink font-semibold">
              <span className="material-symbols-outlined text-sm text-brass">check_circle</span>
              Marked as Reviewed — advancing…
            </div>
          ) : acceptedInvoices.has(invoiceNumber) ? (
            <div className="flex items-center gap-2 px-4 py-2 border border-ink border-opacity-15 text-xs font-sans text-ink-55 font-semibold">
              <span className="material-symbols-outlined text-sm text-ink-35">check_circle</span>
              Already Reviewed This Session
            </div>
          ) : (
            <div className="flex gap-3">
              <button type="button" onClick={handleEscalate}
                className="border border-ink text-ink btn-outline-hover font-sans font-semibold text-xs px-4 py-2">
                Escalate Discrepancy
              </button>
              <button type="button" onClick={handleAccept}
                disabled={acceptInFlight}
                className="bg-brass text-paper hover:opacity-95 font-sans font-semibold text-xs px-4 py-2 border border-brass disabled:opacity-50 disabled:cursor-not-allowed transition-opacity">
                Accept Ledger Entry
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

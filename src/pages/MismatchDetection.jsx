import React, { useState, useEffect } from 'react';
import { api, safeStr, safeFloat } from '../api';
import { useAppData } from '../AppDataContext';
import { SkeletonCard } from '../components/Skeleton';

export default function MismatchDetection({ setCurrentPage, setSelectedInvoice }) {
  const contextData = useAppData();

  const [queue, setQueue] = useState(
    contextData?.mismatchRecon?.data ? contextData.mismatchRecon.data.filter(item => item.mismatch_type !== 'CLEAN_MATCH') : []
  );
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(!contextData?.prefetchDone);
  const [fetchError, setFetchError] = useState(null);
  const [auditedCount, setAuditedCount] = useState(0);

  useEffect(() => {
    if (contextData?.prefetchDone && contextData?.mismatchRecon) {
      const mismatches = (contextData.mismatchRecon.data || []).filter(item => item.mismatch_type !== 'CLEAN_MATCH');
      setQueue(mismatches);
      setLoading(false);
      return;
    }

    async function fetchQueue() {
      setLoading(true);
      const { data, error } = await api.getReconciliation({ limit: 20 });
      if (error) {
        setFetchError(error);
      } else {
        const mismatches = (data?.data || []).filter(item => item.mismatch_type !== 'CLEAN_MATCH');
        setQueue(mismatches);
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
    alert(`Accepted Ledger Entry for Invoice ${safeStr(currentCase.invoice_number)}. Amending reconciliation record...`);
    setAuditedCount(prev => prev + 1);
    advanceQueue();
  };

  const handleEscalate = () => {
    alert(`Escalated Invoice ${safeStr(currentCase.invoice_number)} to Vendor Management Queue.`);
    setAuditedCount(prev => prev + 1);
    advanceQueue();
  };

  if (loading) {
    return (
      <div className="space-y-6 font-sans max-w-3xl mx-auto">
        <div className="flex justify-between items-end border-b border-ink border-opacity-10 pb-4">
          <div>
            <h1 className="font-fraunces text-2xl font-bold text-ink opacity-25">Mismatch Detection &amp; Review</h1>
            <p className="font-sans text-xs text-ink text-opacity-45 mt-1">Single-case manual reconciliation queue...</p>
          </div>
        </div>
        <SkeletonCard height={300} />
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="bg-paper p-6 border border-vermillion border-opacity-30 font-sans">
        <h2 className="font-fraunces text-lg font-bold text-ink">Queue Unavailable</h2>
        <p className="text-xs text-vermillion font-mono mt-2">{fetchError}</p>
        <button onClick={() => window.location.reload()}
          className="mt-4 bg-brass text-paper px-4 py-2 text-xs font-semibold">Retry</button>
      </div>
    );
  }

  if (queue.length === 0) {
    return (
      <div className="bg-paper p-6 border border-ink border-opacity-15 text-center font-sans">
        <h2 className="font-fraunces text-lg font-bold text-ink">Queue Clear</h2>
        <p className="text-xs text-ink text-opacity-70 mt-2">No pending mismatch cases found requiring manual review.</p>
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
          <h1 className="font-fraunces text-2xl font-bold text-ink">Mismatch Detection &amp; Review</h1>
          <p className="font-sans text-xs text-ink text-opacity-60 mt-1">
            Single-case manual reconciliation queue. Review supplier filings and take inline action.
          </p>
        </div>
        <div className="font-mono text-xs text-ink text-opacity-70">
          Reviewed: <span className="font-bold text-brass">{auditedCount}</span> / Session
        </div>
      </div>

      {/* Progress Timeline */}
      <div className="flex justify-between items-center text-xs font-mono text-ink text-opacity-75 bg-paper p-3 border border-ink border-opacity-10">
        <div>
          Case <span className="font-bold text-brass">{currentIndex + 1}</span> of <span className="font-bold">{queue.length}</span>
        </div>
        <div className="flex gap-4">
          <button disabled={currentIndex === 0} onClick={() => setCurrentIndex(prev => prev - 1)}
            className={`flex items-center gap-1 ${currentIndex === 0 ? 'opacity-35 cursor-not-allowed' : 'hover:text-brass'}`}>
            <span className="material-symbols-outlined text-sm">arrow_back</span> Prev Case
          </button>
          <button disabled={currentIndex === queue.length - 1} onClick={() => setCurrentIndex(prev => prev + 1)}
            className={`flex items-center gap-1 ${currentIndex === queue.length - 1 ? 'opacity-35 cursor-not-allowed' : 'hover:text-brass'}`}>
            Next Case <span className="material-symbols-outlined text-sm">arrow_forward</span>
          </button>
        </div>
      </div>

      {/* Hero Audit Card */}
      <div className="bg-paper border border-ink border-opacity-15 p-6 space-y-6 relative">
        <div className="flex justify-between items-start">
          <div>
            <span className="text-[9px] uppercase font-mono font-bold px-1.5 py-0.5 border border-vermillion text-vermillion bg-vermillion bg-opacity-5">
              {mismatchType.replace(/_/g, ' ')}
            </span>
            <h2 className="font-mono text-base font-bold text-ink mt-2">{invoiceNumber}</h2>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase font-semibold text-ink text-opacity-55">ITC At Risk</p>
            <p className="font-mono text-lg font-bold text-vermillion tabular-nums">
              ₹{itcAtRisk.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </p>
          </div>
        </div>

        {/* Audit Details */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-paper p-4 border border-ink border-opacity-10 text-xs">
          <div className="space-y-2">
            <p className="border-b border-ink border-opacity-10 pb-1 font-fraunces text-xs font-bold">Supplier Information</p>
            <div className="flex justify-between">
              <span className="text-ink text-opacity-65">Vendor Name</span>
              <span className="font-semibold text-ink truncate max-w-[150px]">{vendorName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink text-opacity-65">Vendor GSTIN</span>
              <span className="font-mono">{vendorGstin}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink text-opacity-65">Client GSTIN</span>
              <span className="font-mono text-ink text-opacity-80">{clientGstin}</span>
            </div>
          </div>
          <div className="space-y-2">
            <p className="border-b border-ink border-opacity-10 pb-1 font-fraunces text-xs font-bold">Ledger Discrepancy</p>
            <div className="flex justify-between">
              <span className="text-ink text-opacity-65">Invoice Date</span>
              <span className="font-mono">{invoiceDate}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink text-opacity-65">PR Claimed Tax</span>
              <span className="font-mono">₹{prTax.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink text-opacity-65">GSTR-2B Filed Tax</span>
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
        <div className="bg-vermillion bg-opacity-5 p-4 border border-vermillion border-opacity-20">
          <p className="font-fraunces text-xs font-bold text-vermillion flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm">gavel</span>
            RECONCILIATION DISCREPANCY ANALYSIS
          </p>
          <p className="text-xs text-ink mt-2 leading-relaxed font-sans">{explanationTxt}</p>
          <p className="text-[10px] text-ink text-opacity-65 mt-2 font-sans italic">
            Recommended Action: Verify physical invoice documents and contact the vendor's billing division
            to check why this transaction was not reported in their GSTR-1 for the corresponding period.
          </p>
        </div>

        {/* Actions */}
        <div className="flex justify-between items-center pt-2 border-t border-ink border-opacity-10">
          <button
            onClick={() => { setSelectedInvoice({ invoice_number: invoiceNumber, vendor_gstin: vendorGstin }); setCurrentPage('invoice'); }}
            className="text-xs font-sans text-brass hover:underline flex items-center gap-1">
            <span className="material-symbols-outlined text-sm">zoom_in</span> Compare Ledgers Side-by-Side
          </button>
          <div className="flex gap-3">
            <button onClick={handleEscalate}
              className="border border-ink text-ink btn-outline-hover font-sans font-semibold text-xs px-4 py-2">
              Escalate Discrepancy
            </button>
            <button onClick={handleAccept}
              className="bg-brass text-paper hover:opacity-95 font-sans font-semibold text-xs px-4 py-2 border border-brass">
              Accept Ledger Entry
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

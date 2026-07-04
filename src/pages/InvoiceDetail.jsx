import React, { useState, useEffect } from 'react';
import { api, safeStr, safeFloat } from '../api';

export default function InvoiceDetail({ selectedInvoice, setCurrentPage }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchDetail() {
      setLoading(true);
      setError(null);
      const invNum     = selectedInvoice?.invoice_number || 'INV-2026-001';
      const vendorGstin= selectedInvoice?.vendor_gstin   || '27AAAAA1234A1Z1';

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
        <h2 className="font-fraunces text-lg font-bold text-ink">Invoice Record Not Found</h2>
        <p className="text-sm text-ink text-opacity-70 mt-2">
          Unable to locate reconciliation matches for the requested invoice.
          {error && <span className="block mt-1 font-mono text-xs text-vermillion">{error}</span>}
        </p>
        <button onClick={() => setCurrentPage('ledger')}
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
          <h1 className="font-fraunces text-2xl font-bold text-ink">Invoice Audit Analysis</h1>
          <p className="font-sans text-xs text-ink text-opacity-60 mt-1">
            Row-level ledger audit: Purchase Register comparison against GSTR-2B.
          </p>
        </div>
        <div className="flex gap-3">
          <button onClick={() => setCurrentPage('ledger')}
            className="border border-ink border-opacity-50 text-ink btn-outline-hover font-sans text-xs px-4 py-2">
            BACK TO LEDGER
          </button>
          <button onClick={() => window.print()}
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
            <p className="text-[10px] uppercase font-semibold text-ink text-opacity-55 font-sans">Invoice Number</p>
            <p className="font-mono text-sm font-bold text-ink">{invoiceNumber}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase font-semibold text-ink text-opacity-55 font-sans">Vendor Name / GSTIN</p>
            <p className="font-sans text-xs font-bold text-ink truncate">{vendorName}</p>
            <p className="font-mono text-[11px] text-ink text-opacity-65">{vendorGstin}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase font-semibold text-ink text-opacity-55 font-sans">Risk Rating</p>
            <span className={`inline-block font-mono text-xs font-bold px-2 py-0.5 mt-1 border ${
              riskLabel === 'CRITICAL' || riskLabel === 'HIGH'
                ? 'border-vermillion text-vermillion bg-vermillion bg-opacity-5'
                : riskLabel === 'MEDIUM'
                  ? 'border-brass text-brass bg-brass bg-opacity-5'
                  : 'border-ink border-opacity-30 text-ink text-opacity-60'
            }`}>
              {riskLabel}
            </span>
          </div>
        </div>

        {/* Side-by-side Ledger columns */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 relative z-10">
          {/* Purchase Register */}
          <div className="space-y-4 border-r border-ink border-opacity-10 pr-0 md:pr-8">
            <h3 className="font-fraunces text-sm font-bold text-ink border-b border-ink border-opacity-15 pb-1 flex items-center justify-between">
              <span>Purchase Register (Claimed)</span>
              <span className="material-symbols-outlined text-sm text-ink text-opacity-60">fact_check</span>
            </h3>
            {!isMissingInRegister ? (
              <div className="space-y-3 font-sans text-xs">
                <div className="flex justify-between">
                  <span className="text-ink text-opacity-65">Invoice Date</span>
                  <span className="font-mono">{prInvoiceDate}</span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-5 pt-2">
                  <span className="text-ink text-opacity-65">Taxable Value</span>
                  <span className={`font-mono font-semibold ${isTaxableMismatch ? 'text-vermillion bg-vermillion bg-opacity-5 font-bold px-1' : ''}`}>
                    ₹{prTaxableValue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-5 pt-2">
                  <span className="text-ink text-opacity-65">CGST Claimed</span>
                  <span className="font-mono">₹{prCgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-5 pt-2">
                  <span className="text-ink text-opacity-65">SGST Claimed</span>
                  <span className="font-mono">₹{prSgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-5 pt-2">
                  <span className="text-ink text-opacity-65">IGST Claimed</span>
                  <span className="font-mono">₹{prIgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-15 pt-2 text-sm">
                  <span className="font-semibold text-ink">Total ITC Claimed</span>
                  <span className={`font-mono font-bold text-brass ${isTaxMismatch ? 'text-vermillion bg-vermillion bg-opacity-5 px-1' : ''}`}>
                    ₹{prTotalItc.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-48 border border-dashed border-ink border-opacity-15 bg-ink bg-opacity-5">
                <p className="text-xs text-ink text-opacity-55 italic font-sans">No claimed entry in Purchase Register</p>
              </div>
            )}
          </div>

          {/* GSTR-2B */}
          <div className="space-y-4">
            <h3 className="font-fraunces text-sm font-bold text-ink border-b border-ink border-opacity-15 pb-1 flex items-center justify-between">
              <span>GSTR-2B (Portal Filing)</span>
              <span className="material-symbols-outlined text-sm text-ink text-opacity-60">cloud_done</span>
            </h3>
            {!isMissingIn2B ? (
              <div className="space-y-3 font-sans text-xs">
                <div className="flex justify-between">
                  <span className="text-ink text-opacity-65">Filing Period</span>
                  <span className="font-mono font-bold text-brass">{filingPeriod}</span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-5 pt-2">
                  <span className="text-ink text-opacity-65">Taxable Value Reported</span>
                  <span className={`font-mono font-semibold ${isTaxableMismatch ? 'text-vermillion bg-vermillion bg-opacity-5 font-bold px-1' : ''}`}>
                    ₹{bTaxableValue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-5 pt-2">
                  <span className="text-ink text-opacity-65">CGST Available</span>
                  <span className="font-mono">₹{bCgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-5 pt-2">
                  <span className="text-ink text-opacity-65">SGST Available</span>
                  <span className="font-mono">₹{bSgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-5 pt-2">
                  <span className="text-ink text-opacity-65">IGST Available</span>
                  <span className="font-mono">₹{bIgst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between border-t border-ink border-opacity-15 pt-2 text-sm">
                  <span className="font-semibold text-ink">Total ITC Available</span>
                  <span className={`font-mono font-bold text-brass ${isTaxMismatch ? 'text-vermillion bg-vermillion bg-opacity-5 px-1' : ''}`}>
                    ₹{bItcAvailable.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-48 border border-dashed border-vermillion border-opacity-25 bg-vermillion bg-opacity-5">
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
        <h2 className="font-fraunces text-base font-bold text-ink mb-2">Auditor Conflict Analysis</h2>
        <div className="bg-ink bg-opacity-5 p-4 border border-ink border-opacity-10 text-xs text-ink space-y-2 font-sans">
          <div className="flex gap-2">
            <span className="font-semibold">Discrepancy Explanation:</span>
            <span>{explanation}</span>
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
          <button onClick={() => setCurrentPage('mismatch')}
            className="border border-ink border-opacity-50 text-ink btn-outline-hover font-sans font-semibold text-xs px-4 py-2">
            Escalate to Client Relationship Team
          </button>
          <button onClick={() => alert(`Notification sent to vendor ${vendorGstin}`)}
            className="bg-brass text-paper hover:opacity-95 font-sans font-semibold text-xs px-4 py-2 border border-brass">
            Draft Non-Compliance Notice
          </button>
        </div>
      </div>
    </div>
  );
}

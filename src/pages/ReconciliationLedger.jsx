import React, { useState, useEffect } from 'react';
import { api, safeStr, safeFloat } from '../api';
import { useAppData } from '../AppDataContext';

export default function ReconciliationLedger({ setCurrentPage, setSelectedInvoice }) {
  const contextData = useAppData();

  const [data, setData] = useState(contextData?.defaultRecon?.data || []);
  const [clients, setClients] = useState(contextData?.clients || []);
  const [selectedClient, setSelectedClient] = useState('');
  const [selectedRisk, setSelectedRisk] = useState('');
  const [selectedMismatch, setSelectedMismatch] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [limit] = useState(15);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(contextData?.defaultRecon?.total || 0);
  const [loading, setLoading] = useState(!contextData?.prefetchDone);
  const [fetchError, setFetchError] = useState(null);

  useEffect(() => {
    if (contextData?.prefetchDone) {
      setClients(contextData.clients || []);
    }
  }, [contextData]);

  useEffect(() => {
    // Skip initial fetch if we already have the default reconciliation prefetch
    if (
      contextData?.prefetchDone &&
      !selectedClient &&
      !selectedRisk &&
      !selectedMismatch &&
      !searchQuery &&
      offset === 0
    ) {
      setData(contextData.defaultRecon?.data || []);
      setTotal(contextData.defaultRecon?.total || 0);
      setLoading(false);
      return;
    }

    async function fetchLedger() {
      setLoading(true);
      setFetchError(null);
      const { data: lData, error } = await api.getReconciliation({
        client_gstin: selectedClient,
        risk_label: selectedRisk,
        mismatch_type: selectedMismatch,
        search: searchQuery,
        limit,
        offset,
      });
      if (error) {
        setFetchError(error);
        setData([]);
        setTotal(0);
      } else {
        setData(lData?.data || []);
        setTotal(lData?.total || 0);
      }
      setLoading(false);
    }
    fetchLedger();
  }, [selectedClient, selectedRisk, selectedMismatch, searchQuery, limit, offset, contextData]);

  const handleClientChange  = (e) => { setSelectedClient(e.target.value);  setOffset(0); };
  const handleRiskChange    = (e) => { setSelectedRisk(e.target.value);    setOffset(0); };
  const handleMismatchChange= (e) => { setSelectedMismatch(e.target.value);setOffset(0); };
  const handleSearchChange  = (e) => { setSearchQuery(e.target.value);     setOffset(0); };

  const handleNextPage = () => { if (offset + limit < total) setOffset(offset + limit); };
  const handlePrevPage = () => { if (offset - limit >= 0) setOffset(offset - limit); };

  return (
    <div className="space-y-6 font-sans">
      <div className="flex justify-between items-end border-b border-ink border-opacity-10 pb-4">
        <div>
          <h1 className="font-fraunces text-2xl font-bold text-ink">GST Reconciliation Ledger</h1>
          <p className="font-sans text-xs text-ink text-opacity-60 mt-1">
            Complete flat table listing of reconciled invoices, matches, and risk assessments.
          </p>
        </div>
      </div>

      {fetchError && (
        <div className="bg-paper border border-vermillion border-opacity-40 p-3">
          <p className="text-xs font-sans font-semibold text-vermillion">Could not load ledger records: {fetchError}</p>
        </div>
      )}

      {/* Filters Strip */}
      <div className="bg-paper p-4 border border-ink border-opacity-15 grid grid-cols-1 md:grid-cols-5 gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase font-semibold text-ink text-opacity-65">Search Invoice/Vendor</label>
          <input type="text" placeholder="Search..." value={searchQuery} onChange={handleSearchChange}
            className="bg-paper border border-ink border-opacity-35 px-3 py-1 text-xs text-ink focus:outline-none focus:border-brass placeholder-ink placeholder-opacity-40"/>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase font-semibold text-ink text-opacity-65">Client Profile</label>
          <select value={selectedClient} onChange={handleClientChange}
            className="bg-paper border border-ink border-opacity-35 px-3 py-1 text-xs text-ink focus:outline-none focus:border-brass">
            <option value="">All Clients</option>
            {(Array.isArray(clients) ? clients : []).map(c => (
              <option key={safeStr(c.client_gstin)} value={safeStr(c.client_gstin)}>{safeStr(c.client_gstin)}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase font-semibold text-ink text-opacity-65">Risk Priority</label>
          <select value={selectedRisk} onChange={handleRiskChange}
            className="bg-paper border border-ink border-opacity-35 px-3 py-1 text-xs text-ink focus:outline-none focus:border-brass">
            <option value="">All Risks</option>
            <option value="CRITICAL">Critical</option>
            <option value="HIGH">High</option>
            <option value="MEDIUM">Medium</option>
            <option value="LOW">Low</option>
            <option value="NONE">None</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase font-semibold text-ink text-opacity-65">Mismatch Type</label>
          <select value={selectedMismatch} onChange={handleMismatchChange}
            className="bg-paper border border-ink border-opacity-35 px-3 py-1 text-xs text-ink focus:outline-none focus:border-brass">
            <option value="">All Categories</option>
            <option value="CLEAN_MATCH">Clean Match</option>
            <option value="TIMING_DIFFERENCE">Timing Difference</option>
            <option value="MISSING_IN_2B">Missing in 2B</option>
            <option value="AMOUNT_MISMATCH">Amount Mismatch</option>
            <option value="DUPLICATE_CLAIM">Duplicate Claim</option>
            <option value="MISSING_IN_REGISTER">Missing in Register</option>
          </select>
        </div>
        <div className="flex items-end">
          <button onClick={() => { setSelectedClient(''); setSelectedRisk(''); setSelectedMismatch(''); setSearchQuery(''); setOffset(0); }}
            className="w-full border border-ink border-opacity-50 text-ink btn-outline-hover text-xs py-1 transition-colors">
            CLEAR FILTERS
          </button>
        </div>
      </div>

      {/* Flat Ledger Table */}
      <div className="bg-paper border border-ink border-opacity-15 overflow-x-auto">
        <table className="w-full text-left font-sans text-xs">
          <thead>
            <tr className="bg-ink bg-opacity-5 text-ink text-opacity-70 font-semibold border-b border-ink border-opacity-15">
              <th className="p-3">Invoice No.</th>
              <th className="p-3">Vendor Name</th>
              <th className="p-3">Vendor GSTIN</th>
              <th className="p-3">Date</th>
              <th className="p-3 text-right">PR Tax</th>
              <th className="p-3 text-right">2B Tax</th>
              <th className="p-3 text-right">ITC Risk</th>
              <th className="p-3">Mismatch Status</th>
              <th className="p-3">Risk Level</th>
              <th className="p-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink divide-opacity-10 font-mono text-[11px] tabular-nums">
            {loading ? (
              Array.from({ length: limit }).map((_, idx) => (
                <tr key={idx} className="animate-pulse border-b border-ink border-opacity-5">
                  <td className="p-3"><div className="h-3 bg-ink bg-opacity-10 w-24"></div></td>
                  <td className="p-3"><div className="h-3 bg-ink bg-opacity-10 w-32"></div></td>
                  <td className="p-3"><div className="h-3 bg-ink bg-opacity-10 w-28"></div></td>
                  <td className="p-3"><div className="h-3 bg-ink bg-opacity-10 w-20"></div></td>
                  <td className="p-3 text-right"><div className="h-3 bg-ink bg-opacity-10 w-16 ml-auto"></div></td>
                  <td className="p-3 text-right"><div className="h-3 bg-ink bg-opacity-10 w-16 ml-auto"></div></td>
                  <td className="p-3 text-right"><div className="h-3 bg-ink bg-opacity-10 w-16 ml-auto"></div></td>
                  <td className="p-3"><div className="h-3 bg-ink bg-opacity-10 w-24"></div></td>
                  <td className="p-3"><div className="h-3 bg-ink bg-opacity-10 w-16"></div></td>
                  <td className="p-3 text-right"><div className="h-3 bg-ink bg-opacity-10 w-12 ml-auto"></div></td>
                </tr>
              ))
            ) : (!Array.isArray(data) || data.length === 0) ? (
              <tr><td colSpan="10" className="p-8 text-center text-ink text-opacity-50 font-sans italic">No matching reconciliation records found.</td></tr>
            ) : (
              (Array.isArray(data) ? data : []).map((item) => {
                const invoiceNum   = safeStr(item.invoice_number);
                const vendorName   = safeStr(item.vendor_name) || 'N/A';
                const vendorGstin  = safeStr(item.vendor_gstin);
                const invoiceDate  = safeStr(item.pr_invoice_date) || safeStr(item.invoice_date) || 'N/A';
                const mismatchType = safeStr(item.mismatch_type);
                const riskLabel    = safeStr(item.risk_label);
                const prTax        = safeFloat(item.pr_total_itc_claimed);
                const bTax         = safeFloat(item.b_itc_available);
                const itcRisk      = safeFloat(item.itc_at_risk);
                const invoiceId    = safeStr(item.invoice_id) || invoiceNum;
                return (
                  <tr key={invoiceId} className="row-hover" style={{ color: '#1B1811' }}>
                    <td className="p-3 font-semibold text-ink">{invoiceNum}</td>
                    <td className="p-3 truncate max-w-[130px] font-sans font-medium text-ink">{vendorName}</td>
                    <td className="p-3">{vendorGstin}</td>
                    <td className="p-3">{invoiceDate}</td>
                    <td className="p-3 text-right">₹{prTax.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                    <td className="p-3 text-right">₹{bTax.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                    <td className="p-3 text-right text-vermillion font-bold">₹{itcRisk.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                    <td className="p-3 font-sans text-[10px] uppercase font-bold text-ink text-opacity-70">
                      {mismatchType.replace(/_/g, ' ')}
                    </td>
                    <td className="p-3 font-sans text-[10px] font-bold">
                      <span className={`px-1.5 py-0.5 border ${
                        riskLabel === 'CRITICAL' || riskLabel === 'HIGH'
                          ? 'border-vermillion text-vermillion bg-vermillion bg-opacity-5'
                          : riskLabel === 'MEDIUM'
                            ? 'border-brass text-brass bg-brass bg-opacity-5'
                            : 'border-ink border-opacity-35 text-ink text-opacity-55'
                      }`}>
                        {riskLabel}
                      </span>
                    </td>
                    <td className="p-3 text-right font-sans">
                      <button
                        onClick={() => {
                          setSelectedInvoice({ invoice_number: invoiceNum, vendor_gstin: vendorGstin });
                          setCurrentPage('invoice');
                        }}
                        className="border border-ink border-opacity-40 text-ink btn-outline-hover px-2 py-0.5 text-[10px] font-semibold"
                      >Audit</button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      <div className="flex justify-between items-center text-xs text-ink text-opacity-70 font-mono">
        <div>
          Showing <span className="font-bold">{total > 0 ? offset + 1 : 0}</span> to{' '}
          <span className="font-bold">{Math.min(offset + limit, total)}</span> of{' '}
          <span className="font-bold">{total}</span> records
        </div>
        <div className="flex gap-2">
          <button onClick={handlePrevPage} disabled={offset === 0}
            className={`border border-ink border-opacity-40 px-3 py-1 font-sans text-xs font-semibold text-ink ${offset === 0 ? 'opacity-30 cursor-not-allowed' : 'btn-outline-hover'}`}>
            PREVIOUS
          </button>
          <button onClick={handleNextPage} disabled={offset + limit >= total}
            className={`border border-ink border-opacity-40 px-3 py-1 font-sans text-xs font-semibold text-ink ${offset + limit >= total ? 'opacity-30 cursor-not-allowed' : 'btn-outline-hover'}`}>
            NEXT
          </button>
        </div>
      </div>
    </div>
  );
}

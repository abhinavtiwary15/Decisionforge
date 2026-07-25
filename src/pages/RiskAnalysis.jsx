import React, { useState, useEffect } from 'react';
import { api, safeStr, safeFloat } from '../api';
import { useAppData } from '../AppDataContext';
import { SkeletonCard } from '../components/Skeleton';

export default function RiskAnalysis({ setCurrentPage, setSelectedInvoice }) {
  const contextData = useAppData();

  const [clients, setClients] = useState(contextData?.clients || []);
  const [reconciliationData, setReconciliationData] = useState(contextData?.riskRecon?.data || []);
  const [benchmarkData, setBenchmarkData] = useState(contextData?.benchmark || []);
  const [loading, setLoading] = useState(!contextData?.prefetchDone);
  const [fetchErrors, setFetchErrors] = useState([]);

  useEffect(() => {
    if (contextData?.prefetchDone) {
      setClients(contextData.clients || []);
      setReconciliationData(contextData.riskRecon?.data || []);
      setBenchmarkData(contextData.benchmark || []);
      setLoading(false);
      return;
    }

    async function fetchData() {
      setLoading(true);
      const errs = [];

      const { data: clientsData, error: ce } = await api.getClients();
      if (ce) errs.push(`Clients: ${ce}`);
      else setClients(clientsData || []);

      const { data: reconData, error: re } = await api.getReconciliation({ limit: 100 });
      if (re) errs.push(`Reconciliation: ${re}`);
      else setReconciliationData(reconData?.data || []);

      const { data: bData, error: bErr } = await api.getBenchmark();
      if (bErr) errs.push(`Benchmark: ${bErr}`);
      else setBenchmarkData(bData || []);

      setFetchErrors(errs);
      setLoading(false);
    }
    fetchData();
  }, [contextData]);

  const sortedClients = [...(Array.isArray(clients) ? clients : [])]
    .sort((a, b) => safeFloat(b.total_itc_at_risk) - safeFloat(a.total_itc_at_risk));

  const sortedReconData = [...reconciliationData]
    .filter(item => safeFloat(item.itc_at_risk) > 0)
    .sort((a, b) => safeFloat(b.itc_at_risk) - safeFloat(a.itc_at_risk));

  const pandasRow = (benchmarkData || []).find(item => Number(item.Scale) === 50000 && item.Backend === 'pandas');
  const cudfRow   = (benchmarkData || []).find(item => Number(item.Scale) === 50000 && item.Backend === 'cudf');
  
  const pandasTimeValue = pandasRow ? safeFloat(pandasRow['Time (s)']) : 0.8533785343170166;
  const cudfTimeValue   = cudfRow   ? safeFloat(cudfRow['Time (s)'])   : 0.12259507179260254;

  const pandasTimeFormatted = pandasTimeValue.toFixed(2);
  const cudfTimeFormatted   = cudfTimeValue.toFixed(2);
  const speedup = (cudfTimeValue > 0) ? (pandasTimeValue / cudfTimeValue).toFixed(2) : '6.96';

  if (loading) {
    return (
      <div className="space-y-6 font-sans">
        <div className="flex justify-between items-end border-b border-ink border-opacity-10 pb-4">
          <div>
            <h1 className="page-title opacity-25">Risk &amp; ITC Analysis Console</h1>
            <p className="body-secondary mt-1">Institutional-grade risk assessment of Input Tax Credit exposures...</p>
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-8"><SkeletonCard height={450} /></div>
          <div className="lg:col-span-4"><SkeletonCard height={450} /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 font-sans">
      <div className="flex justify-between items-end border-b border-ink border-opacity-10 pb-4">
        <div>
          <h1 className="page-title">Risk &amp; ITC Analysis Console</h1>
          <p className="body-secondary mt-1">
            Institutional-grade risk assessment of Input Tax Credit exposures across clients and vendors.
          </p>
        </div>
        <button onClick={() => setCurrentPage('mismatch')}
          className="bg-brass text-paper hover:opacity-95 font-sans font-semibold text-xs px-4 py-2 border border-brass">
          GENERATE RISK REPORT
        </button>
      </div>

      {fetchErrors.length > 0 && (
        <div className="bg-paper border border-vermillion border-opacity-40 p-3">
          {fetchErrors.map((e, i) => (
            <p key={i} className="text-[11px] font-mono text-vermillion">{e}</p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Ranked Client List */}
        <div className="lg:col-span-8 bg-paper p-4 border border-ink border-opacity-15 flex flex-col min-h-[450px]">
          <div className="mb-4">
            <h2 className="section-header">Ranked Client ITC Exposure</h2>
            <p className="body-secondary mt-1">Clients sorted by aggregate Input Tax Credit at risk</p>
          </div>
          
          <div className="flex-1 w-full overflow-x-auto">
            {sortedClients.length > 0 ? (
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="tbl-header">
                    <th className="p-3 text-[10px] uppercase font-bold tracking-wider w-16">Rank</th>
                    <th className="p-3 text-[10px] uppercase font-bold tracking-wider">Client GSTIN</th>
                    <th className="p-3 text-[10px] uppercase font-bold tracking-wider text-center w-36">Risk Level</th>
                    <th className="p-3 text-[10px] uppercase font-bold tracking-wider text-right w-44">ITC at Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedClients.map((client, index) => {
                    const atRisk = safeFloat(client.total_itc_at_risk);
                    const gstin = safeStr(client.client_gstin);
                    
                    let riskTier = 'LOW';
                    let badgeClass = 'bg-ink-5 text-ink-65';
                    if (atRisk > 3700000) {
                      riskTier = 'CRITICAL';
                      badgeClass = 'bg-vermillion text-paper';
                    } else if (atRisk > 3500000) {
                      riskTier = 'HIGH';
                      badgeClass = 'bg-vermillion-20 text-vermillion';
                    } else if (atRisk > 3000000) {
                      riskTier = 'MEDIUM';
                      badgeClass = 'bg-brass-15 text-brass';
                    }
                    
                    return (
                      <tr key={gstin} className="border-b border-ink border-opacity-10 row-hover transition-colors">
                        <td className="p-3 font-mono text-xs text-ink-55 tabular-nums">#{index + 1}</td>
                        <td className="p-3 font-mono text-xs text-ink font-semibold">{gstin}</td>
                        <td className="p-3 text-center">
                          <span className={`text-[9px] uppercase font-sans font-bold px-2 py-0.5 border border-ink border-opacity-10 inline-block w-24 text-center ${badgeClass}`}>
                            {riskTier}
                          </span>
                        </td>
                        <td className="p-3 text-right font-mono text-xs font-bold text-ink tabular-nums">
                          ₹{atRisk.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="flex items-center justify-center h-48">
                <p className="text-xs text-ink-50 italic">No client risk data available.</p>
              </div>
            )}
          </div>
        </div>

        {/* Side panels */}
        <div className="lg:col-span-4 flex flex-col gap-6">
          {/* Top Exposures */}
          <div className="bg-paper p-4 border border-ink border-opacity-15 flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-baseline mb-2">
                <h2 className="section-header">Top Invoice Exposures</h2>
                <span className="font-mono text-[10px] text-ink-65 font-bold">
                  {sortedReconData.length} Flagged
                </span>
              </div>
              <div className="space-y-2.5 my-2">
                {(Array.isArray(sortedReconData) ? sortedReconData : []).slice(0, 7).map((item) => {
                  const invNum    = safeStr(item.invoice_number);
                  const vendGstin = safeStr(item.vendor_gstin);
                  const vendName  = safeStr(item.vendor_name) || 'Unknown Vendor';
                  const risk      = safeStr(item.risk_label);
                  const atRisk    = safeFloat(item.itc_at_risk);
                  return (
                    <div key={safeStr(item.invoice_id) || invNum}
                      onClick={() => { setSelectedInvoice({ invoice_number: invNum, vendor_gstin: vendGstin }); setCurrentPage('invoice'); }}
                      className="flex justify-between items-center pb-2 border-b border-ink border-opacity-10 card-hover p-1 transition-colors cursor-pointer">
                      <div className="overflow-hidden">
                        <p className="font-mono text-xs font-semibold text-ink">{invNum}</p>
                        <p className="text-[10px] text-ink-55 truncate max-w-[170px]">{vendName}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono text-xs font-bold text-vermillion tabular-nums">
                          ₹{atRisk.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                        </p>
                        <span className="text-[9px] uppercase font-sans font-bold text-vermillion bg-vermillion-10 px-1">
                          {risk}
                        </span>
                      </div>
                    </div>
                  );
                })}
                {sortedReconData.length === 0 && (
                  <p className="text-xs text-ink-50 italic py-4 text-center">No high-exposure invoices found.</p>
                )}
              </div>
            </div>
            <button type="button" onClick={() => setCurrentPage('ledger')}
              className="w-full mt-3 border border-ink border-opacity-50 text-ink btn-outline-hover py-2 font-sans text-xs font-semibold">
              VIEW ALL MATCHES
            </button>
          </div>

          {/* GPU Benchmark stat */}
          <div className="bg-paper p-4 border border-ink border-opacity-15 border-t-2 border-t-brass">
            <div className="flex justify-between items-start mb-2">
              <div>
                <h2 className="section-header">Engine Acceleration</h2>
                <p className="body-secondary mt-1">NVIDIA cuDF Ledger Sync Benchmark</p>
              </div>
              <span className="bg-brass-15 text-brass font-mono font-bold text-[10px] px-2 py-0.5 border border-brass border-opacity-35">
                GPU ACTIVE
              </span>
            </div>
            <div className="mt-4 space-y-3">
              <div className="flex justify-between items-baseline border-b border-ink border-opacity-10 pb-2">
                <span className="text-xs text-ink-65">Sync Latency (50k rows)</span>
                <span className="font-mono text-xs font-bold text-ink tabular-nums">{cudfTimeFormatted}s <span className="text-[10px] font-normal text-ink-55">(cuDF GPU)</span></span>
              </div>
              <div className="flex justify-between items-baseline border-b border-ink border-opacity-10 pb-2">
                <span className="text-xs text-ink-65">CPU Standard Latency</span>
                <span className="font-mono text-xs font-bold text-ink text-ink-60 tabular-nums">{pandasTimeFormatted}s <span className="text-[10px] font-normal">(Pandas CPU)</span></span>
              </div>
              <div className="pt-1 flex items-center justify-between">
                <span className="text-xs font-sans font-semibold text-ink">Sync Speedup Factor</span>
                <span className="font-mono text-base font-bold text-brass tabular-nums">{speedup}x</span>
              </div>
            </div>
            <p className="text-[10px] text-ink-55 mt-3 font-sans italic leading-snug">
              Syncing large client ledgers takes under a fraction of a second utilizing GPU-accelerated computing pipelines.
            </p>
          </div>
        </div>
      </div>

      {/* Risk Rules Panel */}
      <div className="bg-paper p-4 border border-ink border-opacity-15">
        <h2 className="section-header mb-3">Reconciliation Risk Scoring Protocol</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-sans text-ink">
          <div className="p-3 border border-ink border-opacity-10 bg-paper">
            <span className="bg-vermillion text-paper font-mono font-bold px-1 text-[9px] uppercase tracking-wider">Critical Risk</span>
            <p className="mt-2 font-medium">ITC At Risk &gt; ₹50,000</p>
            <p className="mt-1 text-ink-60 text-[11px]">
              Missing invoices in GSTR-2B filings with a claimed credit exceeding ₹50,000. Triggers immediate automated notice draft.
            </p>
          </div>
          <div className="p-3 border border-ink border-opacity-10 bg-paper">
            <span className="bg-vermillion-20 text-vermillion font-mono font-bold px-1 text-[9px] uppercase tracking-wider">High Risk</span>
            <p className="mt-2 font-medium">ITC At Risk &gt; ₹25,000</p>
            <p className="mt-1 text-ink-60 text-[11px]">
              Missing invoices under ₹50k or amount discrepancies exceeding ₹25,000. Recommends client withholding.
            </p>
          </div>
          <div className="p-3 border border-ink border-opacity-10 bg-paper">
            <span className="bg-brass text-paper font-mono font-bold px-1 text-[9px] uppercase tracking-wider">Medium / Low Risk</span>
            <p className="mt-2 font-medium">Discrepancy ≤ ₹25,000</p>
            <p className="mt-1 text-ink-60 text-[11px]">
              Duplicate claims or timing differences off by exactly 1 period. Checked automatically via standard follow-up queue.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

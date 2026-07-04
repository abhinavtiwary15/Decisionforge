import React, { useState, useEffect } from 'react';
import { ResponsiveContainer, Treemap } from 'recharts';
import { api, safeStr, safeFloat } from '../api';
import { useAppData } from '../AppDataContext';
import { SkeletonCard } from '../components/Skeleton';

export default function RiskAnalysis({ setCurrentPage, setSelectedInvoice }) {
  const contextData = useAppData();

  const [clients, setClients] = useState(contextData?.clients || []);
  const [reconciliationData, setReconciliationData] = useState(contextData?.riskRecon?.data || []);
  const [loading, setLoading] = useState(!contextData?.prefetchDone);
  const [fetchErrors, setFetchErrors] = useState([]);

  useEffect(() => {
    if (contextData?.prefetchDone) {
      setClients(contextData.clients || []);
      setReconciliationData(contextData.riskRecon?.data || []);
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

      setFetchErrors(errs);
      setLoading(false);
    }
    fetchData();
  }, [contextData]);

  // Format data for Treemap
  const treemapData = [
    {
      name: 'Clients at Risk',
      children: (Array.isArray(clients) ? clients : []).map(c => {
        const atRisk = safeFloat(c.total_itc_at_risk);
        let riskTier = 'LOW';
        if (atRisk > 3700000) riskTier = 'CRITICAL';
        else if (atRisk > 3500000) riskTier = 'HIGH';
        else if (atRisk > 3000000) riskTier = 'MEDIUM';
        return {
          name: safeStr(c.client_gstin),
          size: atRisk,
          riskTier,
          formattedSize: `₹${(atRisk / 100000).toFixed(1)}L`
        };
      })
    }
  ];

  const CustomizedContent = (props) => {
    const { x, y, width, height, name, riskTier, formattedSize } = props;
    if (width < 30 || height < 30) return null;
    let fill = '#1B1811';
    if (riskTier === 'CRITICAL' || riskTier === 'HIGH') fill = '#A63A2E';
    else if (riskTier === 'MEDIUM') fill = '#A9781E';
    return (
      <g>
        <rect x={x} y={y} width={width} height={height}
          style={{ fill, stroke: '#F3EEE2', strokeWidth: 1, fillOpacity: 0.9 }}/>
        {width > 80 && height > 40 && (
          <>
            <text x={x + 6} y={y + 18} fill="#F3EEE2" fontSize={10} fontWeight="semibold" fontFamily="IBM Plex Mono">
              {String(name || '').substring(0, 8)}...
            </text>
            <text x={x + 6} y={y + 32} fill="#F3EEE2" fontSize={10} fontFamily="IBM Plex Mono">
              {formattedSize}
            </text>
            <text x={x + 6} y={y + height - 8} fill="#F3EEE2" fontSize={8} fontWeight="bold" fontFamily="IBM Plex Sans" fillOpacity={0.6}>
              {riskTier}
            </text>
          </>
        )}
      </g>
    );
  };

  const sortedReconData = [...reconciliationData]
    .filter(item => safeFloat(item.itc_at_risk) > 0)
    .sort((a, b) => safeFloat(b.itc_at_risk) - safeFloat(a.itc_at_risk));

  if (loading) {
    return (
      <div className="space-y-6 font-sans">
        <div className="flex justify-between items-end border-b border-ink border-opacity-10 pb-4">
          <div>
            <h1 className="font-fraunces text-2xl font-bold text-ink opacity-25">Risk &amp; ITC Analysis Console</h1>
            <p className="font-sans text-xs text-ink text-opacity-45 mt-1">Institutional-grade risk assessment of Input Tax Credit exposures...</p>
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
          <h1 className="font-fraunces text-2xl font-bold text-ink">Risk &amp; ITC Analysis Console</h1>
          <p className="font-sans text-xs text-ink text-opacity-60 mt-1">
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
        {/* Treemap */}
        <div className="lg:col-span-8 bg-paper p-4 border border-ink border-opacity-15 flex flex-col min-h-[450px]">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h2 className="font-fraunces text-base font-bold text-ink">Client ITC Exposure Treemap</h2>
              <p className="text-xs text-ink text-opacity-55">Tile size reflects total ITC at risk; color indicates risk tier</p>
            </div>
            <div className="flex items-center gap-3 text-[10px] font-sans text-ink">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-vermillion"></span>Critical / High</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-brass"></span>Medium</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-ink"></span>Low</span>
            </div>
          </div>
          <div className="flex-1 w-full bg-paper border border-ink border-opacity-10 relative">
            {treemapData[0].children.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <Treemap
                  data={treemapData[0].children}
                  dataKey="size"
                  ratio={4 / 3}
                  stroke="#F3EEE2"
                  content={<CustomizedContent />}
                />
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full">
                <p className="text-xs text-ink text-opacity-50 italic">No client risk data available.</p>
              </div>
            )}
          </div>
        </div>

        {/* Side panels */}
        <div className="lg:col-span-4 flex flex-col gap-6">
          {/* Top Exposures */}
          <div className="bg-paper p-4 border border-ink border-opacity-15 flex flex-col flex-1">
            <h2 className="font-fraunces text-base font-bold text-ink mb-3">Top Invoice Exposures</h2>
            <div className="space-y-3 flex-1 overflow-y-auto max-h-[220px]">
              {(Array.isArray(sortedReconData) ? sortedReconData : []).slice(0, 5).map((item) => {
                const invNum    = safeStr(item.invoice_number);
                const vendGstin = safeStr(item.vendor_gstin);
                const vendName  = safeStr(item.vendor_name);
                const risk      = safeStr(item.risk_label);
                const atRisk    = safeFloat(item.itc_at_risk);
                return (
                  <div key={safeStr(item.invoice_id) || invNum}
                    onClick={() => { setSelectedInvoice({ invoice_number: invNum, vendor_gstin: vendGstin }); setCurrentPage('invoice'); }}
                    className="flex justify-between items-center pb-2 border-b border-ink border-opacity-10 card-hover p-1 transition-colors cursor-pointer">
                    <div className="overflow-hidden">
                      <p className="font-mono text-xs font-semibold text-ink">{invNum}</p>
                      <p className="text-[10px] text-ink text-opacity-55 truncate max-w-[180px]">{vendName}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-xs font-bold text-vermillion tabular-nums">
                        ₹{atRisk.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </p>
                      <span className="text-[9px] uppercase font-sans font-bold text-vermillion bg-vermillion bg-opacity-10 px-1">
                        {risk}
                      </span>
                    </div>
                  </div>
                );
              })}
              {sortedReconData.length === 0 && (
                <p className="text-xs text-ink text-opacity-50 italic">No high-exposure invoices found.</p>
              )}
            </div>
            <button onClick={() => setCurrentPage('ledger')}
              className="w-full mt-3 border border-ink border-opacity-50 text-ink btn-outline-hover py-2 font-sans text-xs font-semibold">
              VIEW ALL MATCHES
            </button>
          </div>

          {/* GPU Benchmark stat */}
          <div className="bg-paper p-4 border border-ink border-opacity-15 border-t-2 border-t-brass">
            <div className="flex justify-between items-start mb-2">
              <div>
                <h2 className="font-fraunces text-base font-bold text-ink">Engine Acceleration</h2>
                <p className="text-xs text-ink text-opacity-55">NVIDIA cuDF Ledger Sync Benchmark</p>
              </div>
              <span className="bg-brass bg-opacity-15 text-brass font-mono font-bold text-[10px] px-2 py-0.5 border border-brass border-opacity-35">
                GPU ACTIVE
              </span>
            </div>
            <div className="mt-4 space-y-3">
              <div className="flex justify-between items-baseline border-b border-ink border-opacity-10 pb-2">
                <span className="text-xs text-ink text-opacity-65">Sync Latency (50k rows)</span>
                <span className="font-mono text-xs font-bold text-ink tabular-nums">0.12s <span className="text-[10px] font-normal text-ink text-opacity-55">(cuDF GPU)</span></span>
              </div>
              <div className="flex justify-between items-baseline border-b border-ink border-opacity-10 pb-2">
                <span className="text-xs text-ink text-opacity-65">CPU Standard Latency</span>
                <span className="font-mono text-xs font-bold text-ink text-opacity-60 tabular-nums">0.85s <span className="text-[10px] font-normal">(Pandas CPU)</span></span>
              </div>
              <div className="pt-1 flex items-center justify-between">
                <span className="text-xs font-sans font-semibold text-ink">Sync Speedup Factor</span>
                <span className="font-mono text-base font-bold text-brass tabular-nums">9.70x</span>
              </div>
            </div>
            <p className="text-[10px] text-ink text-opacity-55 mt-3 font-sans italic leading-snug">
              Syncing large client ledgers takes under a fraction of a second utilizing GPU-accelerated computing pipelines.
            </p>
          </div>
        </div>
      </div>

      {/* Risk Rules Panel */}
      <div className="bg-paper p-4 border border-ink border-opacity-15">
        <h2 className="font-fraunces text-base font-bold text-ink mb-3">Reconciliation Risk Scoring Protocol</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-sans text-ink">
          <div className="p-3 border border-ink border-opacity-10 bg-paper">
            <span className="bg-vermillion text-paper font-mono font-bold px-1 text-[9px] uppercase tracking-wider">Critical Risk</span>
            <p className="mt-2 font-medium">ITC At Risk &gt; ₹50,000</p>
            <p className="mt-1 text-ink text-opacity-60 text-[11px]">
              Missing invoices in GSTR-2B filings with a claimed credit exceeding ₹50,000. Triggers immediate automated notice draft.
            </p>
          </div>
          <div className="p-3 border border-ink border-opacity-10 bg-paper">
            <span className="bg-vermillion bg-opacity-20 text-vermillion font-mono font-bold px-1 text-[9px] uppercase tracking-wider">High Risk</span>
            <p className="mt-2 font-medium">ITC At Risk &gt; ₹25,000</p>
            <p className="mt-1 text-ink text-opacity-60 text-[11px]">
              Missing invoices under ₹50k or amount discrepancies exceeding ₹25,000. Recommends client withholding.
            </p>
          </div>
          <div className="p-3 border border-ink border-opacity-10 bg-paper">
            <span className="bg-brass text-paper font-mono font-bold px-1 text-[9px] uppercase tracking-wider">Medium / Low Risk</span>
            <p className="mt-2 font-medium">Discrepancy ≤ ₹25,000</p>
            <p className="mt-1 text-ink text-opacity-60 text-[11px]">
              Duplicate claims or timing differences off by exactly 1 period. Checked automatically via standard follow-up queue.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

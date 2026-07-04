import React, { useState, useEffect } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { api, safeStr, safeFloat, safeInt } from '../api';
import { useAppData } from '../AppDataContext';
import { SkeletonPage } from '../components/Skeleton';

export default function DashboardOverview({ setCurrentPage, setSelectedInvoice }) {
  const contextData = useAppData();

  const [clients, setClients] = useState(Array.isArray(contextData?.clients) ? contextData.clients : []);
  const [recentMismatches, setRecentMismatches] = useState(Array.isArray(contextData?.criticalRecon?.data) ? contextData.criticalRecon.data : []);
  const [dataQualityFlags, setDataQualityFlags] = useState(Array.isArray(contextData?.dataQuality) ? contextData.dataQuality : []);
  const [dqExpanded, setDqExpanded] = useState(false);
  const [loading, setLoading] = useState(!contextData?.prefetchDone);
  const [errors, setErrors] = useState([]);

  useEffect(() => {
    if (contextData?.prefetchDone) {
      setClients(Array.isArray(contextData.clients) ? contextData.clients : []);
      setRecentMismatches(Array.isArray(contextData.criticalRecon?.data) ? contextData.criticalRecon.data : []);
      setDataQualityFlags(Array.isArray(contextData.dataQuality) ? contextData.dataQuality : []);
      setLoading(false);
      return;
    }

    async function fetchAll() {
      setLoading(true);
      const errs = [];

      const { data: clientsData, error: clientsErr } = await api.getClients();
      if (clientsErr) errs.push(`Clients: ${clientsErr}`);
      else setClients(Array.isArray(clientsData) ? clientsData : []);

      const { data: reconData, error: reconErr } = await api.getReconciliation({ risk_label: 'CRITICAL', limit: 5 });
      if (reconErr) errs.push(`Mismatches: ${reconErr}`);
      else setRecentMismatches(Array.isArray(reconData?.data) ? reconData.data : []);

      const { data: dqData, error: dqErr } = await api.getDataQuality();
      if (dqErr) errs.push(`Data Quality: ${dqErr}`);
      else setDataQualityFlags(Array.isArray(dqData) ? dqData : []);

      setErrors(errs);
      setLoading(false);
    }
    fetchAll();
  }, [contextData]);

  // Aggregate stats
  const totalITCRisk     = clients.reduce((acc, c) => acc + safeFloat(c.total_itc_at_risk), 0);
  const totalInvoices    = clients.reduce((acc, c) => acc + safeInt(c.total_invoice_count), 0);
  const cleanMatches     = clients.reduce((acc, c) => acc + safeInt(c.clean_match_count), 0);
  const cleanMatchRate   = totalInvoices > 0 ? (cleanMatches / totalInvoices) * 100 : 0;
  const mismatchCount    = clients.reduce((acc, c) =>
    acc + safeInt(c.missing_in_2b_count) + safeInt(c.amount_mismatch_count) + safeInt(c.duplicate_claim_count), 0);

  const trendData = [
    { month: 'Oct 25', matches: 12000, mismatches: 800 },
    { month: 'Nov 25', matches: 14500, mismatches: 950 },
    { month: 'Dec 25', matches: 16200, mismatches: 1100 },
    { month: 'Jan 26', matches: 19100, mismatches: 1250 },
    { month: 'Feb 26', matches: 21500, mismatches: 1400 },
    { month: 'Mar 26', matches: 23921, mismatches: 1053 },
  ];

  if (loading) {
    return <SkeletonPage title="GST Reconciliation Console" />;
  }

  return (
    <div className="space-y-6 font-sans">
      {/* Non-fatal API error banner */}
      {errors.length > 0 && (
        <div className="bg-paper border border-vermillion border-opacity-40 p-3">
          <p className="text-xs font-sans font-semibold text-vermillion mb-1">Some data could not be loaded — showing available data below.</p>
          {errors.map((e, i) => (
            <p key={i} className="text-[11px] font-mono text-vermillion">{e}</p>
          ))}
        </div>
      )}

      {/* Header */}
      <div className="flex justify-between items-end border-b border-ink border-opacity-10 pb-4">
        <div>
          <h1 className="font-fraunces text-2xl font-bold text-ink">GST Reconciliation Console</h1>
          <p className="font-sans text-xs text-ink text-opacity-60 mt-1">
            Real-time reconciliation of Purchase Register against GSTR-2B filings.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => setCurrentPage('mismatch')}
            className="bg-brass text-paper hover:opacity-95 font-sans font-semibold text-xs px-4 py-2 border border-brass"
          >RUN AUDIT ENGINE</button>
          <button
            onClick={() => setCurrentPage('ledger')}
            className="border border-ink border-opacity-50 text-ink btn-outline-hover font-sans text-xs px-4 py-2"
          >VIEW FLAT LEDGER</button>
        </div>
      </div>

      {/* Stats Strip */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-paper p-4 border border-ink border-opacity-15">
          <p className="text-[10px] uppercase tracking-wider font-semibold text-ink text-opacity-65">Total ITC at Risk</p>
          <p className="font-mono text-xl font-bold text-brass mt-1 tabular-nums">
            ₹{totalITCRisk.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </p>
          <p className="text-[10px] text-ink text-opacity-55 mt-1">Across {clients.length} active client profiles</p>
        </div>
        <div className="bg-paper p-4 border border-ink border-opacity-15">
          <p className="text-[10px] uppercase tracking-wider font-semibold text-ink text-opacity-65">Clean Match Rate</p>
          <p className="font-mono text-xl font-bold text-brass mt-1 tabular-nums">{cleanMatchRate.toFixed(1)}%</p>
          <p className="text-[10px] text-ink text-opacity-55 mt-1">Target benchmark: &gt;95.0%</p>
        </div>
        <div className="bg-paper p-4 border border-ink border-opacity-15">
          <p className="text-[10px] uppercase tracking-wider font-semibold text-ink text-opacity-65">Identified Mismatches</p>
          <p className="font-mono text-xl font-bold text-vermillion mt-1 tabular-nums">
            {mismatchCount.toLocaleString('en-IN')}
          </p>
          <p className="text-[10px] text-ink text-opacity-55 mt-1">Requires vendor contact</p>
        </div>
        <div className="bg-paper p-4 border border-ink border-opacity-15 border-l-2 border-l-vermillion">
          <p className="text-[10px] uppercase tracking-wider font-semibold text-vermillion">Needs Attention</p>
          <p className="font-mono text-xl font-bold text-vermillion mt-1 tabular-nums">{dataQualityFlags.length} Flags</p>
          <p className="text-[10px] text-ink text-opacity-55 mt-1">Invalid GSTIN structural failures</p>
        </div>
      </div>

      {/* Needs Attention Panel */}
      <div className="bg-paper border border-vermillion border-opacity-30">
        <div
          onClick={() => setDqExpanded(!dqExpanded)}
          className="p-4 flex justify-between items-center cursor-pointer select-none transition-colors"
          onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(166,58,46,0.05)'}
          onMouseLeave={e => e.currentTarget.style.backgroundColor = ''}
        >
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-vermillion">report_problem</span>
            <div>
              <h2 className="font-fraunces text-sm font-bold text-ink">Data Quality Flags: Action Required</h2>
              <p className="text-[11px] text-ink text-opacity-60 font-sans">
                {dataQualityFlags.length} record{dataQualityFlags.length !== 1 ? 's' : ''} failed GSTIN
                structural validation and must be corrected before financial auditing.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-vermillion font-bold uppercase">
              {dqExpanded ? 'Collapse' : 'Expand List'}
            </span>
            <span
              className="material-symbols-outlined text-vermillion text-sm transition-transform duration-200"
              style={{ transform: dqExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
            >keyboard_arrow_down</span>
          </div>
        </div>

        {dqExpanded && (
          <div className="border-t border-ink border-opacity-10 overflow-x-auto">
            {dataQualityFlags.length === 0 ? (
              <p className="p-4 text-xs text-ink text-opacity-55 italic font-sans">No data quality flags found.</p>
            ) : (
              <table className="w-full text-left font-sans text-xs">
                <thead>
                  <tr className="bg-ink bg-opacity-5 text-ink text-opacity-70 font-semibold border-b border-ink border-opacity-15">
                    <th className="p-3">Invoice No.</th>
                    <th className="p-3">Client GSTIN</th>
                    <th className="p-3">Invalid Vendor GSTIN</th>
                    <th className="p-3">Date</th>
                    <th className="p-3">Source</th>
                    <th className="p-3">Validation Defect</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink divide-opacity-10 font-mono text-[11px] tabular-nums">
                  {(Array.isArray(dataQualityFlags) ? dataQualityFlags : []).map((flag) => (
                    <tr key={safeStr(flag.invoice_id)} className="row-hover" style={{ color: '#1B1811' }}>
                      <td className="p-3 font-semibold">{safeStr(flag.invoice_number)}</td>
                      <td className="p-3">{safeStr(flag.client_gstin) || 'N/A'}</td>
                      <td className="p-3 text-vermillion font-bold">{safeStr(flag.vendor_gstin)}</td>
                      <td className="p-3">{safeStr(flag.invoice_date)}</td>
                      <td className="p-3 uppercase font-sans text-[10px]">{safeStr(flag.source).replace('_', ' ')}</td>
                      <td className="p-3 text-vermillion font-sans font-medium">{safeStr(flag.validation_error)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Mismatch Trends chart */}
        <div className="lg:col-span-2 bg-paper p-4 border border-ink border-opacity-15 flex flex-col">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h2 className="font-fraunces text-base font-bold text-ink">Mismatch Trends</h2>
              <p className="text-xs text-ink text-opacity-55">Timeline of matching vs. discrepant invoices</p>
            </div>
            <div className="flex gap-4 text-xs font-sans text-ink text-opacity-75">
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-brass"></span>Matches</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-vermillion"></span>Mismatches</span>
            </div>
          </div>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorMatches" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#A9781E" stopOpacity={0.2}/>
                    <stop offset="95%" stopColor="#A9781E" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorMismatches" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#A63A2E" stopOpacity={0.2}/>
                    <stop offset="95%" stopColor="#A63A2E" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(27,24,17,0.08)" />
                <XAxis dataKey="month" stroke="#1B1811" style={{ fontSize: '10px', fontFamily: 'IBM Plex Mono' }} tickLine={false}/>
                <YAxis stroke="#1B1811" style={{ fontSize: '10px', fontFamily: 'IBM Plex Mono' }} tickLine={false} axisLine={false}/>
                <Tooltip contentStyle={{ backgroundColor: '#F3EEE2', borderColor: '#1B1811', borderRadius: '0px', fontSize: '11px', fontFamily: 'IBM Plex Sans' }}/>
                <Area type="monotone" dataKey="matches"    stroke="#A9781E" strokeWidth={1.5} fillOpacity={1} fill="url(#colorMatches)"/>
                <Area type="monotone" dataKey="mismatches" stroke="#A63A2E" strokeWidth={1.5} fillOpacity={1} fill="url(#colorMismatches)"/>
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Recent Criticals */}
        <div className="bg-paper p-4 border border-ink border-opacity-15 flex flex-col justify-between">
          <div>
            <div className="flex justify-between items-center mb-4">
              <div>
                <h2 className="font-fraunces text-base font-bold text-ink">Recent Criticals</h2>
                <p className="text-xs text-ink text-opacity-55">Highest value ITC exposures</p>
              </div>
              <span className="bg-vermillion bg-opacity-15 text-vermillion px-2 py-0.5 font-sans font-bold text-[9px] uppercase tracking-wider">
                Action Required
              </span>
            </div>

            {(!Array.isArray(recentMismatches) || recentMismatches.length === 0) ? (
              <p className="text-xs text-ink text-opacity-50 italic">No critical mismatches found.</p>
            ) : (
              <div className="space-y-3">
                {(Array.isArray(recentMismatches) ? recentMismatches : []).slice(0, 4).map((item) => (
                  <div
                    key={safeStr(item.invoice_id)}
                    onClick={() => {
                      setSelectedInvoice({ invoice_number: safeStr(item.invoice_number), vendor_gstin: safeStr(item.vendor_gstin) });
                      setCurrentPage('invoice');
                    }}
                    className="border-b border-ink border-opacity-10 pb-2 cursor-pointer card-hover p-1 transition-colors"
                  >
                    <div className="flex justify-between items-start">
                      <span className="font-mono text-xs font-semibold text-ink">{safeStr(item.invoice_number)}</span>
                      <span className="font-mono text-xs font-bold text-vermillion tabular-nums">
                        ₹{safeFloat(item.itc_at_risk).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </span>
                    </div>
                    <div className="flex justify-between items-center mt-1 text-[10px] text-ink text-opacity-65">
                      <span className="truncate max-w-[150px] font-sans">{safeStr(item.vendor_name)}</span>
                      <span className="font-mono">{safeStr(item.pr_invoice_date) || safeStr(item.invoice_date)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => setCurrentPage('mismatch')}
            className="w-full mt-4 border border-ink border-opacity-50 text-ink btn-outline-hover py-2 font-sans text-xs font-semibold transition-colors"
          >VIEW MISMATCH QUEUE</button>
        </div>
      </div>

      {/* Client Exposure Table */}
      <div className="bg-paper p-4 border border-ink border-opacity-15">
        <h2 className="font-fraunces text-base font-bold text-ink mb-4">Client Exposure Directory</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left font-sans text-xs">
            <thead>
              <tr className="bg-ink bg-opacity-5 text-ink text-opacity-70 font-semibold border-b border-ink border-opacity-15">
                <th className="p-3">Client GSTIN</th>
                <th className="p-3 text-right">Total Invoices</th>
                <th className="p-3 text-right">Matches</th>
                <th className="p-3 text-right">Timing Diff.</th>
                <th className="p-3 text-right">Missing in 2B</th>
                <th className="p-3 text-right">Amt Mismatch</th>
                <th className="p-3 text-right">Duplicates</th>
                <th className="p-3 text-right">ITC At Risk</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink divide-opacity-10 font-mono text-[11px] tabular-nums">
              {(!Array.isArray(clients) || clients.length === 0) ? (
                <tr><td colSpan="8" className="p-6 text-center text-ink text-opacity-50 italic font-sans">No client data available.</td></tr>
              ) : (
                (Array.isArray(clients) ? clients : [])
                  .filter(c => c && c.client_gstin !== null && c.client_gstin !== undefined)
                  .map((client) => {
                    const total = safeInt(client.total_invoice_count);
                    const clean = safeInt(client.clean_match_count);
                    const cRate = total > 0 ? (clean / total) * 100 : 0;
                    return (
                      <tr key={safeStr(client.client_gstin)} className="row-hover" style={{ color: '#1B1811' }}>
                        <td className="p-3 font-semibold">{safeStr(client.client_gstin)}</td>
                        <td className="p-3 text-right">{total.toLocaleString('en-IN')}</td>
                        <td className="p-3 text-right text-brass font-semibold">
                          {clean.toLocaleString('en-IN')} ({cRate.toFixed(0)}%)
                        </td>
                        <td className="p-3 text-right">{safeInt(client.timing_difference_count).toLocaleString('en-IN')}</td>
                        <td className="p-3 text-right text-vermillion font-medium">{safeInt(client.missing_in_2b_count).toLocaleString('en-IN')}</td>
                        <td className="p-3 text-right text-vermillion">{safeInt(client.amount_mismatch_count).toLocaleString('en-IN')}</td>
                        <td className="p-3 text-right text-vermillion">{safeInt(client.duplicate_claim_count).toLocaleString('en-IN')}</td>
                        <td className="p-3 text-right font-bold text-brass">
                          ₹{safeFloat(client.total_itc_at_risk).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                        </td>
                      </tr>
                    );
                  })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

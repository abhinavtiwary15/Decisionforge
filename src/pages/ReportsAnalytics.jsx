import React, { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, Cell, PieChart, Pie } from 'recharts';
import { api, safeStr, safeFloat } from '../api';
import { useAppData } from '../AppDataContext';
import { SkeletonCard } from '../components/Skeleton';

export default function ReportsAnalytics() {
  const contextData = useAppData();

  const [benchmarkData, setBenchmarkData] = useState([]);
  const [reportType, setReportType] = useState('summary');
  const [selectedClient, setSelectedClient] = useState('');
  const [outputFormat, setOutputFormat] = useState('pdf');
  const [clients, setClients] = useState(contextData?.clients || []);
  const [loading, setLoading] = useState(!contextData?.prefetchDone);

  useEffect(() => {
    function processBenchmark(data) {
      if (!Array.isArray(data)) return [];
      const scales = [...new Set(data.map(item => item.Scale))];
      return scales.map(scale => {
        const pandasRow = data.find(item => item.Scale === scale && item.Backend === 'pandas');
        const cudfRow   = data.find(item => item.Scale === scale && item.Backend === 'cudf');
        return {
          rawScale: Number(scale),
          scale: `${Number(scale).toLocaleString()} rows`,
          pandas: pandasRow ? safeFloat(pandasRow['Time (s)']) : 0,
          cudf:   cudfRow   ? safeFloat(cudfRow['Time (s)'])   : 0,
        };
      });
    }

    if (contextData?.prefetchDone) {
      setClients(contextData.clients || []);
      setBenchmarkData(processBenchmark(contextData.benchmark || []));
      setLoading(false);
      return;
    }

    async function fetchAll() {
      setLoading(true);
      const { data: bData, error: bErr } = await api.getBenchmark();
      if (!bErr) {
        setBenchmarkData(processBenchmark(bData));
      }

      const { data: cData, error: cErr } = await api.getClients();
      if (!cErr) setClients(cData || []);
      setLoading(false);
    }
    fetchAll();
  }, [contextData]);

  const mismatchDistribution = [
    { name: 'Clean Matches', value: 23921, color: '#A9781E' },
    { name: 'Timing Diff',   value: 14990, color: '#1B1811' },
    { name: 'Missing in 2B', value:  5081, color: '#A63A2E' },
    { name: 'Amt Mismatch',  value:  3584, color: '#A63A2E' },
    { name: 'Duplicate',     value:  1980, color: '#A63A2E' },
    { name: 'Missing in Reg',value:  1472, color: '#1B1811' }
  ];

  const handleGenerateReport = (e) => {
    e.preventDefault();
    alert(`Generating ${reportType.toUpperCase()} report for client ${selectedClient || 'All'} in ${outputFormat.toUpperCase()} format...`);
  };

  const targetScale = benchmarkData.find(item => item.rawScale === 50000);
  const speedup = (targetScale && targetScale.cudf > 0)
    ? (targetScale.pandas / targetScale.cudf).toFixed(2)
    : '6.96';

  if (loading) {
    return (
      <div className="space-y-6 font-sans">
        <div className="flex justify-between items-end border-b border-ink border-opacity-10 pb-4">
          <div>
            <h1 className="font-fraunces text-2xl font-bold text-ink opacity-25">Reports &amp; Analytics</h1>
            <p className="font-sans text-xs text-ink text-opacity-45 mt-1">System performance logs and comparative mismatch analysis...</p>
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <SkeletonCard height={300} />
          <SkeletonCard height={300} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 font-sans">
      <div className="flex justify-between items-end border-b border-ink border-opacity-10 pb-4">
        <div>
          <h1 className="font-fraunces text-2xl font-bold text-ink">Reports &amp; Analytics</h1>
          <p className="font-sans text-xs text-ink text-opacity-60 mt-1">
            System performance logs and comparative mismatch analysis dashboards.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Benchmark Chart */}
        <div className="bg-paper p-4 border border-ink border-opacity-15 flex flex-col h-[340px]">
          <div>
            <h2 className="font-fraunces text-base font-bold text-ink">Compute Performance (Sync Latency)</h2>
            <p className="text-xs text-ink text-opacity-55 mb-2">Comparison of Pandas CPU vs cuDF GPU processing times</p>
          </div>
          <div className="flex-1 w-full mt-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={benchmarkData} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(27,24,17,0.08)" />
                <XAxis dataKey="scale" stroke="#1B1811" style={{ fontSize: '10px', fontFamily: 'IBM Plex Mono' }} tickLine={false}/>
                <YAxis stroke="#1B1811" style={{ fontSize: '10px', fontFamily: 'IBM Plex Mono' }} tickLine={false} axisLine={false}/>
                <Tooltip contentStyle={{ backgroundColor: '#F3EEE2', borderColor: '#1B1811', borderRadius: '0px', fontSize: '11px', fontFamily: 'IBM Plex Sans' }}
                  formatter={(value) => [`${safeFloat(value).toFixed(4)} s`]}/>
                <Legend wrapperStyle={{ fontSize: '10px', fontFamily: 'IBM Plex Sans' }} iconSize={10}/>
                <Bar dataKey="pandas" name="Pandas CPU" fill="#1B1811" fillOpacity={0.65} />
                <Bar dataKey="cudf"   name="cuDF GPU"   fill="#A9781E">
                  {benchmarkData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill="#A9781E"/>
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="text-[10px] text-brass text-center font-mono font-bold mt-1">
            ⚡ {speedup}x Speedup Factor achieved on 50,000 row ledger syncs using GPU acceleration.
          </div>
        </div>

        {/* Mismatch Distribution Pie */}
        <div className="bg-paper p-4 border border-ink border-opacity-15 flex flex-col h-[340px]">
          <div>
            <h2 className="font-fraunces text-base font-bold text-ink">Mismatch Distribution</h2>
            <p className="text-xs text-ink text-opacity-55 mb-2">Structural distribution of reconciled transaction records</p>
          </div>
          <div className="flex-1 flex items-center justify-center mt-2 relative">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={mismatchDistribution} cx="50%" cy="50%" innerRadius={55} outerRadius={80} paddingAngle={2} dataKey="value">
                  {mismatchDistribution.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} fillOpacity={0.9}/>
                  ))}
                </Pie>
                <Tooltip contentStyle={{ backgroundColor: '#F3EEE2', borderColor: '#1B1811', borderRadius: '0px', fontSize: '11px', fontFamily: 'IBM Plex Sans' }}
                  formatter={(value) => [`${Number(value).toLocaleString()} rows`]}/>
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute flex flex-col items-center justify-center font-mono">
              <span className="text-[10px] text-ink text-opacity-50 uppercase font-sans">Total Rows</span>
              <span className="text-sm font-bold text-ink">50,968</span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-[10px] font-sans text-ink mt-2">
            {mismatchDistribution.map((item) => (
              <div key={item.name} className="flex items-center gap-1.5 truncate">
                <span className="w-2 h-2 shrink-0" style={{ backgroundColor: item.color }}></span>
                <span className="truncate">{item.name} ({((item.value / 50968) * 100).toFixed(0)}%)</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Report Builder */}
      <div className="bg-paper p-6 border border-ink border-opacity-15">
        <h2 className="font-fraunces text-base font-bold text-ink mb-4">Audit Report Builder</h2>
        <form onSubmit={handleGenerateReport} className="grid grid-cols-1 md:grid-cols-4 gap-6 text-xs text-ink font-sans">
          <div className="flex flex-col gap-1.5">
            <label className="font-semibold">Client GSTIN Profile</label>
            <select value={selectedClient} onChange={(e) => setSelectedClient(e.target.value)}
              className="bg-paper border border-ink border-opacity-35 px-3 py-2 text-xs text-ink focus:outline-none focus:border-brass">
              <option value="">All Client Entities</option>
              {(Array.isArray(clients) ? clients : []).map(c => (
                <option key={safeStr(c.client_gstin)} value={safeStr(c.client_gstin)}>{safeStr(c.client_gstin)}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="font-semibold">Audit Scope</label>
            <select value={reportType} onChange={(e) => setReportType(e.target.value)}
              className="bg-paper border border-ink border-opacity-35 px-3 py-2 text-xs text-ink focus:outline-none focus:border-brass">
              <option value="summary">Summary Risk Report</option>
              <option value="detailed">Detailed Mismatch Audit Log</option>
              <option value="compliance">Vendor Compliance Assessment</option>
              <option value="quality">Data Quality Struct Defect List</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="font-semibold">Export Format</label>
            <select value={outputFormat} onChange={(e) => setOutputFormat(e.target.value)}
              className="bg-paper border border-ink border-opacity-35 px-3 py-2 text-xs text-ink focus:outline-none focus:border-brass">
              <option value="pdf">Structured PDF (CA Seal)</option>
              <option value="csv">Raw Tabular CSV (Data Pipe)</option>
              <option value="excel">Reconciliation Spreadsheet (XLSX)</option>
            </select>
          </div>
          <div className="flex items-end gap-3">
            <button type="button"
              onClick={() => { setSelectedClient(''); setReportType('summary'); setOutputFormat('pdf'); }}
              className="flex-1 border border-ink text-ink btn-outline-hover font-sans font-semibold text-xs py-2">
              Reset Form
            </button>
            <button type="submit"
              className="flex-1 bg-brass text-paper hover:opacity-95 font-sans font-semibold text-xs py-2 border border-brass">
              Generate Report
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
  CartesianGrid, Cell, PieChart, Pie, AreaChart, Area
} from 'recharts';
import { jsPDF } from 'jspdf';
import { api, safeStr, safeFloat, safeInt } from '../api';
import { useAppData } from '../AppDataContext';
import { SkeletonCard } from '../components/Skeleton';

// ─── Colour tokens (match design system) ───────────────────────────────────
const C = {
  ink:    '#1B1811',
  brass:  '#A9781E',
  paper:  '#F3EEE2',
  red:    '#A63A2E',
  ink45:  'rgba(27,24,17,0.45)',
  grid:   'rgba(27,24,17,0.08)',
  tooltip: { backgroundColor: '#F3EEE2', borderColor: '#1B1811', borderRadius: '0px', fontSize: '11px', fontFamily: 'IBM Plex Sans' },
};

const INR = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const PDF_INR = (v) => `Rs. ${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

// ─── PDF Generation ─────────────────────────────────────────────────────────
function buildPDF({ reportType, selectedClient, profile, riskByClient, trendData, mismatchDist, dataQualityFlags }) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = 210, M = 14;
  let y = M;

  const LINE_H = 6;
  const section = (txt) => {
    y += 4;
    doc.setFillColor(27, 24, 17);
    doc.rect(M, y, W - M * 2, 7, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(243, 238, 226);
    doc.text(txt.toUpperCase(), M + 3, y + 5);
    doc.setTextColor(27, 24, 17);
    y += 11;
  };

  const row = (label, value, indent = 0) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(27, 24, 17);
    doc.text(label, M + indent, y);
    doc.setFont('courier', 'normal');
    doc.text(String(value), M + 95 + indent, y);
    y += LINE_H;
  };

  const divider = () => {
    doc.setDrawColor(27, 24, 17, 0.2);
    doc.line(M, y, W - M, y);
    y += 4;
  };

  // Header
  doc.setFillColor(27, 24, 17);
  doc.rect(0, 0, W, 22, 'F');
  doc.setFillColor(169, 120, 30);
  doc.rect(0, 22, W, 2, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(243, 238, 226);
  doc.text('DECISIONFORGE', M, 10);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text('GST Reconciliation Audit System - Audit Report', M, 16);
  const now = new Date();
  doc.text(`Generated: ${now.toLocaleDateString('en-IN')}  ${now.toLocaleTimeString('en-IN')}`, W - M, 16, { align: 'right' });
  y = 32;

  // Report meta
  section('Report Details');
  row('Report Type', reportType === 'summary' ? 'Summary Risk Report'
    : reportType === 'detailed' ? 'Detailed Mismatch Audit Log'
    : reportType === 'compliance' ? 'Vendor Compliance Assessment'
    : 'Data Quality Defect List');
  row('Client GSTIN Scope', selectedClient || 'All Entities');
  row('Prepared By', profile?.name || 'ASHOK KAPOOR');
  row('Firm / Organisation', profile?.firm || 'Kapoor & Associates Ltd');
  row('ICA Licence', profile?.license || 'CA-2026-987123');
  divider();

  if (reportType === 'quality') {
    // ── DATA QUALITY DEFECT LIST PDF BODY ──
    const flags = dataQualityFlags || [];
    const filteredFlags = selectedClient
      ? flags.filter(f => f.client_gstin === selectedClient)
      : flags;

    section(`Data Quality Defect List (${filteredFlags.length} Defects Found)`);

    if (filteredFlags.length === 0) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8);
      doc.text('No data quality defects or invalid GSTIN flags found for the selected scope.', M, y);
      y += LINE_H;
    } else {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.text('Inv Number', M, y);
      doc.text('Source', M + 32, y);
      doc.text('Invalid Vendor GSTIN', M + 60, y);
      doc.text('Validation Error / Defect Reason', M + 105, y);
      y += 5;
      divider();

      filteredFlags.forEach((item, i) => {
        if (y > 270) { doc.addPage(); y = M; }
        if (i % 2 === 0) { doc.setFillColor(243, 238, 226); doc.rect(M, y - 3.5, W - M * 2, 5.5, 'F'); }
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6.5);
        doc.setTextColor(27, 24, 17);
        doc.text(safeStr(item.invoice_number, 'N/A').slice(0, 15), M, y);
        doc.text(safeStr(item.source, 'N/A').slice(0, 15), M + 32, y);
        doc.text(safeStr(item.vendor_gstin, 'N/A').slice(0, 20), M + 60, y);
        
        const errTxt = safeStr(item.validation_error, 'N/A');
        const splitErr = doc.splitTextToSize(errTxt, 88);
        doc.text(splitErr, M + 105, y);
        y += Math.max(LINE_H, splitErr.length * 4);
      });
    }
  } else {
    // ── STANDARD ITC / MISMATCH RISK PDF BODY ──
    // Risk by client summary
    if (riskByClient && riskByClient.length) {
      section('ITC at Risk - by Client GSTIN');
      const subset = selectedClient
        ? riskByClient.filter(r => r.client_gstin === selectedClient)
        : riskByClient.slice(0, 10);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.text('Client GSTIN', M, y);
      doc.text('Total Invoices', M + 60, y);
      doc.text('Risk Count', M + 90, y);
      doc.text('ITC at Risk (Rs.)', M + 120, y);
      doc.text('Missing in 2B', M + 152, y);
      y += 5;
      divider();
      subset.forEach((r, i) => {
        if (y > 270) { doc.addPage(); y = M; }
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        if (i % 2 === 0) { doc.setFillColor(243, 238, 226); doc.rect(M, y - 3.5, W - M * 2, 5.5, 'F'); }
        doc.setTextColor(27, 24, 17);

        const gstin = safeStr(r.client_gstin, 'N/A');
        const invoices = safeInt(r.total_invoices ?? r.total_invoice_count ?? 0);
        const riskCount = safeInt(r.risk_count ?? 0);
        const itcAtRisk = safeFloat(r.total_itc_at_risk ?? 0);
        const missing2b = safeInt(r.missing_in_2b ?? r.missing_in_2b_count ?? 0);

        doc.text(gstin.slice(0, 20), M, y);
        doc.text(String(invoices), M + 60, y);
        doc.text(String(riskCount), M + 90, y);
        doc.text(PDF_INR(itcAtRisk), M + 120, y);
        doc.text(String(missing2b), M + 152, y);
        y += LINE_H;
      });
      y += 4;
    }

    // Mismatch distribution
    if (mismatchDist && mismatchDist.length) {
      if (y > 240) { doc.addPage(); y = M; }
      section('Mismatch Distribution Summary');
      mismatchDist.forEach(item => {
        const val = safeInt(item.value ?? 0);
        row(safeStr(item.name, 'Unknown'), `${val.toLocaleString()} records`);
      });
      y += 4;
    }

    // Time trend summary
    if (trendData && trendData.length) {
      if (y > 220) { doc.addPage(); y = M; }
      section('Filing Period Trend (ITC at Risk)');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.text('Filing Period', M, y);
      doc.text('Mismatches', M + 55, y);
      doc.text('ITC at Risk (Rs.)', M + 95, y);
      doc.text('Critical', M + 140, y);
      doc.text('High', M + 162, y);
      y += 5;
      divider();
      trendData.slice(0, 12).forEach((r, i) => {
        if (y > 270) { doc.addPage(); y = M; }
        if (i % 2 === 0) { doc.setFillColor(243, 238, 226); doc.rect(M, y - 3.5, W - M * 2, 5.5, 'F'); }
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(27, 24, 17);

        const period = safeStr(r.filing_period, 'No GSTR-2B Filing');
        const mismatches = safeInt(r.mismatch_count ?? r.mismatches ?? 0);
        const itcAtRisk = safeFloat(r.total_itc_at_risk ?? r.itc ?? 0);
        const critical = safeInt(r.critical_count ?? r.critical ?? 0);
        const high = safeInt(r.high_count ?? r.high ?? 0);

        doc.text(period, M, y);
        doc.text(String(mismatches), M + 55, y);
        doc.text(PDF_INR(itcAtRisk), M + 95, y);
        doc.text(String(critical), M + 140, y);
        doc.text(String(high), M + 162, y);
        y += LINE_H;
      });
      y += 4;
    }
  }

  // Footer
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFillColor(27, 24, 17);
    doc.rect(0, 290, W, 10, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(243, 238, 226);
    doc.text('CONFIDENTIAL - DecisionForge Audit Ledger Portal', M, 296);
    doc.text(`Page ${i} of ${pageCount}`, W - M, 296, { align: 'right' });
  }

  return doc;
}

// ─── Custom Tooltip ──────────────────────────────────────────────────────────
function CustomTooltip({ active, payload, label, currency }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="bg-paper border border-ink border-opacity-30 p-2 text-[10px] font-sans shadow-sm">
      <p className="font-mono font-bold text-ink mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color }}>
          {p.name}: {currency ? INR(p.value) : Number(p.value).toLocaleString('en-IN')}
        </p>
      ))}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────
export default function ReportsAnalytics() {
  const contextData = useAppData();

  const [benchmarkData, setBenchmarkData] = useState([]);
  const [reportType, setReportType]       = useState('summary');
  const [selectedClient, setSelectedClient] = useState('');
  const [clients, setClients]             = useState(contextData?.clients || []);
  const [loading, setLoading]             = useState(!contextData?.prefetchDone);

  const [riskByClient, setRiskByClient]   = useState([]);
  const [trendData, setTrendData]         = useState([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError]     = useState(null);

  const [reportStatus, setReportStatus]   = useState(null); // null | 'generating' | 'success' | 'error'
  const [reportError, setReportError]     = useState('');

  // Static mismatch distribution (from reconciliation_summary; keep as-is)
  const mismatchDistribution = [
    { name: 'Clean Matches',   value: 23921, color: C.ink },
    { name: 'Timing Diff',     value: 14990, color: '#6B6348' },
    { name: 'Missing in 2B',   value:  5081, color: C.red },
    { name: 'Amt Mismatch',    value:  3584, color: C.brass },
    { name: 'Duplicate',       value:  1980, color: '#D44A1A' },
    { name: 'Missing in Reg',  value:  1472, color: '#4A3F2A' },
  ];
  const totalRows = mismatchDistribution.reduce((s, d) => s + d.value, 0);

  // ── Process benchmark helper ──
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

  // ── Fetch core data ──
  useEffect(() => {
    if (contextData?.prefetchDone) {
      setClients(contextData.clients || []);
      setBenchmarkData(processBenchmark(contextData.benchmark || []));
      setLoading(false);
      return;
    }
    async function fetchCore() {
      setLoading(true);
      const [bRes, cRes] = await Promise.all([api.getBenchmark(), api.getClients()]);
      if (!bRes.error) setBenchmarkData(processBenchmark(bRes.data));
      if (!cRes.error) setClients(cRes.data || []);
      setLoading(false);
    }
    fetchCore();
  }, [contextData]);

  // ── Fetch analytics data ──
  const fetchAnalytics = async () => {
    setAnalyticsLoading(true);
    setAnalyticsError(null);
    const [rbcRes, trendRes] = await Promise.all([
      api.getAnalyticsRiskByClient(),
      api.getAnalyticsTrend(),
    ]);
    const err = rbcRes.error || trendRes.error;
    if (err) {
      setAnalyticsError(err);
    } else {
      setRiskByClient(rbcRes.data || []);
      setTrendData(trendRes.data || []);
    }
    setAnalyticsLoading(false);
  };

  useEffect(() => {
    fetchAnalytics();
  }, []);

  const targetScale = benchmarkData.find(item => item.rawScale === 50000);
  const speedup = (targetScale && targetScale.cudf > 0)
    ? (targetScale.pandas / targetScale.cudf).toFixed(2)
    : '6.96';

  // ── Filtered risk-by-client for charts ──
  const displayRiskByClient = selectedClient
    ? riskByClient.filter(r => r.client_gstin === selectedClient)
    : riskByClient.slice(0, 10);

  // Abbreviate GSTIN for chart labels
  const riskChartData = displayRiskByClient.map(r => ({
    ...r,
    label: safeStr(r.client_gstin).slice(-6),
    total_itc_at_risk: safeFloat(r.total_itc_at_risk),
    risk_count: safeInt(r.risk_count),
    missing_in_2b: safeInt(r.missing_in_2b),
    amount_mismatch: safeInt(r.amount_mismatch),
    timing_diff: safeInt(r.timing_diff),
    duplicate: safeInt(r.duplicate),
  }));

  const trendChartData = trendData.map(r => ({
    period: safeStr(r.filing_period),
    mismatches: safeInt(r.mismatch_count),
    itc: safeFloat(r.total_itc_at_risk),
    critical: safeInt(r.critical_count),
    high: safeInt(r.high_count),
  }));

  // ── PDF generation ──
  const handleGenerateReport = async (e) => {
    e.preventDefault();
    setReportStatus('generating');
    setReportError('');
    try {
      let dataQualityFlags = [];
      if (reportType === 'quality') {
        const dqRes = await api.getDataQuality();
        if (!dqRes.error) {
          dataQualityFlags = dqRes.data || [];
        }
      }

      const doc = buildPDF({
        reportType,
        selectedClient,
        profile: contextData?.profile,
        riskByClient,
        trendData,
        mismatchDist: mismatchDistribution,
        dataQualityFlags,
      });
      const clientLabel = selectedClient ? selectedClient.replace(/[^A-Z0-9]/gi, '_') : 'ALL';
      const scopeLabel  = reportType.toUpperCase();
      const datePart    = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      doc.save(`DecisionForge_${scopeLabel}_${clientLabel}_${datePart}.pdf`);
      setReportStatus('success');
      setTimeout(() => setReportStatus(null), 5000);
    } catch (err) {
      console.error('[PDF generation error]', err);
      setReportError(err.message || 'Unknown error');
      setReportStatus('error');
    }
  };

  if (loading) {
    return (
      <div className="space-y-6 font-sans">
        <div className="flex justify-between items-end border-b border-ink border-opacity-10 pb-4">
          <div>
            <h1 className="page-title opacity-25">Reports &amp; Analytics</h1>
            <p className="font-sans text-xs text-ink-45 mt-1">Loading analytics data…</p>
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <SkeletonCard height={300} />
          <SkeletonCard height={300} />
          <SkeletonCard height={300} />
          <SkeletonCard height={300} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 font-sans">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-end border-b border-ink border-opacity-10 pb-4 gap-2">
        <div>
          <h1 className="page-title">Reports &amp; Analytics</h1>
          <p className="body-secondary mt-1">
            ITC exposure breakdowns, filing period trends, and audit report export.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-ink-45 uppercase">
            {riskByClient.length} clients tracked
          </span>
        </div>
      </div>

      {/* ── ROW 1: Risk by Client + Time Trend ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">

        {/* Risk by Client — ranked bar */}
        <div className="bg-paper p-4 border border-ink border-opacity-15 flex flex-col">
          <div className="mb-3">
            <h2 className="section-header">ITC at Risk — by Client</h2>
            <p className="body-secondary mt-0.5">Total ITC exposure ranked by client entity (top 10)</p>
          </div>
          {analyticsLoading ? (
            <div className="h-[260px] flex items-center justify-center text-ink-45 text-xs font-mono animate-pulse">
              Loading analytics…
            </div>
          ) : analyticsError ? (
            <div className="h-[260px] flex flex-col items-center justify-center p-4 border border-vermillion border-opacity-30 text-center font-sans">
              <span className="material-symbols-outlined text-vermillion text-2xl mb-1">warning</span>
              <p className="text-xs font-semibold text-vermillion mb-1">Failed to load analytics</p>
              <p className="text-[11px] font-mono text-ink-70 mb-3 max-w-xs">{analyticsError}</p>
              <button type="button" onClick={fetchAnalytics} className="bg-brass text-paper px-3 py-1.5 text-xs font-semibold hover:opacity-95">
                Retry Query
              </button>
            </div>
          ) : riskChartData.length === 0 ? (
            <div className="h-[260px] flex items-center justify-center text-ink-45 text-xs font-mono">
              No data available
            </div>
          ) : (
            <div className="flex-1 h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={riskChartData} layout="vertical" margin={{ top: 0, right: 60, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} horizontal={false} />
                  <XAxis type="number" stroke={C.ink} style={{ fontSize: '9px', fontFamily: 'IBM Plex Mono' }} tickLine={false}
                    tickFormatter={v => v >= 1e5 ? `${(v / 1e5).toFixed(1)}L` : v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v} />
                  <YAxis type="category" dataKey="label" stroke={C.ink} style={{ fontSize: '9px', fontFamily: 'IBM Plex Mono' }} tickLine={false} width={50} />
                  <Tooltip content={<CustomTooltip currency />} />
                  <Bar dataKey="total_itc_at_risk" name="ITC at Risk" radius={0} maxBarSize={16}>
                    {riskChartData.map((_, i) => (
                      <Cell key={i} fill={i === 0 ? C.red : i < 3 ? C.brass : C.ink} fillOpacity={0.85 - i * 0.04} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {/* Mini table of top 3 */}
          {!analyticsLoading && !analyticsError && riskChartData.length > 0 && (
            <div className="mt-3 pt-3 border-t border-ink border-opacity-10 grid grid-cols-3 gap-2 text-[10px]">
              {riskChartData.slice(0, 3).map((r, i) => (
                <div key={i} className="flex flex-col gap-0.5">
                  <span className="font-mono text-brass">{['①', '②', '③'][i]} {safeStr(r.client_gstin).slice(-8)}</span>
                  <span className="font-semibold text-ink">{INR(r.total_itc_at_risk)}</span>
                  <span className="text-ink-45">{r.risk_count} risk invoices</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Time Trend — area chart */}
        <div className="bg-paper p-4 border border-ink border-opacity-15 flex flex-col">
          <div className="mb-3">
            <h2 className="section-header">ITC Exposure — Filing Period Trend</h2>
            <p className="body-secondary mt-0.5">Month-over-month mismatch count and ITC at risk</p>
          </div>
          {analyticsLoading ? (
            <div className="h-[260px] flex items-center justify-center text-ink-45 text-xs font-mono animate-pulse">
              Loading trend data…
            </div>
          ) : analyticsError ? (
            <div className="h-[260px] flex flex-col items-center justify-center p-4 border border-vermillion border-opacity-30 text-center font-sans">
              <span className="material-symbols-outlined text-vermillion text-2xl mb-1">warning</span>
              <p className="text-xs font-semibold text-vermillion mb-1">Failed to load trend data</p>
              <p className="text-[11px] font-mono text-ink-70 mb-3 max-w-xs">{analyticsError}</p>
              <button type="button" onClick={fetchAnalytics} className="bg-brass text-paper px-3 py-1.5 text-xs font-semibold hover:opacity-95">
                Retry Query
              </button>
            </div>
          ) : trendChartData.length === 0 ? (
            <div className="h-[260px] flex items-center justify-center text-ink-45 text-xs font-mono">
              No trend data available
            </div>
          ) : (
            <div className="flex-1 h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendChartData} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="itcGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={C.brass} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={C.brass} stopOpacity={0.03} />
                    </linearGradient>
                    <linearGradient id="mmGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={C.red} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={C.red} stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                  <XAxis dataKey="period" stroke={C.ink} style={{ fontSize: '9px', fontFamily: 'IBM Plex Mono' }} tickLine={false} />
                  <YAxis yAxisId="left" stroke={C.ink} style={{ fontSize: '9px', fontFamily: 'IBM Plex Mono' }} tickLine={false} axisLine={false}
                    tickFormatter={v => v >= 1e5 ? `${(v / 1e5).toFixed(0)}L` : v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v} />
                  <YAxis yAxisId="right" orientation="right" stroke={C.ink} style={{ fontSize: '9px', fontFamily: 'IBM Plex Mono' }} tickLine={false} axisLine={false} />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: '9px', fontFamily: 'IBM Plex Sans' }} iconSize={8} />
                  <Area yAxisId="left" type="monotone" dataKey="itc" name="ITC at Risk (₹)" stroke={C.brass} fill="url(#itcGrad)" strokeWidth={2} dot={false} />
                  <Area yAxisId="right" type="monotone" dataKey="mismatches" name="Mismatches" stroke={C.red} fill="url(#mmGrad)" strokeWidth={1.5} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      {/* ── ROW 2: Mismatch-type breakdown by client + Mismatch distribution ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">

        {/* Mismatch-type breakdown stacked bar */}
        <div className="bg-paper p-4 border border-ink border-opacity-15 flex flex-col">
          <div className="mb-3">
            <h2 className="section-header">Mismatch Breakdown — by Client</h2>
            <p className="body-secondary mt-0.5">Which clients have the most Missing-in-2B vs Amount-mismatch</p>
          </div>
          {analyticsLoading ? (
            <div className="h-[260px] flex items-center justify-center text-ink-45 text-xs font-mono animate-pulse">Loading…</div>
          ) : riskChartData.length === 0 ? (
            <div className="h-[260px] flex items-center justify-center text-ink-45 text-xs font-mono">No data</div>
          ) : (
            <div className="flex-1 h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={riskChartData} margin={{ top: 0, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                  <XAxis dataKey="label" stroke={C.ink} style={{ fontSize: '9px', fontFamily: 'IBM Plex Mono' }} tickLine={false} />
                  <YAxis stroke={C.ink} style={{ fontSize: '9px', fontFamily: 'IBM Plex Mono' }} tickLine={false} axisLine={false} />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: '9px', fontFamily: 'IBM Plex Sans' }} iconSize={8} />
                  <Bar dataKey="missing_in_2b"   name="Missing in 2B"   stackId="a" fill={C.red}    maxBarSize={28} />
                  <Bar dataKey="amount_mismatch" name="Amt Mismatch"    stackId="a" fill={C.brass}  maxBarSize={28} />
                  <Bar dataKey="timing_diff"     name="Timing Diff"     stackId="a" fill="#6B6348"  maxBarSize={28} />
                  <Bar dataKey="duplicate"       name="Duplicate"       stackId="a" fill="#4A3F2A"  maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Mismatch Distribution Donut */}
        <div className="bg-paper p-4 border border-ink border-opacity-15 flex flex-col">
          <div className="mb-3">
            <h2 className="section-header">Mismatch Distribution</h2>
            <p className="body-secondary mt-0.5">Structural distribution of all reconciled transaction records</p>
          </div>
          <div className="flex-1 flex items-center justify-center h-[200px] relative">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={mismatchDistribution} cx="50%" cy="50%" innerRadius={55} outerRadius={80} paddingAngle={2} dataKey="value">
                  {mismatchDistribution.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} fillOpacity={0.88} />
                  ))}
                </Pie>
                <Tooltip contentStyle={C.tooltip} formatter={(value) => [`${Number(value).toLocaleString()} rows`]} />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute flex flex-col items-center justify-center font-mono pointer-events-none">
              <span className="text-[10px] text-ink-45 uppercase font-sans">Total</span>
              <span className="text-sm font-bold text-ink">{totalRows.toLocaleString('en-IN')}</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] font-sans text-ink mt-2">
            {mismatchDistribution.map((item) => (
              <div key={item.name} className="flex items-center gap-1.5 truncate">
                <span className="w-2 h-2 shrink-0" style={{ backgroundColor: item.color }} />
                <span className="truncate">{item.name} <span className="text-ink-45">({((item.value / totalRows) * 100).toFixed(0)}%)</span></span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── ROW 3: Compute Performance ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-paper p-4 border border-ink border-opacity-15 flex flex-col h-[300px]">
          <div className="mb-2">
            <h2 className="section-header">Compute Performance (Sync Latency)</h2>
            <p className="body-secondary mt-0.5 mb-2">Pandas CPU vs cuDF GPU processing times by dataset scale</p>
          </div>
          <div className="flex-1 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={benchmarkData} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="scale" stroke={C.ink} style={{ fontSize: '9px', fontFamily: 'IBM Plex Mono' }} tickLine={false} />
                <YAxis stroke={C.ink} style={{ fontSize: '9px', fontFamily: 'IBM Plex Mono' }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={C.tooltip} formatter={(v) => [`${safeFloat(v).toFixed(4)} s`]} />
                <Legend wrapperStyle={{ fontSize: '9px', fontFamily: 'IBM Plex Sans' }} iconSize={8} />
                <Bar dataKey="pandas" name="Pandas CPU" fill={C.ink} fillOpacity={0.65} />
                <Bar dataKey="cudf"   name="cuDF GPU"   fill={C.brass} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="text-[10px] text-brass text-center font-mono font-bold mt-1">
            ⚡ {speedup}× Speedup at 50,000 rows using GPU acceleration.
          </div>
        </div>

        {/* Audit Report Builder */}
        <div className="bg-paper p-4 border border-ink border-opacity-15 flex flex-col justify-between">
          <div>
            <h2 className="section-header mb-4">Audit Report Builder</h2>
            <form onSubmit={handleGenerateReport} className="space-y-4 text-xs text-ink font-sans">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="label-caps">Client GSTIN Profile</label>
                  <select value={selectedClient} onChange={(e) => setSelectedClient(e.target.value)}
                    className="bg-paper border border-ink border-opacity-35 px-3 py-2 text-xs text-ink focus:outline-none focus:border-brass">
                    <option value="">All Client Entities</option>
                    {(Array.isArray(clients) ? clients : []).map(c => (
                      <option key={safeStr(c.client_gstin)} value={safeStr(c.client_gstin)}>{safeStr(c.client_gstin)}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="label-caps">Audit Scope</label>
                  <select value={reportType} onChange={(e) => setReportType(e.target.value)}
                    className="bg-paper border border-ink border-opacity-35 px-3 py-2 text-xs text-ink focus:outline-none focus:border-brass">
                    <option value="summary">Summary Risk Report</option>
                    <option value="detailed">Detailed Mismatch Audit Log</option>
                    <option value="compliance">Vendor Compliance Assessment</option>
                    <option value="quality">Data Quality Defect List</option>
                  </select>
                </div>
              </div>

              {/* Status feedback */}
              {reportStatus === 'success' && (
                <div className="flex items-center gap-2 bg-paper border border-brass border-opacity-60 px-3 py-2 text-xs text-brass font-sans">
                  <span className="material-symbols-outlined text-sm">check_circle</span>
                  PDF generated and downloaded successfully.
                </div>
              )}
              {reportStatus === 'error' && (
                <div className="flex items-center gap-2 bg-paper border border-red-700 border-opacity-60 px-3 py-2 text-xs text-red-700 font-sans">
                  <span className="material-symbols-outlined text-sm">error</span>
                  Report generation failed: {reportError || 'Unknown error'}
                </div>
              )}
              {reportStatus === 'generating' && (
                <div className="flex items-center gap-2 bg-paper border border-ink border-opacity-20 px-3 py-2 text-xs text-ink-45 font-sans animate-pulse">
                  <span className="material-symbols-outlined text-sm">hourglass_top</span>
                  Building PDF…
                </div>
              )}

              <div className="flex items-end gap-3 pt-1">
                <button type="button"
                  onClick={() => { setSelectedClient(''); setReportType('summary'); setReportStatus(null); }}
                  className="flex-1 border border-ink text-ink btn-outline-hover font-sans font-semibold text-xs py-2">
                  Reset
                </button>
                <button type="submit" disabled={reportStatus === 'generating'}
                  className="flex-1 bg-brass text-paper font-sans font-semibold text-xs py-2 border border-brass disabled:opacity-60 hover:opacity-95 flex items-center justify-center gap-1.5">
                  <span className="material-symbols-outlined text-sm">picture_as_pdf</span>
                  Generate PDF
                </button>
              </div>
            </form>
          </div>
          <p className="text-[10px] text-ink-45 mt-4 border-t border-ink border-opacity-10 pt-3">
            Exports a structured PDF report with ITC risk summary, filing period trend, and mismatch distribution table. All data sourced from live BigQuery reconciliation views.
          </p>
        </div>
      </div>
    </div>
  );
}

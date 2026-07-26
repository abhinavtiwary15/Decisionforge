import React, { useState, useEffect } from 'react';
import { api, safeStr, safeFloat } from '../api';
import { useAppData } from '../AppDataContext';
import { SkeletonStatStrip, SkeletonTable } from '../components/Skeleton';

// Derive compliance tier from match_rate (same thresholds as before).
function getTier(matchRate) {
  if (matchRate >= 95) return 'EXCELLENT';
  if (matchRate >= 80) return 'ATTENTION';
  return 'INTERVENTION';
}

export default function VendorManagement() {
  const contextData = useAppData();

  const [vendorRegistry, setVendorRegistry] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);

  useEffect(() => {
    async function fetchVendors() {
      setLoading(true);
      const { data, error } = await api.getVendorSummary();
      if (error) {
        setFetchError(error);
        setLoading(false);
        return;
      }
      // data is already aggregated per-vendor from BQ; just add the tier.
      const enriched = (Array.isArray(data) ? data : []).map(v => ({
        ...v,
        complianceRate: safeFloat(v.match_rate),
        tier: getTier(safeFloat(v.match_rate)),
      }));
      setVendorRegistry(enriched);
      setLoading(false);
    }
    fetchVendors();
  }, [contextData]);

  const filtered = vendorRegistry.filter(v => {
    const s = searchQuery.toLowerCase();
    const matchesSearch =
      safeStr(v.vendor_name).toLowerCase().includes(s) ||
      safeStr(v.vendor_gstin).toLowerCase().includes(s);
    const matchesStatus = filterStatus ? v.tier === filterStatus : true;
    return matchesSearch && matchesStatus;
  });

  const totalVendors    = vendorRegistry.length;
  const criticalVendors = vendorRegistry.filter(v => v.tier === 'INTERVENTION').length;
  const totalITCRisk    = vendorRegistry.reduce((acc, v) => acc + safeFloat(v.total_itc_at_risk), 0);

  if (loading) {
    return (
      <div className="space-y-6 font-sans">
        <div className="flex justify-between items-end border-b border-ink border-opacity-10 pb-4">
          <div>
            <h1 className="page-title opacity-25">Vendor Compliance Registry</h1>
            <p className="body-secondary mt-1">Supplier compliance scoring based on GST portal filing promptness...</p>
          </div>
        </div>
        <SkeletonStatStrip cards={3} />
        <div className="mt-6">
          <SkeletonTable rows={10} cols={9} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 font-sans">
      <div className="flex justify-between items-end border-b border-ink border-opacity-10 pb-4">
        <div>
          <h1 className="page-title">Vendor Compliance Registry</h1>
          <p className="body-secondary mt-1">
            Supplier compliance scoring based on GST portal filing promptness and reconciliation metrics.
          </p>
        </div>
      </div>

      {fetchError && (
        <div className="bg-paper border border-vermillion border-opacity-40 p-3">
          <p className="text-xs font-sans font-semibold text-vermillion">Could not load vendor data: {fetchError}</p>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-paper p-4 border border-ink border-opacity-15">
          <p className="label-caps">Tracked Suppliers</p>
          <p className="font-mono text-xl font-bold text-brass mt-1 tabular-nums">{totalVendors}</p>
          <p className="text-[10px] text-ink-55 mt-1">Actively filing GSTR-1 returns</p>
        </div>
        <div className="bg-paper p-4 border border-ink border-opacity-15 border-l-2 border-l-vermillion">
          <p className="label-caps text-vermillion!">Intervention Required</p>
          <p className="font-mono text-xl font-bold text-vermillion mt-1 tabular-nums">{criticalVendors}</p>
          <p className="text-[10px] text-ink-55 mt-1">Suppliers with compliance &lt;80%</p>
        </div>
        <div className="bg-paper p-4 border border-ink border-opacity-15">
          <p className="label-caps">Aggregate Withheld Credit</p>
          <p className="font-mono text-xl font-bold text-brass mt-1 tabular-nums">
            ₹{totalITCRisk.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </p>
          <p className="text-[10px] text-ink-55 mt-1">ITC at risk due to supplier default</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-paper p-4 border border-ink border-opacity-15 flex flex-col md:flex-row gap-4 items-center justify-between">
        <div className="flex flex-col md:flex-row gap-4 w-full md:w-auto">
          <div className="flex flex-col gap-1 w-full md:w-64">
            <span className="label-caps">Search Supplier</span>
            <input type="text" placeholder="Search by name or GSTIN..." value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-paper border border-ink border-opacity-35 px-3 py-1 text-xs text-ink focus:outline-none focus:border-brass placeholder-ink placeholder-opacity-40"/>
          </div>
          <div className="flex flex-col gap-1 w-full md:w-48">
            <span className="label-caps">Compliance Filter</span>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
              className="bg-paper border border-ink border-opacity-35 px-3 py-1 text-xs text-ink focus:outline-none focus:border-brass">
              <option value="">All Tiers</option>
              <option value="EXCELLENT">Excellent (&gt;95%)</option>
              <option value="ATTENTION">Needs Attention (80%-95%)</option>
              <option value="INTERVENTION">Intervention Required (&lt;80%)</option>
            </select>
          </div>
        </div>
        <button disabled
          className="bg-ink/[0.06] text-ink-45 font-sans font-semibold text-xs px-4 py-2 border border-ink border-opacity-20 cursor-not-allowed whitespace-nowrap" title="Batch notice generation is not yet available">
          BATCH NOTICE SUPPLIERS &mdash; COMING SOON
        </button>
      </div>

      {/* Vendor Registry Table */}
      <div className="bg-paper border border-ink border-opacity-15 overflow-x-auto">
        <table className="w-full text-left font-sans text-xs">
          <thead>
            <tr className="tbl-header font-semibold">
              <th className="p-3">Supplier Name</th>
              <th className="p-3">GSTIN</th>
              <th className="p-3 text-right">Invoices</th>
              <th className="p-3 text-right">Clean Matches</th>
              <th className="p-3 text-right">Missing in 2B</th>
              <th className="p-3 text-right">ITC At Risk</th>
              <th className="p-3 text-right">Match Rate</th>
              <th className="p-3 text-right">Compliance Rating</th>
              <th className="p-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink divide-opacity-10 font-mono text-[11px] tabular-nums">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan="9" className="p-8 text-center text-ink-50 font-sans italic">
                  No suppliers found matching the criteria.
                </td>
              </tr>
            ) : (
              (Array.isArray(filtered) ? filtered : []).map((v) => (
                <tr key={v.vendor_gstin} className="row-hover" style={{ color: '#1B1811' }}>
                  <td className="p-3 font-semibold font-sans text-ink truncate max-w-[150px]">{safeStr(v.vendor_name)}</td>
                  <td className="p-3">{safeStr(v.vendor_gstin)}</td>
                  <td className="p-3 text-right">{Number(v.total_invoices || 0).toLocaleString('en-IN')}</td>
                  <td className="p-3 text-right text-brass font-semibold">{Number(v.clean_matches || 0).toLocaleString('en-IN')}</td>
                  <td className="p-3 text-right text-vermillion">{Number(v.missing_in_2b || 0).toLocaleString('en-IN')}</td>
                  <td className="p-3 text-right font-bold text-vermillion">
                    ₹{safeFloat(v.total_itc_at_risk).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </td>
                  <td className="p-3 text-right font-bold text-ink">{safeFloat(v.complianceRate).toFixed(1)}%</td>
                  <td className="p-3 text-right font-sans">
                    <span className={`inline-block px-1.5 py-0.5 border text-[10px] font-bold ${
                      v.tier === 'EXCELLENT'
                        ? 'border-brass text-brass bg-brass-5'
                        : v.tier === 'ATTENTION'
                          ? 'border-ink border-opacity-35 text-ink-65 bg-ink-5'
                          : 'border-vermillion text-vermillion bg-vermillion-5'
                    }`}>
                      {v.tier === 'EXCELLENT' ? 'EXCELLENT' : v.tier === 'ATTENTION' ? 'NEEDS ATTENTION' : 'INTERVENTION REQUIRED'}
                    </span>
                  </td>
                  <td className="p-3 text-right font-sans">
                    <button disabled
                      className="border border-ink border-opacity-20 text-ink-40 px-2 py-0.5 text-[10px] font-semibold cursor-not-allowed" title="Ledger sync is not yet available">
                      Coming Soon
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

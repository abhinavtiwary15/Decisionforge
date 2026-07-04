import React, { useState, useEffect } from 'react';
import { api, safeStr, safeFloat } from '../api';
import { useAppData } from '../AppDataContext';
import { SkeletonStatStrip, SkeletonTable } from '../components/Skeleton';

export default function VendorManagement() {
  const contextData = useAppData();

  const [vendorRegistry, setVendorRegistry] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [loading, setLoading] = useState(!contextData?.prefetchDone);
  const [fetchError, setFetchError] = useState(null);

  useEffect(() => {
    // Helper to group and calculate registry from reconciliation array
    function processVendors(items) {
      const grouped = {};
      items.forEach(item => {
        const gstin = safeStr(item.vendor_gstin);
        if (!gstin) return;
        if (!grouped[gstin]) {
          grouped[gstin] = {
            vendor_gstin: gstin,
            vendor_name: safeStr(item.vendor_name) || 'Unknown Vendor',
            total_invoices: 0,
            clean_matches: 0,
            missing_in_2b: 0,
            amount_mismatches: 0,
            total_itc_at_risk: 0
          };
        }
        const v = grouped[gstin];
        v.total_invoices += 1;
        if (item.mismatch_type === 'CLEAN_MATCH') v.clean_matches += 1;
        else if (item.mismatch_type === 'MISSING_IN_2B') v.missing_in_2b += 1;
        else if (item.mismatch_type === 'AMOUNT_MISMATCH') v.amount_mismatches += 1;
        v.total_itc_at_risk += safeFloat(item.itc_at_risk);
      });

      return Object.values(grouped).map(v => {
        const complianceRate = v.total_invoices > 0 ? (v.clean_matches / v.total_invoices) * 100 : 0;
        let tier = 'EXCELLENT';
        if (complianceRate < 80) tier = 'INTERVENTION';
        else if (complianceRate < 95) tier = 'ATTENTION';
        return { ...v, complianceRate, tier };
      });
    }

    if (contextData?.prefetchDone && contextData?.vendorRecon) {
      setVendorRegistry(processVendors(contextData.vendorRecon.data || []));
      setLoading(false);
      return;
    }

    async function fetchVendors() {
      setLoading(true);
      const { data, error } = await api.getReconciliation({ limit: 1000 });
      if (error) {
        setFetchError(error);
        setLoading(false);
        return;
      }
      setVendorRegistry(processVendors(data?.data || []));
      setLoading(false);
    }
    fetchVendors();
  }, [contextData]);

  const filtered = vendorRegistry.filter(v => {
    const s = searchQuery.toLowerCase();
    const matchesSearch = v.vendor_name.toLowerCase().includes(s) || v.vendor_gstin.toLowerCase().includes(s);
    const matchesStatus = filterStatus ? v.tier === filterStatus : true;
    return matchesSearch && matchesStatus;
  });

  const totalVendors   = vendorRegistry.length;
  const criticalVendors= vendorRegistry.filter(v => v.tier === 'INTERVENTION').length;
  const totalITCRisk   = vendorRegistry.reduce((acc, curr) => acc + curr.total_itc_at_risk, 0);

  if (loading) {
    return (
      <div className="space-y-6 font-sans">
        <div className="flex justify-between items-end border-b border-ink border-opacity-10 pb-4">
          <div>
            <h1 className="font-fraunces text-2xl font-bold text-ink opacity-25">Vendor Compliance Registry</h1>
            <p className="font-sans text-xs text-ink text-opacity-45 mt-1">Supplier compliance scoring based on GST portal filing promptness...</p>
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
          <h1 className="font-fraunces text-2xl font-bold text-ink">Vendor Compliance Registry</h1>
          <p className="font-sans text-xs text-ink text-opacity-60 mt-1">
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
          <p className="text-[10px] uppercase tracking-wider font-semibold text-ink text-opacity-65">Tracked Suppliers</p>
          <p className="font-mono text-xl font-bold text-brass mt-1 tabular-nums">{totalVendors}</p>
          <p className="text-[10px] text-ink text-opacity-55 mt-1">Actively filing GSTR-1 returns</p>
        </div>
        <div className="bg-paper p-4 border border-ink border-opacity-15 border-l-2 border-l-vermillion">
          <p className="text-[10px] uppercase tracking-wider font-semibold text-vermillion">Intervention Required</p>
          <p className="font-mono text-xl font-bold text-vermillion mt-1 tabular-nums">{criticalVendors}</p>
          <p className="text-[10px] text-ink text-opacity-55 mt-1">Suppliers with compliance &lt;80%</p>
        </div>
        <div className="bg-paper p-4 border border-ink border-opacity-15">
          <p className="text-[10px] uppercase tracking-wider font-semibold text-ink text-opacity-65">Aggregate Withheld Credit</p>
          <p className="font-mono text-xl font-bold text-brass mt-1 tabular-nums">
            ₹{totalITCRisk.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </p>
          <p className="text-[10px] text-ink text-opacity-55 mt-1">ITC at risk due to supplier default</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-paper p-4 border border-ink border-opacity-15 flex flex-col md:flex-row gap-4 items-center justify-between">
        <div className="flex flex-col md:flex-row gap-4 w-full md:w-auto">
          <div className="flex flex-col gap-1 w-full md:w-64">
            <span className="text-[10px] uppercase font-semibold text-ink text-opacity-65">Search Supplier</span>
            <input type="text" placeholder="Search by name or GSTIN..." value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-paper border border-ink border-opacity-35 px-3 py-1 text-xs text-ink focus:outline-none focus:border-brass placeholder-ink placeholder-opacity-40"/>
          </div>
          <div className="flex flex-col gap-1 w-full md:w-48">
            <span className="text-[10px] uppercase font-semibold text-ink text-opacity-65">Compliance Filter</span>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
              className="bg-paper border border-ink border-opacity-35 px-3 py-1 text-xs text-ink focus:outline-none focus:border-brass">
              <option value="">All Tiers</option>
              <option value="EXCELLENT">Excellent (&gt;95%)</option>
              <option value="ATTENTION">Needs Attention (80%-95%)</option>
              <option value="INTERVENTION">Intervention Required (&lt;80%)</option>
            </select>
          </div>
        </div>
        <button onClick={() => alert(`Drafting follow-ups for ${criticalVendors} defaulted suppliers.`)}
          className="bg-brass text-paper hover:opacity-95 font-sans font-semibold text-xs px-4 py-2 border border-brass whitespace-nowrap">
          BATCH NOTICE SUPPLIERS
        </button>
      </div>

      {/* Vendor Registry Table */}
      <div className="bg-paper border border-ink border-opacity-15 overflow-x-auto">
        <table className="w-full text-left font-sans text-xs">
          <thead>
            <tr className="bg-ink bg-opacity-5 text-ink text-opacity-70 font-semibold border-b border-ink border-opacity-15">
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
                <td colSpan="9" className="p-8 text-center text-ink text-opacity-50 font-sans italic">
                  No suppliers found matching the criteria.
                </td>
              </tr>
            ) : (
              (Array.isArray(filtered) ? filtered : []).map((v) => (
                <tr key={v.vendor_gstin} className="row-hover" style={{ color: '#1B1811' }}>
                  <td className="p-3 font-semibold font-sans text-ink truncate max-w-[150px]">{v.vendor_name}</td>
                  <td className="p-3">{v.vendor_gstin}</td>
                  <td className="p-3 text-right">{v.total_invoices}</td>
                  <td className="p-3 text-right text-brass font-semibold">{v.clean_matches}</td>
                  <td className="p-3 text-right text-vermillion">{v.missing_in_2b}</td>
                  <td className="p-3 text-right font-bold text-vermillion">
                    ₹{v.total_itc_at_risk.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </td>
                  <td className="p-3 text-right font-bold text-ink">{v.complianceRate.toFixed(1)}%</td>
                  <td className="p-3 text-right font-sans">
                    <span className={`inline-block px-1.5 py-0.5 border text-[10px] font-bold ${
                      v.tier === 'EXCELLENT'
                        ? 'border-brass text-brass bg-brass bg-opacity-5'
                        : v.tier === 'ATTENTION'
                          ? 'border-ink border-opacity-35 text-ink text-opacity-65 bg-ink bg-opacity-5'
                          : 'border-vermillion text-vermillion bg-vermillion bg-opacity-5'
                    }`}>
                      {v.tier === 'EXCELLENT' ? 'EXCELLENT' : v.tier === 'ATTENTION' ? 'NEEDS ATTENTION' : 'INTERVENTION REQUIRED'}
                    </span>
                  </td>
                  <td className="p-3 text-right font-sans">
                    <button onClick={() => alert(`Initiating ledger sync for vendor ${v.vendor_gstin}`)}
                      className="border border-ink border-opacity-40 text-ink btn-outline-hover px-2 py-0.5 text-[10px] font-semibold">
                      Sync
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

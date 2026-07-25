import React, { useState } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import Sidebar from './components/Sidebar';
import SettingsPanel from './components/SettingsPanel';
import DashboardOverview from './pages/DashboardOverview';
import RiskAnalysis from './pages/RiskAnalysis';
import InvoiceDetail from './pages/InvoiceDetail';
import ReconciliationLedger from './pages/ReconciliationLedger';
import MismatchDetection from './pages/MismatchDetection';
import VendorManagement from './pages/VendorManagement';
import ReportsAnalytics from './pages/ReportsAnalytics';
import PurchaseRegisterUpload from './pages/PurchaseRegisterUpload';

export default function App() {
  const [currentPage, setCurrentPage] = useState('dashboard');
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  // Signals InvoiceDetail to auto-open a draft type when navigating from Mismatch page
  const [defaultDraftType, setDefaultDraftType] = useState(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const handleNavChange = (pageId) => {
    setCurrentPage(pageId);
    setMobileMenuOpen(false);
  };

  const renderPage = () => {
    switch (currentPage) {
      case 'dashboard':
        return <DashboardOverview setCurrentPage={handleNavChange} setSelectedInvoice={setSelectedInvoice} />;
      case 'risk':
        return <RiskAnalysis setCurrentPage={handleNavChange} setSelectedInvoice={setSelectedInvoice} />;
      case 'ledger':
        return <ReconciliationLedger setCurrentPage={handleNavChange} setSelectedInvoice={setSelectedInvoice} />;
      case 'mismatch':
        return <MismatchDetection setCurrentPage={handleNavChange} setSelectedInvoice={setSelectedInvoice} setDefaultDraftType={setDefaultDraftType} />;
      case 'vendor':
        return <VendorManagement />;
      case 'invoice':
        return <InvoiceDetail selectedInvoice={selectedInvoice} setCurrentPage={handleNavChange} defaultDraftType={defaultDraftType} onDraftTypeConsumed={() => setDefaultDraftType(null)} />;
      case 'reports':
        return <ReportsAnalytics />;
      case 'upload':
        return <PurchaseRegisterUpload setCurrentPage={handleNavChange} />;
      default:
        return <DashboardOverview setCurrentPage={handleNavChange} setSelectedInvoice={setSelectedInvoice} />;
    }
  };

  return (
    <div className="min-h-screen text-ink antialiased flex flex-col md:flex-row" style={{ backgroundColor: '#FAF8F5' }}>
      {/* Mobile Top Header Bar (< 768px) */}
      <div className="md:hidden flex items-center justify-between p-4 border-b border-ink border-opacity-15 sticky top-0 z-30" style={{ backgroundColor: '#1B1811', color: '#F3EEE2' }}>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 flex items-center justify-center shrink-0" style={{ backgroundColor: '#A9781E', borderRadius: '2px' }}>
            <span className="material-symbols-outlined text-base text-paper">account_balance</span>
          </div>
          <div>
            <h2 className="font-fraunces text-base font-bold leading-none text-paper">DecisionForge</h2>
            <p className="font-sans text-[10px] text-paper opacity-60">Audit Ledger Portal</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {/* Settings gear on mobile header */}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="p-1.5 text-paper opacity-60 hover:opacity-100 focus:outline-none flex items-center"
            aria-label="Open Settings"
          >
            <span className="material-symbols-outlined text-xl">settings</span>
          </button>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(prev => !prev)}
            className="p-1.5 text-paper hover:text-brass focus:outline-none flex items-center"
            aria-label="Toggle Navigation Menu"
          >
            <span className="material-symbols-outlined text-2xl">{mobileMenuOpen ? 'close' : 'menu'}</span>
          </button>
        </div>
      </div>

      <Sidebar
        currentPage={currentPage}
        setCurrentPage={handleNavChange}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="flex-1 p-4 md:p-8 md:ml-64 min-h-screen w-full max-w-full overflow-x-hidden">
        {/* Per-page error boundary: each page gets its own boundary so a
            crash in one page doesn't take down the sidebar or other pages. */}
        <ErrorBoundary key={currentPage}>
          {renderPage()}
        </ErrorBoundary>
      </main>

      {/* Global Settings slide-over panel */}
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

import React, { useState } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import Sidebar from './components/Sidebar';
import DashboardOverview from './pages/DashboardOverview';
import RiskAnalysis from './pages/RiskAnalysis';
import InvoiceDetail from './pages/InvoiceDetail';
import ReconciliationLedger from './pages/ReconciliationLedger';
import MismatchDetection from './pages/MismatchDetection';
import VendorManagement from './pages/VendorManagement';
import ReportsAnalytics from './pages/ReportsAnalytics';
import Settings from './pages/Settings';

export default function App() {
  const [currentPage, setCurrentPage] = useState('dashboard');
  const [selectedInvoice, setSelectedInvoice] = useState(null);

  const renderPage = () => {
    switch (currentPage) {
      case 'dashboard':
        return <DashboardOverview setCurrentPage={setCurrentPage} setSelectedInvoice={setSelectedInvoice} />;
      case 'risk':
        return <RiskAnalysis setCurrentPage={setCurrentPage} setSelectedInvoice={setSelectedInvoice} />;
      case 'ledger':
        return <ReconciliationLedger setCurrentPage={setCurrentPage} setSelectedInvoice={setSelectedInvoice} />;
      case 'mismatch':
        return <MismatchDetection setCurrentPage={setCurrentPage} setSelectedInvoice={setSelectedInvoice} />;
      case 'vendor':
        return <VendorManagement />;
      case 'invoice':
        return <InvoiceDetail selectedInvoice={selectedInvoice} setCurrentPage={setCurrentPage} />;
      case 'reports':
        return <ReportsAnalytics />;
      case 'settings':
        return <Settings />;
      default:
        return <DashboardOverview setCurrentPage={setCurrentPage} setSelectedInvoice={setSelectedInvoice} />;
    }
  };

  return (
    <div className="min-h-screen text-ink antialiased flex" style={{ backgroundColor: '#FAF8F5' }}>
      <Sidebar currentPage={currentPage} setCurrentPage={setCurrentPage} />
      <main className="ml-64 flex-1 p-8 min-h-screen">
        {/* Per-page error boundary: each page gets its own boundary so a
            crash in one page doesn't take down the sidebar or other pages. */}
        <ErrorBoundary key={currentPage}>
          {renderPage()}
        </ErrorBoundary>
      </main>
    </div>
  );
}

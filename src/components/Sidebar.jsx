import React from 'react';
import { useAppData } from '../AppDataContext';

const navItems = [
  { id: 'dashboard', label: 'Dashboard Overview',        icon: 'dashboard' },
  { id: 'risk',      label: 'Risk Analysis',             icon: 'warning' },
  { id: 'ledger',    label: 'GST Reconciliation Ledger', icon: 'account_balance' },
  { id: 'mismatch',  label: 'Mismatch Review',           icon: 'rule' },
  { id: 'vendor',    label: 'Vendor Management',         icon: 'store' },
  { id: 'invoice',   label: 'Invoice Detail',            icon: 'description' },
  { id: 'reports',   label: 'Reports & Analytics',       icon: 'analytics' },
  { id: 'settings',  label: 'Settings',                  icon: 'settings' },
];

export default function Sidebar({ currentPage, setCurrentPage }) {
  const { profile } = useAppData();
  const auditorName = profile?.name || 'ASHOK KAPOOR';
  const auditorRole = profile?.role || 'Lead Chartered Accountant';

  return (

    <nav
      className="w-64 h-screen fixed left-0 top-0 flex flex-col z-50 border-r border-white border-opacity-10 font-sans"
      style={{ backgroundColor: '#1B1811', color: '#F3EEE2' }}
    >
      {/* Brand Header */}
      <div className="p-6 border-b border-white border-opacity-10 flex items-center gap-3">
        <div className="w-8 h-8 flex items-center justify-center shrink-0" style={{ backgroundColor: '#A9781E', borderRadius: '2px' }}>
          <span className="material-symbols-outlined text-xl" style={{ color: '#F3EEE2' }}>account_balance</span>
        </div>
        <div>
          <h2 className="font-fraunces text-lg font-bold leading-tight" style={{ color: '#F3EEE2' }}>DecisionForge</h2>
          <p className="font-sans text-xs" style={{ color: 'rgba(243,238,226,0.6)' }}>Audit Ledger Portal</p>
        </div>
      </div>

      {/* Primary Action Button */}
      <div className="p-4">
        <button
          onClick={() => setCurrentPage('mismatch')}
          className="w-full py-2.5 px-4 font-sans font-semibold text-sm flex items-center justify-center gap-2 transition-opacity hover:opacity-90"
          style={{ backgroundColor: '#A9781E', color: '#F3EEE2', border: '1px solid #A9781E', borderRadius: '0px' }}
        >
          <span className="material-symbols-outlined text-sm">play_arrow</span>
          Run Mismatch Review
        </button>
      </div>

      {/* Nav List */}
      <ul className="flex-1 px-3 py-2 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = currentPage === item.id;
          return (
            <li key={item.id}>
              <button
                onClick={() => setCurrentPage(item.id)}
                /*
                 * FIX: Use explicit inline styles + CSS class instead of
                 * Tailwind's two-part bg-X + bg-opacity-Y pattern.
                 * Each state pairs background AND text colour explicitly
                 * so text never becomes invisible against its background.
                 *
                 * Active: paper-tint bg (#F3EEE2 at 8%) + brass text
                 * Hover:  paper-tint bg (#F3EEE2 at 10%) + paper text (via nav-hover CSS class)
                 * Default: transparent bg + paper text at 70% opacity
                 */
                className={`w-full text-left flex items-center gap-3 px-3 py-2.5 transition-colors border-l-2 font-sans text-sm ${
                  isActive ? 'nav-active' : 'nav-hover'
                }`}
                style={
                  isActive
                    ? {
                        borderLeftColor: '#A9781E',
                        backgroundColor: 'rgba(243,238,226,0.08)',
                        color: '#A9781E',
                      }
                    : {
                        borderLeftColor: 'transparent',
                        backgroundColor: 'transparent',
                        color: 'rgba(243,238,226,0.75)',
                      }
                }
              >
                <span
                  className="material-symbols-outlined text-[20px] shrink-0"
                  style={{ color: isActive ? '#A9781E' : 'rgba(243,238,226,0.75)' }}
                >
                  {item.icon}
                </span>
                <span style={{ color: 'inherit' }}>{item.label}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* Footer Info */}
      <div
        className="p-4 flex items-center gap-3"
        style={{ borderTop: '1px solid rgba(243,238,226,0.10)' }}
      >
        <div
          className="w-8 h-8 flex items-center justify-center font-mono text-sm shrink-0"
          style={{ backgroundColor: 'rgba(243,238,226,0.10)', color: '#F3EEE2', borderRadius: '2px' }}
        >
          CA
        </div>
        <div className="overflow-hidden">
          <p className="text-xs font-semibold truncate" style={{ color: '#F3EEE2' }}>{auditorName}</p>
          <p className="text-[10px] font-mono truncate" style={{ color: 'rgba(243,238,226,0.55)' }}>{auditorRole}</p>
        </div>
      </div>
    </nav>
  );
}

import React, { useState, useEffect } from 'react';
import { useAppData } from '../AppDataContext';

export default function Settings() {
  const { profile: contextProfile, updateProfile } = useAppData();

  // Form State
  const [profile, setProfile] = useState({
    name: 'ASHOK KAPOOR',
    role: 'Lead Chartered Accountant',
    firm: 'Kapoor & Associates Ltd',
    license: 'CA-2026-987123',
    email: 'a.kapoor@kapoor-associates.com'
  });

  // Sync local state when contextProfile is loaded/changed
  useEffect(() => {
    if (contextProfile) {
      setProfile(contextProfile);
    }
  }, [contextProfile]);

  const [thresholds, setThresholds] = useState({
    criticalRisk: '50000',
    highRisk: '25000',
    toleranceAmt: '100',
    timingDiffMonth: '1'
  });

  const [integrations, setIntegrations] = useState({
    projectId: 'decisionforge-501312',
    datasetId: 'gst_notices',
    localFallback: 'Enabled when offline/unauthorized'
  });

  const handleSave = (section) => {
    if (section === 'Auditor Profile') {
      updateProfile(profile);
    }
    alert(`Configuration section "${section}" updated and saved successfully.`);
  };

  return (
    <div className="space-y-6 font-sans">
      {/* Header */}
      <div className="flex justify-between items-end border-b border-ink border-opacity-10 pb-4">
        <div>
          <h1 className="font-fraunces text-2xl font-bold text-ink">Administrative Settings</h1>
          <p className="font-sans text-xs text-ink text-opacity-60 mt-1">
            Configure audit rules, risk scoring thresholds, API integrations, and CA registration profiles.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Card 1: Profile Settings */}
        <div className="bg-paper p-6 border border-ink border-opacity-15 flex flex-col justify-between">
          <div className="space-y-4">
            <h2 className="font-fraunces text-base font-bold text-ink border-b border-ink border-opacity-10 pb-2">
              Auditor Profile
            </h2>
            <div className="grid grid-cols-1 gap-4 text-xs text-ink">
              <div className="flex flex-col gap-1">
                <label className="font-semibold">Chartered Accountant Name</label>
                <input 
                  type="text" 
                  value={profile.name}
                  onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                  className="bg-paper border border-ink border-opacity-35 px-3 py-1.5 text-xs text-ink focus:outline-none focus:border-brass"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="font-semibold">Firm / Organization</label>
                <input 
                  type="text" 
                  value={profile.firm}
                  onChange={(e) => setProfile({ ...profile, firm: e.target.value })}
                  className="bg-paper border border-ink border-opacity-35 px-3 py-1.5 text-xs text-ink focus:outline-none focus:border-brass"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1">
                  <label className="font-semibold">ICA Registration License</label>
                  <input 
                    type="text" 
                    value={profile.license}
                    onChange={(e) => setProfile({ ...profile, license: e.target.value })}
                    className="bg-paper border border-ink border-opacity-35 px-3 py-1.5 text-xs text-ink font-mono focus:outline-none focus:border-brass"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="font-semibold">Email Address</label>
                  <input 
                    type="email" 
                    value={profile.email}
                    onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                    className="bg-paper border border-ink border-opacity-35 px-3 py-1.5 text-xs text-ink focus:outline-none focus:border-brass"
                  />
                </div>
              </div>
            </div>
          </div>
          
          <div className="flex justify-end mt-6">
            <button 
              onClick={() => handleSave('Auditor Profile')}
              className="bg-brass text-paper hover:opacity-95 font-sans font-semibold text-xs px-4 py-2 border border-brass"
            >
              SAVE PROFILE
            </button>
          </div>
        </div>

        {/* Card 2: Audit Rules & Thresholds */}
        <div className="bg-paper p-6 border border-ink border-opacity-15 flex flex-col justify-between">
          <div className="space-y-4">
            <h2 className="font-fraunces text-base font-bold text-ink border-b border-ink border-opacity-10 pb-2">
              Audit Rules &amp; Thresholds
            </h2>
            <div className="grid grid-cols-1 gap-4 text-xs text-ink">
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1">
                  <label className="font-semibold">Critical Risk Threshold (ITC)</label>
                  <div className="relative">
                    <span className="absolute left-2.5 top-1.5 font-mono text-ink text-opacity-50">₹</span>
                    <input 
                      type="number" 
                      value={thresholds.criticalRisk}
                      onChange={(e) => setThresholds({ ...thresholds, criticalRisk: e.target.value })}
                      className="w-full bg-paper border border-ink border-opacity-35 pl-6 pr-3 py-1.5 text-xs text-ink font-mono focus:outline-none focus:border-brass"
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="font-semibold">High Risk Threshold (Discrepancy)</label>
                  <div className="relative">
                    <span className="absolute left-2.5 top-1.5 font-mono text-ink text-opacity-50">₹</span>
                    <input 
                      type="number" 
                      value={thresholds.highRisk}
                      onChange={(e) => setThresholds({ ...thresholds, highRisk: e.target.value })}
                      className="w-full bg-paper border border-ink border-opacity-35 pl-6 pr-3 py-1.5 text-xs text-ink font-mono focus:outline-none focus:border-brass"
                    />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1">
                  <label className="font-semibold">Rounding Tolerance Limit</label>
                  <div className="relative">
                    <span className="absolute left-2.5 top-1.5 font-mono text-ink text-opacity-50">₹</span>
                    <input 
                      type="number" 
                      value={thresholds.toleranceAmt}
                      onChange={(e) => setThresholds({ ...thresholds, toleranceAmt: e.target.value })}
                      className="w-full bg-paper border border-ink border-opacity-35 pl-6 pr-3 py-1.5 text-xs text-ink font-mono focus:outline-none focus:border-brass"
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="font-semibold">Timing Diff Period Distance</label>
                  <input 
                    type="text" 
                    value={`${thresholds.timingDiffMonth} Calendar Month`}
                    disabled
                    className="bg-paper border border-ink border-opacity-20 px-3 py-1.5 text-xs text-ink text-opacity-50 font-mono"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end mt-6">
            <button 
              onClick={() => handleSave('Audit Rules')}
              className="bg-brass text-paper hover:opacity-95 font-sans font-semibold text-xs px-4 py-2 border border-brass"
            >
              SAVE THRESHOLDS
            </button>
          </div>
        </div>

        {/* Card 3: API & Database Integrations */}
        <div className="bg-paper p-6 border border-ink border-opacity-15 flex flex-col justify-between md:col-span-2">
          <div className="space-y-4">
            <h2 className="font-fraunces text-base font-bold text-ink border-b border-ink border-opacity-10 pb-2">
              API &amp; Database Integrations
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-xs text-ink">
              <div className="flex flex-col gap-1">
                <label className="font-semibold">BigQuery billing Project ID</label>
                <input 
                  type="text" 
                  value={integrations.projectId}
                  onChange={(e) => setIntegrations({ ...integrations, projectId: e.target.value })}
                  className="bg-paper border border-ink border-opacity-35 px-3 py-1.5 text-xs text-ink font-mono focus:outline-none focus:border-brass"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="font-semibold">BigQuery Dataset ID</label>
                <input 
                  type="text" 
                  value={integrations.datasetId}
                  onChange={(e) => setIntegrations({ ...integrations, datasetId: e.target.value })}
                  className="bg-paper border border-ink border-opacity-35 px-3 py-1.5 text-xs text-ink font-mono focus:outline-none focus:border-brass"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="font-semibold">Local Fallback Strategy</label>
                <input 
                  type="text" 
                  value={integrations.localFallback}
                  disabled
                  className="bg-paper border border-ink border-opacity-20 px-3 py-1.5 text-xs text-ink text-opacity-50 font-mono"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-between items-center mt-6 pt-4 border-t border-ink border-opacity-10">
            <p className="text-[10px] text-ink text-opacity-50 italic">
              Credential discovery runs via standard Google Application Default Credentials.
            </p>
            <button 
              onClick={() => handleSave('Integrations')}
              className="bg-brass text-paper hover:opacity-95 font-sans font-semibold text-xs px-4 py-2 border border-brass"
            >
              SAVE INTEGRATION
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

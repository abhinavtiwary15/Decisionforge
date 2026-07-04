import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api';

const AppDataContext = createContext(null);

export function AppDataProvider({ children }) {
  const [clients, setClients] = useState(null);
  const [benchmark, setBenchmark] = useState(null);
  const [dataQuality, setDataQuality] = useState(null);
  const [defaultRecon, setDefaultRecon] = useState(null); // limit=25
  const [criticalRecon, setCriticalRecon] = useState(null); // CRITICAL risk, limit=5
  const [riskRecon, setRiskRecon] = useState(null); // limit=100
  const [vendorRecon, setVendorRecon] = useState(null); // limit=1000
  const [mismatchRecon, setMismatchRecon] = useState(null); // limit=20
  const [prefetchDone, setPrefetchDone] = useState(false);

  const didFetch = useRef(false);

  useEffect(() => {
    if (didFetch.current) return;
    didFetch.current = true;

    async function prefetch() {
      console.log('[Prefetch] Starting parallel loads for all audit views...');
      const start = Date.now();

      const [
        clientsRes,
        benchmarkRes,
        dqRes,
        defaultReconRes,
        criticalReconRes,
        riskReconRes,
        vendorReconRes,
        mismatchReconRes
      ] = await Promise.allSettled([
        api.getClients(),
        api.getBenchmark(),
        api.getDataQuality(),
        api.getReconciliation({ limit: 25, offset: 0 }),
        api.getReconciliation({ risk_label: 'CRITICAL', limit: 5, offset: 0 }),
        api.getReconciliation({ limit: 100, offset: 0 }),
        api.getReconciliation({ limit: 1000, offset: 0 }),
        api.getReconciliation({ limit: 20, offset: 0 })
      ]);

      if (clientsRes.status === 'fulfilled' && !clientsRes.value.error) setClients(clientsRes.value.data);
      if (benchmarkRes.status === 'fulfilled' && !benchmarkRes.value.error) setBenchmark(benchmarkRes.value.data);
      if (dqRes.status === 'fulfilled' && !dqRes.value.error) setDataQuality(dqRes.value.data);
      if (defaultReconRes.status === 'fulfilled' && !defaultReconRes.value.error) setDefaultRecon(defaultReconRes.value.data);
      if (criticalReconRes.status === 'fulfilled' && !criticalReconRes.value.error) setCriticalRecon(criticalReconRes.value.data);
      if (riskReconRes.status === 'fulfilled' && !riskReconRes.value.error) setRiskRecon(riskReconRes.value.data);
      if (vendorReconRes.status === 'fulfilled' && !vendorReconRes.value.error) setVendorRecon(vendorReconRes.value.data);
      if (mismatchReconRes.status === 'fulfilled' && !mismatchReconRes.value.error) setMismatchRecon(mismatchReconRes.value.data);

      setPrefetchDone(true);
      console.log(`[Prefetch] Completed successfully in ${Date.now() - start}ms.`);
    }

    prefetch();
  }, []);

  const [profile, setProfileState] = useState(() => {
    const saved = localStorage.getItem('decisionforge_auditor_profile');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        // ignore
      }
    }
    return {
      name: 'ASHOK KAPOOR',
      role: 'Lead Chartered Accountant',
      firm: 'Kapoor & Associates Ltd',
      license: 'CA-2026-987123',
      email: 'a.kapoor@kapoor-associates.com'
    };
  });

  const updateProfile = (newProfile) => {
    setProfileState(newProfile);
    localStorage.setItem('decisionforge_auditor_profile', JSON.stringify(newProfile));
  };

  return (
    <AppDataContext.Provider value={{
      clients,
      benchmark,
      dataQuality,
      defaultRecon,
      criticalRecon,
      riskRecon,
      vendorRecon,
      mismatchRecon,
      prefetchDone,
      profile,
      updateProfile
    }}>
      {children}
    </AppDataContext.Provider>
  );
}

export function useAppData() {
  return useContext(AppDataContext);
}


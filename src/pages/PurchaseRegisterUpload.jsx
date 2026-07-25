import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { useAppData } from '../AppDataContext';

// Field specifications for mapping
const REQUIRED_FIELDS = [
  { key: 'invoice_number', label: 'Invoice Number', description: 'Unique invoice identifier' },
  { key: 'vendor_gstin', label: 'Supplier GSTIN', description: '15-char supplier registration number' },
  { key: 'taxable_value', label: 'Taxable Value', description: 'Base taxable value of transaction' }
];

const OPTIONAL_FIELDS = [
  { key: 'vendor_name', label: 'Supplier Trade Name', description: 'Trade name of the vendor' },
  { key: 'invoice_date', label: 'Invoice Date', description: 'Date of invoice issue' },
  { key: 'cgst', label: 'CGST Amount', description: 'Central GST component' },
  { key: 'sgst', label: 'SGST Amount', description: 'State GST component' },
  { key: 'igst', label: 'IGST Amount', description: 'Integrated GST component' },
  { key: 'total_itc_claimed', label: 'Total ITC Claimed', description: 'Total claimed Input Tax Credit' }
];

export default function PurchaseRegisterUpload({ setCurrentPage }) {
  const contextData = useAppData();
  const clients = Array.isArray(contextData?.clients) ? contextData.clients : [];

  // Local state
  const [selectedClientGstin, setSelectedClientGstin] = useState('');
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [step, setStep] = useState(1); // 1: UPLOAD, 2: MAP, 3: SUMMARY
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Upload/Detection Results
  const [fileId, setFileId] = useState('');
  const [detectedColumns, setDetectedColumns] = useState([]);
  const [mapping, setMapping] = useState({});
  const [savedMapping, setSavedMapping] = useState(null);

  // Ingestion Results
  const [summary, setSummary] = useState(null);
  const [issues, setIssues] = useState([]);

  // Select default client
  useEffect(() => {
    if (clients.length > 0 && !selectedClientGstin) {
      setSelectedClientGstin(clients[0].client_gstin);
    }
  }, [clients, selectedClientGstin]);

  // Try to automatically match columns to fields when detected columns update
  useEffect(() => {
    if (detectedColumns.length > 0) {
      const autoMapping = {};
      const allFields = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];

      allFields.forEach(field => {
        // Look for close matches in column names (case-insensitive, ignoring spaces/underscores/dashes)
        const canonicalKey = field.key.replace(/[^a-z0-9]/gi, '').toLowerCase();
        
        // Specific custom matching rules for higher accuracy
        const matches = detectedColumns.find(col => {
          const colClean = col.replace(/[^a-z0-9]/gi, '').toLowerCase();
          
          // direct match
          if (colClean === canonicalKey) return true;
          // check variations
          if (field.key === 'invoice_number' && ['invoiceno', 'invoicenumber', 'billno', 'billnumber', 'invno'].includes(colClean)) return true;
          if (field.key === 'vendor_gstin' && ['suppliergstin', 'gstinofsupplier', 'gstin', 'partygstin', 'vendorgstin'].includes(colClean)) return true;
          if (field.key === 'vendor_name' && ['suppliername', 'vendorname', 'tradename', 'partyname'].includes(colClean)) return true;
          if (field.key === 'invoice_date' && ['invoicedate', 'billdate', 'date'].includes(colClean)) return true;
          if (field.key === 'taxable_value' && ['taxablevalue', 'taxableamt', 'taxableamount', 'taxval'].includes(colClean)) return true;
          if (field.key === 'total_itc_claimed' && ['totalitc', 'itcclaimed', 'totalclaimed', 'itcamount'].includes(colClean)) return true;
          
          return false;
        });

        autoMapping[field.key] = matches || '';
      });

      setMapping(autoMapping);
    }
  }, [detectedColumns]);

  // Handle Drag & Drop
  const handleDragOver = (e) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  // Step 1: Upload File and Detect Columns
  const handleUpload = async () => {
    if (!file) {
      setError('Please select a file to upload.');
      return;
    }
    if (!selectedClientGstin) {
      setError('Please select a client GSTIN first.');
      return;
    }

    setLoading(true);
    setError(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('client_gstin', selectedClientGstin);

    const { data, error: uploadErr } = await api.uploadPRFile(formData, selectedClientGstin);
    setLoading(false);

    if (uploadErr) {
      setError(uploadErr);
      return;
    }

    setFileId(data.file_id);
    setDetectedColumns(data.columns);
    setSavedMapping(data.savedMapping);

    if (data.mappingValid && data.savedMapping) {
      // Mapping matches current file fingerprint perfectly! Skip step 2, call ingest directly
      handleIngestDirectly(data.file_id, data.savedMapping);
    } else {
      // Mapping invalid or doesn't exist, transition to step 2 mapping UI
      setStep(2);
    }
  };

  // Skip step 2 and process directly
  const handleIngestDirectly = async (fId, mappingToUse) => {
    setLoading(true);
    const { data, error: ingestErr } = await api.ingestPR(fId, mappingToUse);
    setLoading(false);

    if (ingestErr) {
      setError(ingestErr);
      return;
    }

    setSummary(data.summary);
    setIssues(data.issues || []);
    setStep(3);
  };

  // Step 2: Confirm Mapping and Save
  const handleConfirmMapping = async () => {
    // Validate required fields mapping is present
    const missing = REQUIRED_FIELDS.filter(f => !mapping[f.key]);
    if (missing.length > 0) {
      setError(`Mapping is missing required fields: ${missing.map(m => m.label).join(', ')}`);
      return;
    }

    setLoading(true);
    setError(null);

    // Save mapping to file cache
    const fingerprint = [...detectedColumns].sort();
    const { error: saveErr } = await api.savePRMapping(selectedClientGstin, mapping, fingerprint);
    if (saveErr) {
      setLoading(false);
      setError('Failed to save column mapping config: ' + saveErr);
      return;
    }

    // Call Ingestion
    const { data, error: ingestErr } = await api.ingestPR(fileId, mapping);
    setLoading(false);

    if (ingestErr) {
      setError(ingestErr);
      return;
    }

    setSummary(data.summary);
    setIssues(data.issues || []);
    setStep(3);
  };

  const selectedClient = clients.find(c => c.client_gstin === selectedClientGstin);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header Bar */}
      <div className="flex justify-between items-center pb-5 border-b border-gray-200">
        <div>
          <h1 className="font-fraunces text-2xl font-bold" style={{ color: '#1B1811' }}>
            Import Client Purchase Register
          </h1>
          <p className="text-sm font-sans mt-1 text-gray-500">
            Upload CSV or Excel spreadsheets and align columns to run automated reconciliation.
          </p>
        </div>
        <button
          onClick={() => setCurrentPage('dashboard')}
          className="px-4 py-2 border border-gray-300 font-sans text-sm font-semibold rounded hover:bg-gray-50 transition-colors flex items-center gap-1.5"
          style={{ color: '#1B1811' }}
        >
          <span className="material-symbols-outlined text-base">arrow_back</span>
          Back to Dashboard
        </button>
      </div>

      {/* Error alert */}
      {error && (
        <div className="p-4 bg-rose-50 border-l-4 border-rose-500 text-rose-800 rounded font-sans text-sm flex gap-3 items-start">
          <span className="material-symbols-outlined shrink-0 text-rose-500">error</span>
          <div>
            <h4 className="font-bold">Error Encountered</h4>
            <p className="mt-1">{error}</p>
          </div>
        </div>
      )}

      {/* STEP 1: UPLOAD */}
      {step === 1 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-2 space-y-6">
            <div className="bg-white border border-gray-200 p-6 rounded shadow-sm">
              <h3 className="text-lg font-bold font-fraunces mb-4" style={{ color: '#1B1811' }}>Select Audit Client</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase font-sans mb-1">
                    Client Entity
                  </label>
                  <select
                    value={selectedClientGstin}
                    onChange={(e) => setSelectedClientGstin(e.target.value)}
                    className="w-full p-2.5 border border-gray-300 rounded font-sans text-sm focus:border-[#A9781E] focus:outline-none"
                  >
                    <option value="" disabled>Select a client...</option>
                    {clients.map(c => (
                      <option key={c.client_gstin} value={c.client_gstin}>
                        {c.client_name} ({c.client_gstin})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Dropzone */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded p-12 text-center transition-all ${
                dragOver ? 'border-[#A9781E] bg-[#FAF8F5]' : 'border-gray-300 bg-white'
              }`}
            >
              <div className="flex flex-col items-center justify-center">
                <span className="material-symbols-outlined text-5xl mb-4" style={{ color: '#A9781E' }}>
                  cloud_upload
                </span>
                <p className="font-sans text-sm font-semibold text-gray-800">
                  Drag and drop your spreadsheet here, or
                </p>
                <label className="mt-2 px-4 py-2 bg-white border border-gray-300 font-sans text-xs font-semibold rounded shadow-sm hover:bg-gray-50 cursor-pointer inline-block">
                  Browse Files
                  <input
                    type="file"
                    accept=".csv, .xlsx"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                </label>
                <p className="text-xs text-gray-500 mt-2 font-sans">
                  Supports GSTR-2B or Purchase Register CSV or Excel (.xlsx) formats
                </p>
              </div>
            </div>

            {file && (
              <div className="bg-white border border-gray-200 p-4 rounded flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-3xl" style={{ color: '#A9781E' }}>
                    description
                  </span>
                  <div>
                    <p className="font-sans text-sm font-semibold text-gray-800">{file.name}</p>
                    <p className="font-sans text-xs text-gray-500">{(file.size / 1024).toFixed(1)} KB</p>
                  </div>
                </div>
                <button
                  onClick={() => setFile(null)}
                  className="p-1 hover:bg-gray-100 rounded text-gray-400 hover:text-gray-600"
                >
                  <span className="material-symbols-outlined text-xl">close</span>
                </button>
              </div>
            )}

            <button
              onClick={handleUpload}
              disabled={loading || !file}
              className="w-full py-3 bg-[#A9781E] text-white font-sans font-semibold rounded hover:opacity-95 transition-opacity disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Uploading & Analyzing...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-base">arrow_forward</span>
                  Upload and Map Columns
                </>
              )}
            </button>
          </div>

          {/* Right Instructions Panel */}
          <div className="bg-white border border-gray-200 p-6 rounded shadow-sm space-y-4">
            <h3 className="text-lg font-bold font-fraunces" style={{ color: '#1B1811' }}>
              How Column Mapping Works
            </h3>
            <p className="font-sans text-xs leading-relaxed text-gray-600">
              Each ERP / accounting system (Tally, Zoho Books, Busy, custom Excel) exports purchase registers differently.
            </p>
            <hr className="border-gray-100" />
            <div className="space-y-3 font-sans text-xs">
              <div className="flex gap-2">
                <span className="material-symbols-outlined text-base text-[#A9781E]">check_circle</span>
                <div>
                  <p className="font-semibold text-gray-800">One-Time Mapping Setup</p>
                  <p className="text-gray-500">The first time you upload, you will link your columns to our standard schema.</p>
                </div>
              </div>
              <div className="flex gap-2">
                <span className="material-symbols-outlined text-base text-[#A9781E]">history</span>
                <div>
                  <p className="font-semibold text-gray-800">Automatic Memory</p>
                  <p className="text-gray-500">DecisionForge stores column mappings per Client. Subsequent uploads are processed instantly.</p>
                </div>
              </div>
              <div className="flex gap-2">
                <span className="material-symbols-outlined text-base text-[#A9781E]">warning</span>
                <div>
                  <p className="font-semibold text-gray-800">Header Change Detection</p>
                  <p className="text-gray-500">If you rename columns, we detect it automatically and request a quick remap.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* STEP 2: COLUMN MAPPING UI */}
      {step === 2 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Mapping settings form */}
          <div className="lg:col-span-2 bg-white border border-gray-200 rounded p-6 shadow-sm space-y-6">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100">
              <h3 className="text-lg font-bold font-fraunces" style={{ color: '#1B1811' }}>
                Map Column Headers
              </h3>
              <span className="px-2.5 py-1 bg-yellow-50 text-xs font-semibold text-[#A9781E] border border-yellow-200">
                New Column Structure Detected
              </span>
            </div>

            {/* Mappings Grid */}
            <div className="space-y-6">
              <div>
                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider font-sans mb-3">
                  Required Fields (Must Map)
                </h4>
                <div className="space-y-4">
                  {REQUIRED_FIELDS.map(f => (
                    <div key={f.key} className="grid grid-cols-1 md:grid-cols-3 items-center gap-4 py-2 border-b border-gray-50 last:border-b-0">
                      <div>
                        <span className="font-sans text-sm font-semibold text-gray-800 flex items-center gap-1">
                          {f.label} <span className="text-rose-500">*</span>
                        </span>
                        <p className="font-sans text-xs text-gray-500">{f.description}</p>
                      </div>
                      <div className="md:col-span-2">
                        <select
                          value={mapping[f.key] || ''}
                          onChange={(e) => setMapping(prev => ({ ...prev, [f.key]: e.target.value }))}
                          className="w-full p-2 border border-gray-300 rounded font-sans text-sm focus:border-[#A9781E] focus:outline-none"
                        >
                          <option value="" disabled>Select file column...</option>
                          {detectedColumns.map(col => (
                            <option key={col} value={col}>{col}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <hr className="border-gray-100" />

              <div>
                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider font-sans mb-3">
                  Optional Fields
                </h4>
                <div className="space-y-4">
                  {OPTIONAL_FIELDS.map(f => (
                    <div key={f.key} className="grid grid-cols-1 md:grid-cols-3 items-center gap-4 py-2 border-b border-gray-50 last:border-b-0">
                      <div>
                        <span className="font-sans text-sm font-semibold text-gray-800">
                          {f.label}
                        </span>
                        <p className="font-sans text-xs text-gray-500">{f.description}</p>
                      </div>
                      <div className="md:col-span-2">
                        <select
                          value={mapping[f.key] || ''}
                          onChange={(e) => setMapping(prev => ({ ...prev, [f.key]: e.target.value }))}
                          className="w-full p-2 border border-gray-300 rounded font-sans text-sm focus:border-[#A9781E] focus:outline-none"
                        >
                          <option value="">Not present in my data (Derive/Use Zero)</option>
                          {detectedColumns.map(col => (
                            <option key={col} value={col}>{col}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Ingestion button */}
            <div className="flex gap-4 pt-4">
              <button
                onClick={() => setStep(1)}
                className="px-6 py-2.5 border border-gray-300 font-sans text-sm font-semibold rounded hover:bg-gray-50"
              >
                Back
              </button>
              <button
                onClick={handleConfirmMapping}
                disabled={loading}
                className="flex-1 py-2.5 bg-[#A9781E] text-white font-sans font-semibold rounded hover:opacity-95 disabled:opacity-40 flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Importing Records...
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-base">check</span>
                    Save Mapping & Import
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Detected column chips list */}
          <div className="bg-white border border-gray-200 rounded p-6 shadow-sm space-y-4 h-fit">
            <h3 className="text-sm font-bold font-sans uppercase tracking-wider text-gray-500">
              Columns Detected in File
            </h3>
            <p className="font-sans text-xs text-gray-500">
              Here are the exact column headers parsed from your uploaded spreadsheet file:
            </p>
            <div className="flex flex-wrap gap-2 pt-2">
              {detectedColumns.map(col => {
                // Check if currently selected in mapping
                const isMapped = Object.values(mapping).includes(col);
                return (
                  <span
                    key={col}
                    className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                      isMapped
                        ? 'bg-yellow-50 text-[#A9781E] border-yellow-300 font-semibold'
                        : 'bg-gray-50 text-gray-600 border-gray-200'
                    }`}
                  >
                    {col}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* STEP 3: SUMMARY REPORT */}
      {step === 3 && summary && (
        <div className="bg-white border border-gray-200 rounded p-6 shadow-sm space-y-6">
          <div className="flex items-center gap-3 pb-4 border-b border-gray-100">
            <div className="w-12 h-12 bg-green-50 text-green-600 rounded-full flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-2xl font-bold">check_circle</span>
            </div>
            <div>
              <h3 className="text-xl font-bold font-fraunces text-gray-800">
                Data Import Completed Successfully
              </h3>
              <p className="font-sans text-xs text-gray-500">
                Reconciliation engine has parsed and validated the records.
              </p>
            </div>
          </div>

          {/* KPI grid */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
            <div className="p-4 bg-gray-50 rounded text-center">
              <p className="text-xs font-semibold text-gray-400 uppercase font-sans">Total Rows</p>
              <p className="text-2xl font-bold font-fraunces text-gray-800 mt-1">{summary.total}</p>
            </div>
            <div className="p-4 bg-green-50 bg-opacity-50 rounded text-center">
              <p className="text-xs font-semibold text-green-700 uppercase font-sans">Clean Records</p>
              <p className="text-2xl font-bold font-fraunces text-green-800 mt-1">{summary.clean}</p>
            </div>
            <div className="p-4 bg-red-50 bg-opacity-50 rounded text-center">
              <p className="text-xs font-semibold text-red-700 uppercase font-sans">Invalid GSTINs</p>
              <p className="text-2xl font-bold font-fraunces text-red-800 mt-1">{summary.flagged}</p>
            </div>
            <div className="p-4 bg-rose-50 bg-opacity-50 rounded text-center border border-rose-100">
              <p className="text-xs font-semibold text-rose-700 uppercase font-sans">Skipped Rows</p>
              <p className="text-2xl font-bold font-fraunces text-rose-800 mt-1">{summary.skipped ?? 0}</p>
            </div>
            <div className="p-4 bg-orange-50 bg-opacity-50 rounded text-center">
              <p className="text-xs font-semibold text-orange-700 uppercase font-sans">Total Row Errors</p>
              <p className="text-2xl font-bold font-fraunces text-orange-800 mt-1">{summary.issues_count}</p>
            </div>
          </div>

          {/* Issues table */}
          {issues.length > 0 ? (
            <div className="space-y-3">
              <h4 className="text-sm font-bold text-gray-700 font-sans flex items-center gap-1">
                <span className="material-symbols-outlined text-lg text-orange-500">warning</span>
                Row-Level Issues Identified ({issues.length})
              </h4>
              <p className="text-xs font-sans text-gray-500">
                The following validation issues were flagged. Invalid GSTIN rows have been routed to data quality checks and excluded from financial scoring. Date/numeric parse failures were skipped entirely.
              </p>
              <div className="border border-gray-200 rounded overflow-x-auto">
                <table className="w-full min-w-[580px] text-left font-sans text-xs border-collapse">
                  <thead>
                    <tr className="bg-gray-50 text-gray-600 border-b border-gray-200">
                      <th className="p-3 font-semibold w-16">Row</th>
                      <th className="p-3 font-semibold w-36">Invoice Number</th>
                      <th className="p-3 font-semibold w-32">Failed Field</th>
                      <th className="p-3 font-semibold">Description of Problem</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 text-gray-700">
                    {issues.map((iss, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="p-3 font-semibold">{iss.row}</td>
                        <td className="p-3 font-semibold font-mono text-gray-600">{iss.invoice_number}</td>
                        <td className="p-3 font-semibold text-red-600">{iss.field}</td>
                        <td className="p-3">{iss.problem}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="p-4 bg-green-50 rounded border border-green-200 font-sans text-xs text-green-800 flex items-center gap-2">
              <span className="material-symbols-outlined text-lg">check_circle</span>
              All records were imported clean with zero formatting or validation issues!
            </div>
          )}

          {/* Action buttons */}
          <div className="pt-4 flex gap-4">
            <button
              onClick={() => {
                setFile(null);
                setStep(1);
              }}
              className="px-6 py-2.5 border border-gray-300 font-sans text-sm font-semibold rounded hover:bg-gray-50"
            >
              Upload Another File
            </button>
            <button
              onClick={() => setCurrentPage('dashboard')}
              className="flex-1 py-2.5 bg-[#A9781E] text-white font-sans text-sm font-semibold rounded hover:opacity-95 text-center"
            >
              Finish & Go to Dashboard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

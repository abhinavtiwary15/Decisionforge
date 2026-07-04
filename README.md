# DecisionForge: GST Audit Ledger Portal

DecisionForge is a premium, high-performance web portal designed for Chartered Accountants (CAs) to automate GST Input Tax Credit (ITC) reconciliation. It joins Purchase Register raw data with GSTR-2B filings in Google BigQuery, detects financial mismatches, flags data quality anomalies, and prioritizes audit tasks based on financial risk exposure.

---

## Technical Stack & Architecture

- **Backend**: Node.js & Express.js with `@google-cloud/bigquery` client SDK.
- **Frontend**: React (Vite) styled with semantic Vanilla CSS (HSL dark-mode themed: Brass, Paper, Ink, Vermillion).
- **Database/Data Pipe**: Google BigQuery tables and custom SQL views.
- **Reconciliation Engine**: Python `risk_scorer.py` (canonical classifier) mirrored in BigQuery SQL views.
- **Caching Layer**: Server-side TTL caching (120s for BigQuery queries, 300s for static CSV data) to optimize API performance.

---

## Setup & Installation

Follow these steps to run DecisionForge locally:

### 1. Install Dependencies
Initialize the node modules for both backend routing and Vite bundling:
```bash
npm install
```

### 2. BigQuery Authentication & Environment Variables
DecisionForge communicates with Google Cloud BigQuery using the standard Google Application Default Credentials (ADC) flow. 

Set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to point to the absolute path of your GCP service account JSON key file:

**In PowerShell (Windows):**
```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\your\service-account-key.json"
```

**In Command Prompt (Windows):**
```cmd
set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\your\service-account-key.json
```

**In Bash/macOS/Linux:**
```bash
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/your/service-account-key.json"
```

---

## Running the Application

To start the application, run both the backend server and the frontend dev server in separate terminal windows.

### 1. Start the Backend API Server
The backend starts on port `3001` and connects directly to BigQuery.
```bash
npm run server
```
*(Alternative: `node server.js`)*

### 2. Start the Frontend Development Server
The Vite server compiles the frontend and launches the portal (typically on port `3000` or `5173`).
```bash
npm run dev
```

Open the displayed localhost URL (e.g., `http://localhost:3000`) in your browser.

---

## Demo Dataset & Pipeline

- **Synthetic Purchase Register**: Contains ~49k+ generated rows of transaction logs located in `data/purchase_register_50000.csv` loaded into BigQuery.
- **Data Quality Anomalies**: The pipeline contains 3 deliberately injected malformed GSTIN rows (too short, invalid state code, position 14 check) that show up under the **Needs Attention** dashboard panel. Lowercase valid GSTINs are normalized and pass validation successfully.
- **Reconciliation Views**:
  - `reconciliation_matches`: Outer joins raw data and classifies match types.
  - `reconciliation_risk_ranked`: Filters and sorts rows by risk levels (Critical, High, Medium, Low).
  - `data_quality_flags`: Identifies structurally malformed GSTIN records.
  - `reconciliation_summary_by_client`: Aggregates audit metrics per client.

---

## Verification & Tests

To validate the classification engine against all boundary rules, run the Python edge-case test suite:
```bash
python pipeline/test_edge_cases.py
```
This runs 20 automated assertions (null values, tolerance boundary checks, timing gaps, and lowercase normalization checks) confirming system integrity.

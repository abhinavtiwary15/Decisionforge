# DecisionForge: GST Audit Ledger Portal

DecisionForge is a premium, high-performance web portal designed for Chartered Accountants (CAs) to automate GST Input Tax Credit (ITC) reconciliation. It joins Purchase Register raw data with GSTR-2B filings in Google BigQuery, detects financial mismatches, flags data quality anomalies, and prioritizes audit tasks based on financial risk exposure.

---

## Technical Stack & Architecture

- **Backend**: Node.js & Express.js with `@google-cloud/bigquery` client SDK.
- **Frontend**: React (Vite) styled with semantic Vanilla CSS (HSL dark-mode themed: Brass, Paper, Ink, Vermillion).
- **Database/Data Pipe**: Google BigQuery tables and custom SQL views (`decisionforge-501312.gst_notices`).
- **Reconciliation Engine**: Python `risk_scorer.py` (canonical classifier) mirrored in BigQuery SQL views.
- **Caching Layer**: Server-side TTL caching (120s for BigQuery queries, 300s for static CSV data) to optimize API performance.
- **AI / LLM Integration**: Google Gemini via `@google/genai` with strict numeric grounding verification (`validateNumericGrounding`).

---

## Setup & Installation

### 1. Install Node Dependencies
Initialize the node modules for backend routing and Vite bundling:
```bash
npm install
```

### 2. Python Environment & Pipeline Requirements
The data ingestion and reconciliation pipeline requires Python 3.10+:
```bash
pip install -r pipeline/requirements.txt
```
*(Dependencies: `google-cloud-bigquery`, `pandas`, `openpyxl`, `pytest`)*

### 3. BigQuery Authentication & Environment Variables
DecisionForge communicates with Google Cloud BigQuery using Google Application Default Credentials (ADC) or a service account key file.

Set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable:

**In PowerShell (Windows):**
```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\your\service-account-key.json"
```

**In Bash/macOS/Linux:**
```bash
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/your/service-account-key.json"
```

### 4. Security & Environment Configuration (`.env.local`)
Create a `.env.local` file in the project root to configure local credentials:
```env
BIGQUERY_PROJECT_ID=decisionforge-501312
BIGQUERY_DATASET=gst_notices
GEMINI_API_KEY=AIzaSy...
```
> **Security Notice**: 
> - Never commit `.env` or `.env.local` to git version control (already in `.gitignore`).
> - The Gemini API key must be a valid Google AI Studio key (starts with `AIzaSy...`). Service-account OAuth tokens (starting with `AQ.`) will be rejected by the Gemini API endpoint.
> - If any key is exposed or invalidated, rotate it immediately in Google AI Studio or GCP Secret Manager.

---

## Running the Application

To run DecisionForge, start both the backend API server and frontend development server:

### 1. Start the Backend API Server
The backend starts on port `3001` and connects to BigQuery with automatic fallback to local datasets if BigQuery is unreachable:
```bash
npm run server
```
*(Alternative: `node server.js`)*

### 2. Start the Frontend Development Server
The Vite server compiles the frontend and launches the portal (typically on port `3000` or `5173`):
```bash
npm run dev
```

Open `http://localhost:3000` in your browser.

---

## Data Pipeline & Live BigQuery Status

The production BigQuery dataset (`decisionforge-501312.gst_notices`) is fully populated and verified:
- **`purchase_register_raw`**: 49,519 rows of purchase transactions.
- **`gstr2b_raw`**: 44,914 rows of GSTR-2B filings.
- **`client_registry` & `client_column_mappings`**: Client metadata and schema mappings.
- **Live Analytical SQL Views**:
  - `reconciliation_matches`: Outer-joins PR and GSTR-2B with mismatch classification.
  - `reconciliation_risk_ranked`: Scores and ranks audit exposure (CRITICAL, HIGH, MEDIUM, LOW).
  - `data_quality_flags`: Identifies structurally malformed GSTIN records (format anomalies, checksum errors).
  - `reconciliation_summary_by_client`: Aggregates audit metrics per client.
  - `vendor_compliance_summary`: Aggregates vendor compliance patterns and missing invoice counts.

To reload or re-create all BigQuery analytical views:
```bash
python scripts/recreate_all_views.py
```

---

## Repository Structure & Maintenance Scripts

- **`api/`**: Serverless function handlers for Vercel deployment.
- **`pipeline/`**: Python reconciliation engine, ingestion scripts, and edge-case integration tests.
  - `pipeline/risk_scorer.py`: Canonical financial classification logic.
  - `pipeline/load_bq_data.py`: Loads CSV datasets directly into BigQuery.
  - `pipeline/test_edge_cases.py`: 20 unit assertions for classification edge cases.
  - `pipeline/test_pr_integration.py`: End-to-end 7-step API integration test.
- **`scripts/`**: Project maintenance and administration scripts:
  - `scripts/recreate_all_views.py`: Deploys all 5 BigQuery analytical views.
  - `scripts/recreate_dq_view.py`: Deploys the data quality view with GSTIN validation regex.
  - `scripts/inject_and_reload.py`: Injects test GSTIN anomalies and re-verifies BigQuery.
  - `scripts/screenshot_pages.js`: Headless browser script for UI capture.
  - `scripts/trace_quotes.py`: SQL quotation and syntax verification utility.
- **`docs/screens/`**: Design history and UI mockups preserved for reference and visual regression tracking.
- **`src/`**: React frontend components and views.

---

## Verification & Tests

### 1. Classification Engine Edge Cases
Validate classification boundary rules (tolerance boundaries, timing gaps, nulls, lowercase GSTINs):
```bash
python pipeline/test_edge_cases.py
```
*(All 20 assertions verify system integrity).*

### 2. Purchase Register API Integration Test
Validate the 7-step purchase register workflow against the live backend server:
```bash
python pipeline/test_pr_integration.py
```
Tests session creation, schema mapping detection, persistence, ingestion, duplicate handling, and stale mapping invalidation.

### 3. GSTIN Injection & Structural Validation Test
Validate SQL injection prevention, shell command injection sanitization, and structural validation:
```bash
node test_gstin_injection.js
```
*(Confirms malicious payloads and malformed GSTINs are strictly rejected).*


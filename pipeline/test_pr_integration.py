#!/usr/bin/env python3
"""
pipeline/test_pr_integration.py
===============================
Integration test suite for the Purchase Register Upload & Column Mapping API.
Tests end-to-end flow by calling the Express server endpoints.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
import urllib.error
import mimetypes
import uuid

# Force UTF-8 output
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE_URL = "http://localhost:3001"
CLIENT_GSTIN = "27AABCU9603R1ZV"  # Maharashtra client

# Helper to construct multipart form-data request
def encode_multipart_formdata(fields, files):
    boundary = uuid.uuid4().hex
    parts = []
    
    for name, value in fields.items():
        parts.append(f"--{boundary}")
        parts.append(f'Content-Disposition: form-data; name="{name}"')
        parts.append('')
        parts.append(str(value))
        
    for name, filepath in files.items():
        filename = os.path.basename(filepath)
        ctype, _ = mimetypes.guess_type(filename)
        if not ctype:
            ctype = 'application/octet-stream'
        parts.append(f"--{boundary}")
        parts.append(f'Content-Disposition: form-data; name="{name}"; filename="{filename}"')
        parts.append(f'Content-Type: {ctype}')
        parts.append('')
        with open(filepath, 'rb') as f:
            parts.append(f.read())
            
    parts.append(f"--{boundary}--")
    parts.append(b'')
    
    # Join parts with \r\n
    body = b''
    for part in parts:
        if isinstance(part, bytes):
            body += part + b'\r\n'
        else:
            body += part.encode('utf-8') + b'\r\n'
            
    headers = {
        'Content-Type': f'multipart/form-data; boundary={boundary}',
        'Content-Length': str(len(body))
    }
    return body, headers

def make_request(path, method="GET", data=None, headers=None):
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url, method=method)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    
    try:
        with urllib.request.urlopen(req, data=data) as response:
            return response.status, response.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8')
    except Exception as e:
        return 999, str(e)


def run_integration_tests():
    print("=" * 75)
    print("RUNNING PURCHASE REGISTER END-TO-END INTEGRATION TESTS")
    print("=" * 75)

    # 1. Create temporary test files
    import tempfile
    
    # Standard format: Tally
    tally_csv_data = (
        "Date,Invoice No,Party Name,Party GSTIN,Taxable Amt,CGST Amt,SGST Amt,IGST Amt,Total ITC\n"
        "05/04/2026,INV-001,Reliance Pvt,27AABCU9603R1ZV,10000.0,900.0,900.0,0.0,1800.0\n"
        "12-04-2026,INV-002,Infosys Ltd,29AADCB2230M1ZV,20000.0,0.0,0.0,3600.0,3600.0\n"
        "15/04/2026,INV-003,Bad Supplier,99AABCU9603R1ZV,5000.0,450.0,450.0,0.0,900.0\n" # Invalid GSTIN
        "32-13-2026,INV-004,Date Error,27AABCU9603R1ZV,15000.0,1350.0,1350.0,0.0,2700.0\n" # Bad Date
    )
    
    # Zoho format (different order & names)
    zoho_csv_data = (
        "Invoice Number,Invoice Date,GSTIN of Vendor,Vendor Name,Taxable Value,CGST,SGST,IGST,Total Claimed\n"
        "INV-001,2026-04-05,27AABCU9603R1ZV,Reliance Pvt,10000.0,900.0,900.0,0.0,1800.0\n"
        "INV-002,12/04/2026,29AADCB2230M1ZV,Infosys Ltd,20000.0,0.0,0.0,3600.0,3600.0\n"
    )

    # Tally with one column renamed (Party GSTIN -> Vendor GSTIN No)
    tally_single_rename_data = (
        "Date,Invoice No,Party Name,Vendor GSTIN No,Taxable Amt,CGST Amt,SGST Amt,IGST Amt,Total ITC\n"
        "05/04/2026,INV-001,Reliance Pvt,27AABCU9603R1ZV,10000.0,900.0,900.0,0.0,1800.0\n"
    )

    with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False, encoding="utf-8") as f:
        f.write(tally_csv_data)
        tally_path = f.name
    with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False, encoding="utf-8") as f:
        f.write(zoho_csv_data)
        zoho_path = f.name
    with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False, encoding="utf-8") as f:
        f.write(tally_single_rename_data)
        rename_path = f.name

    tally_mapping = {
        "invoice_number": "Invoice No",
        "vendor_gstin": "Party GSTIN",
        "vendor_name": "Party Name",
        "invoice_date": "Date",
        "taxable_value": "Taxable Amt",
        "cgst": "CGST Amt",
        "sgst": "SGST Amt",
        "igst": "IGST Amt",
    }

    zoho_mapping = {
        "invoice_number": "Invoice Number",
        "vendor_gstin": "GSTIN of Vendor",
        "vendor_name": "Vendor Name",
        "invoice_date": "Invoice Date",
        "taxable_value": "Taxable Value",
        "cgst": "CGST",
        "sgst": "SGST",
        "igst": "IGST",
        "total_itc_claimed": "Total Claimed"
    }

    results = []

    try:
        # ────────────────────────────────────────────────────────────────────────
        # 1. Clean Mapping Cache (Reset mappings for client)
        # ────────────────────────────────────────────────────────────────────────
        print("\nResetting client mapping for tests...")
        mappings_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "client_column_mappings.json")
        if os.path.exists(mappings_path):
            with open(mappings_path, "r", encoding="utf-8") as fh:
                all_maps = json.load(fh)
            if CLIENT_GSTIN in all_maps:
                del all_maps[CLIENT_GSTIN]
                with open(mappings_path, "w", encoding="utf-8") as fh:
                    json.dump(all_maps, fh, indent=2)
        # 2. Upload Tally CSV — First time (Expect mappingValid = False)
        # ────────────────────────────────────────────────────────────────────────
        print("\n[Step 1] Uploading Tally file (first time)...")
        body, headers = encode_multipart_formdata({"client_gstin": CLIENT_GSTIN}, {"file": tally_path})
        status, resp = make_request("/api/purchase-register/upload", "POST", body, headers)
        
        assert status == 200, f"Expected 200, got {status}: {resp}"
        res = json.loads(resp)
        assert res["mappingValid"] is False, "Expected mappingValid to be False on first upload."
        assert "Date" in res["columns"], "Expected detected columns in response."
        file_id_tally = res["file_id"]
        print("  Upload Success. file_id:", file_id_tally)
        print("  Detected Columns:", res["columns"])
        results.append(("1. Upload (first time) - mappingValid is False", "PASSED"))
        
        # ────────────────────────────────────────────────────────────────────────
        # 3. Save mapping configuration
        # ────────────────────────────────────────────────────────────────────────
        print("\n[Step 2] Saving mapping for client...")
        fingerprint = sorted(res["columns"])
        save_body = json.dumps({
            "client_gstin": CLIENT_GSTIN,
            "mapping": tally_mapping,
            "columns_fingerprint": fingerprint
        }).encode('utf-8')
        save_headers = {"Content-Type": "application/json"}
        
        status, resp = make_request("/api/purchase-register/save-mapping", "POST", save_body, save_headers)
        assert status == 200, f"Failed to save mapping: {resp}"
        print("  Mapping saved successfully.")
        results.append(("2. Save Mapping Config", "PASSED"))

        # ────────────────────────────────────────────────────────────────────────
        # 4. Run ingestion with mapping
        # ────────────────────────────────────────────────────────────────────────
        print("\n[Step 3] Running ingestion for Tally file...")
        ingest_body = json.dumps({
            "file_id": file_id_tally,
            "mapping": tally_mapping
        }).encode('utf-8')
        
        status, resp = make_request("/api/purchase-register/ingest", "POST", ingest_body, save_headers)
        assert status == 200, f"Ingest failed: {resp}"
        ingest_res = json.loads(resp)
        
        # Check validations
        clean_invs = [r["invoice_number"] for r in ingest_res["records"]]
        flagged_invs = [r["invoice_number"] for r in ingest_res["data_quality_flags"]]
        
        print("  Clean parsed invoices:", clean_invs)
        print("  Flagged data quality invoices:", flagged_invs)
        print("  Summary:", ingest_res["summary"])
        
        assert "INV-001" in clean_invs
        assert "INV-002" in clean_invs
        assert "INV-003" in flagged_invs # Invalid GSTIN
        assert any(i["invoice_number"] == "INV-004" and i["field"] == "invoice_date" for i in ingest_res["issues"]) # Bad Date
        
        results.append(("3. Ingestion & validations (G1, D1, D2 checks)", "PASSED"))

        # ────────────────────────────────────────────────────────────────────────
        # 5. Upload Tally CSV again — (Expect mappingValid = True, skips mapping)
        # ────────────────────────────────────────────────────────────────────────
        print("\n[Step 4] Uploading Tally file again (second time)...")
        body, headers = encode_multipart_formdata({"client_gstin": CLIENT_GSTIN}, {"file": tally_path})
        status, resp = make_request("/api/purchase-register/upload", "POST", body, headers)
        
        assert status == 200, f"Expected 200, got {status}: {resp}"
        res_sec = json.loads(resp)
        assert res_sec["mappingValid"] is True, "Expected mappingValid to be True on second upload."
        print("  Upload Success. mappingValid is True (remembered mapping works).")
        results.append(("4. Remember mapping (R1 check)", "PASSED"))
        
        # Cleanup secondary session
        make_request("/api/purchase-register/ingest", "POST", json.dumps({"file_id": res_sec["file_id"], "mapping": tally_mapping}).encode('utf-8'), save_headers)

        # ────────────────────────────────────────────────────────────────────────
        # 6. Upload Zoho CSV (Different structure) — (Expect mappingValid = False)
        # ────────────────────────────────────────────────────────────────────────
        print("\n[Step 5] Uploading Zoho file (different structure)...")
        body, headers = encode_multipart_formdata({"client_gstin": CLIENT_GSTIN}, {"file": zoho_path})
        status, resp = make_request("/api/purchase-register/upload", "POST", body, headers)
        
        assert status == 200, f"Expected 200, got {status}: {resp}"
        res_zoho = json.loads(resp)
        assert res_zoho["mappingValid"] is False, "Expected mappingValid to be False for different format."
        print("  Upload Success. mappingValid is False (correctly detected format change).")
        results.append(("5. Stale detection: Full swap (R2 check)", "PASSED"))
        
        # Cleanup zoho session
        make_request("/api/purchase-register/ingest", "POST", json.dumps({"file_id": res_zoho["file_id"], "mapping": zoho_mapping}).encode('utf-8'), save_headers)

        # ────────────────────────────────────────────────────────────────────────
        # 7. Upload Single Renamed Column — (Expect mappingValid = False)
        # ────────────────────────────────────────────────────────────────────────
        print("\n[Step 6] Uploading Tally file with one column renamed...")
        body, headers = encode_multipart_formdata({"client_gstin": CLIENT_GSTIN}, {"file": rename_path})
        status, resp = make_request("/api/purchase-register/upload", "POST", body, headers)
        
        assert status == 200, f"Expected 200, got {status}: {resp}"
        res_rename = json.loads(resp)
        assert res_rename["mappingValid"] is False, "Expected mappingValid to be False for single column change."
        print("  Upload Success. mappingValid is False (correctly detected single column change).")
        results.append(("6. Stale detection: Single column rename (R3 check)", "PASSED"))
        
        # Cleanup rename session
        tally_rename_mapping = tally_mapping.copy()
        tally_rename_mapping["vendor_gstin"] = "Vendor GSTIN No"
        make_request("/api/purchase-register/ingest", "POST", json.dumps({"file_id": res_rename["file_id"], "mapping": tally_rename_mapping}).encode('utf-8'), save_headers)

        # ────────────────────────────────────────────────────────────────────────
        # 8. Test Session Timeout / Expired file_id behavior
        # ────────────────────────────────────────────────────────────────────────
        print("\n[Step 7] Testing invalid/expired file_id behavior...")
        status, resp = make_request("/api/purchase-register/ingest", "POST", json.dumps({"file_id": "nonexistent-uuid", "mapping": {}}).encode('utf-8'), save_headers)
        assert status == 404, f"Expected 404, got {status}"
        resp_json = json.loads(resp)
        assert "Upload session not found" in resp_json["error"]
        print("  Correctly returned 404 error message:", resp_json["error"])
        results.append(("7. Invalid/expired session handling", "PASSED"))

    except Exception as exc:
        print("\n❌ Integration tests failed:", exc)
        results.append(("E2E Integration Tests", f"FAILED: {exc}"))
        sys.exit(1)
        
    finally:
        # Cleanup files
        try: os.unlink(tally_path)
        except: pass
        try: os.unlink(zoho_path)
        except: pass
        try: os.unlink(rename_path)
        except: pass

    print("\n" + "=" * 75)
    print("INTEGRATION TEST SUMMARY")
    print("=" * 75)
    all_pass = True
    for name, status in results:
        print(f"  [{status}] {name}")
        if status != "PASSED":
            all_pass = False
    print("=" * 75)
    
    if not all_pass:
        sys.exit(1)
    else:
        print("All integration tests passed successfully!\n")

if __name__ == "__main__":
    run_integration_tests()

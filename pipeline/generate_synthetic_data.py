#!/usr/bin/env python3
"""
GST ITC Synthetic Data Generator

This script generates two linked synthetic datasets for a GST Input Tax Credit (ITC) reconciliation tool:
1. Client Purchase Register (PR)
2. Corresponding GSTR-2B data (2B)

It simulates real-world invoicing patterns and common tax mismatch scenarios (clean matches, timing
differences, missing invoices, amount discrepancies, duplicates, and register-missing invoices)
using a fixed pool of clients and vendors.
"""

import argparse
import csv
import os
import random
import sys
import uuid
from datetime import datetime, timedelta

# ---------------------------------------------------------------------------
# Validator import -- supports running as script or as module
# ---------------------------------------------------------------------------
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJ_DIR = os.path.dirname(_THIS_DIR)
if _PROJ_DIR not in sys.path:
    sys.path.insert(0, _PROJ_DIR)
try:
    from pipeline.validators import validate_gstin
except ImportError:
    from validators import validate_gstin  # type: ignore[no-redef]

# List of realistic Indian business names and matching state codes for pool generation
STATES = [
    ("27", "MH", "Maharashtra"),
    ("29", "KA", "Karnataka"),
    ("07", "DL", "Delhi"),
    ("33", "TN", "Tamil Nadu"),
    ("09", "UP", "Uttar Pradesh"),
    ("19", "WB", "West Bengal"),
    ("24", "GJ", "Gujarat"),
    ("32", "KL", "Kerala"),
]

VENDOR_SUFFIXES = ["Pvt Ltd", "Industries", "Logistics", "Enterprises", "Solutions", "Services", "Trading Co", "Associates"]
VENDOR_FIRST_NAMES = [
    "Apex", "BlueStar", "Radiant", "Vertex", "Horizon", "Quantum", "Omega", "Delta",
    "Sigma", "Zenith", "Matrix", "Summit", "Genesis", "Infinity", "Pioneer", "Starlight",
    "Trident", "Beacon", "Vanguard", "Nova", "Alpha", "Meridian", "Ascent", "Eclipse"
]

CLIENT_NAMES = [
    "DecisionForge Corp", "OmniCorp India", "TechnoCraft Ltd", "CoreSystems Pvt Ltd",
    "EvolveTech Solutions", "FuturePrime Industries", "DeltaRetail", "LogiChain India",
    "InnovaWeb Services", "NexaRetailers", "GlobalTrade Link", "SmartWorks Solutions",
    "Intellect Partners", "Aura Enterprises", "SpectraLogistics", "UnitedDistributors",
    "SwiftCargo Pvt Ltd", "PrimeBazaar", "ZenithRetail", "CloudBase Systems"
]

GST_RATES = [0.05, 0.12, 0.18, 0.28]

def generate_gstin(state_code):
    """Generates a realistic mock GSTIN string for a given state code."""
    pan_chars = "".join(random.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=5))
    pan_digits = "".join(random.choices("0123456789", k=4))
    pan_last = random.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    entity_code = random.choice("123456789")
    check_digit = random.choice("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    return f"{state_code}{pan_chars}{pan_digits}{pan_last}{entity_code}Z{check_digit}"

def generate_invoice_number():
    """Generates a realistic invoice number string."""
    prefix = random.choice(["INV", "INV/26-27", "QT", "TX", "RE"])
    num = random.randint(1, 99999)
    if prefix == "INV/26-27":
        return f"INV/26-27/{num:04d}"
    return f"{prefix}-{num:05d}"

def get_adjacent_month(period_str, direction):
    """Returns the YYYY-MM period offset by ±1 month."""
    dt = datetime.strptime(period_str + "-01", "%Y-%m-%d")
    if direction == "plus":
        # Add 32 days and go to 1st of month
        next_dt = dt + timedelta(days=32)
        return next_dt.strftime("%Y-%m")
    else:
        # Subtract 15 days and go to 1st of month
        prev_dt = dt - timedelta(days=15)
        return prev_dt.strftime("%Y-%m")

def main():
    parser = argparse.ArgumentParser(description="Generate linked synthetic GST PR and GSTR-2B data.")
    parser.add_argument("count_pos", nargs="?", type=int, default=None, help="Number of PR invoices (positional)")
    parser.add_argument("--count", "-c", type=int, default=1000, help="Number of PR invoices (keyword)")
    parser.add_argument("--seed", "-s", type=int, default=None, help="Random seed for reproducibility")
    args = parser.parse_args()

    # Determine final count
    count = args.count_pos if args.count_pos is not None else args.count
    if args.seed is not None:
        random.seed(args.seed)

    print(f"Generating synthetic datasets with base count = {count} (Seed: {args.seed})...")

    # 1. Generate client pool (~20 clients)
    clients = []
    for i in range(20):
        state = random.choice(STATES)
        gstin = generate_gstin(state[0])
        # Validate immediately -- a failure here is a generator bug, not a data issue.
        _ok, _err = validate_gstin(gstin)
        if not _ok:
            raise RuntimeError(
                f"Generator bug: produced structurally invalid client GSTIN "
                f"'{gstin}' for state '{state[0]}': {_err}"
            )
        name = CLIENT_NAMES[i % len(CLIENT_NAMES)]
        clients.append({"gstin": gstin, "name": name, "state_code": state[0]})

    # 2. Generate vendor pool (~80 vendors)
    vendors = []
    for i in range(80):
        state = random.choice(STATES)
        gstin = generate_gstin(state[0])
        # Validate immediately -- a failure here is a generator bug, not a data issue.
        _ok, _err = validate_gstin(gstin)
        if not _ok:
            raise RuntimeError(
                f"Generator bug: produced structurally invalid vendor GSTIN "
                f"'{gstin}' for state '{state[0]}': {_err}"
            )
        name = f"{random.choice(VENDOR_FIRST_NAMES)} {random.choice(VENDOR_SUFFIXES)}"
        vendors.append({"gstin": gstin, "name": name, "state_code": state[0]})

    purchase_register = []
    gstr2b_records = []

    # Helper function to compute GST components based on state matching
    def compute_gst(taxable, client_state, vendor_state, rate=None):
        if rate is None:
            rate = random.choice(GST_RATES)
        # Determine intra-state vs inter-state
        if client_state == vendor_state:
            cgst = round((taxable * rate) / 2.0, 2)
            sgst = cgst
            igst = 0.0
        else:
            cgst = 0.0
            sgst = 0.0
            igst = round(taxable * rate, 2)
        total_itc = round(cgst + sgst + igst, 2)
        return cgst, sgst, igst, total_itc, rate

    # Helper to generate right-skewed taxable values
    # Median is exp(10.12) ~ 25k; range is mostly 5k to 200k, occasionally up to 2M.
    def get_taxable_value():
        val = random.lognormvariate(10.12, 1.2)
        # Clamp between 1,000 and 2,000,000
        return round(max(1000.0, min(2000000.0, val)), 2)

    # 3. Generate baseline PR records and match them to GSTR-2B based on mismatch logic
    for _ in range(count):
        client = random.choice(clients)
        vendor = random.choice(vendors)
        
        # Invoicing details
        invoice_id = str(uuid.uuid4())
        invoice_num = generate_invoice_number()
        
        # Generate random date in 2026
        start_date = datetime(2026, 1, 1)
        random_days = random.randint(0, 150)  # Jan to May 2026
        inv_date_obj = start_date + timedelta(days=random_days)
        invoice_date = inv_date_obj.strftime("%Y-%m-%d")
        
        # Expected filing period (usually same or next month)
        base_filing_period = inv_date_obj.strftime("%Y-%m")
        if random.random() < 0.3:
            # Filed in next month
            base_filing_period = get_adjacent_month(base_filing_period, "plus")

        taxable_value = get_taxable_value()
        cgst, sgst, igst, total_itc, rate = compute_gst(taxable_value, client["state_code"], vendor["state_code"])

        # Decide mismatch category
        rand = random.random() * 100.0

        if rand < 65.0:
            # CLEAN_MATCH (~65%)
            # Add to Purchase Register
            purchase_register.append({
                "invoice_id": invoice_id, "vendor_gstin": vendor["gstin"], "vendor_name": vendor["name"],
                "invoice_date": invoice_date, "invoice_number": invoice_num, "taxable_value": taxable_value,
                "cgst": cgst, "sgst": sgst, "igst": igst, "total_itc_claimed": total_itc, "client_gstin": client["gstin"]
            })
            
            # GSTR-2B amounts can have tiny variations under ₹100 due to rounding differences
            deviation = round(random.uniform(-99.0, 99.0), 2) if random.random() < 0.05 else 0.0
            taxable_2b = max(100.0, round(taxable_value + deviation, 2))
            cgst_2b, sgst_2b, igst_2b, total_itc_2b, _ = compute_gst(taxable_2b, client["state_code"], vendor["state_code"], rate=rate)

            # Add to GSTR-2B
            gstr2b_records.append({
                "gstr2b_id": str(uuid.uuid4()), "vendor_gstin": vendor["gstin"], "invoice_number": invoice_num,
                "invoice_date": invoice_date, "taxable_value": taxable_2b, "cgst": cgst_2b, "sgst": sgst_2b, "igst": igst_2b,
                "itc_available": total_itc_2b, "filing_period": base_filing_period
            })

        elif rand < 80.0:
            # TIMING_DIFFERENCE (~15%)
            # Add to Purchase Register
            purchase_register.append({
                "invoice_id": invoice_id, "vendor_gstin": vendor["gstin"], "vendor_name": vendor["name"],
                "invoice_date": invoice_date, "invoice_number": invoice_num, "taxable_value": taxable_value,
                "cgst": cgst, "sgst": sgst, "igst": igst, "total_itc_claimed": total_itc, "client_gstin": client["gstin"]
            })
            
            # Filing period is offset by exactly +1 or -1 calendar month
            offset_dir = "plus" if random.random() < 0.5 else "minus"
            adjusted_period = get_adjacent_month(base_filing_period, offset_dir)

            # Add to GSTR-2B
            gstr2b_records.append({
                "gstr2b_id": str(uuid.uuid4()), "vendor_gstin": vendor["gstin"], "invoice_number": invoice_num,
                "invoice_date": invoice_date, "taxable_value": taxable_value, "cgst": cgst, "sgst": sgst, "igst": igst,
                "itc_available": total_itc, "filing_period": adjusted_period
            })

        elif rand < 90.0:
            # MISSING_IN_2B (~10%)
            # Add to Purchase Register, but do not create a corresponding GSTR-2B record
            purchase_register.append({
                "invoice_id": invoice_id, "vendor_gstin": vendor["gstin"], "vendor_name": vendor["name"],
                "invoice_date": invoice_date, "invoice_number": invoice_num, "taxable_value": taxable_value,
                "cgst": cgst, "sgst": sgst, "igst": igst, "total_itc_claimed": total_itc, "client_gstin": client["gstin"]
            })

        elif rand < 95.0:
            # AMOUNT_MISMATCH (~5%)
            # Add to Purchase Register
            purchase_register.append({
                "invoice_id": invoice_id, "vendor_gstin": vendor["gstin"], "vendor_name": vendor["name"],
                "invoice_date": invoice_date, "invoice_number": invoice_num, "taxable_value": taxable_value,
                "cgst": cgst, "sgst": sgst, "igst": igst, "total_itc_claimed": total_itc, "client_gstin": client["gstin"]
            })

            # Significant deviation (more than ₹100, up to 15% of the original invoice value or flat large amount)
            deviation = round(random.choice([random.uniform(150.0, 5000.0), -random.uniform(150.0, 5000.0)]), 2)
            taxable_2b = max(500.0, round(taxable_value + deviation, 2))
            cgst_2b, sgst_2b, igst_2b, total_itc_2b, _ = compute_gst(taxable_2b, client["state_code"], vendor["state_code"], rate=rate)

            # Add to GSTR-2B
            gstr2b_records.append({
                "gstr2b_id": str(uuid.uuid4()), "vendor_gstin": vendor["gstin"], "invoice_number": invoice_num,
                "invoice_date": invoice_date, "taxable_value": taxable_2b, "cgst": cgst_2b, "sgst": sgst_2b, "igst": igst_2b,
                "itc_available": total_itc_2b, "filing_period": base_filing_period
            })

        elif rand < 98.0:
            # MISSING_IN_REGISTER (~3%)
            # Generates an extra unmatched GSTR-2B entry (not present in Purchase Register)
            # Create a separate GSTR-2B record
            gstr2b_records.append({
                "gstr2b_id": str(uuid.uuid4()), "vendor_gstin": vendor["gstin"], "invoice_number": invoice_num,
                "invoice_date": invoice_date, "taxable_value": taxable_value, "cgst": cgst, "sgst": sgst, "igst": igst,
                "itc_available": total_itc, "filing_period": base_filing_period
            })

        else:
            # DUPLICATE_CLAIM (~2%)
            # The Purchase Register gets TWO entries for the same invoice_number + client_gstin
            # Add first record to Purchase Register
            purchase_register.append({
                "invoice_id": invoice_id, "vendor_gstin": vendor["gstin"], "vendor_name": vendor["name"],
                "invoice_date": invoice_date, "invoice_number": invoice_num, "taxable_value": taxable_value,
                "cgst": cgst, "sgst": sgst, "igst": igst, "total_itc_claimed": total_itc, "client_gstin": client["gstin"]
            })
            
            # Add second (duplicate) record with new invoice_id but same details
            purchase_register.append({
                "invoice_id": str(uuid.uuid4()), "vendor_gstin": vendor["gstin"], "vendor_name": vendor["name"],
                "invoice_date": invoice_date, "invoice_number": invoice_num, "taxable_value": taxable_value,
                "cgst": cgst, "sgst": sgst, "igst": igst, "total_itc_claimed": total_itc, "client_gstin": client["gstin"]
            })

            # The GSTR-2B correctly contains only one entry
            gstr2b_records.append({
                "gstr2b_id": str(uuid.uuid4()), "vendor_gstin": vendor["gstin"], "invoice_number": invoice_num,
                "invoice_date": invoice_date, "taxable_value": taxable_value, "cgst": cgst, "sgst": sgst, "igst": igst,
                "itc_available": total_itc, "filing_period": base_filing_period
            })

    # 4. Save to files
    os.makedirs("data", exist_ok=True)
    
    pr_file_path = f"data/purchase_register_{count}.csv"
    gstr2b_file_path = f"data/gstr2b_{count}.csv"

    # Write Purchase Register CSV
    pr_fields = ["invoice_id", "vendor_gstin", "vendor_name", "invoice_date", "invoice_number", "taxable_value", "cgst", "sgst", "igst", "total_itc_claimed", "client_gstin"]
    with open(pr_file_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=pr_fields)
        writer.writeheader()
        writer.writerows(purchase_register)

    # Write GSTR-2B CSV
    gstr2b_fields = ["gstr2b_id", "vendor_gstin", "invoice_number", "invoice_date", "taxable_value", "cgst", "sgst", "igst", "itc_available", "filing_period"]
    with open(gstr2b_file_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=gstr2b_fields)
        writer.writeheader()
        writer.writerows(gstr2b_records)

    print(f"Generation complete!")
    print(f"  - Purchase Register: {len(purchase_register)} rows written to {pr_file_path}")
    print(f"  - GSTR-2B: {len(gstr2b_records)} rows written to {gstr2b_file_path}")

if __name__ == "__main__":
    main()

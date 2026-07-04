#!/usr/bin/env python3
"""
benchmark_cpu_vs_gpu.py

Benchmarks the GST ITC reconciliation pipeline on CPU (pandas) vs GPU (cudf).

Usage:
    python benchmark_cpu_vs_gpu.py <purchase_register_csv> <gstr2b_csv>

Example:
    python benchmark_cpu_vs_gpu.py data/purchase_register_50000.csv data/gstr2b_50000.csv

The script:
  1. Loads both CSVs using the specified library (pandas or cudf).
  2. Performs a full outer join on vendor_gstin + invoice_number.
  3. Classifies each row into a mismatch_type using the same logic as the
     BigQuery `reconciliation_matches` view (bigquery_views.sql).
  4. Computes itc_at_risk per row:
       - total_itc_claimed  when mismatch_type is MISSING_IN_2B or AMOUNT_MISMATCH
       - 0                  otherwise
  5. Groups by client_gstin and sums itc_at_risk.
  6. Repeats each pipeline 3 times, records individual and average runtimes.
  7. Prints a formatted results table.
  8. Saves per-run timings to /data/benchmark_results.csv.

Notes:
  - cudf must be installed and a CUDA GPU must be present. If not, the script
    exits immediately with a clear error rather than silently falling back.
  - Designed to run unmodified inside a Colab notebook cell.
"""

import sys
import time
import argparse
import csv
import os


# ---------------------------------------------------------------------------
# Guard: cudf must be importable before we do anything else.
# ---------------------------------------------------------------------------
try:
    import cudf
    CUDF_AVAILABLE = True
except ImportError:
    CUDF_AVAILABLE = False

if not CUDF_AVAILABLE:
    print(
        "\n[ERROR] cudf is not installed or could not be imported.\n"
        "  Install it via the RAPIDS installer for your CUDA version:\n"
        "    pip install cudf-cu12 --extra-index-url https://pypi.nvidia.com\n"
        "  (replace cu12 with your CUDA version, e.g. cu11 for CUDA 11.x)\n"
        "  cudf requires an NVIDIA GPU with a supported CUDA toolkit.\n"
        "  This script will not fall back to pandas-only to ensure a fair benchmark.\n",
        file=sys.stderr,
    )
    sys.exit(1)

import pandas as pd

# ---------------------------------------------------------------------------
# Constants — must match BigQuery reconciliation_matches classification logic
# ---------------------------------------------------------------------------
AMOUNT_TOLERANCE = 100.0  # ₹100 threshold for clean-match tolerance


# ---------------------------------------------------------------------------
# Core reconciliation function — library-agnostic (works for pandas and cudf)
# ---------------------------------------------------------------------------
def run_reconciliation(lib, pr_df, gstr2b_df):
    """
    Executes the full reconciliation pipeline using the provided dataframe library.

    Steps:
      1. Count duplicates in the purchase register (DUPLICATE_CLAIM detection).
      2. Full outer join PR and GSTR-2B on vendor_gstin + invoice_number.
      3. Classify mismatch_type for each row.
      4. Compute itc_at_risk.
      5. Group by client_gstin and sum itc_at_risk.

    Parameters
    ----------
    lib : module
        Either `pandas` or `cudf` — both expose the same DataFrame API used here.
    pr_df : DataFrame
        Purchase Register dataframe (loaded with `lib`).
    gstr2b_df : DataFrame
        GSTR-2B dataframe (loaded with `lib`).

    Returns
    -------
    DataFrame
        Summary grouped by client_gstin with total itc_at_risk.
    """

    # --- Step 1: Mark duplicate invoices in the purchase register.
    # A DUPLICATE_CLAIM is when the same invoice_number + client_gstin + vendor_gstin
    # appears more than once in the purchase register.
    dup_counts = (
        pr_df.groupby(["client_gstin", "invoice_number", "vendor_gstin"])
        .size()
        .reset_index()
    )
    dup_counts.columns = ["client_gstin", "invoice_number", "vendor_gstin", "dup_count"]
    pr_df = pr_df.merge(dup_counts, on=["client_gstin", "invoice_number", "vendor_gstin"], how="left")

    # --- Step 2: Full outer join on vendor_gstin + invoice_number.
    # Suffix _pr = purchase register side, _2b = GSTR-2B side.
    merged = pr_df.merge(
        gstr2b_df,
        on=["vendor_gstin", "invoice_number"],
        how="outer",
        suffixes=("_pr", "_2b"),
    )

    # --- Step 3: Compute derived difference columns used in classification.
    # ABS(taxable_value_pr - taxable_value_2b)
    merged["taxable_diff"] = (
        merged["taxable_value_pr"].fillna(0) - merged["taxable_value_2b"].fillna(0)
    ).abs()

    # total tax on PR side: cgst + sgst + igst (= total_itc_claimed already, but recompute for clarity)
    merged["total_tax_pr"] = (
        merged["cgst_pr"].fillna(0) + merged["sgst_pr"].fillna(0) + merged["igst_pr"].fillna(0)
    )
    # total tax on 2B side: cgst + sgst + igst (= itc_available already)
    merged["total_tax_2b"] = (
        merged["cgst_2b"].fillna(0) + merged["sgst_2b"].fillna(0) + merged["igst_2b"].fillna(0)
    )
    merged["tax_diff"] = (merged["total_tax_pr"] - merged["total_tax_2b"]).abs()

    # Flags used in the CASE expression below
    pr_exists  = merged["invoice_id"].notna()    # PR side present
    b_exists   = merged["gstr2b_id"].notna()     # 2B side present
    is_dup     = merged.get("dup_count", 0) > 1  # Duplicate in PR (col may not exist on 2B-only rows)
    amounts_ok = (merged["taxable_diff"] <= AMOUNT_TOLERANCE) & (merged["tax_diff"] <= AMOUNT_TOLERANCE)

    # --- Replicate the GSTR-2B filing_period == YYYY-MM of invoice_date check.
    # invoice_date_pr is a date; extract YYYY-MM string for comparison with filing_period.
    # Both pandas and cudf support dt accessor.
    try:
        merged["invoice_ym"] = (
            merged["invoice_date_pr"]
            .astype("datetime64[ms]")
            .dt.strftime("%Y-%m")
        )
    except Exception:
        # Fallback: treat as string and take first 7 chars
        merged["invoice_ym"] = merged["invoice_date_pr"].astype(str).str[:7]

    filing_period_col = "filing_period" if "filing_period" in merged.columns else None
    if filing_period_col:
        same_period = merged["filing_period"].fillna("") == merged["invoice_ym"].fillna("")
    else:
        same_period = lib.Series([False] * len(merged), dtype=bool)

    # --- Step 3 (continued): Classify mismatch_type.
    # Priority order matches the BigQuery CASE WHEN logic:
    #   1. DUPLICATE_CLAIM (PR side, dup_count > 1)
    #   2. MISSING_IN_2B  (PR side only)
    #   3. MISSING_IN_REGISTER (2B side only)
    #   4. CLEAN_MATCH    (both, amounts within tolerance, same period)
    #   5. TIMING_DIFFERENCE (both, amounts within tolerance, period off by 1 month)
    #   6. AMOUNT_MISMATCH (both, but amounts differ > ₹100)
    conditions = [
        pr_exists & is_dup,                               # DUPLICATE_CLAIM
        pr_exists & ~b_exists,                            # MISSING_IN_2B
        ~pr_exists & b_exists,                            # MISSING_IN_REGISTER
        pr_exists & b_exists & amounts_ok & same_period,  # CLEAN_MATCH
        pr_exists & b_exists & amounts_ok & ~same_period, # TIMING_DIFFERENCE (amounts match, period off)
    ]
    choices = [
        "DUPLICATE_CLAIM",
        "MISSING_IN_2B",
        "MISSING_IN_REGISTER",
        "CLEAN_MATCH",
        "TIMING_DIFFERENCE",
    ]

    # numpy/cupy select equivalent — use pandas/cudf where() chaining
    # Build the mismatch_type column with a priority cascade
    mismatch = lib.Series(["AMOUNT_MISMATCH"] * len(merged), dtype="object")
    # Apply in reverse priority so the highest-priority overwrites last
    for cond, choice in zip(reversed(conditions), reversed(choices)):
        mismatch = mismatch.where(~cond, other=choice)
    merged["mismatch_type"] = mismatch

    # --- Step 4: Compute itc_at_risk.
    at_risk_types = {"MISSING_IN_2B", "AMOUNT_MISMATCH"}
    merged["itc_at_risk"] = merged["total_itc_claimed"].fillna(0).where(
        merged["mismatch_type"].isin(at_risk_types), other=0.0
    )

    # --- Step 5: Group by client_gstin and sum itc_at_risk.
    summary = (
        merged.groupby("client_gstin", dropna=False)["itc_at_risk"]
        .sum()
        .reset_index()
    )
    return summary


# ---------------------------------------------------------------------------
# Timing harness
# ---------------------------------------------------------------------------
def time_pipeline(lib, pr_path, gstr2b_path, n_runs=3, label="pandas"):
    """
    Runs the full reconciliation pipeline `n_runs` times, returning individual
    and average wall-clock seconds.

    The CSV loading is included inside the timed region so that cudf's
    GPU transfer overhead (which is part of the real-world cost) is measured.

    Parameters
    ----------
    lib : module
        pandas or cudf.
    pr_path : str
        Path to the Purchase Register CSV file.
    gstr2b_path : str
        Path to the GSTR-2B CSV file.
    n_runs : int
        Number of timed repetitions.
    label : str
        Label for progress messages.

    Returns
    -------
    tuple[list[float], float]
        (individual_times_sec, average_time_sec)
    """
    run_times = []
    for i in range(1, n_runs + 1):
        print(f"  [{label}] Run {i}/{n_runs} ...", end=" ", flush=True)
        t0 = time.perf_counter()

        # Load CSVs inside the timed region (includes IO + GPU transfer for cudf)
        pr_df    = lib.read_csv(pr_path,    dtype={"filing_period": str, "invoice_date": str})
        gstr2b_df = lib.read_csv(gstr2b_path, dtype={"filing_period": str, "invoice_date": str})

        _result = run_reconciliation(lib, pr_df, gstr2b_df)

        elapsed = time.perf_counter() - t0
        run_times.append(elapsed)
        print(f"{elapsed:.4f}s")

    avg = sum(run_times) / len(run_times)
    return run_times, avg


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Benchmark GST ITC reconciliation: pandas (CPU) vs cudf (GPU)."
    )
    parser.add_argument(
        "purchase_register",
        help="Path to the Purchase Register CSV file.",
    )
    parser.add_argument(
        "gstr2b",
        help="Path to the GSTR-2B CSV file.",
    )
    parser.add_argument(
        "--runs",
        type=int,
        default=3,
        help="Number of timed repetitions per backend (default: 3).",
    )
    parser.add_argument(
        "--output",
        default="data/benchmark_results.csv",
        help="Path for the benchmark results CSV (default: data/benchmark_results.csv).",
    )
    args = parser.parse_args()

    pr_path     = args.purchase_register
    gstr2b_path = args.gstr2b
    n_runs      = args.runs
    output_path = args.output

    # Quick sanity check on input files
    for path in (pr_path, gstr2b_path):
        if not os.path.exists(path):
            print(f"[ERROR] File not found: {path}", file=sys.stderr)
            sys.exit(1)

    # Row count (from pandas, once, not timed)
    row_count = len(pd.read_csv(pr_path, usecols=["invoice_id"]))
    print(f"\nPurchase Register row count: {row_count:,}")
    print(f"Running {n_runs} timed iteration(s) per backend.\n")

    # --- pandas benchmark
    print("=== pandas (CPU) ===")
    pandas_times, pandas_avg = time_pipeline(pd, pr_path, gstr2b_path, n_runs=n_runs, label="pandas")

    # --- cudf benchmark
    print("\n=== cudf (GPU) ===")
    cudf_times, cudf_avg = time_pipeline(cudf, pr_path, gstr2b_path, n_runs=n_runs, label="cudf")

    # --- Compute speedup
    speedup = pandas_avg / cudf_avg if cudf_avg > 0 else float("inf")

    # --- Print results table
    col_w = 22
    print("\n" + "=" * 80)
    print("BENCHMARK RESULTS")
    print("=" * 80)
    print(f"{'Metric':<{col_w}} {'pandas (CPU)':>{col_w}} {'cudf (GPU)':>{col_w}}")
    print("-" * 80)
    for i, (pt, ct) in enumerate(zip(pandas_times, cudf_times), start=1):
        print(f"  Run {i} (sec):{'':<{col_w - 10}} {pt:>{col_w}.4f} {ct:>{col_w}.4f}")
    print("-" * 80)
    print(f"{'Average (sec)':<{col_w}} {pandas_avg:>{col_w}.4f} {cudf_avg:>{col_w}.4f}")
    print(f"{'Speedup Factor':>{col_w + 1}} {'':>{col_w}} {speedup:>{col_w}.2f}x")
    print("=" * 80)
    print(f"\nRow count used: {row_count:,}")
    print(f"pandas avg: {pandas_avg:.4f}s  |  cudf avg: {cudf_avg:.4f}s  |  GPU speedup: {speedup:.2f}x\n")

    # --- Save results to CSV
    os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else ".", exist_ok=True)

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        # Header
        header = (
            ["row_count", "backend", "run_number", "time_sec",
             "pandas_avg_sec", "cudf_avg_sec", "speedup_factor"]
        )
        writer.writerow(header)

        # pandas rows
        for i, t in enumerate(pandas_times, start=1):
            writer.writerow([row_count, "pandas", i, round(t, 6),
                             round(pandas_avg, 6), round(cudf_avg, 6), round(speedup, 4)])
        # cudf rows
        for i, t in enumerate(cudf_times, start=1):
            writer.writerow([row_count, "cudf", i, round(t, 6),
                             round(pandas_avg, 6), round(cudf_avg, 6), round(speedup, 4)])

    print(f"Results saved to: {output_path}")


if __name__ == "__main__":
    main()

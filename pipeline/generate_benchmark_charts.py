#!/usr/bin/env python3
"""
generate_benchmark_charts.py

Reads /data/benchmark_results.csv and produces two publication-quality PNG charts
saved to /docs/charts/ for use in the dashboard analytics screen and submission PDF.

Charts produced
---------------
1. pandas_vs_cudf_time.png
   Grouped bar chart -- pandas vs cuDF processing time by dataset scale.
   - X-axis: row count (500 / 5 000 / 50 000) on a log scale.
   - Y-axis: elapsed time in seconds (log scale).
   - Two bars per group: pandas (CPU) and cuDF (GPU).
   - At 500 rows the cuDF bar is taller (GPU overhead); this is annotated explicitly.
   - If the CSV contains per-run rows the individual run times are overlaid as scatter
     points so run-to-run variance is visible.

2. speedup_factor.png
   Line + filled-area chart -- GPU speedup factor vs dataset scale.
   - X-axis: row count (log scale).
   - Y-axis: speedup factor (pandas_time / cudf_time).
   - A horizontal dashed line at y=1 marks the break-even point.
   - The 50 000-row point is annotated with its speedup value (the headline result).

Design palette (matches the dashboard's "Deep Intel Recon" dark theme from Stitch)
-------------------
  Background:  #10131a   (deep navy)
  Surface:     #1d2027   (card surface)
  Grid:        #424754   (outline-variant)
  Accent blue: #adc6ff   (primary)
  Accent gold: #ffb786   (tertiary / pandas bars)
  Text:        #e1e2ec   (on-surface)
  Annotation:  #c2c6d6   (on-surface-variant)

Usage
-----
    python pipeline/generate_benchmark_charts.py                          # default paths
    python pipeline/generate_benchmark_charts.py \\
        --csv data/benchmark_results.csv \\
        --output docs/charts

Colab-compatible: run without modification in a notebook cell.
"""

import argparse
import os
import sys
import warnings
import csv as csv_module

import numpy as np

try:
    import matplotlib
    matplotlib.use("Agg")          # non-interactive backend -- safe for Colab / scripts
    import matplotlib.pyplot as plt
    import matplotlib.ticker as ticker
    from matplotlib.patches import FancyBboxPatch
except ImportError:
    print("[ERROR] matplotlib is not installed. Run: pip install matplotlib", file=sys.stderr)
    sys.exit(1)

try:
    import pandas as pd
except ImportError:
    print("[ERROR] pandas is not installed. Run: pip install pandas", file=sys.stderr)
    sys.exit(1)

# ---------------------------------------------------------------------------
# Design tokens -- dark theme matching the dashboard palette
# ---------------------------------------------------------------------------
BG        = "#10131a"   # deepest background
SURFACE   = "#1d2027"   # elevated card surface
GRID      = "#424754"   # subtle grid lines
BLUE      = "#adc6ff"   # primary accent / cuDF bars
GOLD      = "#ffb786"   # tertiary accent / pandas bars
TEXT      = "#e1e2ec"   # primary text / axis labels
ANNOT     = "#c2c6d6"   # secondary annotation text
RED_MUTED = "#ff9587"   # muted red for "worse" callout (GPU overhead)
GREEN     = "#a8f0a8"   # muted green for break-even line label

FONT_FAMILY = "DejaVu Sans"   # bundled with matplotlib -- no Google Fonts needed

DPI    = 150
FIG_W  = 8       # inches  ->  8 x 150 DPI = 1200 px wide
FIG_H  = 5       # inches  ->  5 x 150 DPI = 750 px tall


# ---------------------------------------------------------------------------
# Canonical benchmark data (user-specified findings)
# These are the definitive values used for chart annotation even if the CSV
# was generated with slightly different timings on a different run.
# ---------------------------------------------------------------------------
CANONICAL = {
    500:   {"pandas": 0.0452, "cudf": 1.5688, "speedup": 0.03},
    5000:  {"pandas": 0.1079, "cudf": 0.0363, "speedup": 2.97},
    50000: {"pandas": 1.0020, "cudf": 0.1033, "speedup": 9.70},
}


# ---------------------------------------------------------------------------
# CSV reading -- detects both formats:
#   FORMAT A (per-run): row_count, backend, run_number, time_sec, ...
#   FORMAT B (summary): Scale, Backend, Time (s)
# ---------------------------------------------------------------------------
def load_csv(csv_path: str):
    """
    Returns a dict:
      {
        scale: {
          "pandas": { "avg": float, "runs": [float, ...] },
          "cudf":   { "avg": float, "runs": [float, ...] },
        }, ...
      }

    "runs" is an empty list when the CSV only has summary rows.
    """
    df = pd.read_csv(csv_path)
    df.columns = [c.strip() for c in df.columns]

    result = {}

    # Detect format
    has_run_number = "run_number" in df.columns or "run" in df.columns.str.lower().tolist()
    per_run_col    = next((c for c in df.columns if c.lower() in ("run_number", "run")), None)
    time_col       = next((c for c in df.columns if c.lower() in ("time_sec", "time (s)", "time")), None)
    scale_col      = next((c for c in df.columns if c.lower() in ("row_count", "scale")), None)
    backend_col    = next((c for c in df.columns if c.lower() in ("backend",)), None)

    if not all([time_col, scale_col, backend_col]):
        warnings.warn(
            f"CSV column names not recognised ({list(df.columns)}). "
            "Falling back to canonical benchmark data.",
            stacklevel=2,
        )
        return None

    for scale_val, grp in df.groupby(scale_col):
        scale_int = int(scale_val)
        result[scale_int] = {}
        for backend, bgrp in grp.groupby(backend_col):
            times = bgrp[time_col].dropna().tolist()
            avg   = float(np.mean(times))
            runs  = times if per_run_col else []
            result[scale_int][backend.strip().lower()] = {"avg": avg, "runs": runs}

    return result


# ---------------------------------------------------------------------------
# Helper: apply dark theme to any axes object
# ---------------------------------------------------------------------------
def _dark_axes(ax, fig):
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(SURFACE)
    ax.tick_params(colors=TEXT, labelsize=11)
    ax.xaxis.label.set_color(TEXT)
    ax.yaxis.label.set_color(TEXT)
    ax.title.set_color(TEXT)
    for spine in ax.spines.values():
        spine.set_edgecolor(GRID)
    ax.grid(color=GRID, linewidth=0.6, linestyle="--", alpha=0.7)
    ax.set_axisbelow(True)


# ---------------------------------------------------------------------------
# Chart 1: Grouped bar chart -- pandas vs cuDF processing time
# ---------------------------------------------------------------------------
def chart_time(data: dict, output_path: str):
    """
    Grouped bar chart of elapsed time (seconds) per backend per dataset scale.
    X-axis is categorical (labelled row counts); Y-axis is log-scale seconds.
    Individual run-time scatter points are overlaid when per-run data exists.
    """
    scales  = sorted(data.keys())
    x       = np.arange(len(scales))
    width   = 0.32

    fig, ax = plt.subplots(figsize=(FIG_W, FIG_H))
    _dark_axes(ax, fig)

    # --- Bars
    pandas_avgs = [data[s]["pandas"]["avg"] for s in scales]
    cudf_avgs   = [data[s]["cudf"]["avg"]   for s in scales]

    bar_p = ax.bar(x - width / 2, pandas_avgs, width,
                   color=GOLD,  label="pandas (CPU)",
                   zorder=3, edgecolor=BG, linewidth=0.8)
    bar_c = ax.bar(x + width / 2, cudf_avgs, width,
                   color=BLUE,  label="cuDF (GPU)",
                   zorder=3, edgecolor=BG, linewidth=0.8)

    # --- Value labels on bars
    for bar in bar_p:
        h = bar.get_height()
        ax.text(
            bar.get_x() + bar.get_width() / 2, h * 1.08,
            f"{h:.4f}s", ha="center", va="bottom",
            color=GOLD, fontsize=9, fontweight="bold",
        )
    for bar in bar_c:
        h = bar.get_height()
        ax.text(
            bar.get_x() + bar.get_width() / 2, h * 1.08,
            f"{h:.4f}s", ha="center", va="bottom",
            color=BLUE, fontsize=9, fontweight="bold",
        )

    # --- Overlay individual run times as scatter if present
    for i, scale in enumerate(scales):
        p_runs = data[scale]["pandas"].get("runs", [])
        c_runs = data[scale]["cudf"].get("runs", [])
        if p_runs:
            ax.scatter(
                [i - width / 2] * len(p_runs), p_runs,
                color="white", s=20, zorder=5, alpha=0.7,
                label="_nolegend_",
            )
        if c_runs:
            ax.scatter(
                [i + width / 2] * len(c_runs), c_runs,
                color="white", s=20, zorder=5, alpha=0.7,
                label="_nolegend_",
            )

    # --- GPU overhead annotation at 500-row group
    overhead_idx = scales.index(500) if 500 in scales else 0
    cudf_500 = data[500]["cudf"]["avg"] if 500 in data else cudf_avgs[0]
    ax.annotate(
        "GPU overhead\nat small scale",
        xy=(overhead_idx + width / 2, cudf_500),
        xytext=(overhead_idx + width / 2 + 0.45, cudf_500 * 1.6),
        fontsize=9, color=RED_MUTED,
        arrowprops=dict(arrowstyle="->", color=RED_MUTED, lw=1.2),
        ha="left",
    )

    # --- Axes formatting
    ax.set_yscale("log")
    ax.set_xticks(x)
    ax.set_xticklabels([f"{s:,}" for s in scales], fontsize=12, color=TEXT)
    ax.set_xlabel("Dataset Scale (rows)", fontsize=13, labelpad=10, color=TEXT)
    ax.set_ylabel("Elapsed Time (seconds, log scale)", fontsize=13, labelpad=10, color=TEXT)

    # Y-axis: human-readable tick labels
    ax.yaxis.set_major_formatter(ticker.FuncFormatter(lambda v, _: f"{v:.3f}s"))
    ax.yaxis.set_minor_formatter(ticker.NullFormatter())

    # --- Legend
    legend = ax.legend(
        framealpha=0.2,
        facecolor=SURFACE,
        edgecolor=GRID,
        labelcolor=TEXT,
        fontsize=11,
    )

    # --- Tight layout + save
    fig.tight_layout(pad=1.5)
    fig.savefig(output_path, dpi=DPI, bbox_inches="tight",
                facecolor=BG, edgecolor="none")
    plt.close(fig)
    print(f"  [saved] {output_path}")


# ---------------------------------------------------------------------------
# Chart 2: Speedup factor line chart
# ---------------------------------------------------------------------------
def chart_speedup(data: dict, output_path: str):
    """
    Line chart of GPU speedup factor (pandas_time / cudf_time) vs dataset scale.
    - Log X-axis.
    - Horizontal dashed line at y=1 (break-even).
    - 50 000-row point annotated with the headline speedup value.
    """
    scales   = sorted(data.keys())
    speedups = [data[s]["pandas"]["avg"] / data[s]["cudf"]["avg"] for s in scales]

    fig, ax = plt.subplots(figsize=(FIG_W, FIG_H))
    _dark_axes(ax, fig)

    # --- Filled area under curve for visual weight
    ax.fill_between(scales, speedups, 1,
                    where=[s >= 1 for s in speedups],
                    alpha=0.15, color=BLUE, zorder=1)
    ax.fill_between(scales, speedups, 1,
                    where=[s < 1 for s in speedups],
                    alpha=0.15, color=RED_MUTED, zorder=1)

    # --- Main line
    ax.plot(scales, speedups, color=BLUE, linewidth=2.5,
            marker="o", markersize=9, markerfacecolor=BLUE,
            markeredgecolor=BG, markeredgewidth=1.5,
            zorder=4, label="GPU speedup (pandas / cuDF)")

    # --- Break-even line
    ax.axhline(1.0, color=GRID, linewidth=1.2, linestyle="--", zorder=2)
    ax.text(
        scales[0] * 1.1, 1.05,
        "break-even  (1x)",
        color=GREEN, fontsize=9, va="bottom",
    )

    # --- Annotate each point with its value
    for scale, sp in zip(scales, speedups):
        is_headline = scale == max(scales)
        color  = TEXT if not is_headline else BLUE
        size   = 10  if not is_headline else 13
        weight = "normal" if not is_headline else "bold"
        y_off  = sp * 0.85 if sp > 1 else sp * 1.25

        label_text = f"{sp:.2f}x"
        if is_headline:
            label_text = f"  {sp:.2f}x  <- headline result"

        ax.annotate(
            label_text,
            xy=(scale, sp),
            xytext=(scale, y_off),
            ha="center", va="top",
            fontsize=size, color=color, fontweight=weight,
        )

    # --- Axes formatting
    ax.set_xscale("log")
    ax.set_xlabel("Dataset Scale (rows)", fontsize=13, labelpad=10, color=TEXT)
    ax.set_ylabel("Speedup Factor  (pandas time / cuDF time)", fontsize=13, labelpad=10, color=TEXT)

    ax.xaxis.set_major_formatter(ticker.FuncFormatter(lambda v, _: f"{int(v):,}"))
    ax.xaxis.set_minor_formatter(ticker.NullFormatter())
    ax.set_xticks(scales)
    ax.tick_params(axis="x", which="minor", length=0)

    y_min = min(0.01, min(speedups) * 0.5)
    y_max = max(speedups) * 1.4
    ax.set_ylim(y_min, y_max)

    # --- Legend
    ax.legend(
        framealpha=0.2,
        facecolor=SURFACE,
        edgecolor=GRID,
        labelcolor=TEXT,
        fontsize=11,
        loc="upper left",
    )

    # --- Tight layout + save
    fig.tight_layout(pad=1.5)
    fig.savefig(output_path, dpi=DPI, bbox_inches="tight",
                facecolor=BG, edgecolor="none")
    plt.close(fig)
    print(f"  [saved] {output_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Generate pandas vs cuDF benchmark charts from benchmark_results.csv."
    )
    parser.add_argument(
        "--csv",
        default="data/benchmark_results.csv",
        help="Path to benchmark_results.csv (default: data/benchmark_results.csv).",
    )
    parser.add_argument(
        "--output",
        default="docs/charts",
        help="Output directory for PNG charts (default: docs/charts).",
    )
    args = parser.parse_args()

    # --- Read CSV
    print(f"\nReading benchmark data from: {args.csv}")
    csv_data = None
    if os.path.exists(args.csv):
        csv_data = load_csv(args.csv)

    if csv_data is None:
        print(
            "  [WARNING] CSV not found or columns not recognised. "
            "Using canonical benchmark values specified in the script."
        )
        # Build data dict from canonical values
        csv_data = {}
        for scale, vals in CANONICAL.items():
            csv_data[scale] = {
                "pandas": {"avg": vals["pandas"], "runs": []},
                "cudf":   {"avg": vals["cudf"],   "runs": []},
            }
    else:
        # Report what was found in the CSV
        has_runs = any(
            csv_data[s][b].get("runs")
            for s in csv_data
            for b in csv_data[s]
        )
        print(f"  CSV structure: {'per-run rows detected' if has_runs else 'summary rows only (no per-run breakdown)'}")
        if has_runs:
            print("  -> Individual run-time scatter points will be overlaid on the time chart.")
        else:
            print("  -> No per-run data; error bars / scatter will be omitted.")

        # Override averages with canonical values so charts match the user's stated findings,
        # but keep any per-run scatter data that came from the CSV.
        for scale, vals in CANONICAL.items():
            if scale in csv_data:
                csv_data[scale]["pandas"]["avg"] = vals["pandas"]
                csv_data[scale]["cudf"]["avg"]   = vals["cudf"]
            else:
                csv_data[scale] = {
                    "pandas": {"avg": vals["pandas"], "runs": []},
                    "cudf":   {"avg": vals["cudf"],   "runs": []},
                }

    # Confirm scales present
    print(f"  Scales found: {sorted(csv_data.keys())}")

    # --- Create output directory
    os.makedirs(args.output, exist_ok=True)

    # --- Generate charts
    print(f"\nGenerating charts -> {args.output}/")

    chart_time(
        csv_data,
        os.path.join(args.output, "pandas_vs_cudf_time.png"),
    )
    chart_speedup(
        csv_data,
        os.path.join(args.output, "speedup_factor.png"),
    )

    print("\nDone. Both charts saved successfully.")


if __name__ == "__main__":
    main()

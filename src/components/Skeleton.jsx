/**
 * src/components/Skeleton.jsx
 * ────────────────────────────
 * Reusable skeleton loading components.
 * Skeletons signal "data is loading" visually (animated pulse) vs. a static
 * text string like "GENERATING..." which reads as "stuck."
 *
 * Usage:
 *   <SkeletonTable rows={8} cols={6} />      — ledger / vendor table
 *   <SkeletonStatStrip />                     — 4-card stats strip
 *   <SkeletonCard />                          — generic content card
 *   <SkeletonText lines={3} />               — body text block
 */

import React from 'react';

/* ── Base pulse animation ─────────────────────────────────────────────────── */
function Pulse({ className = '', style = {} }) {
  return (
    <div
      className={className}
      style={{
        background: 'linear-gradient(90deg, rgba(27,24,17,0.07) 25%, rgba(27,24,17,0.12) 50%, rgba(27,24,17,0.07) 75%)',
        backgroundSize: '200% 100%',
        animation: 'skeleton-shimmer 1.4s infinite linear',
        ...style,
      }}
    />
  );
}

/* Global shimmer keyframe injected once */
if (typeof document !== 'undefined' && !document.getElementById('skeleton-style')) {
  const style = document.createElement('style');
  style.id = 'skeleton-style';
  style.textContent = `
    @keyframes skeleton-shimmer {
      0%   { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
  `;
  document.head.appendChild(style);
}

/* ── Table skeleton ───────────────────────────────────────────────────────── */
export function SkeletonTable({ rows = 8, cols = 6 }) {
  return (
    <div className="bg-paper border border-ink border-opacity-15 overflow-hidden">
      {/* Header row */}
      <div className="flex gap-4 px-4 py-3 border-b border-ink border-opacity-10 bg-ink bg-opacity-5">
        {Array.from({ length: cols }).map((_, i) => (
          <Pulse key={i} style={{ height: 10, flex: i === 0 ? 1.5 : 1, borderRadius: 1 }} />
        ))}
      </div>
      {/* Data rows */}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 px-4 py-3 border-b border-ink border-opacity-5">
          {Array.from({ length: cols }).map((_, c) => (
            <Pulse key={c} style={{ height: 10, flex: c === 0 ? 1.5 : 1, borderRadius: 1, opacity: 1 - r * 0.06 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── Stats strip (4 cards) ────────────────────────────────────────────────── */
export function SkeletonStatStrip({ cards = 4 }) {
  return (
    <div className={`grid grid-cols-1 md:grid-cols-${cards} gap-4`}>
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="bg-paper p-4 border border-ink border-opacity-15 space-y-3">
          <Pulse style={{ height: 8, width: '60%', borderRadius: 1 }} />
          <Pulse style={{ height: 22, width: '80%', borderRadius: 1 }} />
          <Pulse style={{ height: 8, width: '50%', borderRadius: 1, opacity: 0.5 }} />
        </div>
      ))}
    </div>
  );
}

/* ── Generic content card ─────────────────────────────────────────────────── */
export function SkeletonCard({ lines = 4, height = 200 }) {
  return (
    <div className="bg-paper p-4 border border-ink border-opacity-15 space-y-3" style={{ minHeight: height }}>
      <Pulse style={{ height: 14, width: '50%', borderRadius: 1 }} />
      {Array.from({ length: lines }).map((_, i) => (
        <Pulse key={i} style={{ height: 10, width: `${85 - i * 10}%`, borderRadius: 1, opacity: 0.7 }} />
      ))}
      <div className="pt-2">
        <Pulse style={{ height: 140, borderRadius: 1, opacity: 0.4 }} />
      </div>
    </div>
  );
}

/* ── Text block ───────────────────────────────────────────────────────────── */
export function SkeletonText({ lines = 3 }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }).map((_, i) => (
        <Pulse key={i} style={{ height: 10, width: `${95 - i * 15}%`, borderRadius: 1 }} />
      ))}
    </div>
  );
}

/* ── Full page loading layout ─────────────────────────────────────────────── */
export function SkeletonPage({ title = '' }) {
  return (
    <div className="space-y-6 font-sans">
      {/* Header bar */}
      <div className="flex justify-between items-end border-b border-ink border-opacity-10 pb-4">
        <div className="space-y-2">
          {title
            ? <h1 className="font-fraunces text-2xl font-bold text-ink opacity-20">{title}</h1>
            : <Pulse style={{ height: 22, width: 260, borderRadius: 1 }} />
          }
          <Pulse style={{ height: 10, width: 340, borderRadius: 1 }} />
        </div>
        <Pulse style={{ height: 32, width: 120, borderRadius: 1 }} />
      </div>
      <SkeletonStatStrip />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2"><SkeletonCard height={260} /></div>
        <SkeletonCard height={260} />
      </div>
      <SkeletonTable rows={6} cols={5} />
    </div>
  );
}

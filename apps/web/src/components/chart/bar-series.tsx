import * as React from "react";

/**
 * Shared SVG bar series for usage/overview trend charts.
 *
 * Honesty rules: a zero day draws NO bar (no 2px stub, no fake track) — only
 * the baseline proves the axis; values are rendered exclusively through the
 * caller's formatter (spend stays spend_vnd passthrough); every point also
 * appears in an sr-only data table so screen readers get the same data as the
 * plot. Narrow containers keep a per-bar minimum hit width and scroll
 * horizontally (90 days on mobile) instead of compressing bars sub-pixel.
 */

export interface BarSeriesPoint {
  label: string;
  value: number;
}

export interface BarSeriesProps {
  points: BarSeriesPoint[];
  /** Single source of display formatting (USD labels / token counts / counts). */
  formatValue: (value: number) => string;
  ariaLabel: string;
  /** Optional longer sr-only summary (already localized by the caller). */
  srSummary?: string;
  dateHeader: string;
  valueHeader: string;
  height?: number;
  /** Minimum horizontal pixels per bar (hit area); the plot scrolls past it. */
  minStep?: number;
}

const PAD_L = 56;
const PAD_R = 8;
const PAD_T = 12;
const PAD_B = 22;

/** Short tick text for ISO UTC dates ("2025-03-01" -> "03-01"); full label otherwise. */
function tickText(label: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(label) ? label.slice(5) : label;
}

export function BarSeries({
  points,
  formatValue: fmt,
  ariaLabel,
  srSummary,
  dateHeader,
  valueHeader,
  height = 240,
  minStep = 8,
}: BarSeriesProps) {
  const n = points.length;
  const [measured, setMeasured] = React.useState(0);
  const measureRef = React.useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = React.useState(n - 1);

  React.useEffect(() => {
    setSelected((s) => Math.min(Math.max(s, 0), n - 1));
  }, [n]);

  React.useEffect(() => {
    const el = measureRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setMeasured(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (n === 0) return null;

  const minRequired = PAD_L + PAD_R + n * minStep;
  const width = Math.max(measured, minRequired);
  const baseline = height - PAD_B;
  const plotH = baseline - PAD_T;
  const plotW = width - PAD_L - PAD_R;
  const step = plotW / n;
  const barW = Math.min(Math.max(step * 0.7, 2), 24);
  const maxV = Math.max(...points.map((p) => p.value), 0);

  const sel = points[Math.min(Math.max(selected, 0), n - 1)] ?? points[n - 1]!;

  // Sparse tick indices: ends + quarters, deduplicated for tiny ranges.
  const tickIdx = [
    ...new Set([
      0,
      Math.round((n - 1) / 4),
      Math.round((n - 1) / 2),
      Math.round((3 * (n - 1)) / 4),
      n - 1,
    ]),
  ];

  const onKeyDown = (e: React.KeyboardEvent) => {
    const move =
      e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowLeft"
          ? -1
          : e.key === "Home"
            ? -Infinity
            : e.key === "End"
              ? Infinity
              : 0;
    if (move === 0) return;
    e.preventDefault();
    setSelected((s) => Math.min(Math.max(s + move, 0), n - 1));
  };

  return (
    <div ref={measureRef} className="w-full">
      <p className="sr-only">{srSummary ?? ariaLabel}</p>
      <div
        data-slot="bar-series-group"
        role="group"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div data-slot="bar-series-scroll" className="w-full overflow-x-auto">
          <svg
            width={width}
            height={height}
            className="block"
            // The plot is interactive; the sr-only table below is the AT surface.
            aria-hidden="true"
          >
            {/* Y gridlines + labels at max / mid / zero */}
            {[maxV, maxV / 2, 0].map((v, i) => {
              const y = baseline - (maxV > 0 ? (v / maxV) * plotH : 0);
              return (
                <g key={i}>
                  <line
                    x1={PAD_L}
                    x2={width - PAD_R}
                    y1={y}
                    y2={y}
                    className={v === 0 ? "stroke-border" : "stroke-border/60"}
                    strokeWidth={1}
                    data-slot={v === 0 ? "bar-series-baseline" : undefined}
                  />
                  <text
                    x={PAD_L - 6}
                    y={y}
                    dy="0.32em"
                    textAnchor="end"
                    className="fill-muted-foreground font-mono text-[10px]"
                  >
                    {fmt(v)}
                  </text>
                </g>
              );
            })}
            {/* Bars: one value rect per NONZERO day; invisible hit areas stay full-height. */}
            {points.map((p, i) => {
              const x = PAD_L + i * step;
              if (p.value > 0 && maxV > 0) {
                const h = (p.value / maxV) * plotH;
                return (
                  <rect
                    key={p.label}
                    x={x + (step - barW) / 2}
                    y={baseline - h}
                    width={barW}
                    height={h}
                    rx={2}
                    className={`chart-bar ${i === selected ? "fill-foreground" : "fill-foreground/70"}`}
                  />
                );
              }
              return null;
            })}
            {/* Full-height hit areas: keyboard/touch selection target per day. */}
            {points.map((p, i) => (
              <rect
                key={`hit-${p.label}`}
                data-hit-index={i}
                x={PAD_L + i * step}
                y={PAD_T}
                width={step}
                height={plotH}
                fill="transparent"
                onPointerDown={() => setSelected(i)}
              />
            ))}
            {/* X date ticks */}
            {tickIdx.map((i) => (
              <text
                key={`tick-${i}`}
                x={PAD_L + i * step + step / 2}
                y={height - 6}
                textAnchor="middle"
                className="fill-muted-foreground font-mono text-[10px]"
              >
                {tickText(points[i]!.label)}
              </text>
            ))}
          </svg>
        </div>
      </div>
      {/* Persistent, visible detail for the selected day (mouse, touch, keyboard alike). */}
      <p
        data-slot="bar-series-detail"
        aria-live="polite"
        className="mt-2 font-mono text-xs tabular-nums"
      >
        <span className="text-muted-foreground">{sel.label}</span> · {fmt(sel.value)}
      </p>
      {/* Screen-reader data parity: every point, same formatter, no invented data. */}
      <table data-slot="bar-series-table" className="sr-only">
        <thead>
          <tr>
            <th scope="col">{dateHeader}</th>
            <th scope="col">{valueHeader}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.label}>
              <td>{p.label}</td>
              <td>{fmt(p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

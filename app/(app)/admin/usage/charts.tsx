'use client';

import {
  Area, AreaChart, CartesianGrid, Legend, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { DockerPoint, UsagePoint } from '@/lib/host/series';
import { formatGiB, formatPct, toGiB } from '@/lib/host/format';

/**
 * Chart palette. Recharts takes colours as SVG presentation attributes, which
 * do not resolve `var()`, so these are literals rather than reads of the
 * `@theme` tokens in app/globals.css — the deliberate narrowing the plan
 * records. Keep the INK/GRID values in step with those tokens.
 *
 * The SERIES hues are NOT the app's gold: validated against this app's own
 * panel surface (#0b1827), `--color-gold` sits outside the dark lightness band
 * (OKLCH L 0.714 > 0.67) and under the chroma floor (0.088 < 0.10), so a
 * gold-anchored categorical set fails. These four are the data-viz reference
 * dark categorical order, which passes every gate here: worst adjacent CVD
 * ΔE 8.4, worst normal-vision ΔE 19.8, all ≥ 3:1 contrast.
 */
const SERIES = {
  blue: '#3987e5',
  orange: '#d95926',
  aqua: '#199e70',
  yellow: '#c98500',
};

const INK = {
  /** --color-ink-dim, 7.3:1 on the panel surface — axis and legend text. */
  dim: '#9aa7b6',
  /** --color-ink-faint, 3.3:1 — gridlines and capacity annotations only. */
  faint: '#5d6b7d',
};

/** --color-panel over --color-bg. The 2px gap between stacked fills. */
const SURFACE = '#0b1827';

/** Area fills are a wash, never a saturated block. */
const FILL_OPACITY = 0.1;
const STROKE_WIDTH = 2;

const AXIS = {
  stroke: INK.faint,
  tick: { fill: INK.dim, fontSize: 11 },
  tickLine: false,
} as const;

const TOOLTIP_STYLE = {
  contentStyle: {
    background: '#02101f',
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: 6,
    fontSize: 12,
  },
  labelStyle: { color: INK.dim },
  // The crosshair finds the X: readers aim at a time, never at a 2px line.
  cursor: { stroke: INK.faint, strokeWidth: 1 },
} as const;

const LEGEND_STYLE = { fontSize: 11, color: INK.dim } as const;

export type TimeFormatter = (iso: string) => string;

/** Recharts hands `labelFormatter` a ReactNode, not the raw dataKey value. */
const timeLabel = (formatTime: TimeFormatter) => (label: React.ReactNode): string =>
  typeof label === 'string' ? formatTime(label) : '';

/** Shared frame: fixed height, and a scroll container so a narrow viewport
 *  scrolls the chart rather than the page. */
function ChartFrame({ title, hint, children }: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border-strong bg-panel p-4">
      <header className="mb-3">
        <h2 className="text-sm font-medium text-ink">{title}</h2>
        {hint ? <p className="mt-0.5 text-[11px] text-ink-faint">{hint}</p> : null}
      </header>
      <div className="overflow-x-auto">
        <div className="h-56 min-w-[32rem]">{children}</div>
      </div>
    </section>
  );
}

export function CpuChart({ points, formatTime }: { points: UsagePoint[]; formatTime: TimeFormatter }) {
  return (
    <ChartFrame
      title="CPU utilization"
      hint="Average across the box; iowait counts as busy and is also drawn on its own."
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={INK.faint} strokeOpacity={0.35} vertical={false} />
          <XAxis dataKey="at" tickFormatter={formatTime} {...AXIS} />
          <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} unit="%" width={44} {...AXIS} />
          <Tooltip
            {...TOOLTIP_STYLE}
            labelFormatter={timeLabel(formatTime)}
            formatter={(v) => formatPct(typeof v === 'number' ? v : null)}
          />
          <Legend wrapperStyle={LEGEND_STYLE} iconSize={8} />
          <Area
            name="Mean" type="monotone" dataKey="cpuPct"
            stroke={SERIES.blue} strokeWidth={STROKE_WIDTH}
            fill={SERIES.blue} fillOpacity={FILL_OPACITY} dot={false}
          />
          <Area
            name="Iowait" type="monotone" dataKey="iowaitPct"
            stroke={SERIES.orange} strokeWidth={STROKE_WIDTH}
            fill={SERIES.orange} fillOpacity={FILL_OPACITY} dot={false}
          />
          {/* Peak is the same measure as mean, so it shares the hue and is
              told apart by shape — a bare line, no fill. */}
          <Line
            name="Peak" type="monotone" dataKey="cpuPeakPct"
            stroke={SERIES.blue} strokeWidth={STROKE_WIDTH} strokeDasharray="4 3" dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function MemoryChart({ points, formatTime, totalBytes }: {
  points: UsagePoint[];
  formatTime: TimeFormatter;
  totalBytes: number | null;
}) {
  return (
    <ChartFrame
      title="Memory used"
      hint="Total minus available — reclaimable cache counts as available, so this will not match free's used column."
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={INK.faint} strokeOpacity={0.35} vertical={false} />
          <XAxis dataKey="at" tickFormatter={formatTime} {...AXIS} />
          <YAxis
            width={56}
            tickFormatter={(v: number) => toGiB(v).toFixed(0)}
            unit=" GiB"
            {...AXIS}
          />
          <Tooltip
            {...TOOLTIP_STYLE}
            labelFormatter={timeLabel(formatTime)}
            formatter={(v) => formatGiB(typeof v === 'number' ? v : null)}
          />
          <Legend wrapperStyle={LEGEND_STYLE} iconSize={8} />
          <Area
            name="Used" type="monotone" dataKey="memUsedBytes"
            stroke={SERIES.blue} strokeWidth={STROKE_WIDTH}
            fill={SERIES.blue} fillOpacity={FILL_OPACITY} dot={false}
          />
          <Line
            name="Peak" type="monotone" dataKey="memPeakBytes"
            stroke={SERIES.blue} strokeWidth={STROKE_WIDTH} strokeDasharray="4 3" dot={false}
          />
          {/* Capacity is an annotation, not a series: recessive ink plus a
              label, so headroom is visible without adding a data colour. */}
          {totalBytes !== null ? (
            <ReferenceLine
              y={totalBytes}
              stroke={INK.faint}
              label={{ value: `${formatGiB(totalBytes)} total`, position: 'insideTopRight', fill: INK.dim, fontSize: 11 }}
            />
          ) : null}
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function DiskChart({ points, formatTime, totalBytes }: {
  points: UsagePoint[];
  formatTime: TimeFormatter;
  totalBytes: number | null;
}) {
  return (
    // One series, so no legend box — the title already names what is plotted.
    <ChartFrame title="Disk used" hint="Root filesystem, against its capacity.">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={INK.faint} strokeOpacity={0.35} vertical={false} />
          <XAxis dataKey="at" tickFormatter={formatTime} {...AXIS} />
          <YAxis
            width={56}
            domain={[0, totalBytes ?? 'auto']}
            tickFormatter={(v: number) => toGiB(v).toFixed(0)}
            unit=" GiB"
            {...AXIS}
          />
          <Tooltip
            {...TOOLTIP_STYLE}
            labelFormatter={timeLabel(formatTime)}
            formatter={(v) => formatGiB(typeof v === 'number' ? v : null)}
          />
          <Area
            name="Used" type="monotone" dataKey="diskUsedBytes"
            stroke={SERIES.blue} strokeWidth={STROKE_WIDTH}
            fill={SERIES.blue} fillOpacity={FILL_OPACITY} dot={false}
          />
          {totalBytes !== null ? (
            <ReferenceLine
              y={totalBytes}
              stroke={INK.faint}
              label={{ value: `${formatGiB(totalBytes)} capacity`, position: 'insideTopRight', fill: INK.dim, fontSize: 11 }}
            />
          ) : null}
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function DockerChart({ points, formatTime }: { points: DockerPoint[]; formatTime: TimeFormatter }) {
  return (
    <ChartFrame
      title="Docker disk usage"
      hint="Sampled every 30 minutes — the daemon walk costs ~17 s. GiB here, so these read lower than docker system df's base-1000 GB."
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={INK.faint} strokeOpacity={0.35} vertical={false} />
          <XAxis dataKey="at" tickFormatter={formatTime} {...AXIS} />
          <YAxis
            width={56}
            tickFormatter={(v: number) => toGiB(v).toFixed(0)}
            unit=" GiB"
            {...AXIS}
          />
          <Tooltip
            {...TOOLTIP_STYLE}
            labelFormatter={timeLabel(formatTime)}
            formatter={(v) => formatGiB(typeof v === 'number' ? v : null)}
          />
          <Legend wrapperStyle={LEGEND_STYLE} iconSize={8} />
          {/* Stacked, so the total is the box's docker footprint. The 2px
              surface-coloured stroke is the gap that separates segments —
              never a border drawn to outline them. */}
          <Area
            name="Build cache" type="monotone" dataKey="buildCacheBytes" stackId="d"
            stroke={SURFACE} strokeWidth={STROKE_WIDTH} fill={SERIES.yellow} fillOpacity={0.55}
          />
          <Area
            name="Volumes" type="monotone" dataKey="volumesBytes" stackId="d"
            stroke={SURFACE} strokeWidth={STROKE_WIDTH} fill={SERIES.aqua} fillOpacity={0.55}
          />
          <Area
            name="Images" type="monotone" dataKey="imagesBytes" stackId="d"
            stroke={SURFACE} strokeWidth={STROKE_WIDTH} fill={SERIES.blue} fillOpacity={0.55}
          />
          <Area
            name="Containers" type="monotone" dataKey="containersBytes" stackId="d"
            stroke={SURFACE} strokeWidth={STROKE_WIDTH} fill={SERIES.orange} fillOpacity={0.55}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/**
 * The four charts on a shared time axis. `connectNulls` is left at its default
 * false throughout: a null is a real gap — a reboot, a deploy window, an
 * outage — and joining across one would draw a line through it.
 */
export function UsageCharts({ points, docker, formatTime }: {
  points: UsagePoint[];
  docker: DockerPoint[];
  formatTime: TimeFormatter;
}) {
  const last = [...points].reverse().find((p) => p.memTotalBytes !== null);
  return (
    <div className="flex flex-col gap-4">
      <CpuChart points={points} formatTime={formatTime} />
      <MemoryChart points={points} formatTime={formatTime} totalBytes={last?.memTotalBytes ?? null} />
      <DiskChart points={points} formatTime={formatTime} totalBytes={last?.diskTotalBytes ?? null} />
      {docker.length > 0 ? <DockerChart points={docker} formatTime={formatTime} /> : null}
    </div>
  );
}

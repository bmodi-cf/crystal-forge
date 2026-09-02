'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatGiB, formatPct } from '@/lib/host/format';
import type { UsageRange, UsageSeries } from '@/lib/host/series';
import { UsageCharts } from './charts';

const RANGE_OPTIONS: UsageRange[] = ['24h', '7d', '30d', '90d'];
const DEFAULT_RANGE: UsageRange = '30d';

/** Below a day of span, a bare time reads better than a date. */
function makeTimeFormatter(range: UsageRange) {
  const withDate = range !== '24h';
  return (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return withDate
      ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
      : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };
}

function Tile({ testId, label, value, caption }: {
  testId: string;
  label: string;
  value: string;
  caption: string;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-lg border border-border-strong bg-panel px-4 py-3"
    >
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-faint">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
      <div className="mt-0.5 text-[11px] text-ink-dim">{caption}</div>
    </div>
  );
}

export function UsageClient() {
  const [range, setRange] = useState<UsageRange>(DEFAULT_RANGE);
  const [series, setSeries] = useState<UsageSeries | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  const load = useCallback(async (which: UsageRange) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/usage?range=${which}`);
      if (!res.ok) {
        if (!cancelled.current) setError('Could not load usage data.');
        return;
      }
      const body = (await res.json()) as { series: UsageSeries };
      if (!cancelled.current) {
        setSeries(body.series);
        setError(null);
      }
    } catch {
      if (!cancelled.current) setError('Could not load usage data.');
    } finally {
      if (!cancelled.current) setLoading(false);
    }
  }, []);

  // No polling: live diagnosis is out of scope, the data is 5-minute granular,
  // and a poll would be load for no information. Refresh is a button.
  useEffect(() => {
    cancelled.current = false;
    void load(range);
    return () => { cancelled.current = true; };
  }, [load, range]);

  const latest = series?.latest ?? null;
  const formatTime = makeTimeFormatter(range);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium text-ink">Host usage</h1>
          <p className="mt-0.5 text-xs text-ink-dim">
            This dashboard&apos;s own machine, sampled every 5 minutes.
          </p>
        </div>
        {/* Filters in one row above the charts, presets first. */}
        <div className="flex items-center gap-2">
          <div className="flex gap-1 rounded-md border border-border-strong p-1">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setRange(option)}
                aria-pressed={option === range}
                className={`rounded px-2.5 py-1 text-xs transition ${
                  option === range ? 'bg-panel text-ink' : 'text-ink-dim hover:bg-panel hover:text-ink'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void load(range)}
            className="rounded-md border border-border-strong px-2.5 py-1.5 text-xs text-ink-dim transition hover:bg-panel hover:text-ink"
          >
            Refresh
          </button>
        </div>
      </header>

      {error ? (
        <p className="rounded-lg border border-border-strong bg-panel p-4 text-sm text-danger">
          Could not load usage data.
        </p>
      ) : loading && !series ? (
        <div className="h-24 animate-pulse rounded-lg border border-border-strong bg-panel" />
      ) : latest === null ? (
        <p className="rounded-lg border border-border-strong bg-panel p-4 text-sm text-ink-dim">
          Collecting — first samples appear within 5 minutes.
        </p>
      ) : (
        // A refetch keeps the frame: the previous render dims rather than
        // collapsing to a skeleton, so nothing jumps.
        <div className={`flex flex-col gap-6 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile
              testId="tile-cpu"
              label="CPU"
              value={formatPct(latest.cpuPct)}
              caption={`${latest.cpuCount} vCPU`}
            />
            <Tile
              testId="tile-memory"
              label="Memory"
              value={formatGiB(latest.memUsedBytes)}
              caption={`of ${formatGiB(latest.memTotalBytes)} — total minus available`}
            />
            <Tile
              testId="tile-disk"
              label="Disk"
              value={formatGiB(latest.diskUsedBytes)}
              caption={`of ${formatGiB(latest.diskTotalBytes)}`}
            />
            <Tile
              testId="tile-forges"
              label="Forges"
              value={latest.runningForges === null ? '—' : String(latest.runningForges)}
              caption="running forges"
            />
          </div>

          {/* One sample is enough for the gauges but not for a rate: CPU is a
              delta between two reads, so say so rather than showing a blank. */}
          {series && series.points.length < 2 ? (
            <p className="text-xs text-ink-faint">
              Only {series.points.length} sample so far — CPU is derived between two
              readings, so it fills in after the next one.
            </p>
          ) : null}

          {series ? (
            <UsageCharts points={series.points} docker={series.docker} formatTime={formatTime} />
          ) : null}
        </div>
      )}
    </div>
  );
}

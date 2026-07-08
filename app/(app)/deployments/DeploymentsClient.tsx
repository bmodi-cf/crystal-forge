'use client';

import { useEffect, useState } from 'react';

type DeploymentStatus = {
  forgeId: string;
  slug: string;
  name: string;
  desiredVersion: string;
  runningVersion: string | null;
  phase: 'running' | 'failed' | 'stopped';
  error: string | null;
  consecutiveFailures: number;
};

const PHASE_CLASS: Record<DeploymentStatus['phase'], string> = {
  running: 'text-emerald-400',
  failed: 'text-red-400',
  stopped: 'text-ink-dim',
};

export function DeploymentsClient() {
  const [rows, setRows] = useState<DeploymentStatus[]>([]);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const res = await fetch('/api/deployments');
        if (res.ok) {
          const data = (await res.json()) as { deployments: DeploymentStatus[] };
          if (alive) setRows(data.deployments);
        }
      } catch {
        /* keep last known state */
      }
    }
    void poll();
    const h = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(h); };
  }, []);

  return (
    <main className="mx-auto max-w-5xl px-8 py-10">
      <h1 className="mb-6 text-lg font-semibold text-ink">Deployments</h1>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-dim">No forges are enabled for deployment.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-ink-dim">
              <tr>
                <th className="py-2 pr-4">Forge</th>
                <th className="py-2 pr-4">Pinned</th>
                <th className="py-2 pr-4">Running</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.forgeId} className="border-t border-border">
                  <td className="py-2 pr-4 font-medium text-ink">{r.name}</td>
                  <td className="py-2 pr-4">{r.desiredVersion}</td>
                  <td className="py-2 pr-4">{r.runningVersion ?? '—'}</td>
                  <td className={`py-2 pr-4 ${PHASE_CLASS[r.phase]}`}>{r.phase}</td>
                  <td className="py-2 pr-4 text-ink-dim">
                    {r.error ?? (r.consecutiveFailures > 0 ? `${r.consecutiveFailures} failed attempts` : '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

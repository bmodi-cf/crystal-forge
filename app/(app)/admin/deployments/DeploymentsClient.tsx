'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { DeploymentRow } from '@/lib/services/deployments';
import { deriveRowState, type RowState } from './rowState';

type VersionMap = Record<string, string[] | null>;

const STATE_LABEL: Record<RowState, string> = {
  'not-deployed': 'not deployed',
  'no-image': 'no image',
  deploying: 'deploying',
  running: 'running',
  failed: 'failed',
  stopped: 'stopped',
};

const STATE_CLASS: Record<RowState, string> = {
  'not-deployed': 'text-ink-dim',
  'no-image': 'text-ink-dim',
  deploying: 'text-amber-400',
  running: 'text-emerald-400',
  failed: 'text-red-400',
  stopped: 'text-ink-dim',
};

export function DeploymentsClient() {
  const [rows, setRows] = useState<DeploymentRow[]>([]);
  const [versions, setVersions] = useState<VersionMap>({});
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [deployError, setDeployError] = useState<Record<string, string>>({});
  const [versionsError, setVersionsError] = useState<string | null>(null);

  // Status poll: every 3s, never touches the registry.
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const res = await fetch('/api/deployments');
        if (!res.ok) return;
        const data = (await res.json()) as { deployments: DeploymentRow[] };
        if (alive) setRows(data.deployments);
      } catch {
        /* keep last known state */
      }
    }
    void poll();
    const h = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(h); };
  }, []);

  // Versions: on mount and after a deploy, on their own cadence.
  const versionsAlive = useRef(true);
  useEffect(() => {
    versionsAlive.current = true;
    return () => { versionsAlive.current = false; };
  }, []);

  const loadVersions = useCallback(async () => {
    try {
      const res = await fetch('/api/deployments/versions');
      if (!res.ok) {
        if (versionsAlive.current) setVersionsError('Could not load available versions.');
        return;
      }
      const data = (await res.json()) as { versions: VersionMap };
      if (versionsAlive.current) {
        setVersions(data.versions);
        setVersionsError(null);
      }
    } catch {
      if (versionsAlive.current) setVersionsError('Could not load available versions.');
    }
  }, []);

  useEffect(() => { void loadVersions(); }, [loadVersions]);

  async function deploy(forgeId: string, version: string) {
    setBusy((b) => ({ ...b, [forgeId]: true }));
    setDeployError((e) => {
      const next = { ...e };
      delete next[forgeId];
      return next;
    });
    try {
      const res = await fetch(`/api/deployments/${forgeId}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        setDeployError((e) => ({ ...e, [forgeId]: body.error ?? 'Deploy failed' }));
        return;
      }
      await loadVersions();
    } catch {
      setDeployError((e) => ({ ...e, [forgeId]: 'Deploy failed' }));
    } finally {
      setBusy((b) => ({ ...b, [forgeId]: false }));
    }
  }

  return (
    <main className="mx-auto max-w-6xl px-8 py-10">
      <h1 className="mb-6 text-lg font-semibold text-ink">Deployments</h1>
      {versionsError ? (
        <p className="mb-4 text-sm text-red-400">{versionsError}</p>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-sm text-ink-dim">No forges are registered on this server.</p>
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
                <th className="py-2 pr-4">Deploy</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const available = versions[r.forgeId];
                const state = deriveRowState(r, available);
                const options = available ?? [];
                const choice =
                  selected[r.forgeId] ??
                  (r.pinnedVersion && options.includes(r.pinnedVersion) ? r.pinnedVersion : options[0]) ??
                  '';
                const canDeploy = options.length > 0 && !busy[r.forgeId];
                return (
                  <tr key={r.forgeId} className="border-t border-border">
                    <td className="py-2 pr-4 font-medium text-ink">{r.displayName || r.name}</td>
                    <td className="py-2 pr-4">{r.pinnedVersion ?? '—'}</td>
                    <td className="py-2 pr-4">{r.runningVersion ?? '—'}</td>
                    <td className={`py-2 pr-4 ${STATE_CLASS[state]}`}>{STATE_LABEL[state]}</td>
                    <td className="py-2 pr-4 text-ink-dim">
                      {[
                        r.error,
                        r.consecutiveFailures > 0 ? `${r.consecutiveFailures} failed attempts` : null,
                        available === null ? 'registry unavailable' : null,
                      ].filter(Boolean).join(' · ')}
                    </td>
                    <td className="py-2 pr-4">
                      <div className="flex items-center gap-2">
                        <select
                          aria-label={`Version for ${r.displayName || r.name}`}
                          className="h-8 rounded-md border border-border bg-panel px-2 text-sm text-ink disabled:opacity-50"
                          value={choice}
                          disabled={options.length === 0}
                          onChange={(e) => {
                            const value = e.target.value;
                            setSelected((s) => ({ ...s, [r.forgeId]: value }));
                            setDeployError((err) => {
                              if (!(r.forgeId in err)) return err;
                              const next = { ...err };
                              delete next[r.forgeId];
                              return next;
                            });
                          }}
                        >
                          {options.length === 0 ? (
                            <option value="">—</option>
                          ) : (
                            options.map((v) => <option key={v} value={v}>{v}</option>)
                          )}
                        </select>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canDeploy}
                          onClick={() => void deploy(r.forgeId, choice)}
                        >
                          {busy[r.forgeId] ? 'Deploying…' : 'Deploy'}
                        </Button>
                      </div>
                      {deployError[r.forgeId] ? (
                        <p className="mt-1 text-xs text-red-400">{deployError[r.forgeId]}</p>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

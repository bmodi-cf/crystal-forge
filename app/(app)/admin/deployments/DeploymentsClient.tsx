'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { DeploymentRow } from '@/lib/services/deployments';
import { BundleImportSection } from './BundleImportSection';
import { deriveRowState, type RowState } from './rowState';

type VersionMap = Record<string, string[] | null>;

const STATE_LABEL: Record<RowState, string> = {
  'not-deployed': 'not deployed',
  'no-image': 'no image',
  deploying: 'deploying',
  running: 'running',
  failed: 'failed',
  stopping: 'stopping',
  stopped: 'stopped',
};

const STATE_CLASS: Record<RowState, string> = {
  'not-deployed': 'text-ink-dim',
  'no-image': 'text-ink-dim',
  deploying: 'text-amber-400',
  running: 'text-emerald-400',
  failed: 'text-red-400',
  stopping: 'text-amber-400',
  stopped: 'text-ink-dim',
};

function rowLabel(row: DeploymentRow): string {
  return row.displayName || row.name;
}

export function DeploymentsClient() {
  const [rows, setRows] = useState<DeploymentRow[]>([]);
  const [versions, setVersions] = useState<VersionMap>({});
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState<DeploymentRow | null>(null);

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

  const clearRowError = useCallback((forgeId: string) => {
    setRowError((e) => {
      if (!(forgeId in e)) return e;
      const next = { ...e };
      delete next[forgeId];
      return next;
    });
  }, []);

  /**
   * Flip deployEnabled. The response carries the refreshed row, which we splice
   * in so the button label turns over immediately instead of waiting out the
   * 3s status poll.
   */
  async function setEnabled(row: DeploymentRow, enabled: boolean) {
    const forgeId = row.forgeId;
    const verb = enabled ? 'start' : 'stop';
    setBusy((b) => ({ ...b, [forgeId]: true }));
    clearRowError(forgeId);
    try {
      const res = await fetch(`/api/deployments/${forgeId}/${verb}`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        setRowError((e) => ({ ...e, [forgeId]: body.error ?? `${enabled ? 'Start' : 'Stop'} failed` }));
        return;
      }
      const body = (await res.json()) as { deployment: DeploymentRow };
      setRows((rs) => rs.map((r) => (r.forgeId === forgeId ? body.deployment : r)));
    } catch {
      setRowError((e) => ({ ...e, [forgeId]: `${enabled ? 'Start' : 'Stop'} failed` }));
    } finally {
      setBusy((b) => ({ ...b, [forgeId]: false }));
      setConfirmStop(null);
    }
  }

  async function deploy(forgeId: string, version: string) {
    setBusy((b) => ({ ...b, [forgeId]: true }));
    clearRowError(forgeId);
    try {
      const res = await fetch(`/api/deployments/${forgeId}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        setRowError((e) => ({ ...e, [forgeId]: body.error ?? 'Deploy failed' }));
        return;
      }
      await loadVersions();
    } catch {
      setRowError((e) => ({ ...e, [forgeId]: 'Deploy failed' }));
    } finally {
      setBusy((b) => ({ ...b, [forgeId]: false }));
    }
  }

  return (
    <main className="mx-auto max-w-6xl px-8 py-10">
      <h1 className="mb-6 text-lg font-semibold text-ink">Deployments</h1>
      <BundleImportSection onImported={() => void loadVersions()} />
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
                <th className="py-2 pr-4">Actions</th>
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
                        {/* Only a pinned forge can be toggled — starting one that
                            was never deployed is what DEPLOY is for. */}
                        {r.pinnedVersion === null ? null : r.deployEnabled ? (
                          <Button
                            size="sm"
                            variant="destructive"
                            aria-label={`Stop ${rowLabel(r)}`}
                            disabled={busy[r.forgeId]}
                            onClick={() => setConfirmStop(r)}
                          >
                            Stop
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`Start ${rowLabel(r)}`}
                            disabled={busy[r.forgeId]}
                            onClick={() => void setEnabled(r, true)}
                          >
                            Start
                          </Button>
                        )}
                        <select
                          aria-label={`Version for ${rowLabel(r)}`}
                          className="h-8 rounded-md border border-border bg-panel px-2 text-sm text-ink disabled:opacity-50"
                          value={choice}
                          disabled={options.length === 0}
                          onChange={(e) => {
                            const value = e.target.value;
                            setSelected((s) => ({ ...s, [r.forgeId]: value }));
                            clearRowError(r.forgeId);
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
                      {rowError[r.forgeId] ? (
                        <p className="mt-1 text-xs text-red-400">{rowError[r.forgeId]}</p>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Stop confirmation — stopping takes a team's forge offline. */}
      <Dialog open={confirmStop !== null} onOpenChange={(open) => { if (!open) setConfirmStop(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop {confirmStop ? rowLabel(confirmStop) : ''}?</DialogTitle>
            <DialogDescription>
              {confirmStop && (
                <>
                  Its container is removed on the next reconcile tick and the forge goes offline
                  for everyone using it. The pinned version{' '}
                  <strong>{confirmStop.pinnedVersion}</strong> is kept, so Start brings the same
                  version back.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmStop(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={confirmStop ? busy[confirmStop.forgeId] : false}
              onClick={() => { if (confirmStop) void setEnabled(confirmStop, false); }}
            >
              Stop forge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

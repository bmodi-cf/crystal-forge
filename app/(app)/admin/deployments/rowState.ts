import type { DeploymentRow } from '@/lib/services/deployments';

export type RowState =
  | 'not-deployed'
  | 'no-image'
  | 'deploying'
  | 'running'
  | 'failed'
  | 'stopping'
  | 'stopped';

/**
 * Seven display states from three inputs: the DB's desired state, the
 * reconciler's snapshot, and the registry's tag list. Order is precedence.
 *
 * `versions` distinguishes three cases: a list (images exist), `[]` (none
 * exist -> no-image, DEPLOY disabled), and `null`/`undefined` (registry
 * unreachable or not fetched yet -> must NOT read as no-image).
 */
export function deriveRowState(
  row: DeploymentRow,
  versions: string[] | null | undefined,
): RowState {
  // 1. Disabled but still pinned means an admin pressed STOP: the pin is the
  //    record of what START will relight. `stopping` mirrors `deploying` — it
  //    covers the window from the POST until the tick that actually removes
  //    the container, so the table never claims a forge is off while it serves.
  if (!row.deployEnabled && row.pinnedVersion !== null) {
    return row.runningVersion !== null ? 'stopping' : 'stopped';
  }
  // 2. Never deployed wins over any stale snapshot phase.
  if (!row.deployEnabled || row.pinnedVersion === null) {
    return versions !== null && versions !== undefined && versions.length === 0
      ? 'no-image'
      : 'not-deployed';
  }
  // 3. A failure is the most actionable thing to show.
  if (row.phase === 'failed') return 'failed';
  // 4. Desired != actual means the loop has not converged yet. Also covers a
  //    first deploy, where the snapshot has no entry at all.
  if (row.pinnedVersion !== row.runningVersion) return 'deploying';
  if (row.phase === 'stopped') return 'stopped';
  return 'running';
}

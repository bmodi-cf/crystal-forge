import { getContainerManager, type ContainerManager } from '@/lib/runtime/container';
import { CONTAINER_WORKDIR } from '@/lib/runtime/paths';
import { loadState } from '@/lib/runtime/state';
import type { RuntimeStatus } from '@/lib/runtime/types';
import { DEV_BRANCH } from '@/lib/github/branches';

/**
 * Exit codes the in-container check script uses to report *why* a workspace is
 * not releasable. `ContainerManager.exec` returns only an exit code — no stdout
 * — so the verdict has to be encoded numerically rather than parsed from output.
 */
export const WORKSPACE_SYNC_EXIT = {
  OK: 0,
  DIRTY: 2,
  AHEAD: 3,
  BEHIND: 4,
  FETCH_FAILED: 5,
  NO_WORKSPACE: 6,
  DIVERGED: 7,
} as const;

const CHECK_TIMEOUT_MS = 60 * 1000;

/**
 * Verify the workspace is exactly `origin/dev`. HEAD is compared rather than the
 * local `dev` ref because HEAD is what the forge's dev server actually serves —
 * so this also catches a workspace parked on a feature branch, which a
 * `dev`-vs-`origin/dev` comparison would call in sync.
 *
 * `set -e` is deliberately absent: under it, a failing `[ … ] && exit 0` test
 * would abort the script with that status and be misread as a real verdict.
 */
const CHECK_SCRIPT = `
cd ${CONTAINER_WORKDIR} 2>/dev/null || exit ${WORKSPACE_SYNC_EXIT.NO_WORKSPACE}
git rev-parse --git-dir >/dev/null 2>&1 || exit ${WORKSPACE_SYNC_EXIT.NO_WORKSPACE}
git fetch -q origin ${DEV_BRANCH} 2>/dev/null || exit ${WORKSPACE_SYNC_EXIT.FETCH_FAILED}
[ -z "$(git status --porcelain)" ] || exit ${WORKSPACE_SYNC_EXIT.DIRTY}
head=$(git rev-parse HEAD) || exit ${WORKSPACE_SYNC_EXIT.NO_WORKSPACE}
remote=$(git rev-parse origin/${DEV_BRANCH}) || exit ${WORKSPACE_SYNC_EXIT.FETCH_FAILED}
if [ "$head" = "$remote" ]; then exit ${WORKSPACE_SYNC_EXIT.OK}; fi
if git merge-base --is-ancestor "$head" "$remote"; then exit ${WORKSPACE_SYNC_EXIT.BEHIND}; fi
if git merge-base --is-ancestor "$remote" "$head"; then exit ${WORKSPACE_SYNC_EXIT.AHEAD}; fi
exit ${WORKSPACE_SYNC_EXIT.DIVERGED}
`;

export type WorkspaceSyncBlocker = {
  kind: 'not_running' | 'dirty' | 'ahead' | 'behind' | 'diverged' | 'fetch_failed' | 'no_workspace' | 'unknown';
  /** Short headline for the UI. */
  title: string;
  /** What is wrong and what to do about it. */
  message: string;
};

const NOT_RUNNING: WorkspaceSyncBlocker = {
  kind: 'not_running',
  title: 'Forge is not running',
  message:
    `The release is built from ${DEV_BRANCH} on GitHub, so the forge has to be running for the ` +
    'dashboard to confirm its workspace matches. Start the forge, then request the release.',
};

const BLOCKERS: Record<number, WorkspaceSyncBlocker> = {
  [WORKSPACE_SYNC_EXIT.DIRTY]: {
    kind: 'dirty',
    title: 'Workspace has uncommitted changes',
    message:
      'The forge workspace has uncommitted changes, so what is running is not what would be ' +
      `built. Commit or discard them and push to ${DEV_BRANCH}, then request the release.`,
  },
  [WORKSPACE_SYNC_EXIT.AHEAD]: {
    kind: 'ahead',
    title: 'Workspace has unpushed commits',
    message:
      `The forge workspace has commits that are not on origin/${DEV_BRANCH}. The release builds ` +
      `from origin, so those commits would be silently left out. Push to ${DEV_BRANCH}, then ` +
      'request the release.',
  },
  [WORKSPACE_SYNC_EXIT.BEHIND]: {
    kind: 'behind',
    title: 'Workspace is behind origin',
    message:
      `origin/${DEV_BRANCH} has commits the forge workspace does not, so the release would ship ` +
      'code that was never running here. Pull, verify the forge still behaves, then request the ' +
      'release.',
  },
  [WORKSPACE_SYNC_EXIT.DIVERGED]: {
    kind: 'diverged',
    title: 'Workspace has diverged from origin',
    message:
      `The forge workspace and origin/${DEV_BRANCH} have each moved on separately. Reconcile them ` +
      `(pull, resolve, push) so ${DEV_BRANCH} matches what is running, then request the release.`,
  },
  [WORKSPACE_SYNC_EXIT.FETCH_FAILED]: {
    kind: 'fetch_failed',
    title: 'Could not reach origin',
    message:
      `The forge could not fetch origin/${DEV_BRANCH}, so its workspace cannot be verified against ` +
      'what would be released. Check the forge\'s GitHub token and network, then try again.',
  },
  [WORKSPACE_SYNC_EXIT.NO_WORKSPACE]: {
    kind: 'no_workspace',
    title: 'No git workspace in the forge',
    message:
      `${CONTAINER_WORKDIR} is not a git repository in this forge, so there is nothing to verify ` +
      'against origin. Restart the forge to re-run setup.',
  },
};

/**
 * Map a check-script exit code to an actionable blocker, or null when the
 * workspace is releasable. Unrecognised codes block: an unverifiable workspace
 * is exactly the case this guard exists to catch, so it must never fail open.
 */
export function workspaceSyncBlocker(exitCode: number): WorkspaceSyncBlocker | null {
  if (exitCode === WORKSPACE_SYNC_EXIT.OK) return null;
  return (
    BLOCKERS[exitCode] ?? {
      kind: 'unknown',
      title: 'Workspace check failed',
      message:
        `The workspace check exited with an unexpected code (${exitCode}), so the forge could not ` +
        'be confirmed in sync with origin. Check the forge logs and try again.',
    }
  );
}

async function loadRuntimeEntry(
  forgeId: string,
): Promise<{ status: RuntimeStatus; containerId: string } | null> {
  const state = await loadState();
  const e = state[forgeId];
  return e ? { status: e.status, containerId: e.containerId } : null;
}

/**
 * Guard for the release path: a promotion may only be requested from a forge
 * that is *running* and whose workspace is exactly `origin/dev`.
 *
 * Both halves matter. An unpushed commit means the release silently omits work
 * that was validated on the pilot (this is what shipped a stale v1.4.1); an
 * unpulled commit means it ships work that never ran here at all. The check has
 * to happen inside the container because an unpushed commit is by definition
 * invisible to GitHub.
 */
export async function checkWorkspaceSync(
  forgeId: string,
  mgr: ContainerManager = getContainerManager(),
  loadEntry: typeof loadRuntimeEntry = loadRuntimeEntry,
): Promise<WorkspaceSyncBlocker | null> {
  const entry = await loadEntry(forgeId);
  if (!entry || entry.status !== 'running') return NOT_RUNNING;

  const { exitCode } = await mgr.exec(entry.containerId, 'sh', ['-c', CHECK_SCRIPT], {
    workdir: CONTAINER_WORKDIR,
    timeoutMs: CHECK_TIMEOUT_MS,
  });
  return workspaceSyncBlocker(exitCode);
}

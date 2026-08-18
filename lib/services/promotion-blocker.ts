/**
 * Statuses in which a promotion request is still live — it appears on the
 * admin Pending tab and `refreshPromotionGates` may still advance it.
 */
export const ACTIVE_STATUSES = ['checks_running', 'checks_failed', 'awaiting_approval'] as const;

/**
 * How long to wait for the first promote-gates run to appear before treating
 * an empty gate list as "the gates never started" rather than "still starting".
 * GitHub creates check runs within seconds of opening the PR; a few minutes of
 * silence means no run is coming.
 */
export const GATE_START_GRACE_MS = 3 * 60 * 1000;

/** Why a live promotion cannot progress, in terms an admin can act on. */
export type PromotionBlocker = {
  kind: 'conflict' | 'no_gate_runs';
  /** Short headline for the UI. */
  title: string;
  /** What is wrong and what to do about it. */
  message: string;
};

/**
 * The subset of a promotion these rules read. Deliberately structural so the
 * server DTO (`CheckResult` gates) and the client's own looser row type both
 * satisfy it — only the gate *count* matters here.
 */
export type BlockerInput = {
  status: string;
  createdAt: string;
  summary: {
    gates?: readonly { name: string; status: string; conclusion: string | null }[];
    mergeable?: boolean | null;
    /** When the current PR head was first seen; the gate-start clock runs from here. */
    headSince?: string;
  } | null;
};

/**
 * A promotion can sit at `checks_running` forever without anything being wrong
 * with the dashboard: if the dev -> main PR has merge conflicts, GitHub refuses
 * to build the merge ref and so never dispatches the `pull_request`-triggered
 * promote-gates workflow. No runs exist, `computeStatus` sees no failures and no
 * completions, and the gate chips have nothing to render. These rules name that
 * situation (and its cousins — workflow missing, Actions disabled, runner
 * offline) instead of leaving "checks running" to mean both things.
 */
export function promotionBlocker(p: BlockerInput, now: number = Date.now()): PromotionBlocker | null {
  if (!(ACTIVE_STATUSES as readonly string[]).includes(p.status)) return null;

  if (p.summary?.mergeable === false) {
    return {
      kind: 'conflict',
      title: 'Merge conflict — gates cannot run',
      message:
        'dev cannot be merged into main: the pull request has conflicts. GitHub will not run the ' +
        'promotion gates until they are resolved, so this request cannot progress. Resolve the ' +
        'conflicts on dev (merge main into dev), push, and the gates will start.',
    };
  }

  // Time the wait from the current head, not from the request: a push to dev
  // moves the head and the gates legitimately start over.
  const gatesSince = Date.parse(p.summary?.headSince ?? p.createdAt);
  const gateCount = p.summary?.gates?.length ?? 0;
  if (gateCount === 0 && now - gatesSince > GATE_START_GRACE_MS) {
    return {
      kind: 'no_gate_runs',
      title: 'Gates never started',
      message:
        'No promote-gates check runs exist for this commit. Check that ' +
        '.github/workflows/promote-gates.yml is present on dev, that Actions is enabled on the ' +
        'repo, and that the self-hosted forge-pilot runner is online.',
    };
  }

  return null;
}

const PLAIN_LABELS: Record<string, string> = {
  checks_failed: 'checks failed',
  awaiting_approval: 'awaiting approval',
  accepted: 'accepted',
  rejected: 'rejected',
};

/** Human-readable state, preferring the blocker over the stored status. */
export function promotionStatusLabel(p: BlockerInput, now: number = Date.now()): string {
  const blocker = promotionBlocker(p, now);
  if (blocker) return blocker.kind === 'conflict' ? 'blocked — merge conflict' : 'gates never started';
  if (p.status === 'checks_running') {
    return (p.summary?.gates?.length ?? 0) === 0 ? 'waiting for gates to start' : 'checks running';
  }
  return PLAIN_LABELS[p.status] ?? p.status;
}

/** True when Accept & release should be available. */
export function canAcceptPromotion(p: BlockerInput, now: number = Date.now()): boolean {
  return p.status === 'awaiting_approval' && promotionBlocker(p, now) === null;
}

import { prisma } from '@/lib/prisma';
import { ForbiddenError } from '@/lib/errors';
import { slugifyForgeName } from '@/lib/github/slug';
import { loadDeploymentStatuses } from '@/lib/runtime/prod/deployment-status';
import type { DeploymentPhase } from '@/lib/runtime/prod/reconciler';
import type { SessionUser } from './types';

/** One row of the admin Deployments table: inventory joined with live status. */
export type DeploymentRow = {
  forgeId: string;
  name: string;
  displayName: string | null;
  slug: string;
  deployEnabled: boolean;
  /** Desired version from the DB. Null when the forge has never been deployed. */
  pinnedVersion: string | null;
  /** Actual version from the last reconcile tick. Null when nothing is running. */
  runningVersion: string | null;
  /** Null when the snapshot has no entry for this forge (never deployed, or no tick yet). */
  phase: DeploymentPhase | null;
  error: string | null;
  consecutiveFailures: number;
};

function assertAdmin(user: SessionUser): void {
  if (!user.isAdmin) throw new ForbiddenError('Admin only');
}

/**
 * Every forge prod knows about — deliberately unfiltered, unlike
 * listDesiredForges — joined with the reconciler's last status snapshot.
 *
 * Never calls the registry: the client polls this every 3s, and a registry
 * outage must not blank the status table. Versions come from
 * listAvailableVersions on its own cadence.
 */
export async function listDeployments(currentUser: SessionUser): Promise<DeploymentRow[]> {
  assertAdmin(currentUser);
  const [forges, snapshot] = await Promise.all([
    prisma.forge.findMany({
      select: { id: true, name: true, displayName: true, deployEnabled: true, deployVersion: true },
      orderBy: { name: 'asc' },
    }),
    loadDeploymentStatuses(),
  ]);
  return forges.map((f) => {
    const s = snapshot[f.id];
    return {
      forgeId: f.id,
      name: f.name,
      displayName: f.displayName,
      slug: slugifyForgeName(f.name),
      deployEnabled: f.deployEnabled,
      pinnedVersion: f.deployVersion,
      runningVersion: s?.runningVersion ?? null,
      phase: s?.phase ?? null,
      error: s?.error ?? null,
      consecutiveFailures: s?.consecutiveFailures ?? 0,
    };
  });
}

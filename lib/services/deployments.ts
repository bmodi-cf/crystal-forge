import { prisma } from '@/lib/prisma';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { slugifyForgeName } from '@/lib/github/slug';
import { loadDeploymentStatuses } from '@/lib/runtime/prod/deployment-status';
import type { DeploymentPhase } from '@/lib/runtime/prod/reconciler';
import { getRegistryClient } from '@/lib/registry/client';
import type { RegistryClient } from '@/lib/registry/types';
import { compareVersions, parseVersion } from '@/lib/versioning/semver';
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

/**
 * Semver tags per forge, newest first, keyed by forgeId.
 *
 * Batch (not per-forge-on-demand) because the `no image` row state disables the
 * DEPLOY button: the client must know a forge has no tags before the admin
 * interacts with it, which a lazy per-menu fetch cannot provide.
 *
 * `latest` and `sha-…` are excluded. `latest` is a moving pointer maintained by
 * acceptPromotion — pinning it would break the reconciler's version check,
 * because the container label would read "latest" forever and never appear to
 * drift even after the underlying manifest moves.
 *
 * A forge whose lookup throws yields `null`, distinct from `[]` ("no images
 * exist"), so one unreachable repo neither fails the batch nor masquerades as
 * an imageless forge.
 */
export async function listAvailableVersions(
  currentUser: SessionUser,
  registry: RegistryClient = getRegistryClient(),
): Promise<Record<string, string[] | null>> {
  assertAdmin(currentUser);
  const forges = await prisma.forge.findMany({ select: { id: true, name: true } });
  const entries = await Promise.all(
    forges.map(async (f) => {
      const slug = slugifyForgeName(f.name);
      try {
        const tags = await registry.listTags(slug);
        const versions = tags
          .filter((t) => parseVersion(t) !== null)
          .sort((a, b) => compareVersions(b, a));
        return [f.id, versions] as const;
      } catch (err) {
        console.error('[deployments] listTags failed for %s: %s', slug, err);
        return [f.id, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Pin a forge to a version and enable it. First deploy and upgrade are the same
 * gesture; deploying an older version is rollback.
 *
 * Writes desired state and returns — the reconcile loop converges on its next
 * tick. This must never start a container itself: the reconciler is the only
 * thing that does, and a second writer could race it.
 *
 * The version is validated against the live semver tag list because a bad pin
 * is not self-correcting: the reconciler removes the running container before
 * pulling, so pinning a nonexistent tag takes the forge down until someone
 * deploys a working version.
 */
export async function deployForge(
  currentUser: SessionUser,
  forgeId: string,
  version: string,
  registry: RegistryClient = getRegistryClient(),
): Promise<DeploymentRow> {
  assertAdmin(currentUser);
  const forge = await prisma.forge.findUnique({
    where: { id: forgeId },
    select: { id: true, name: true },
  });
  if (!forge) throw new NotFoundError('forge', forgeId);

  const slug = slugifyForgeName(forge.name);
  const tags = await registry.listTags(slug);
  const available = tags.filter((t) => parseVersion(t) !== null);
  if (!available.includes(version)) {
    throw new ValidationError(`Version ${version} is not available for ${slug}`, {
      version: [`Not a published version of ${slug}`],
    });
  }

  await prisma.forge.update({
    where: { id: forgeId },
    data: { deployVersion: version, deployEnabled: true },
  });

  const rows = await listDeployments(currentUser);
  const row = rows.find((r) => r.forgeId === forgeId);
  if (!row) throw new NotFoundError('forge', forgeId);
  return row;
}

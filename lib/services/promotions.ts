import { prisma } from '@/lib/prisma';
import { canWriteForge, canReadForge, toAcl } from '@/lib/acl';
import { getGitHubClient } from '@/lib/github/client';
import { getRegistryClient } from '@/lib/registry/client';
import type { GitHubClient, CheckResult } from '@/lib/github/types';
import type { RegistryClient } from '@/lib/registry/types';
import { DEV_BRANCH, PROD_BRANCH, REQUIRED_CHECKS } from '@/lib/github/branches';
import { nextVersion, type BumpLevel } from '@/lib/versioning/semver';
import { slugifyForgeName } from '@/lib/github/slug';
import type { SessionUser } from './types';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { ACTIVE_STATUSES } from './promotion-blocker';
import { checkWorkspaceSync, type WorkspaceSyncBlocker } from './workspace-sync';

export type PromotionSummary = {
  forgeName: string;
  commits: number;
  changedFiles: number;
  additions: number;
  deletions: number;
  gates: CheckResult[];
  /**
   * PR mergeability at the last refresh (`null` while GitHub computes it).
   * Recorded because a conflicted PR is why the gate list can be empty: GitHub
   * cannot build the merge ref, so promote-gates is never dispatched. See
   * `promotionBlocker`.
   */
  mergeable?: boolean | null;
  mergeableState?: string;
  /**
   * When the promotion's current head sha was first observed. The gate-start
   * grace period runs from here rather than from the request, because a push to
   * dev moves the head and the gates legitimately start over.
   */
  headSince?: string;
};

export type PromotionDto = {
  id: string;
  forgeId: string;
  status: string;
  bumpLevel: BumpLevel;
  targetVersion: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  imageRef: string | null;
  summary: PromotionSummary | null;
  requestedBy: { id: string; name: string };
  approvedBy: { id: string; name: string } | null;
  createdAt: string;
  decidedAt: string | null;
  rejectReason: string | null;
};

export const ACTIVE = ACTIVE_STATUSES;

const promotionInclude = {
  requestedBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
} as const;

type Row = Awaited<ReturnType<typeof loadRow>>;
async function loadRow(id: string) {
  return prisma.promotionRequest.findUnique({ where: { id }, include: promotionInclude });
}

function toDto(row: NonNullable<Row>): PromotionDto {
  return {
    id: row.id,
    forgeId: row.forgeId,
    status: row.status,
    bumpLevel: row.bumpLevel as BumpLevel,
    targetVersion: row.targetVersion,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    headSha: row.headSha,
    imageRef: row.imageRef,
    summary: (row.summary as PromotionSummary | null) ?? null,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    rejectReason: row.rejectReason ?? null,
  };
}

async function loadForgeForAcl(forgeId: string) {
  const forge = await prisma.forge.findUnique({
    where: { id: forgeId },
    include: { groups: { include: { group: true } } },
  });
  if (!forge) throw new NotFoundError('forge', forgeId);
  return forge;
}

export async function requestPromotion(
  currentUser: SessionUser,
  forgeId: string,
  input: { bumpLevel: BumpLevel },
  github: GitHubClient = getGitHubClient(),
  checkWorkspace: (forgeId: string) => Promise<WorkspaceSyncBlocker | null> = checkWorkspaceSync,
): Promise<PromotionDto> {
  const forge = await loadForgeForAcl(forgeId);
  if (!canWriteForge(currentUser, toAcl(forge))) {
    throw new ForbiddenError(`Cannot request promotion for forge ${forgeId}`);
  }

  const existingOpen = await prisma.promotionRequest.findFirst({
    where: { forgeId, status: { in: [...ACTIVE] } },
  });
  if (existingOpen) {
    throw new ValidationError('A promotion is already in progress for this forge', {});
  }

  // The PR below is opened from `origin/dev` — GitHub resolves both sides
  // server-side and never sees the forge's workspace. So a commit sitting
  // unpushed in the container is silently omitted from the release, and a
  // commit pushed by someone else is silently included. Both produce a build
  // that is not what the pilot was validated on; refuse before a version
  // number and a PR exist for it.
  const blocker = await checkWorkspace(forgeId);
  if (blocker) {
    throw new ValidationError(`Cannot release ${forge.name}: ${blocker.message}`, {});
  }

  // Compute the target version from the last accepted release.
  const targetVersion = nextVersion(await lastAcceptedVersion(forgeId), input.bumpLevel);

  const title = `Promote to production (${targetVersion})`;
  const body = `Automated promotion request for **${forge.name}** → \`${targetVersion}\`.`;
  const pr = await github.openPullRequest(forge.repoFullName, {
    head: DEV_BRANCH, base: PROD_BRANCH, title, body,
  });

  const created = await prisma.promotionRequest.create({
    data: {
      forgeId,
      requestedById: currentUser.id,
      prNumber: pr.number,
      prUrl: pr.url,
      headSha: pr.headSha,
      bumpLevel: input.bumpLevel,
      targetVersion,
      status: 'checks_running',
    },
    include: promotionInclude,
  });
  return toDto(created);
}

function computeStatus(gates: CheckResult[]): 'checks_running' | 'checks_failed' | 'awaiting_approval' {
  const byName = new Map(gates.map((g) => [g.name, g]));
  for (const req of REQUIRED_CHECKS) {
    const g = byName.get(req);
    if (g && g.status === 'completed' && g.conclusion !== 'success' && g.conclusion !== 'skipped') {
      return 'checks_failed';
    }
  }
  const allDone = REQUIRED_CHECKS.every((req) => {
    const g = byName.get(req);
    return g && g.status === 'completed' && (g.conclusion === 'success' || g.conclusion === 'skipped');
  });
  return allDone ? 'awaiting_approval' : 'checks_running';
}

export async function refreshPromotionGates(
  id: string,
  github: GitHubClient = getGitHubClient(),
): Promise<PromotionDto> {
  const row = await loadRow(id);
  if (!row) throw new NotFoundError('promotion', id);
  const forge = await prisma.forge.findUniqueOrThrow({ where: { id: row.forgeId } });

  // Read the PR first: pushing to dev moves its head, and GitHub runs the gates
  // on the new sha. Polling the sha captured at request time would report zero
  // gates forever, and accepting would retag an image built from the old code.
  const pr = await github.getPullRequest(forge.repoFullName, row.prNumber);
  const headMoved = pr.headSha !== row.headSha;
  const gates = await github.getRefCheckResults(forge.repoFullName, pr.headSha);

  const previous = (row.summary as PromotionSummary | null) ?? null;
  const summary: PromotionSummary = {
    forgeName: forge.name,
    commits: pr.commits,
    changedFiles: pr.changedFiles,
    additions: pr.additions,
    deletions: pr.deletions,
    gates,
    mergeable: pr.mergeable,
    mergeableState: pr.mergeableState,
    headSince:
      headMoved || !previous?.headSince ? new Date().toISOString() : previous.headSince,
  };

  // Only advance forward from an active checks state; never override a decided request.
  const nextStatus = ([...ACTIVE] as string[]).includes(row.status)
    ? computeStatus(gates)
    : row.status;

  // Compare-and-set on the status read above. The row was read before two
  // GitHub round-trips, so an Accept or Reject can land in between; a plain
  // update would write the stale active status back over that decision, and
  // since the resurrected status is active the request would reappear on the
  // Pending tab and every later refresh would keep it there. The decision wins.
  const { count } = await prisma.promotionRequest.updateMany({
    where: { id, status: { in: [...ACTIVE] } },
    data: {
      summary: summary as unknown as object,
      status: nextStatus as typeof row.status,
      headSha: pr.headSha,
    },
  });

  const current = await loadRow(id);
  if (!current) throw new NotFoundError('promotion', id);
  if (count === 0) {
    console.warn(
      `[refreshPromotionGates] ${id}: decided (${current.status}) while refreshing; ` +
        'gate refresh discarded',
    );
  }
  return toDto(current);
}

export async function listPendingPromotions(currentUser: SessionUser): Promise<PromotionDto[]> {
  if (!currentUser.isAdmin) throw new ForbiddenError('Admin only');
  const rows = await prisma.promotionRequest.findMany({
    where: { status: { in: [...ACTIVE] } },
    orderBy: { createdAt: 'desc' },
    include: promotionInclude,
  });
  return rows.map(toDto);
}

export async function acceptPromotion(
  currentUser: SessionUser,
  id: string,
  github: GitHubClient = getGitHubClient(),
  registry: RegistryClient = getRegistryClient(),
): Promise<PromotionDto> {
  if (!currentUser.isAdmin) throw new ForbiddenError('Admin only');
  const row = await loadRow(id);
  if (!row) throw new NotFoundError('promotion', id);
  if (row.status !== 'awaiting_approval') {
    throw new ValidationError(`Promotion ${id} is not awaiting approval (status ${row.status})`, {});
  }
  const forge = await prisma.forge.findUniqueOrThrow({ where: { id: row.forgeId } });
  const slug = slugifyForgeName(forge.name);

  // Refuse a known-conflicted PR here: GitHub would reject the merge with an
  // opaque "Pull Request is not mergeable", and a conflicted PR never ran the
  // gates in the first place. `null` means GitHub has not decided yet — let the
  // merge attempt be the judge in that case.
  const prState = await github.getPullRequest(forge.repoFullName, row.prNumber);
  // Guard the sha as well as the mergeability: the release retags the candidate
  // image built for `row.headSha`, so a dev push between the last gate refresh
  // and this click would ship an image that does not match what gets merged.
  if (prState.headSha !== row.headSha) {
    throw new ValidationError(
      `Cannot release ${forge.name}: ${DEV_BRANCH} moved (${row.headSha.slice(0, 8)} -> ` +
        `${prState.headSha.slice(0, 8)}) since the gates last ran. Wait for the gates on the new ` +
        `commit, then release.`,
      {},
    );
  }
  if (prState.mergeable === false) {
    throw new ValidationError(
      `Cannot release ${forge.name}: the ${DEV_BRANCH} -> ${PROD_BRANCH} pull request has merge ` +
        `conflicts (mergeable_state: ${prState.mergeableState}). Merge ${PROD_BRANCH} into ` +
        `${DEV_BRANCH}, resolve the conflicts and push — the gates will run on the new head.`,
      {},
    );
  }

  // Merge dev -> main.
  const merge = await github.mergePullRequest(forge.repoFullName, row.prNumber, { method: 'squash' });
  // Tag the merge commit for traceability.
  await github.createGitTag(forge.repoFullName, row.targetVersion, merge.sha);
  // Retag the already-built candidate image to the release + latest (no rebuild).
  await registry.tagManifest(slug, `sha-${row.headSha}`, [row.targetVersion, 'latest']);

  const imageRef = `${process.env.REGISTRY_HOST ?? 'registry.crystalfountains.com'}/${slug}:${row.targetVersion}`;
  const updated = await prisma.promotionRequest.update({
    where: { id },
    data: {
      status: 'accepted',
      approvedById: currentUser.id,
      decidedAt: new Date(),
      imageRef,
    },
    include: promotionInclude,
  });

  await syncDevWithProd(forge.repoFullName, github);

  return toDto(updated);
}

/**
 * Bring `main` back into `dev` after a release.
 *
 * The release is a *squash* merge, so main gains a commit that dev does not
 * have and the two branches diverge by one commit per release. Once the same
 * regions get touched on both sides the next dev -> main promotion PR
 * conflicts — and a conflicted PR never gets a promote-gates run at all, so the
 * promotion sits at `checks_running` with no gates forever.
 *
 * Best-effort by design: the release is already merged, tagged and recorded by
 * the time this runs, so a conflict (or a GitHub blip) is logged for a human to
 * resolve and never fails the release.
 */
async function syncDevWithProd(repoFullName: string, github: GitHubClient): Promise<void> {
  try {
    const result = await github.mergeBranch(repoFullName, DEV_BRANCH, PROD_BRANCH);
    if (result.conflicted) {
      console.warn(
        `[acceptPromotion] ${repoFullName}: ${PROD_BRANCH} -> ${DEV_BRANCH} back-merge conflicts; ` +
          `resolve on ${DEV_BRANCH} or the next promotion PR will not run its gates`,
      );
    }
  } catch (err) {
    console.error(`[acceptPromotion] ${repoFullName}: back-merge into ${DEV_BRANCH} failed:`, err);
  }
}

export async function rejectPromotion(
  currentUser: SessionUser,
  id: string,
  input: { reason?: string },
  github: GitHubClient = getGitHubClient(),
): Promise<PromotionDto> {
  if (!currentUser.isAdmin) throw new ForbiddenError('Admin only');
  const row = await loadRow(id);
  if (!row) throw new NotFoundError('promotion', id);
  if (row.status === 'accepted' || row.status === 'rejected') {
    throw new ValidationError(`Promotion ${id} already decided`, {});
  }
  const forge = await prisma.forge.findUniqueOrThrow({ where: { id: row.forgeId } });
  await github.closePullRequest(forge.repoFullName, row.prNumber);
  const updated = await prisma.promotionRequest.update({
    where: { id },
    data: { status: 'rejected', approvedById: currentUser.id, decidedAt: new Date(), rejectReason: input.reason ?? null },
    include: promotionInclude,
  });
  return toDto(updated);
}

/** The forge's most recently decided accepted release version, or null before any release. */
async function lastAcceptedVersion(forgeId: string): Promise<string | null> {
  const lastAccepted = await prisma.promotionRequest.findFirst({
    where: { forgeId, status: 'accepted' },
    orderBy: { decidedAt: 'desc' },
  });
  return lastAccepted?.targetVersion ?? null;
}

export async function getForgeCurrentVersion(
  currentUser: SessionUser,
  forgeId: string,
): Promise<string | null> {
  const forge = await loadForgeForAcl(forgeId);
  if (!canReadForge(currentUser, toAcl(forge))) throw new ForbiddenError(`Cannot read forge ${forgeId}`);
  return lastAcceptedVersion(forgeId);
}

export async function getForgePromotion(
  currentUser: SessionUser,
  forgeId: string,
): Promise<PromotionDto | null> {
  const forge = await loadForgeForAcl(forgeId);
  // canReadForge is sufficient to view a forge's promotion status
  if (!canReadForge(currentUser, toAcl(forge))) throw new ForbiddenError(`Cannot read forge ${forgeId}`);
  const row = await prisma.promotionRequest.findFirst({
    where: { forgeId },
    orderBy: { createdAt: 'desc' },
    include: promotionInclude,
  });
  return row ? toDto(row) : null;
}

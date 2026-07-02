import { prisma } from '@/lib/prisma';
import { canWriteForge, canReadForge } from '@/lib/acl';
import { getGitHubClient } from '@/lib/github/client';
import { getRegistryClient } from '@/lib/registry/client';
import type { GitHubClient, CheckResult } from '@/lib/github/types';
import type { RegistryClient } from '@/lib/registry/types';
import { DEV_BRANCH, PROD_BRANCH, REQUIRED_CHECKS } from '@/lib/github/branches';
import { nextVersion, type BumpLevel } from '@/lib/versioning/semver';
import { slugifyForgeName } from '@/lib/github/slug';
import type { SessionUser } from './types';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';

export type PromotionSummary = {
  forgeName: string;
  commits: number;
  changedFiles: number;
  additions: number;
  deletions: number;
  gates: CheckResult[];
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
};

const ACTIVE = ['checks_running', 'checks_failed', 'awaiting_approval'] as const;

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
  registry: RegistryClient = getRegistryClient(), // reserved for symmetry; not used here
): Promise<PromotionDto> {
  void registry;
  const forge = await loadForgeForAcl(forgeId);
  const acl = { id: forge.id, createdById: forge.createdById, groups: forge.groups.map((g) => g.group.name) };
  if (!canWriteForge(currentUser, acl)) {
    throw new ForbiddenError(`Cannot request promotion for forge ${forgeId}`);
  }

  const existingOpen = await prisma.promotionRequest.findFirst({
    where: { forgeId, status: { in: [...ACTIVE] } },
  });
  if (existingOpen) {
    throw new ValidationError('A promotion is already in progress for this forge', {});
  }

  // Compute the target version from the last accepted release.
  const lastAccepted = await prisma.promotionRequest.findFirst({
    where: { forgeId, status: 'accepted' },
    orderBy: { decidedAt: 'desc' },
  });
  const targetVersion = nextVersion(lastAccepted?.targetVersion ?? null, input.bumpLevel);

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

  const gates = await github.getRefCheckResults(forge.repoFullName, row.headSha);
  const pr = await github.getPullRequest(forge.repoFullName, row.prNumber);
  const summary: PromotionSummary = {
    forgeName: forge.name,
    commits: pr.commits,
    changedFiles: pr.changedFiles,
    additions: pr.additions,
    deletions: pr.deletions,
    gates,
  };

  // Only advance forward from an active checks state; never override a decided request.
  const nextStatus = ([...ACTIVE] as string[]).includes(row.status)
    ? computeStatus(gates)
    : row.status;

  const updated = await prisma.promotionRequest.update({
    where: { id },
    data: { summary: summary as unknown as object, status: nextStatus as typeof row.status },
    include: promotionInclude,
  });
  return toDto(updated);
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

export async function getForgePromotion(
  currentUser: SessionUser,
  forgeId: string,
): Promise<PromotionDto | null> {
  const forge = await loadForgeForAcl(forgeId);
  const acl = { id: forge.id, createdById: forge.createdById, groups: forge.groups.map((g) => g.group.name) };
  // canReadForge is sufficient to view a forge's promotion status
  if (!canReadForge(currentUser, acl)) throw new ForbiddenError(`Cannot read forge ${forgeId}`);
  const row = await prisma.promotionRequest.findFirst({
    where: { forgeId },
    orderBy: { createdAt: 'desc' },
    include: promotionInclude,
  });
  return row ? toDto(row) : null;
}

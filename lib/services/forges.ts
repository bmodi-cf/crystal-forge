import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canReadForge, canWriteForge, forgeReadFilter } from '@/lib/acl';
import { env } from '@/lib/env';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { getGitHubClient } from '@/lib/github/client';
import type { GitHubClient } from '@/lib/github/client';
import { slugifyForgeName } from '@/lib/github/slug';
import type { Forge, SessionUser } from './types';
import type { CreateForgeInput, UpdateForgeInput } from './forges-schema';

const forgeInclude = {
  groups: { include: { group: true } },
  createdBy: { select: { id: true, name: true } },
} as const satisfies Prisma.ForgeInclude;

type ForgeWithRelations = Prisma.ForgeGetPayload<{ include: typeof forgeInclude }>;

function toDto(row: ForgeWithRelations): Forge {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    tone: row.tone,
    initials: row.initials,
    groups: row.groups.map((fg) => fg.group.name),
    createdBy: { id: row.createdBy.id, name: row.createdBy.name },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    repoFullName: row.repoFullName,
    repoUrl: `${env.GITHUB_BASE_URL.replace(/\/$/, '')}/${row.repoFullName}`,
  };
}

export async function listForges(currentUser: SessionUser): Promise<Forge[]> {
  const rows = await prisma.forge.findMany({
    where: forgeReadFilter(currentUser),
    include: forgeInclude,
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map(toDto);
}

export async function getForge(currentUser: SessionUser, id: string): Promise<Forge> {
  const row = await prisma.forge.findUnique({
    where: { id },
    include: forgeInclude,
  });
  if (!row) {
    throw new NotFoundError('forge', id);
  }
  const aclShape = {
    id: row.id,
    createdById: row.createdById,
    groups: row.groups.map((fg) => fg.group.name),
  };
  if (!canReadForge(currentUser, aclShape)) {
    throw new ForbiddenError(`Cannot read forge ${id}`);
  }
  return toDto(row);
}

function deriveInitials(name: string): string {
  const cleaned = name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]!)
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return cleaned || 'F';
}

/**
 * Create a Forge atomically with its GitHub repo. If the DB write fails after
 * the repo was created, the just-created repo is deleted (compensating action).
 *
 * `client` is injectable for tests; in production the default factory returns
 * the singleton chosen by GITHUB_CLIENT_MODE.
 */
export async function createForge(
  currentUser: SessionUser,
  input: CreateForgeInput,
  client: GitHubClient = getGitHubClient(),
): Promise<Forge> {
  // 1. Pre-check name uniqueness in DB (cheaper than going to GitHub first).
  const dup = await prisma.forge.findUnique({ where: { name: input.name } });
  if (dup) {
    throw new ValidationError('Forge name already in use', {
      name: ['A Forge with this name already exists'],
    });
  }

  // 2. Validate group names exist before any external call.
  const groupRows = await prisma.group.findMany({ where: { name: { in: input.groups } } });
  if (groupRows.length !== input.groups.length) {
    const known = new Set(groupRows.map((g) => g.name));
    const unknown = input.groups.filter((g) => !known.has(g));
    throw new ValidationError('Unknown group(s)', { groups: unknown });
  }

  // Non-admins may only assign groups they are members of.
  if (!currentUser.isAdmin) {
    const userGroups = new Set(currentUser.groups);
    const foreign = input.groups.filter((g) => !userGroups.has(g));
    if (foreign.length > 0) {
      throw new ValidationError('Cannot assign groups you are not a member of', {
        groups: foreign,
      });
    }
  }

  // 3. Compute slug + create the GitHub repo. Errors here surface unchanged.
  const description = input.description?.trim() ? input.description.trim() : null;
  const slug = slugifyForgeName(input.name);
  const created = await client.createRepoFromTemplate({
    name: slug,
    description,
    private: true,
  });

  // 4. Insert the Forge row. If this fails, compensate by deleting the GitHub repo.
  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.forge.create({
        data: {
          name: input.name,
          description,
          initials: deriveInitials(input.name),
          createdById: currentUser.id,
          repoFullName: created.fullName,
          groups: { create: groupRows.map((g) => ({ groupId: g.id })) },
        },
        include: forgeInclude,
      });
      return toDto(row);
    });
  } catch (err) {
    // Best-effort compensating delete. Failure of compensation is logged loudly
    // but the original error is what propagates to the caller.
    try {
      await client.deleteRepo(created.fullName);
    } catch (cleanupErr) {
      console.error(
        '[createForge] orphaned repo — cleanup failed',
        { repo: created.fullName, cleanupErr },
      );
    }
    throw err;
  }
}

export async function updateForge(
  currentUser: SessionUser,
  id: string,
  input: UpdateForgeInput,
): Promise<Forge> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.forge.findUnique({ where: { id }, include: forgeInclude });
    if (!existing) throw new NotFoundError('forge', id);

    const aclShape = {
      id: existing.id,
      createdById: existing.createdById,
      groups: existing.groups.map((fg) => fg.group.name),
    };
    if (!canWriteForge(currentUser, aclShape)) {
      throw new ForbiddenError(`Cannot update forge ${id}`);
    }

    const data: Prisma.ForgeUpdateInput = {};
    if (input.description !== undefined) {
      const trimmed = input.description?.trim() ?? null;
      data.description = trimmed && trimmed.length > 0 ? trimmed : null;
    }

    if (input.groups !== undefined) {
      const groupRows = await tx.group.findMany({ where: { name: { in: input.groups } } });
      if (groupRows.length !== input.groups.length) {
        const known = new Set(groupRows.map((g) => g.name));
        const unknown = input.groups.filter((g) => !known.has(g));
        throw new ValidationError('Unknown group(s)', { groups: unknown });
      }
      if (!currentUser.isAdmin) {
        const userGroups = new Set(currentUser.groups);
        const foreign = input.groups.filter((g) => !userGroups.has(g));
        if (foreign.length > 0) {
          throw new ValidationError('Cannot assign groups you are not a member of', {
            groups: foreign,
          });
        }
      }
      await tx.forgeGroup.deleteMany({ where: { forgeId: id } });
      await tx.forgeGroup.createMany({
        data: groupRows.map((g) => ({ forgeId: id, groupId: g.id })),
      });
    }

    const updated = await tx.forge.update({
      where: { id },
      data,
      include: forgeInclude,
    });
    return toDto(updated);
  });
}

/**
 * Delete a Forge. The GitHub repo is archived first; if archive fails, the
 * Forge row is preserved (better to leave a usable Forge than a broken
 * repo<->row link).
 */
export async function deleteForge(
  currentUser: SessionUser,
  id: string,
  client: GitHubClient = getGitHubClient(),
): Promise<void> {
  const existing = await prisma.forge.findUnique({
    where: { id },
    include: forgeInclude,
  });
  if (!existing) throw new NotFoundError('forge', id);

  const aclShape = {
    id: existing.id,
    createdById: existing.createdById,
    groups: existing.groups.map((fg) => fg.group.name),
  };
  if (!canWriteForge(currentUser, aclShape)) {
    throw new ForbiddenError(`Cannot delete forge ${id}`);
  }

  // Archive on GitHub BEFORE the DB delete. If archive fails, abort.
  await client.archiveRepo(existing.repoFullName);

  await prisma.forge.delete({ where: { id } }); // ON DELETE CASCADE wipes forge_groups
}

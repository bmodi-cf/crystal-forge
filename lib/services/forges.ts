import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canReadForge, forgeReadFilter } from '@/lib/acl';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import type { Forge, SessionUser } from './types';
import type { CreateForgeInput } from './forges-schema';

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

export async function createForge(
  currentUser: SessionUser,
  input: CreateForgeInput,
): Promise<Forge> {
  return prisma.$transaction(async (tx) => {
    const groupRows = await tx.group.findMany({ where: { name: { in: input.groups } } });
    if (groupRows.length !== input.groups.length) {
      const known = new Set(groupRows.map((g) => g.name));
      const unknown = input.groups.filter((g) => !known.has(g));
      throw new ValidationError('Unknown group(s)', { groups: unknown });
    }
    const description = input.description?.trim() ? input.description.trim() : null;
    const created = await tx.forge.create({
      data: {
        name: input.name,
        description,
        initials: deriveInitials(input.name),
        createdById: currentUser.id,
        groups: { create: groupRows.map((g) => ({ groupId: g.id })) },
      },
      include: forgeInclude,
    });
    return toDto(created);
  });
}

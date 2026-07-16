import type { Prisma } from '@prisma/client';
import type { SessionUser } from './services/types';

type ForgeForAcl = {
  id: string;
  createdById: string;
  groups: string[];
};

type ForgeRowForAcl = {
  id: string;
  createdById: string;
  groups: { group: { name: string } }[];
};

/** Flattens a Prisma forge row (with `groups: {group}[]`) into the ACL shape. */
export function toAcl(forge: ForgeRowForAcl): ForgeForAcl {
  return {
    id: forge.id,
    createdById: forge.createdById,
    groups: forge.groups.map((fg) => fg.group.name),
  };
}

/** True when the user may reach the edit surface (create/edit forges, runtimes). */
export function canEdit(user: SessionUser): boolean {
  return user.role === 'ADMIN' || user.role === 'DEVELOPER';
}

export function canReadForge(user: SessionUser, forge: ForgeForAcl): boolean {
  if (user.isAdmin) return true;
  if (user.id === forge.createdById) return true;
  return forge.groups.some((g) => user.groups.includes(g));
}

export function canWriteForge(user: SessionUser, forge: ForgeForAcl): boolean {
  if (user.isAdmin) return true;
  return user.id === forge.createdById;
}

export function forgeReadFilter(user: SessionUser): Prisma.ForgeWhereInput {
  if (user.isAdmin) return {};
  return {
    OR: [
      { groups: { some: { group: { name: { in: user.groups } } } } },
      { createdById: user.id },
    ],
  };
}

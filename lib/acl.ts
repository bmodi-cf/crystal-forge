import type { Prisma } from '@prisma/client';
import type { SessionUser } from './services/types';

type ForgeForAcl = {
  id: string;
  createdById: string;
  groups: string[];
};

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

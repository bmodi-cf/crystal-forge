import { prisma } from '@/lib/prisma';

export type GroupDto = { id: string; name: string };

export async function listGroups(): Promise<GroupDto[]> {
  const rows = await prisma.group.findMany({ orderBy: { name: 'asc' } });
  return rows.map((g) => ({ id: g.id, name: g.name }));
}

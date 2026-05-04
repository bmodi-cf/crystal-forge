import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { SessionUser } from '@/lib/services/types';

let _prisma: PrismaClient | null = null;

export function getTestPrisma(): PrismaClient {
  if (!_prisma) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    const adapter = new PrismaPg({ connectionString });
    _prisma = new PrismaClient({ adapter, log: ['error'] });
  }
  return _prisma;
}

export async function withCleanDb<T>(fn: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const prisma = getTestPrisma();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.forgeGroup.deleteMany();
  await prisma.forge.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.userGroup.deleteMany();
  await prisma.account.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await prisma.group.deleteMany();
  return fn(prisma);
}

export async function makeUser(
  prisma: PrismaClient,
  data: {
    email: string;
    name: string;
    groups?: string[];
    isAdmin?: boolean;
  },
): Promise<SessionUser> {
  const initials = data.name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const user = await prisma.user.create({
    data: { email: data.email, name: data.name, initials },
  });
  for (const name of data.groups ?? []) {
    const group =
      (await prisma.group.findUnique({ where: { name } })) ??
      (await prisma.group.create({ data: { name } }));
    await prisma.userGroup.create({ data: { userId: user.id, groupId: group.id } });
  }
  if (data.isAdmin) {
    await prisma.userRole.create({ data: { userId: user.id, role: 'admin' } });
  }
  return {
    id: user.id,
    entraOid: null,
    email: user.email,
    name: user.name,
    initials: user.initials,
    groups: data.groups ?? [],
    isAdmin: data.isAdmin ?? false,
  };
}

export async function makeForge(
  prisma: PrismaClient,
  data: {
    name: string;
    createdById: string;
    groups?: string[];
    status?: 'active' | 'draft' | 'archived';
  },
) {
  const forge = await prisma.forge.create({
    data: {
      name: data.name,
      initials: data.name.slice(0, 2).toUpperCase(),
      tone: 'navy',
      status: data.status ?? 'active',
      createdById: data.createdById,
    },
  });
  for (const name of data.groups ?? []) {
    const group =
      (await prisma.group.findUnique({ where: { name } })) ??
      (await prisma.group.create({ data: { name } }));
    await prisma.forgeGroup.create({ data: { forgeId: forge.id, groupId: group.id } });
  }
  return forge;
}

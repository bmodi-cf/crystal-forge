import { PrismaClient, type Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { SessionUser } from '@/lib/services/types';
import { slugifyForgeName } from '@/lib/github/slug';

let _prisma: PrismaClient | null = null;

export function getTestPrisma(): PrismaClient {
  if (!_prisma) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    // Defense-in-depth: refuse to run destructive test helpers against any
    // database that isn't explicitly named "*_test". vitest.setup.ts rewrites
    // DATABASE_URL automatically; if this guard fires, the override did not
    // run and withCleanDb would otherwise nuke real data.
    const dbName = new URL(connectionString).pathname.replace(/^\//, '');
    if (!dbName.endsWith('_test')) {
      throw new Error(
        `Refusing to use database "${dbName}" for integration tests. ` +
          `Database name must end with "_test". Tests must run via vitest ` +
          `so vitest.setup.ts can rewrite DATABASE_URL.`,
      );
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
  await prisma.promotionRequest.deleteMany();
  await prisma.forge.deleteMany();
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
    role?: Role;
  },
): Promise<SessionUser> {
  const initials = data.name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const role = data.role ?? 'DEVELOPER';
  const user = await prisma.user.create({
    data: { email: data.email, name: data.name, initials, role },
  });
  for (const name of data.groups ?? []) {
    const group =
      (await prisma.group.findUnique({ where: { name } })) ??
      (await prisma.group.create({ data: { name } }));
    await prisma.userGroup.create({ data: { userId: user.id, groupId: group.id } });
  }
  return {
    id: user.id,
    entraOid: null,
    email: user.email,
    name: user.name,
    initials: user.initials,
    groups: data.groups ?? [],
    role,
    isAdmin: role === 'ADMIN',
  };
}

export async function makeForge(
  prisma: PrismaClient,
  data: {
    name: string;
    createdById: string;
    groups?: string[];
    repoFullName?: string; // override for tests that care about value
  },
) {
  const slug = slugifyForgeName(data.name);
  const repoFullName = data.repoFullName ?? `test-owner/${slug}`;
  const forge = await prisma.forge.create({
    data: {
      name: data.name,
      initials: data.name.slice(0, 2).toUpperCase(),
      tone: 'navy',
      createdById: data.createdById,
      repoFullName,
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

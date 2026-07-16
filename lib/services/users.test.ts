// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { withCleanDb, makeUser } from '@/lib/test/db';
import { provisionFromEntra, getSessionUserById, getUserBySessionToken } from './users';

beforeAll(async () => {
  // Confirm DB is reachable
  const { getTestPrisma } = await import('@/lib/test/db');
  await getTestPrisma().$connect();
});

describe('provisionFromEntra', () => {
  it('creates a new user on first login', async () => {
    await withCleanDb(async (prisma) => {
      const user = await provisionFromEntra({
        entraOid: 'entra-abc',
        email: 'newcomer@crystalfountains.com',
        name: 'New Comer',
      });
      expect(user.email).toBe('newcomer@crystalfountains.com');
      expect(user.initials).toBe('NC');
      const persisted = await prisma.user.findUnique({ where: { email: 'newcomer@crystalfountains.com' } });
      expect(persisted?.entraOid).toBe('entra-abc');
    });
  });

  it('updates existing user on subsequent logins (matched by entra_oid)', async () => {
    await withCleanDb(async (prisma) => {
      await prisma.user.create({
        data: { email: 'existing@x.com', name: 'Old Name', initials: 'ON', entraOid: 'entra-xyz' },
      });
      const user = await provisionFromEntra({
        entraOid: 'entra-xyz',
        email: 'existing@x.com',
        name: 'New Name',
      });
      expect(user.name).toBe('New Name');
      expect(user.initials).toBe('NN');
    });
  });
});

describe('getSessionUserById', () => {
  it('returns the user with groups[], role and isAdmin populated', async () => {
    await withCleanDb(async (prisma) => {
      const user = await prisma.user.create({
        data: { email: 'maya@x.com', name: 'Maya', initials: 'M', role: 'ADMIN' },
      });
      const eng = await prisma.group.create({ data: { name: 'Engineering' } });
      await prisma.userGroup.create({ data: { userId: user.id, groupId: eng.id } });

      const session = await getSessionUserById(user.id);
      expect(session?.groups).toEqual(['Engineering']);
      expect(session?.role).toBe('ADMIN');
      expect(session?.isAdmin).toBe(true);
    });
  });

  it('defaults a plain user to DEFAULT_USER / non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const user = await prisma.user.create({
        data: { email: 'plain@x.com', name: 'Plain', initials: 'P' },
      });
      const session = await getSessionUserById(user.id);
      expect(session?.role).toBe('DEFAULT_USER');
      expect(session?.isAdmin).toBe(false);
    });
  });

  it('returns null for unknown id', async () => {
    await withCleanDb(async () => {
      const session = await getSessionUserById('00000000-0000-0000-0000-000000000000');
      expect(session).toBeNull();
    });
  });
});

describe('getUserBySessionToken', () => {
  it('returns the user for a live session, null for expired/missing', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      await prisma.session.create({
        data: { sessionToken: 'live-tok', userId: tom.id, expires: new Date(Date.now() + 60_000) },
      });
      await prisma.session.create({
        data: { sessionToken: 'dead-tok', userId: tom.id, expires: new Date(Date.now() - 60_000) },
      });
      expect((await getUserBySessionToken('live-tok', prisma))?.id).toBe(tom.id);
      expect(await getUserBySessionToken('dead-tok', prisma)).toBeNull();
      expect(await getUserBySessionToken('nope', prisma)).toBeNull();
    });
  });
});

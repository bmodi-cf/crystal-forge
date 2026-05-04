// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { withCleanDb } from '@/lib/test/db';
import { provisionFromEntra, getSessionUserById } from './users';

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
  it('returns the user with groups[] and isAdmin populated', async () => {
    await withCleanDb(async (prisma) => {
      const user = await prisma.user.create({
        data: { email: 'maya@x.com', name: 'Maya', initials: 'M' },
      });
      const eng = await prisma.group.create({ data: { name: 'Engineering' } });
      await prisma.userGroup.create({ data: { userId: user.id, groupId: eng.id } });
      await prisma.userRole.create({ data: { userId: user.id, role: 'admin' } });

      const session = await getSessionUserById(user.id);
      expect(session?.groups).toEqual(['Engineering']);
      expect(session?.isAdmin).toBe(true);
    });
  });

  it('returns null for unknown id', async () => {
    await withCleanDb(async () => {
      const session = await getSessionUserById('00000000-0000-0000-0000-000000000000');
      expect(session).toBeNull();
    });
  });
});

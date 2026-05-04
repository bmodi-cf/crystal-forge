// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import { listForges, getForge } from './forges';
import { ForbiddenError, NotFoundError } from '@/lib/errors';

describe('listForges', () => {
  it('returns only Forges whose groups overlap with the user', async () => {
    await withCleanDb(async (prisma) => {
      const tom   = await makeUser(prisma, { email: 't@x', name: 'Tom Reed',   groups: ['Operations'] });
      const maya  = await makeUser(prisma, { email: 'm@x', name: 'Maya Chen',  groups: ['Engineering'] });
      await makeForge(prisma, { name: 'Aquaflow', createdById: tom.id, groups: ['Engineering'] });
      await makeForge(prisma, { name: 'Site Survey', createdById: tom.id, groups: ['Operations'] });
      await makeForge(prisma, { name: 'BrandKit', createdById: tom.id, groups: ['Marketing'] });

      const tomList  = await listForges(tom);
      const mayaList = await listForges(maya);
      expect(tomList.map((f) => f.name).sort()).toEqual(['Site Survey']);
      expect(mayaList.map((f) => f.name).sort()).toEqual(['Aquaflow']);
    });
  });

  it('admin sees every Forge', async () => {
    await withCleanDb(async (prisma) => {
      const tom   = await makeUser(prisma, { email: 't@x', name: 'Tom Reed', groups: [] });
      const admin = await makeUser(prisma, { email: 'a@x', name: 'Admin',    groups: [], isAdmin: true });
      await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await makeForge(prisma, { name: 'B', createdById: tom.id, groups: ['Sales'] });

      const list = await listForges(admin);
      expect(list.map((f) => f.name).sort()).toEqual(['A', 'B']);
    });
  });

  it('returns empty list for a user in zero groups (and not admin)', async () => {
    await withCleanDb(async (prisma) => {
      const u   = await makeUser(prisma, { email: 'x@x', name: 'X', groups: [] });
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      const list = await listForges(u);
      expect(list).toEqual([]);
    });
  });
});

describe('getForge', () => {
  it('returns the Forge if user can read it', async () => {
    await withCleanDb(async (prisma) => {
      const tom  = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const maya = await makeUser(prisma, { email: 'm@x', name: 'Maya', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'Aquaflow', createdById: tom.id, groups: ['Engineering'] });
      const result = await getForge(maya, forge.id);
      expect(result.name).toBe('Aquaflow');
      expect(result.groups).toEqual(['Engineering']);
    });
  });

  it('throws ForbiddenError if user cannot read it', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const stranger = await makeUser(prisma, { email: 's@x', name: 'S', groups: ['Sales'] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await expect(getForge(stranger, forge.id)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('throws NotFoundError if id does not exist', async () => {
    await withCleanDb(async (prisma) => {
      const u = await makeUser(prisma, { email: 'u@x', name: 'U', groups: [] });
      await expect(getForge(u, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

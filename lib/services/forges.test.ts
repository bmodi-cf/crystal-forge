// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import { listForges, getForge, createForge, updateForge, deleteForge } from './forges';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';

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

describe('createForge', () => {
  it('creates a Forge with derived initials, default status=draft and tone=navy', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom Reed', groups: ['Engineering'] });
      await prisma.group.create({ data: { name: 'Engineering' } }).catch(() => {}); // makeUser already created it

      const forge = await createForge(tom, {
        name: 'Aquaflow Designer',
        description: 'Hydraulics tool',
        groups: ['Engineering'],
      });

      expect(forge.name).toBe('Aquaflow Designer');
      expect(forge.initials).toBe('AD');
      expect(forge.status).toBe('draft');
      expect(forge.tone).toBe('navy');
      expect(forge.groups).toEqual(['Engineering']);
      expect(forge.createdBy.id).toBe(tom.id);
    });
  });

  it('persists the join rows so the forge appears in listForges for group members', async () => {
    await withCleanDb(async (prisma) => {
      const tom  = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const maya = await makeUser(prisma, { email: 'm@x', name: 'Maya', groups: ['Engineering'] });
      await createForge(tom, { name: 'A', description: '', groups: ['Engineering'] });
      const list = await listForges(maya);
      expect(list.map((f) => f.name)).toEqual(['A']);
    });
  });

  it('throws ValidationError if any group name is unknown', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      await expect(
        createForge(tom, { name: 'X', description: '', groups: ['NoSuchGroup'] }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});

describe('updateForge', () => {
  it('creator can update name, description and groups', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      await prisma.group.create({ data: { name: 'Operations' } });
      const forge = await makeForge(prisma, { name: 'Old', createdById: tom.id, groups: ['Engineering'] });
      const updated = await updateForge(tom, forge.id, {
        name: 'New',
        description: 'desc',
        groups: ['Operations'],
      });
      expect(updated.name).toBe('New');
      expect(updated.description).toBe('desc');
      expect(updated.groups).toEqual(['Operations']);
    });
  });

  it('admin can update any forge', async () => {
    await withCleanDb(async (prisma) => {
      const tom   = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const admin = await makeUser(prisma, { email: 'a@x', name: 'Admin', groups: [], isAdmin: true });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      const updated = await updateForge(admin, forge.id, { name: 'A2' });
      expect(updated.name).toBe('A2');
    });
  });

  it('group member who is not creator/admin cannot update', async () => {
    await withCleanDb(async (prisma) => {
      const tom  = await makeUser(prisma, { email: 't@x', name: 'Tom',  groups: ['Engineering'] });
      const maya = await makeUser(prisma, { email: 'm@x', name: 'Maya', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await expect(updateForge(maya, forge.id, { name: 'X' })).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('non-member cannot update', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const stranger = await makeUser(prisma, { email: 's@x', name: 'S', groups: ['Sales'] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await expect(updateForge(stranger, forge.id, { name: 'X' })).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('throws NotFoundError when the id does not exist', async () => {
    await withCleanDb(async (prisma) => {
      const u = await makeUser(prisma, { email: 'u@x', name: 'U', groups: [] });
      await expect(
        updateForge(u, '00000000-0000-0000-0000-000000000000', { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('throws ValidationError when an unknown group is supplied', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await expect(
        updateForge(tom, forge.id, { groups: ['Engineering', 'Imaginary'] }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});

describe('deleteForge', () => {
  it('creator can delete', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await deleteForge(tom, forge.id);
      const remaining = await prisma.forge.findUnique({ where: { id: forge.id } });
      expect(remaining).toBeNull();
    });
  });

  it('admin can delete a forge they did not create', async () => {
    await withCleanDb(async (prisma) => {
      const tom   = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const admin = await makeUser(prisma, { email: 'a@x', name: 'Admin', groups: [], isAdmin: true });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await deleteForge(admin, forge.id);
      const remaining = await prisma.forge.findUnique({ where: { id: forge.id } });
      expect(remaining).toBeNull();
    });
  });

  it('group member who is not creator/admin cannot delete', async () => {
    await withCleanDb(async (prisma) => {
      const tom  = await makeUser(prisma, { email: 't@x', name: 'Tom',  groups: ['Engineering'] });
      const maya = await makeUser(prisma, { email: 'm@x', name: 'Maya', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await expect(deleteForge(maya, forge.id)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('non-member cannot delete', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const stranger = await makeUser(prisma, { email: 's@x', name: 'S', groups: ['Sales'] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await expect(deleteForge(stranger, forge.id)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('cascades forge_groups rows when a forge is deleted', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering', 'Operations'] });
      await deleteForge(tom, forge.id);
      const fgRows = await prisma.forgeGroup.findMany({ where: { forgeId: forge.id } });
      expect(fgRows).toEqual([]);
    });
  });

  it('throws NotFoundError when the id does not exist', async () => {
    await withCleanDb(async (prisma) => {
      const u = await makeUser(prisma, { email: 'u@x', name: 'U', groups: [] });
      await expect(
        deleteForge(u, '00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

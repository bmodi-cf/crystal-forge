// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import { FakeGitHubClient } from '@/lib/github/fake-client';
import { listForges, getForge, createForge, updateForge, deleteForge } from './forges';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';

let fake: FakeGitHubClient;

beforeEach(() => {
  fake = new FakeGitHubClient({ owner: 'test-owner', baseUrl: 'https://github.com' });
});

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

  it('exposes repoFullName and repoUrl on the DTO', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      await makeForge(prisma, {
        name: 'Aquaflow',
        createdById: tom.id,
        groups: ['Engineering'],
        repoFullName: 'test-owner/aquaflow',
      });
      const [f] = await listForges(tom);
      expect(f.repoFullName).toBe('test-owner/aquaflow');
      expect(f.repoUrl).toMatch(/\/test-owner\/aquaflow$/);
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
  it('creates a Forge AND a GitHub repo, with derived initials and defaults', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom Reed', groups: ['Engineering'] });

      const forge = await createForge(
        tom,
        { name: 'Aquaflow Designer', description: 'Hydraulics tool', groups: ['Engineering'] },
        fake,
      );

      expect(forge.name).toBe('Aquaflow Designer');
      expect(forge.initials).toBe('AD');
      expect(forge.status).toBe('draft');
      expect(forge.tone).toBe('navy');
      expect(forge.groups).toEqual(['Engineering']);
      expect(forge.repoFullName).toBe('test-owner/aquaflow-designer');
      expect(forge.createdBy.id).toBe(tom.id);
      // Repo recorded in the fake.
      expect(fake.getRepo('test-owner/aquaflow-designer')?.private).toBe(true);
    });
  });

  it('persists join rows so the forge appears in listForges for group members', async () => {
    await withCleanDb(async (prisma) => {
      const tom  = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const maya = await makeUser(prisma, { email: 'm@x', name: 'Maya', groups: ['Engineering'] });
      await createForge(tom, { name: 'A', description: '', groups: ['Engineering'] }, fake);
      const list = await listForges(maya);
      expect(list.map((f) => f.name)).toEqual(['A']);
    });
  });

  it('throws ValidationError if any group is unknown — and does NOT create a GitHub repo', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      await expect(
        createForge(tom, { name: 'X', description: '', groups: ['NoSuch'] }, fake),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(fake.listRepos()).toHaveLength(0);
    });
  });

  it('throws ValidationError if name is already in use — and does NOT create a GitHub repo', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      await createForge(tom, { name: 'Dup', description: '', groups: ['Engineering'] }, fake);
      await expect(
        createForge(tom, { name: 'Dup', description: '', groups: ['Engineering'] }, fake),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(fake.listRepos()).toHaveLength(1);
    });
  });

  it('propagates GitHub create failure and does NOT insert a Forge row', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      fake.failNextCall('createRepoFromTemplate', new Error('boom'));
      await expect(
        createForge(tom, { name: 'A', description: '', groups: ['Engineering'] }, fake),
      ).rejects.toThrow('boom');
      const rows = await prisma.forge.findMany();
      expect(rows).toHaveLength(0);
      expect(fake.listRepos()).toHaveLength(0);
    });
  });

  it('compensates by deleting the just-created repo when the DB insert fails', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      // Pre-create a Forge row holding the slug we'll collide on, by-passing
      // the unique-name pre-check. Insert directly so the unique-index trips
      // INSIDE the transaction (simulating a race).
      await makeForge(prisma, {
        name: 'Race Winner',
        createdById: tom.id,
        groups: ['Engineering'],
        repoFullName: 'test-owner/aquaflow', // repo slug we'll compete for
      });
      // Pre-seed the fake with that slug, so the second create finds it free
      // (different forge name, same slug → fake will let it through, then DB
      // collides on repoFullName unique index).
      await expect(
        createForge(
          tom,
          { name: 'Aquaflow', description: '', groups: ['Engineering'] },
          fake,
        ),
      ).rejects.toThrow();
      // Compensating delete must have removed the repo from the fake.
      expect(fake.getRepo('test-owner/aquaflow')).toBeUndefined();
      // No new Forge row exists with that name.
      const rows = await prisma.forge.findMany({ where: { name: 'Aquaflow' } });
      expect(rows).toHaveLength(0);
    });
  });
});

describe('updateForge', () => {
  it('creator can update description and groups', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      await prisma.group.create({ data: { name: 'Operations' } });
      const forge = await makeForge(prisma, { name: 'Old', createdById: tom.id, groups: ['Engineering'] });
      const updated = await updateForge(tom, forge.id, {
        description: 'desc',
        groups: ['Operations'],
      });
      expect(updated.description).toBe('desc');
      expect(updated.groups).toEqual(['Operations']);
    });
  });

  it('admin can update any forge', async () => {
    await withCleanDb(async (prisma) => {
      const tom   = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const admin = await makeUser(prisma, { email: 'a@x', name: 'Admin', groups: [], isAdmin: true });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      const updated = await updateForge(admin, forge.id, { description: 'A2' });
      expect(updated.description).toBe('A2');
    });
  });

  it('group member who is not creator/admin cannot update', async () => {
    await withCleanDb(async (prisma) => {
      const tom  = await makeUser(prisma, { email: 't@x', name: 'Tom',  groups: ['Engineering'] });
      const maya = await makeUser(prisma, { email: 'm@x', name: 'Maya', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await expect(updateForge(maya, forge.id, { description: 'X' })).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('non-member cannot update', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const stranger = await makeUser(prisma, { email: 's@x', name: 'S', groups: ['Sales'] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await expect(updateForge(stranger, forge.id, { description: 'X' })).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('throws NotFoundError when the id does not exist', async () => {
    await withCleanDb(async (prisma) => {
      const u = await makeUser(prisma, { email: 'u@x', name: 'U', groups: [] });
      await expect(
        updateForge(u, '00000000-0000-0000-0000-000000000000', { description: 'X' }),
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
  it('creator can delete; archive is called on the GitHub repo', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const forge = await makeForge(prisma, {
        name: 'A',
        createdById: tom.id,
        groups: ['Engineering'],
        repoFullName: 'test-owner/a',
      });
      // Pre-record the repo on the fake so we can observe archive.
      await fake.createRepoFromTemplate({ name: 'a', description: null, private: true });
      await deleteForge(tom, forge.id, fake);
      const remaining = await prisma.forge.findUnique({ where: { id: forge.id } });
      expect(remaining).toBeNull();
      expect(fake.getRepo('test-owner/a')?.archived).toBe(true);
    });
  });

  it('admin can delete a forge they did not create', async () => {
    await withCleanDb(async (prisma) => {
      const tom   = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const admin = await makeUser(prisma, { email: 'a@x', name: 'Admin', groups: [], isAdmin: true });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await deleteForge(admin, forge.id, fake);
      const remaining = await prisma.forge.findUnique({ where: { id: forge.id } });
      expect(remaining).toBeNull();
    });
  });

  it('group member who is not creator/admin cannot delete', async () => {
    await withCleanDb(async (prisma) => {
      const tom  = await makeUser(prisma, { email: 't@x', name: 'Tom',  groups: ['Engineering'] });
      const maya = await makeUser(prisma, { email: 'm@x', name: 'Maya', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await expect(deleteForge(maya, forge.id, fake)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('non-member cannot delete', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const stranger = await makeUser(prisma, { email: 's@x', name: 'S', groups: ['Sales'] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      await expect(deleteForge(stranger, forge.id, fake)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('cascades forge_groups rows when a forge is deleted', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering', 'Operations'] });
      await deleteForge(tom, forge.id, fake);
      const fgRows = await prisma.forgeGroup.findMany({ where: { forgeId: forge.id } });
      expect(fgRows).toEqual([]);
    });
  });

  it('throws NotFoundError when the id does not exist', async () => {
    await withCleanDb(async (prisma) => {
      const u = await makeUser(prisma, { email: 'u@x', name: 'U', groups: [] });
      await expect(
        deleteForge(u, '00000000-0000-0000-0000-000000000000', fake),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('aborts and preserves the DB row when archive throws', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      const forge = await makeForge(prisma, { name: 'A', createdById: tom.id, groups: ['Engineering'] });
      fake.failNextCall('archiveRepo', new Error('archive failed'));
      await expect(deleteForge(tom, forge.id, fake)).rejects.toThrow('archive failed');
      const remaining = await prisma.forge.findUnique({ where: { id: forge.id } });
      expect(remaining).not.toBeNull();
    });
  });
});

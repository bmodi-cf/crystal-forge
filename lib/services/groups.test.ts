// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import {
  listGroups,
  listGroupsForAdmin,
  getGroupDetail,
  createGroup,
  renameGroup,
  deleteGroup,
  addMember,
  removeMember,
} from './groups';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';

const MISSING_ID = '00000000-0000-0000-0000-000000000000';

describe('listGroups', () => {
  it('returns every group, alphabetically by name', async () => {
    await withCleanDb(async (prisma) => {
      await prisma.group.createMany({
        data: [{ name: 'Sales' }, { name: 'Engineering' }, { name: 'Marketing' }],
      });
      const groups = await listGroups();
      expect(groups.map((g) => g.name)).toEqual(['Engineering', 'Marketing', 'Sales']);
      expect(groups[0]).toMatchObject({ id: expect.any(String), name: 'Engineering' });
    });
  });

  it('returns an empty array when no groups exist', async () => {
    await withCleanDb(async () => {
      expect(await listGroups()).toEqual([]);
    });
  });
});

describe('listGroupsForAdmin', () => {
  it('returns groups with member and forge counts, ordered by name', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const alice = await makeUser(prisma, { email: 'alice@x.com', name: 'Alice', groups: ['Sales'] });
      await makeUser(prisma, { email: 'bob@x.com', name: 'Bob', groups: ['Sales'] });
      await prisma.group.create({ data: { name: 'Engineering' } });
      await makeForge(prisma, { name: 'Forge One', createdById: alice.id, groups: ['Sales'] });

      const rows = await listGroupsForAdmin(admin);
      expect(rows.map((r) => r.name)).toEqual(['Engineering', 'Sales']);
      const sales = rows.find((r) => r.name === 'Sales')!;
      expect(sales).toMatchObject({ memberCount: 2, forgeCount: 1 });
      const eng = rows.find((r) => r.name === 'Engineering')!;
      expect(eng).toMatchObject({ memberCount: 0, forgeCount: 0 });
    });
  });

  it('rejects a non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'Dev', role: 'DEVELOPER' });
      await expect(listGroupsForAdmin(dev)).rejects.toThrow(ForbiddenError);
    });
  });
});

describe('getGroupDetail', () => {
  it('returns the group with members ordered by name', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      await makeUser(prisma, { email: 'zoe@x.com', name: 'Zoe', groups: ['Sales'] });
      await makeUser(prisma, { email: 'amy@x.com', name: 'Amy', groups: ['Sales'] });
      const group = await prisma.group.findUniqueOrThrow({ where: { name: 'Sales' } });

      const detail = await getGroupDetail(admin, group.id);
      expect(detail).toMatchObject({ id: group.id, name: 'Sales', memberCount: 2, forgeCount: 0 });
      expect(detail.members.map((m) => m.name)).toEqual(['Amy', 'Zoe']);
      expect(detail.members[0]).toMatchObject({ id: expect.any(String), email: 'amy@x.com' });
    });
  });

  it('throws NotFoundError for an unknown group', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      await expect(getGroupDetail(admin, MISSING_ID)).rejects.toThrow(NotFoundError);
    });
  });

  it('rejects a non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'Dev', role: 'DEVELOPER' });
      const group = await prisma.group.create({ data: { name: 'Sales' } });
      await expect(getGroupDetail(dev, group.id)).rejects.toThrow(ForbiddenError);
    });
  });
});

describe('createGroup', () => {
  it('creates a group with a trimmed name', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const group = await createGroup(admin, '  Platform  ');
      expect(group.name).toBe('Platform');
      const persisted = await prisma.group.findUnique({ where: { name: 'Platform' } });
      expect(persisted).not.toBeNull();
    });
  });

  it('rejects an empty name', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      await expect(createGroup(admin, '   ')).rejects.toThrow(ValidationError);
    });
  });

  it('rejects a duplicate name with ValidationError (not a raw Prisma error)', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      await prisma.group.create({ data: { name: 'Sales' } });
      await expect(createGroup(admin, 'Sales')).rejects.toThrow(ValidationError);
    });
  });

  it('rejects a non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'Dev', role: 'DEVELOPER' });
      await expect(createGroup(dev, 'Sales')).rejects.toThrow(ForbiddenError);
    });
  });
});

describe('renameGroup', () => {
  it('renames a group', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const group = await prisma.group.create({ data: { name: 'Sales' } });
      const res = await renameGroup(admin, group.id, 'Revenue');
      expect(res.name).toBe('Revenue');
      expect((await prisma.group.findUnique({ where: { id: group.id } }))?.name).toBe('Revenue');
    });
  });

  it('is a no-op-safe when the name is unchanged', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const group = await prisma.group.create({ data: { name: 'Sales' } });
      const res = await renameGroup(admin, group.id, 'Sales');
      expect(res.name).toBe('Sales');
    });
  });

  it('rejects a duplicate name', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      await prisma.group.create({ data: { name: 'Engineering' } });
      const sales = await prisma.group.create({ data: { name: 'Sales' } });
      await expect(renameGroup(admin, sales.id, 'Engineering')).rejects.toThrow(ValidationError);
    });
  });

  it('rejects an empty name', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const group = await prisma.group.create({ data: { name: 'Sales' } });
      await expect(renameGroup(admin, group.id, '  ')).rejects.toThrow(ValidationError);
    });
  });

  it('throws NotFoundError for an unknown group', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      await expect(renameGroup(admin, MISSING_ID, 'X')).rejects.toThrow(NotFoundError);
    });
  });

  it('rejects a non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'Dev', role: 'DEVELOPER' });
      const group = await prisma.group.create({ data: { name: 'Sales' } });
      await expect(renameGroup(dev, group.id, 'X')).rejects.toThrow(ForbiddenError);
    });
  });
});

describe('deleteGroup', () => {
  it('deletes the group, returns pre-delete counts, and cascades memberships/forges', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const alice = await makeUser(prisma, { email: 'alice@x.com', name: 'Alice', groups: ['Sales'] });
      await makeUser(prisma, { email: 'bob@x.com', name: 'Bob', groups: ['Sales'] });
      await makeForge(prisma, { name: 'Forge One', createdById: alice.id, groups: ['Sales'] });
      const group = await prisma.group.findUniqueOrThrow({ where: { name: 'Sales' } });

      const res = await deleteGroup(admin, group.id);
      expect(res).toEqual({ memberCount: 2, forgeCount: 1 });
      expect(await prisma.group.findUnique({ where: { id: group.id } })).toBeNull();
      expect(await prisma.userGroup.count({ where: { groupId: group.id } })).toBe(0);
      expect(await prisma.forgeGroup.count({ where: { groupId: group.id } })).toBe(0);
    });
  });

  it('throws NotFoundError for an unknown group', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      await expect(deleteGroup(admin, MISSING_ID)).rejects.toThrow(NotFoundError);
    });
  });

  it('rejects a non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'Dev', role: 'DEVELOPER' });
      const group = await prisma.group.create({ data: { name: 'Sales' } });
      await expect(deleteGroup(dev, group.id)).rejects.toThrow(ForbiddenError);
    });
  });
});

describe('addMember', () => {
  it('adds a user to a group and returns the member', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const user = await makeUser(prisma, { email: 'u@x.com', name: 'Ursula' });
      const group = await prisma.group.create({ data: { name: 'Sales' } });

      const member = await addMember(admin, group.id, user.id);
      expect(member).toMatchObject({ id: user.id, name: 'Ursula', email: 'u@x.com' });
      expect(await prisma.userGroup.count({ where: { groupId: group.id, userId: user.id } })).toBe(1);
    });
  });

  it('is idempotent when the user is already a member', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const user = await makeUser(prisma, { email: 'u@x.com', name: 'Ursula', groups: ['Sales'] });
      const group = await prisma.group.findUniqueOrThrow({ where: { name: 'Sales' } });

      await addMember(admin, group.id, user.id);
      expect(await prisma.userGroup.count({ where: { groupId: group.id, userId: user.id } })).toBe(1);
    });
  });

  it('throws NotFoundError when the group is missing', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const user = await makeUser(prisma, { email: 'u@x.com', name: 'Ursula' });
      await expect(addMember(admin, MISSING_ID, user.id)).rejects.toThrow(NotFoundError);
    });
  });

  it('throws NotFoundError when the user is missing', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const group = await prisma.group.create({ data: { name: 'Sales' } });
      await expect(addMember(admin, group.id, MISSING_ID)).rejects.toThrow(NotFoundError);
    });
  });

  it('rejects a non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'Dev', role: 'DEVELOPER' });
      const user = await makeUser(prisma, { email: 'u@x.com', name: 'Ursula' });
      const group = await prisma.group.create({ data: { name: 'Sales' } });
      await expect(addMember(dev, group.id, user.id)).rejects.toThrow(ForbiddenError);
    });
  });
});

describe('removeMember', () => {
  it('removes a member', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const user = await makeUser(prisma, { email: 'u@x.com', name: 'Ursula', groups: ['Sales'] });
      const group = await prisma.group.findUniqueOrThrow({ where: { name: 'Sales' } });

      await removeMember(admin, group.id, user.id);
      expect(await prisma.userGroup.count({ where: { groupId: group.id, userId: user.id } })).toBe(0);
    });
  });

  it('is a no-op when the user is not a member', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const user = await makeUser(prisma, { email: 'u@x.com', name: 'Ursula' });
      const group = await prisma.group.create({ data: { name: 'Sales' } });
      await expect(removeMember(admin, group.id, user.id)).resolves.not.toThrow();
    });
  });

  it('throws NotFoundError when the group is missing', async () => {
    await withCleanDb(async (prisma) => {
      const admin = await makeUser(prisma, { email: 'a@x.com', name: 'Admin', role: 'ADMIN' });
      const user = await makeUser(prisma, { email: 'u@x.com', name: 'Ursula' });
      await expect(removeMember(admin, MISSING_ID, user.id)).rejects.toThrow(NotFoundError);
    });
  });

  it('rejects a non-admin', async () => {
    await withCleanDb(async (prisma) => {
      const dev = await makeUser(prisma, { email: 'd@x.com', name: 'Dev', role: 'DEVELOPER' });
      const user = await makeUser(prisma, { email: 'u@x.com', name: 'Ursula', groups: ['Sales'] });
      const group = await prisma.group.findUniqueOrThrow({ where: { name: 'Sales' } });
      await expect(removeMember(dev, group.id, user.id)).rejects.toThrow(ForbiddenError);
    });
  });
});

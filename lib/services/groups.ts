import { prisma } from '@/lib/prisma';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import type { SessionUser } from './types';

export type GroupDto = { id: string; name: string };

export type GroupSummary = {
  id: string;
  name: string;
  memberCount: number;
  forgeCount: number;
};

export type GroupMember = { id: string; name: string; email: string };

export type GroupDetail = GroupSummary & { members: GroupMember[] };

/**
 * Every group, alphabetically. Feeds the forge-edit group picker and the
 * dashboard — unrelated to admin management, so no admin guard.
 */
export async function listGroups(): Promise<GroupDto[]> {
  const rows = await prisma.group.findMany({ orderBy: { name: 'asc' } });
  return rows.map((g) => ({ id: g.id, name: g.name }));
}

function assertAdmin(currentUser: SessionUser): void {
  if (!currentUser.isAdmin) throw new ForbiddenError('Admin only');
}

/**
 * Normalize + validate a group name. Throws ValidationError on empty input so
 * the API surfaces a clean 400.
 */
function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new ValidationError('Group name is required', { name: ['Name is required'] });
  }
  return trimmed;
}

/**
 * Reject a name already taken by a *different* group. Checked before
 * insert/update so a duplicate returns ValidationError rather than a raw
 * Prisma P2002 unique-constraint throw.
 */
async function assertNameAvailable(name: string, exceptGroupId?: string): Promise<void> {
  const existing = await prisma.group.findUnique({ where: { name }, select: { id: true } });
  if (existing && existing.id !== exceptGroupId) {
    throw new ValidationError('A group with that name already exists', {
      name: ['A group with that name already exists'],
    });
  }
}

export async function listGroupsForAdmin(currentUser: SessionUser): Promise<GroupSummary[]> {
  assertAdmin(currentUser);
  const rows = await prisma.group.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, _count: { select: { members: true, forges: true } } },
  });
  return rows.map((g) => ({
    id: g.id,
    name: g.name,
    memberCount: g._count.members,
    forgeCount: g._count.forges,
  }));
}

export async function getGroupDetail(
  currentUser: SessionUser,
  groupId: string,
): Promise<GroupDetail> {
  assertAdmin(currentUser);
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: {
      id: true,
      name: true,
      _count: { select: { members: true, forges: true } },
      members: {
        orderBy: { user: { name: 'asc' } },
        select: { user: { select: { id: true, name: true, email: true } } },
      },
    },
  });
  if (!group) throw new NotFoundError('Group', groupId);
  return {
    id: group.id,
    name: group.name,
    memberCount: group._count.members,
    forgeCount: group._count.forges,
    members: group.members.map((m) => m.user),
  };
}

export async function createGroup(
  currentUser: SessionUser,
  name: string,
): Promise<{ id: string; name: string }> {
  assertAdmin(currentUser);
  const trimmed = normalizeName(name);
  await assertNameAvailable(trimmed);
  return prisma.group.create({ data: { name: trimmed }, select: { id: true, name: true } });
}

export async function renameGroup(
  currentUser: SessionUser,
  groupId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  assertAdmin(currentUser);
  const trimmed = normalizeName(name);
  const existing = await prisma.group.findUnique({ where: { id: groupId }, select: { id: true } });
  if (!existing) throw new NotFoundError('Group', groupId);
  await assertNameAvailable(trimmed, groupId);
  return prisma.group.update({
    where: { id: groupId },
    data: { name: trimmed },
    select: { id: true, name: true },
  });
}

export async function deleteGroup(
  currentUser: SessionUser,
  groupId: string,
): Promise<{ memberCount: number; forgeCount: number }> {
  assertAdmin(currentUser);
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: { id: true, _count: { select: { members: true, forges: true } } },
  });
  if (!group) throw new NotFoundError('Group', groupId);
  // DB cascade (UserGroup/ForgeGroup onDelete: Cascade) removes memberships.
  await prisma.group.delete({ where: { id: groupId } });
  return { memberCount: group._count.members, forgeCount: group._count.forges };
}

export async function addMember(
  currentUser: SessionUser,
  groupId: string,
  userId: string,
): Promise<GroupMember> {
  assertAdmin(currentUser);
  const group = await prisma.group.findUnique({ where: { id: groupId }, select: { id: true } });
  if (!group) throw new NotFoundError('Group', groupId);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true },
  });
  if (!user) throw new NotFoundError('User', userId);
  // Idempotent: a double-click or stale UI must not 500 on a duplicate PK.
  await prisma.userGroup.upsert({
    where: { userId_groupId: { userId, groupId } },
    create: { userId, groupId },
    update: {},
  });
  return user;
}

export async function removeMember(
  currentUser: SessionUser,
  groupId: string,
  userId: string,
): Promise<void> {
  assertAdmin(currentUser);
  const group = await prisma.group.findUnique({ where: { id: groupId }, select: { id: true } });
  if (!group) throw new NotFoundError('Group', groupId);
  // Idempotent: no error if the row is already gone.
  await prisma.userGroup.deleteMany({ where: { userId, groupId } });
}

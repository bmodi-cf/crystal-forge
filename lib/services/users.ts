import { Role, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import type { SessionUser } from './types';

const ROLE_VALUES: Role[] = ['ADMIN', 'DEVELOPER', 'DEFAULT_USER'];

export function computeInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]!)
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'U';
}

export async function provisionFromEntra(input: {
  entraOid: string;
  email: string;
  name: string;
}): Promise<{ id: string; email: string; name: string; initials: string }> {
  const initials = computeInitials(input.name);
  const user = await prisma.user.upsert({
    where: { entraOid: input.entraOid },
    create: {
      entraOid: input.entraOid,
      email: input.email,
      name: input.name,
      initials,
    },
    update: {
      email: input.email,
      name: input.name,
      initials,
    },
  });
  return { id: user.id, email: user.email, name: user.name, initials: user.initials };
}

export async function getSessionUserById(id: string): Promise<SessionUser | null> {
  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      groups: { include: { group: true } },
    },
  });
  if (!user) return null;
  return {
    id: user.id,
    entraOid: user.entraOid,
    email: user.email,
    name: user.name,
    initials: user.initials,
    groups: user.groups.map((ug) => ug.group.name),
    role: user.role,
    isAdmin: user.role === 'ADMIN',
  };
}

export async function getSessionUserByEmail(email: string): Promise<SessionUser | null> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return null;
  return getSessionUserById(user.id);
}

/**
 * Resolve the SessionUser for an Auth.js database-session token, or null if the
 * token is unknown or expired. Used to authenticate raw WebSocket upgrades,
 * which have no Next request context for `auth()`.
 */
export async function getUserBySessionToken(
  sessionToken: string,
  client: PrismaClient = prisma,
): Promise<SessionUser | null> {
  const session = await client.session.findUnique({ where: { sessionToken } });
  if (!session || session.expires <= new Date()) return null;
  return getSessionUserById(session.userId);
}

export async function listUsersForAdmin(
  currentUser: SessionUser,
): Promise<{ id: string; name: string; email: string; role: Role }[]> {
  if (!currentUser.isAdmin) throw new ForbiddenError('Admin only');
  return prisma.user.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, email: true, role: true },
  });
}

export async function setUserRole(
  currentUser: SessionUser,
  targetUserId: string,
  role: Role,
): Promise<{ id: string; role: Role }> {
  if (!currentUser.isAdmin) throw new ForbiddenError('Admin only');
  if (targetUserId === currentUser.id) {
    throw new ForbiddenError('You cannot change your own role');
  }
  if (!ROLE_VALUES.includes(role)) {
    throw new ValidationError('Unknown role', {
      role: [`Must be one of ${ROLE_VALUES.join(', ')}`],
    });
  }
  const existing = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError('User', targetUserId);
  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: { role },
    select: { id: true, role: true },
  });
  return updated;
}

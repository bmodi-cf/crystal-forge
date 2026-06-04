import type { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from './types';

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
      roles: true,
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
    isAdmin: user.roles.some((r) => r.role === 'admin'),
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

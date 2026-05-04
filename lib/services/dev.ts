import { prisma } from '@/lib/prisma';
import { randomBytes } from 'node:crypto';

export async function devCreateSessionForEmail(
  email: string
): Promise<{ sessionToken: string; expires: Date } | null> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return null;
  const sessionToken = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await prisma.session.create({ data: { sessionToken, userId: user.id, expires } });
  return { sessionToken, expires };
}

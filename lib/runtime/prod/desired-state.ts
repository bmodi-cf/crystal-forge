import type { PrismaClient } from '@prisma/client';
import { slugifyForgeName, slugToDbName, dbNameToRole } from '@/lib/github/slug';

export type DesiredForge = {
  forgeId: string;
  name: string;
  slug: string;
  deployVersion: string;
  dbName: string;
  role: string;
};

/**
 * The declarative desired state: every forge the admin has enabled for prod
 * (`deployEnabled`) and pinned to a version (`deployVersion`). slug/dbName/role
 * are derived the same way the dev runtime derives them.
 */
export async function listDesiredForges(prisma: PrismaClient): Promise<DesiredForge[]> {
  const rows = await prisma.forge.findMany({
    where: { deployEnabled: true, deployVersion: { not: null } },
    select: { id: true, name: true, deployVersion: true },
  });
  return rows.map((r) => {
    const slug = slugifyForgeName(r.name);
    const dbName = slugToDbName(slug);
    return {
      forgeId: r.id,
      name: r.name,
      slug,
      deployVersion: r.deployVersion as string,
      dbName,
      role: dbNameToRole(dbName),
    };
  });
}

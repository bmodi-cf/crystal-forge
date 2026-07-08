// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import { listDesiredForges } from './desired-state';

describe('listDesiredForges', () => {
  it('returns only enabled forges that have a pinned version, with derived slug/dbName/role', async () => {
    await withCleanDb(async (prisma) => {
      const user = await makeUser(prisma, { email: 'a@x.com', name: 'Admin' });
      await makeForge(prisma, { name: 'Acme Portal', createdById: user.id, deployEnabled: true, deployVersion: 'v1.2.3' });
      await makeForge(prisma, { name: 'Disabled One', createdById: user.id, deployEnabled: false, deployVersion: 'v1.0.0' });
      await makeForge(prisma, { name: 'No Version', createdById: user.id, deployEnabled: true, deployVersion: null });

      const desired = await listDesiredForges(prisma);

      expect(desired).toHaveLength(1);
      expect(desired[0]).toMatchObject({
        name: 'Acme Portal',
        slug: 'acme-portal',
        deployVersion: 'v1.2.3',
      });
      // dbName + role are derived and non-empty.
      expect(desired[0].dbName.length).toBeGreaterThan(0);
      expect(desired[0].role.length).toBeGreaterThan(0);
    });
  });
});

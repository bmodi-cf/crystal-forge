// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { withCleanDb } from '@/lib/test/db';
import { listGroups } from './groups';

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

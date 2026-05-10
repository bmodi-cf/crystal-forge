// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { withCleanDb, makeUser, makeForge } from '@/lib/test/db';
import {
  listConversations, createConversation, getConversation,
  appendMessage, setClaudeSessionId, maybeBackfillTitle,
} from './conversations';
import { ForbiddenError, NotFoundError } from '@/lib/errors';

describe('conversations service', () => {
  it('createConversation requires write access', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const intruder = await makeUser(prisma, { email: 'i@x', name: 'I', groups: [] });
      const forge = await makeForge(prisma, { name: 'F', createdById: tom.id, groups: ['Engineering'] });
      await expect(createConversation(intruder, forge.id)).rejects.toBeInstanceOf(ForbiddenError);
      const conv = await createConversation(tom, forge.id);
      expect(conv.title).toBe('New conversation');
      expect(conv.hasClaudeSessionId).toBe(false);
    });
  });

  it('listConversations is gated by canReadForge and ordered by updatedAt desc', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const reader = await makeUser(prisma, { email: 'r@x', name: 'R', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'F', createdById: tom.id, groups: ['Engineering'] });
      const a = await createConversation(tom, forge.id);
      await new Promise((r) => setTimeout(r, 5));
      const b = await createConversation(tom, forge.id);
      const list = await listConversations(reader, forge.id);
      expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
    });
  });

  it('getConversation returns full message history', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'F', createdById: tom.id, groups: ['Engineering'] });
      const conv = await createConversation(tom, forge.id);
      await appendMessage(conv.id, { role: 'user', content: [{ type: 'text', text: 'hi' }] });
      await appendMessage(conv.id, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] });
      const got = await getConversation(tom, conv.id);
      expect(got.messages).toHaveLength(2);
      expect(got.messages[0]?.role).toBe('user');
      expect(got.messages[1]?.role).toBe('assistant');
    });
  });

  it('appendMessage backfills title from first user message', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'F', createdById: tom.id, groups: ['Engineering'] });
      const conv = await createConversation(tom, forge.id);
      await appendMessage(conv.id, { role: 'user', content: [{ type: 'text', text: 'Add a quote builder for line items' }] });
      const got = await getConversation(tom, conv.id);
      expect(got.title).toBe('Add a quote builder for line items');
    });
  });

  it('appendMessage truncates very long titles to 80 chars', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'F', createdById: tom.id, groups: ['Engineering'] });
      const conv = await createConversation(tom, forge.id);
      const long = 'A'.repeat(200);
      await appendMessage(conv.id, { role: 'user', content: [{ type: 'text', text: long }] });
      const got = await getConversation(tom, conv.id);
      expect(got.title.length).toBeLessThanOrEqual(80);
    });
  });

  it('setClaudeSessionId is idempotent — only first write wins', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'F', createdById: tom.id, groups: ['Engineering'] });
      const conv = await createConversation(tom, forge.id);
      const id1 = '00000000-0000-0000-0000-000000000001';
      const id2 = '00000000-0000-0000-0000-000000000002';
      await setClaudeSessionId(conv.id, id1);
      await setClaudeSessionId(conv.id, id2);
      const got = await getConversation(tom, conv.id);
      expect(got.hasClaudeSessionId).toBe(true);
      // Direct DB peek to confirm id1 stuck.
      const row = await prisma.conversation.findUnique({ where: { id: conv.id } });
      expect(row?.claudeSessionId).toBe(id1);
    });
  });

  it('getConversation throws NotFound on unknown id', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: [] });
      await expect(getConversation(tom, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('maybeBackfillTitle is a no-op when title is already custom', async () => {
    await withCleanDb(async (prisma) => {
      const tom = await makeUser(prisma, { email: 't@x', name: 'Tom', groups: ['Engineering'] });
      const forge = await makeForge(prisma, { name: 'F', createdById: tom.id, groups: ['Engineering'] });
      const conv = await createConversation(tom, forge.id);
      await prisma.conversation.update({ where: { id: conv.id }, data: { title: 'Custom title' } });
      await appendMessage(conv.id, { role: 'user', content: [{ type: 'text', text: 'should not overwrite' }] });
      const got = await getConversation(tom, conv.id);
      expect(got.title).toBe('Custom title');
    });
  });
});

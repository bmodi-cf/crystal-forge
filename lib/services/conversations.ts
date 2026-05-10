import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canReadForge, canWriteForge } from '@/lib/acl';
import { ForbiddenError, NotFoundError } from '@/lib/errors';
import type { SessionUser } from './types';

const TITLE_MAX = 80;
const DEFAULT_TITLE = 'New conversation';

export type ConversationDto = {
  id: string;
  forgeId: string;
  createdBy: { id: string; name: string };
  title: string;
  hasClaudeSessionId: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ConversationWithMessagesDto = ConversationDto & {
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: unknown;
    createdAt: string;
  }>;
};

const conversationInclude = {
  createdBy: { select: { id: true, name: true } },
} as const satisfies Prisma.ConversationInclude;

type ConversationRow = Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>;

function toDto(row: ConversationRow): ConversationDto {
  return {
    id: row.id,
    forgeId: row.forgeId,
    createdBy: { id: row.createdBy.id, name: row.createdBy.name },
    title: row.title,
    hasClaudeSessionId: row.claudeSessionId !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadForgeForAcl(forgeId: string) {
  const row = await prisma.forge.findUnique({
    where: { id: forgeId },
    include: { groups: { include: { group: true } } },
  });
  if (!row) throw new NotFoundError('forge', forgeId);
  return {
    id: row.id,
    createdById: row.createdById,
    groups: row.groups.map((fg) => fg.group.name),
  };
}

export async function listConversations(currentUser: SessionUser, forgeId: string): Promise<ConversationDto[]> {
  const acl = await loadForgeForAcl(forgeId);
  if (!canReadForge(currentUser, acl)) throw new ForbiddenError(`Cannot read forge ${forgeId}`);
  const rows = await prisma.conversation.findMany({
    where: { forgeId },
    include: conversationInclude,
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map(toDto);
}

export async function createConversation(currentUser: SessionUser, forgeId: string): Promise<ConversationDto> {
  const acl = await loadForgeForAcl(forgeId);
  if (!canWriteForge(currentUser, acl)) throw new ForbiddenError(`Cannot create conversation on forge ${forgeId}`);
  const row = await prisma.conversation.create({
    data: { forgeId, createdById: currentUser.id, title: DEFAULT_TITLE },
    include: conversationInclude,
  });
  return toDto(row);
}

export async function getConversation(currentUser: SessionUser, conversationId: string): Promise<ConversationWithMessagesDto> {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { ...conversationInclude, messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!row) throw new NotFoundError('conversation', conversationId);
  const acl = await loadForgeForAcl(row.forgeId);
  if (!canReadForge(currentUser, acl)) throw new ForbiddenError(`Cannot read conversation ${conversationId}`);
  return {
    ...toDto(row),
    messages: row.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

export async function assertCanConnect(
  currentUser: SessionUser,
  forgeId: string,
  conversationId: string,
): Promise<void> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { forge: { include: { groups: { include: { group: true } } } } },
  });
  if (!conv || conv.forgeId !== forgeId) throw new NotFoundError('conversation', conversationId);
  const acl = {
    id: conv.forge.id,
    createdById: conv.forge.createdById,
    groups: conv.forge.groups.map((fg) => fg.group.name),
  };
  if (!canWriteForge(currentUser, acl)) {
    throw new ForbiddenError(`Cannot connect to conversation ${conversationId}`);
  }
}

export async function appendMessage(
  conversationId: string,
  payload: { role: 'user' | 'assistant'; content: unknown; createdAt?: Date },
): Promise<void> {
  await prisma.message.create({
    data: {
      conversationId,
      role: payload.role,
      content: payload.content as Prisma.InputJsonValue,
      ...(payload.createdAt ? { createdAt: payload.createdAt } : {}),
    },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });
  if (payload.role === 'user') await maybeBackfillTitle(conversationId);
}

export async function setClaudeSessionId(conversationId: string, sessionId: string): Promise<void> {
  try {
    await prisma.conversation.update({
      where: { id: conversationId, claudeSessionId: null },
      data: { claudeSessionId: sessionId },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return;
    throw err;
  }
}

export async function maybeBackfillTitle(conversationId: string): Promise<void> {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { messages: { orderBy: { createdAt: 'asc' }, take: 1, where: { role: 'user' } } },
  });
  if (!row || row.title !== DEFAULT_TITLE) return;
  const first = row.messages[0];
  if (!first) return;
  const text = flattenContentText(first.content);
  if (!text) return;
  const truncated = text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1).trimEnd() + '…' : text;
  await prisma.conversation.update({ where: { id: conversationId }, data: { title: truncated } });
}

function flattenContentText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && 'type' in block && (block as { type: string }).type === 'text') {
      const text = (block as { text?: string }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join(' ').trim();
}

import type { ForgeStatus, ForgeTone, MessageRole } from '@prisma/client';

export type SessionUser = {
  id: string;
  entraOid: string | null;
  email: string;
  name: string;
  initials: string;
  groups: string[];
  isAdmin: boolean;
};

export type Forge = {
  id: string;
  name: string;
  description: string | null;
  status: ForgeStatus;
  tone: ForgeTone;
  initials: string;
  groups: string[];
  createdBy: { id: string; name: string };
  createdAt: string; // ISO
  updatedAt: string; // ISO
  repoFullName: string;
  repoUrl: string;
};

export type Conversation = {
  id: string;
  forgeId: string;
  title: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: unknown;
  createdAt: string;
};

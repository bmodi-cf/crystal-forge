import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { canEdit } from '@/lib/acl';
import { getForge, canCurrentUserWriteForge } from '@/lib/services/forges';
import { listConversations, createConversation } from '@/lib/services/conversations';
import { getRuntimeService } from '@/lib/services/runtime';
import { ForgePageClient } from './ForgePageClient';

export const dynamic = 'force-dynamic';

export default async function ForgePage(
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!canEdit(session.user)) redirect('/launch');
  const { id } = await params;
  let forge: Awaited<ReturnType<typeof getForge>>;
  try { forge = await getForge(session.user, id); } catch { notFound(); }

  const [runtime, conversations, canWrite] = await Promise.all([
    getRuntimeService().getRuntime(session.user, forge.id),
    listConversations(session.user, forge.id),
    canCurrentUserWriteForge(session.user, forge.id),
  ]);

  async function onCreateConversation() {
    'use server';
    const me = await auth();
    if (!me?.user) throw new Error('Unauthorized');
    return createConversation(me.user, forge.id);
  }

  return (
    <ForgePageClient
      forge={{ id: forge.id, name: forge.name, createdBy: forge.createdBy }}
      runtime={runtime}
      canWrite={canWrite}
      currentUserId={session.user.id}
      initialConversations={conversations}
      onCreateConversation={onCreateConversation}
    />
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import type { ConversationWithMessagesDto } from '@/lib/services/conversations';

export type ConversationMessage = ConversationWithMessagesDto['messages'][number];

export function useConversationMessages(
  forgeId: string,
  conversationId: string | null,
  active: boolean,
) {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchMessages() {
    if (!conversationId) return;
    try {
      const res = await fetch(`/api/forges/${forgeId}/conversations/${conversationId}`);
      if (!res.ok) return;
      const body = (await res.json()) as { conversation: ConversationWithMessagesDto };
      setMessages(body.conversation.messages);
    } catch { /* network blip */ }
  }

  useEffect(() => {
    if (!conversationId) { setMessages([]); return; }
    void fetchMessages();
    if (active) {
      intervalRef.current = setInterval(fetchMessages, 2000);
    }
    return () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, active]);

  return { messages, refetch: fetchMessages };
}

'use client';

import { useEffect, useRef, useState } from 'react';

export type ChatStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export type ChatSession = {
  status: ChatStatus;
  errorMessage: string | null;
  send: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  /** Subscribe to incoming server bytes. */
  onData: (handler: (chunk: string) => void) => () => void;
};

export function useChatSession(forgeId: string, conversationId: string | null): ChatSession {
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<(chunk: string) => void>>(new Set());

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    setStatus('connecting');
    setErrorMessage(null);
    (async () => {
      try {
        const res = await fetch(`/api/forges/${forgeId}/conversations/${conversationId}/connect`, { method: 'POST' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `connect failed (${res.status})`);
        const body = (await res.json()) as { wsUrl: string; token: string };
        if (cancelled) return;
        const ws = new WebSocket(`${body.wsUrl}?token=${encodeURIComponent(body.token)}`);
        wsRef.current = ws;
        ws.onopen = () => setStatus('open');
        ws.onmessage = (ev) => {
          const text = typeof ev.data === 'string' ? ev.data : '';
          handlersRef.current.forEach((h) => h(text));
        };
        ws.onclose = (ev) => {
          if (ev.code === 4401) setErrorMessage('Authorization expired');
          else if (ev.code === 4409) setErrorMessage('Conversation already active in another tab');
          else if (ev.code === 4404) setErrorMessage('Conversation not found');
          setStatus('closed');
        };
        ws.onerror = () => { setStatus('error'); setErrorMessage('WebSocket error'); };
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setErrorMessage(err instanceof Error ? err.message : 'Failed to connect');
        }
      }
    })();
    return () => {
      cancelled = true;
      try { wsRef.current?.close(); } catch { /* noop */ }
      wsRef.current = null;
    };
  }, [forgeId, conversationId]);

  return {
    status,
    errorMessage,
    send: (data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    },
    resize: (cols, rows) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    },
    onData: (handler) => {
      handlersRef.current.add(handler);
      return () => { handlersRef.current.delete(handler); };
    },
  };
}

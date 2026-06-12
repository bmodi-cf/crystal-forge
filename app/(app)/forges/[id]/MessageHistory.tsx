'use client';

import { useEffect, useRef } from 'react';
import type { ConversationMessage } from './useConversationMessages';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; content: unknown }
  | { type: string; [key: string]: unknown };

function hasTextContent(content: unknown): boolean {
  if (typeof content === 'string') return content.length > 0;
  if (!Array.isArray(content)) return false;
  return (content as ContentBlock[]).some((b) => b.type === 'text');
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as ContentBlock[])
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('');
}

function extractToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return (content as ContentBlock[])
    .filter((b) => b.type === 'tool_use')
    .map((b) => (b as { name?: string }).name ?? 'Tool');
}

type Props = { messages: ConversationMessage[] };

export function MessageHistory({ messages }: Props) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const prevLengthRef = useRef(0);

  const visible = messages.filter((m) => hasTextContent(m.content));

  useEffect(() => {
    if (visible.length !== prevLengthRef.current) {
      prevLengthRef.current = visible.length;
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [visible.length]);

  if (visible.length === 0) {
    return (
      <div className="grid place-items-center h-full text-ink-faint text-[12px]">
        No messages yet. Start typing below.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {visible.map((msg) => {
        const text = extractText(msg.content);
        const toolNames = msg.role === 'assistant' ? extractToolNames(msg.content) : [];
        return (
          <div key={msg.id} className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
            <span className="text-[10px] text-ink-faint uppercase tracking-wide">
              {msg.role === 'user' ? 'You' : 'Claude'}
            </span>
            {toolNames.length > 0 && (
              <div className="flex flex-col gap-0.5">
                {toolNames.map((name, i) => (
                  <span key={i} className="text-[10px] text-ink-faint font-mono opacity-50">⚙ {name}</span>
                ))}
              </div>
            )}
            <div
              className={`max-w-[90%] rounded px-3 py-2 text-[12px] leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-surface-raised text-ink'
                  : 'bg-transparent text-ink border border-border'
              }`}
            >
              <span className="whitespace-pre-wrap">{text}</span>
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

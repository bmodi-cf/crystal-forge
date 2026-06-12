'use client';

import { useEffect, useRef } from 'react';
import type { ConversationMessage } from './useConversationMessages';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; content: unknown }
  | { type: string; [key: string]: unknown };

function renderContent(content: unknown): React.ReactNode {
  if (typeof content === 'string') {
    return <span className="whitespace-pre-wrap">{content}</span>;
  }
  if (!Array.isArray(content)) return null;

  return (content as ContentBlock[]).map((block, i) => {
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      return <span key={i} className="whitespace-pre-wrap">{text}</span>;
    }
    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : '';
      return (
        <span key={i} className="inline-block my-0.5 px-1.5 py-0.5 rounded text-[11px] bg-surface-raised text-ink-faint font-mono">
          ⚙ {name}
        </span>
      );
    }
    if (block.type === 'tool_result') {
      const text = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? (block.content as ContentBlock[]).filter(b => b.type === 'text').map(b => (b as { text?: string }).text ?? '').join('')
          : '';
      if (!text.trim()) return null;
      return (
        <span key={i} className="block mt-1 text-ink-faint whitespace-pre-wrap text-[11px] font-mono border-l-2 border-border pl-2">
          {text.length > 300 ? text.slice(0, 300) + '…' : text}
        </span>
      );
    }
    return null;
  });
}

type Props = {
  messages: ConversationMessage[];
};

export function ConversationHistory({ messages }: Props) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const prevLengthRef = useRef(0);

  useEffect(() => {
    if (messages.length !== prevLengthRef.current) {
      prevLengthRef.current = messages.length;
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className="grid place-items-center h-full text-ink-faint text-[12px]">
        No messages yet. Start typing below.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {messages.map((msg) => (
        <div key={msg.id} className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
          <span className="text-[10px] text-ink-faint uppercase tracking-wide">
            {msg.role === 'user' ? 'You' : 'Claude'}
          </span>
          <div
            className={`max-w-[90%] rounded px-3 py-2 text-[12px] leading-relaxed ${
              msg.role === 'user'
                ? 'bg-surface-raised text-ink'
                : 'bg-transparent text-ink border border-border'
            }`}
          >
            {renderContent(msg.content)}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

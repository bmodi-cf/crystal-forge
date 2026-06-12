// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageHistory } from './MessageHistory';
import type { ConversationMessage } from './useConversationMessages';

function msg(role: 'user' | 'assistant', content: unknown, id = Math.random().toString()): ConversationMessage {
  return { id, role, content, createdAt: new Date().toISOString() } as ConversationMessage;
}

describe('MessageHistory', () => {
  it('renders empty state when no messages', () => {
    render(<MessageHistory messages={[]} />);
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
  });

  it('renders string user message', () => {
    render(<MessageHistory messages={[msg('user', 'Hello world')]} />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('renders text block from assistant', () => {
    const content = [{ type: 'text', text: 'Here are the routes.' }];
    render(<MessageHistory messages={[msg('assistant', content)]} />);
    expect(screen.getByText('Here are the routes.')).toBeInTheDocument();
  });

  it('does NOT render tool_use blocks as bubbles', () => {
    const content = [{ type: 'tool_use', name: 'Read', input: { path: 'foo.ts' } }];
    render(<MessageHistory messages={[msg('assistant', content)]} />);
    expect(screen.queryByText(/foo\.ts/)).not.toBeInTheDocument();
  });

  it('skips tool_result-only user messages (no bubble)', () => {
    const messages = [
      msg('user', 'Do something'),
      msg('user', [{ type: 'tool_result', content: 'file contents here' }]),
      msg('assistant', [{ type: 'text', text: 'Done.' }]),
    ];
    render(<MessageHistory messages={messages} />);
    expect(screen.queryByText('file contents here')).not.toBeInTheDocument();
    expect(screen.getByText('Done.')).toBeInTheDocument();
  });

  it('shows tool names above the assistant bubble when message has tool_use', () => {
    const content = [
      { type: 'tool_use', name: 'Read', input: {} },
      { type: 'text', text: 'Here is the answer.' },
    ];
    render(<MessageHistory messages={[msg('assistant', content)]} />);
    expect(screen.getByText(/⚙ Read/)).toBeInTheDocument();
    expect(screen.getByText('Here is the answer.')).toBeInTheDocument();
  });
});

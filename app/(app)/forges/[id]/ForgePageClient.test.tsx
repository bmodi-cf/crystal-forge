import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForgePageClient } from './ForgePageClient';

const forge = { id: 'f1', name: 'Aquaflow Designer', createdBy: { id: 'u1', name: 'Maya' } };

vi.mock('./ChatPanel', () => ({ ChatPanel: ({ conversationId }: { conversationId: string | null }) =>
  <div data-testid="chat-panel">conv={conversationId ?? 'null'}</div>
}));
vi.mock('./InstancePanel', () => ({ InstancePanel: () => <div data-testid="instance-panel" /> }));

describe('ForgePageClient', () => {
  it('selects an existing conversation by choosing it from the dropdown', async () => {
    const onCreate = vi.fn();
    render(<ForgePageClient
      forge={forge}
      runtime={null}
      canWrite
      currentUserId="u1"
      initialConversations={[
        { id: 'c1', forgeId: 'f1', createdBy: { id: 'u1', name: 'Maya' }, title: 'Setup', hasClaudeSessionId: true, createdAt: '2026-05-09T00:00Z', updatedAt: '2026-05-09T00:00Z' },
      ]}
      onCreateConversation={onCreate}
    />);
    expect(screen.getByTestId('chat-panel').textContent).toContain('conv=null');
    await userEvent.selectOptions(screen.getByRole('combobox'), 'c1');
    expect(screen.getByTestId('chat-panel').textContent).toContain('conv=c1');
  });

  it('clicking + New invokes onCreateConversation and selects the returned id', async () => {
    const onCreate = vi.fn(async () => ({
      id: 'c-new', forgeId: 'f1', createdBy: { id: 'u1', name: 'Maya' },
      title: 'New conversation', hasClaudeSessionId: false,
      createdAt: '2026-05-10T00:00Z', updatedAt: '2026-05-10T00:00Z',
    }));
    render(<ForgePageClient
      forge={forge}
      runtime={null}
      canWrite
      currentUserId="u1"
      initialConversations={[]}
      onCreateConversation={onCreate}
    />);
    await userEvent.click(screen.getByRole('button', { name: /\+ new/i }));
    await waitFor(() => expect(screen.getByTestId('chat-panel').textContent).toContain('conv=c-new'));
    expect(onCreate).toHaveBeenCalled();
  });
});

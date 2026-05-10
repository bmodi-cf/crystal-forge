import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConversationList } from './ConversationList';

const sample = [
  { id: 'c1', forgeId: 'f1', createdBy: { id: 'u1', name: 'Maya' }, title: 'Setup auth', hasClaudeSessionId: true,  createdAt: '2026-05-09T12:00:00Z', updatedAt: '2026-05-09T12:00:00Z' },
  { id: 'c2', forgeId: 'f1', createdBy: { id: 'u1', name: 'Maya' }, title: 'First steps', hasClaudeSessionId: false, createdAt: '2026-05-08T09:00:00Z', updatedAt: '2026-05-08T09:00:00Z' },
];

describe('ConversationList', () => {
  it('renders titles and a New button', () => {
    render(<ConversationList items={sample} activeId={null} canWrite onSelect={() => {}} onCreate={() => {}} />);
    expect(screen.getByText('Setup auth')).toBeInTheDocument();
    expect(screen.getByText('First steps')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ new/i })).toBeEnabled();
  });

  it('marks the active conversation', () => {
    render(<ConversationList items={sample} activeId="c1" canWrite onSelect={() => {}} onCreate={() => {}} />);
    expect(screen.getByText('Setup auth').closest('button')).toHaveAttribute('data-active', 'true');
    expect(screen.getByText('First steps').closest('button')).toHaveAttribute('data-active', 'false');
  });

  it('disables New when canWrite is false', () => {
    render(<ConversationList items={sample} activeId={null} canWrite={false} onSelect={() => {}} onCreate={() => {}} />);
    expect(screen.getByRole('button', { name: /\+ new/i })).toBeDisabled();
  });

  it('fires onSelect when a conversation is clicked', async () => {
    const onSelect = vi.fn();
    render(<ConversationList items={sample} activeId={null} canWrite onSelect={onSelect} onCreate={() => {}} />);
    await userEvent.click(screen.getByText('Setup auth'));
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('fires onCreate when New is clicked', async () => {
    const onCreate = vi.fn();
    render(<ConversationList items={sample} activeId={null} canWrite onSelect={() => {}} onCreate={onCreate} />);
    await userEvent.click(screen.getByRole('button', { name: /\+ new/i }));
    expect(onCreate).toHaveBeenCalled();
  });
});

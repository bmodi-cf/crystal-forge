// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageInput } from './MessageInput';

describe('MessageInput', () => {
  it('renders Send button when not working', () => {
    render(<MessageInput onSend={vi.fn()} onInterrupt={vi.fn()} isWorking={false} />);
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /interrupt/i })).not.toBeInTheDocument();
  });

  it('renders Interrupt button and disables textarea when working', () => {
    render(<MessageInput onSend={vi.fn()} onInterrupt={vi.fn()} isWorking={true} />);
    expect(screen.getByRole('button', { name: /interrupt/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('calls onSend with trimmed text and clears textarea on Enter', () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} onInterrupt={vi.fn()} isWorking={false} />);
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: '  hello  ' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });
    expect(onSend).toHaveBeenCalledWith('hello');
    expect((ta as HTMLTextAreaElement).value).toBe('');
  });

  it('does NOT call onSend on Shift+Enter', () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} onInterrupt={vi.fn()} isWorking={false} />);
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: 'hi' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does NOT call onSend when text is empty', () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} onInterrupt={vi.fn()} isWorking={false} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('calls onInterrupt when Interrupt button clicked', () => {
    const onInterrupt = vi.fn();
    render(<MessageInput onSend={vi.fn()} onInterrupt={onInterrupt} isWorking={true} />);
    fireEvent.click(screen.getByRole('button', { name: /interrupt/i }));
    expect(onInterrupt).toHaveBeenCalled();
  });
});

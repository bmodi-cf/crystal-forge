// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ToolFeed } from './ToolFeed';

function makeOnData() {
  const handlers = new Set<(chunk: string) => void>();
  const onData = vi.fn((handler: (chunk: string) => void) => {
    handlers.add(handler);
    return () => { handlers.delete(handler); };
  });
  const emit = (chunk: string) => act(() => { handlers.forEach((h) => h(chunk)); });
  return { onData, emit };
}

describe('ToolFeed', () => {
  it('renders nothing when not working', () => {
    const { onData } = makeOnData();
    const { container } = render(<ToolFeed onData={onData} isWorking={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when working but no tool lines detected', () => {
    const { onData, emit } = makeOnData();
    render(<ToolFeed onData={onData} isWorking={true} />);
    emit('Hello from Claude, no tool here');
    expect(screen.queryByText(/⚙/)).not.toBeInTheDocument();
  });

  it('shows tool name when PTY chunk contains a tool call pattern', async () => {
    const { onData, emit } = makeOnData();
    render(<ToolFeed onData={onData} isWorking={true} />);
    emit('Read(app/api/forges/route.ts)\n');
    expect(await screen.findByText(/Read\(app\/api\/forges\/route\.ts\)/)).toBeInTheDocument();
  });

  it('strips ANSI codes before matching', async () => {
    const { onData, emit } = makeOnData();
    render(<ToolFeed onData={onData} isWorking={true} />);
    emit('\x1b[32mWrite(lib/foo.ts)\x1b[0m\n');
    expect(await screen.findByText(/Write\(lib\/foo\.ts\)/)).toBeInTheDocument();
  });

  it('clears lines when isWorking becomes false', async () => {
    const { onData, emit } = makeOnData();
    const { rerender } = render(<ToolFeed onData={onData} isWorking={true} />);
    emit('Read(foo.ts)\n');
    expect(await screen.findByText(/Read\(foo\.ts\)/)).toBeInTheDocument();
    rerender(<ToolFeed onData={onData} isWorking={false} />);
    expect(screen.queryByText(/Read\(foo\.ts\)/)).not.toBeInTheDocument();
  });
});

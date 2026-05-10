// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startTranscriptWatcher, encodedCwd, parseTranscriptLine,
} from './transcript-watcher';

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-tw-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  fs.mkdirSync(path.join(tmp, '.claude', 'projects'), { recursive: true });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('encodedCwd', () => {
  it('replaces / with - for the project dir name', () => {
    expect(encodedCwd('/home/bmodi/.crystal-forge/clones/marketing-frufru'))
      .toBe('-home-bmodi--crystal-forge-clones-marketing-frufru');
  });
});

describe('parseTranscriptLine', () => {
  it('parses a user line with text content', () => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId: 'sid-1' });
    expect(parseTranscriptLine(line)).toEqual({
      sessionId: 'sid-1',
      message: { role: 'user', content: 'hi' },
    });
  });

  it('parses an assistant line with structured content blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      sessionId: 'sid-2',
    });
    expect(parseTranscriptLine(line)).toEqual({
      sessionId: 'sid-2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    });
  });

  it('returns null for malformed lines', () => {
    expect(parseTranscriptLine('garbage')).toBeNull();
    expect(parseTranscriptLine('{}')).toBeNull();
  });
});

describe('startTranscriptWatcher', () => {
  it('claims the JSONL file with mtime >= spawn time and persists each line', async () => {
    const cloneDir = '/home/x/clone';
    const projectDir = path.join(tmp, '.claude', 'projects', encodedCwd(cloneDir));
    fs.mkdirSync(projectDir, { recursive: true });

    const append = vi.fn();
    const setSession = vi.fn();
    const watcher = startTranscriptWatcher('conv-1', cloneDir, {
      appendMessage: append,
      setClaudeSessionId: setSession,
      pollIntervalMs: 30,
      claimWindowMs: 1000,
    });

    // Wait briefly, then create the JSONL with a session header line.
    await new Promise((r) => setTimeout(r, 60));
    const file = path.join(projectDir, 'sid-A.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      sessionId: 'sid-A',
    }) + '\n');

    // Wait for watcher to pick it up.
    await new Promise((r) => setTimeout(r, 200));

    expect(setSession).toHaveBeenCalledWith('conv-1', 'sid-A');
    expect(append).toHaveBeenCalledWith('conv-1', expect.objectContaining({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    }));

    // Append another line and verify it lands.
    fs.appendFileSync(file, JSON.stringify({
      type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
      sessionId: 'sid-A',
    }) + '\n');
    await new Promise((r) => setTimeout(r, 200));
    expect(append).toHaveBeenCalledTimes(2);

    watcher.stop();
  });

  it('ignores stale JSONL files whose mtime is older than spawn time', async () => {
    const cloneDir = '/home/x/clone';
    const projectDir = path.join(tmp, '.claude', 'projects', encodedCwd(cloneDir));
    fs.mkdirSync(projectDir, { recursive: true });
    const stale = path.join(projectDir, 'sid-stale.jsonl');
    fs.writeFileSync(stale, JSON.stringify({
      type: 'user', message: { role: 'user', content: 'old' }, sessionId: 'sid-stale',
    }) + '\n');
    // Backdate.
    const past = Date.now() / 1000 - 60;
    fs.utimesSync(stale, past, past);

    const append = vi.fn();
    const watcher = startTranscriptWatcher('conv-2', cloneDir, {
      appendMessage: append,
      setClaudeSessionId: vi.fn(),
      pollIntervalMs: 30,
      claimWindowMs: 200,
    });
    await new Promise((r) => setTimeout(r, 350));
    expect(append).not.toHaveBeenCalled();
    watcher.stop();
  });
});

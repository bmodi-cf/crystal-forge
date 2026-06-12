// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('forge-runtime.Dockerfile', () => {
  const dockerfile = readFileSync(join(__dirname, 'forge-runtime.Dockerfile'), 'utf8');

  it('installs tmux (durable Claude sessions depend on it)', () => {
    expect(dockerfile).toMatch(/\btmux\b/);
  });
});

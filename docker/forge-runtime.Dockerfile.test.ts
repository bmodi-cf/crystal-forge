// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('forge-runtime.Dockerfile', () => {
  const dockerfile = readFileSync(join(__dirname, 'forge-runtime.Dockerfile'), 'utf8');

  it('installs tmux (durable Claude sessions depend on it)', () => {
    expect(dockerfile).toMatch(/\btmux\b/);
  });

  it('bakes a Chromium build for Playwright', () => {
    expect(dockerfile).toMatch(/playwright install .*\bchromium\b/);
  });

  it('keeps the browser cache outside /home/forge', () => {
    // CLAUDE_HOME (/home/forge) is a per-forge named volume: docker seeds it
    // from the image once, then pins that copy forever. Browsers baked under
    // the default ~/.cache/ms-playwright would never reach a forge — neither an
    // existing one (volume already populated) nor a later image rebuild.
    const path = dockerfile.match(/^ENV PLAYWRIGHT_BROWSERS_PATH=(\S+)/m)?.[1];
    expect(path).toBeDefined();
    expect(path).not.toMatch(/^\/home\/forge/);
  });

  it('skips the postinstall browser download (it would pull all three engines)', () => {
    expect(dockerfile).toMatch(/PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g playwright@/);
  });
});

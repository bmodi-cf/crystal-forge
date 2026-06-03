// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { claudeCredentialsEnv } from './claude-credentials';

afterEach(() => { delete process.env.ANTHROPIC_API_KEY; });

describe('claudeCredentialsEnv', () => {
  it('forwards ANTHROPIC_API_KEY when set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    expect(claudeCredentialsEnv()).toEqual({ ANTHROPIC_API_KEY: 'sk-test' });
  });
  it('returns an empty object when unset', () => {
    expect(claudeCredentialsEnv()).toEqual({});
  });
});

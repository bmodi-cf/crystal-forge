/**
 * Single seam for the credentials a spawned `claude` subprocess sees.
 *
 * Today: returns an empty env override, so the child inherits the harness
 * operator's `~/.claude/` (i.e. `process.env.HOME`).
 *
 * Future: a per-user variant will return `{ HOME: '/path/to/user-claude-home' }`
 * or set `CLAUDE_CONFIG_DIR` directly. Callers must NOT read these env vars
 * by other means — this is the only seam.
 */
export function claudeCredentialsEnv(): Record<string, string> {
  return {};
}

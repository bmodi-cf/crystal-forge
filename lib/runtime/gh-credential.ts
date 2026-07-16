import type { ContainerManager } from './container/types';
import { CLAUDE_HOME } from './paths';

const HOSTS_YML = `${CLAUDE_HOME}/.config/gh/hosts.yml`;
const WRITE_TIMEOUT_MS = 30_000;

/**
 * Write `token` into the forge's `gh` credential store (hosts.yml) so both the
 * `gh` CLI and `git` (via `gh auth setup-git` → `gh auth git-credential`) pick
 * it up on their next invocation. The token is passed through the exec
 * environment ($FORGE_GH_TOKEN), never argv, so it never leaks into process
 * listings or logs. Container-level GH_TOKEN must be unset, or it would shadow
 * hosts.yml in `gh`.
 */
export async function writeForgeGitToken(
  mgr: ContainerManager,
  containerId: string,
  token: string,
): Promise<void> {
  const script =
    `set -e; mkdir -p "$(dirname "${HOSTS_YML}")"; ` +
    `printf 'github.com:\\n    oauth_token: %s\\n    user: x-access-token\\n    git_protocol: https\\n' ` +
    `"$FORGE_GH_TOKEN" > "${HOSTS_YML}"`;
  const { exitCode } = await mgr.exec(containerId, 'sh', ['-c', script], {
    env: { FORGE_GH_TOKEN: token },
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  if (exitCode !== 0) throw new Error(`write gh token failed (exit ${exitCode})`);
}

import type { ContainerManager } from './container/types';
import { CLAUDE_HOME } from './paths';

const GH_CONFIG_DIR = `${CLAUDE_HOME}/.config/gh`;
const CONFIG_YML = `${GH_CONFIG_DIR}/config.yml`;
const HOSTS_YML = `${GH_CONFIG_DIR}/hosts.yml`;
const WRITE_TIMEOUT_MS = 30_000;

/**
 * Write `token` into the forge's `gh` credential store so both the `gh` CLI
 * and `git` (via `gh auth setup-git` → `gh auth git-credential`) pick it up
 * on their next invocation, entirely offline.
 *
 * gh >= 2.40 (the forge image runs 2.95.0) treats an un-versioned config dir
 * as needing a one-time "multi-account migration", which calls `GET /user`
 * to resolve the login before it will do anything else — including serve
 * `git-credential get`. An installation token (`x-access-token`) can't call
 * `/user`, so migration aborts with a CowardlyRefusalError and every `gh`
 * invocation fails. Writing `config.yml` with a `version:` marker up front
 * tells gh the config is already migrated, skipping that call entirely.
 * `hosts.yml` uses the nested `users:` shape gh's migrated format expects.
 *
 * Verified empirically against gh 2.95.0 in a forge container: this exact
 * shape (config.yml + nested hosts.yml) makes `gh auth git-credential get`
 * return the token with zero network calls; the legacy flat hosts.yml alone
 * fails the migration with a 401 from an attempted `/user` call.
 *
 * The token is passed through the exec environment ($FORGE_GH_TOKEN), never
 * argv, so it never leaks into process listings or logs. Container-level
 * GH_TOKEN must be unset, or it would shadow hosts.yml in `gh`.
 */
export async function writeForgeGitToken(
  mgr: ContainerManager,
  containerId: string,
  token: string,
): Promise<void> {
  const script =
    `set -e; mkdir -p "${GH_CONFIG_DIR}"; ` +
    `printf 'version: 1\\n' > "${CONFIG_YML}"; ` +
    `printf 'github.com:\\n    users:\\n        x-access-token:\\n            oauth_token: %s\\n    git_protocol: https\\n    user: x-access-token\\n    oauth_token: %s\\n' ` +
    `"$FORGE_GH_TOKEN" "$FORGE_GH_TOKEN" > "${HOSTS_YML}"`;
  const { exitCode } = await mgr.exec(containerId, 'sh', ['-c', script], {
    env: { FORGE_GH_TOKEN: token },
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  if (exitCode !== 0) throw new Error(`write gh token failed (exit ${exitCode})`);
}

/** The branch a Forge team works on (Claude Code commits here). */
export const DEV_BRANCH = 'dev' as const;

/** The production branch; protected, merged into only via an approved promotion. */
export const PROD_BRANCH = 'main' as const;

/**
 * Status-check names that must be green before a promotion can be accepted.
 * These MUST match the job/check names produced by the template's CI workflow
 * (`.github/workflows/promote-gates.yml`). The `tests` job self-skips to success
 * when a Forge has no tests, so requiring it never blocks a test-less Forge.
 */
export const REQUIRED_CHECKS = ['build', 'typecheck', 'lint', 'tests'] as const;

/**
 * Topic applied to every forge repo at creation so the org repo list can be
 * filtered (`topic:crystal-forge` / `-topic:crystal-forge`). Best-effort —
 * cosmetic only, never blocks creation.
 */
export const FORGE_TOPIC = 'crystal-forge' as const;

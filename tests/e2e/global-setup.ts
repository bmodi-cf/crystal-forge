import { execSync } from 'node:child_process';

export default async function globalSetup() {
  console.log('[e2e setup] Re-seeding dev DB with fake GitHub mode...');
  execSync('pnpm db:seed', {
    stdio: 'inherit',
    env: {
      ...process.env,
      GITHUB_CLIENT_MODE: 'fake',
      GITHUB_REPO_OWNER: process.env.GITHUB_REPO_OWNER ?? 'bmodi-cf',
      GITHUB_TEMPLATE_REPO:
        process.env.GITHUB_TEMPLATE_REPO ?? 'bmodi-cf/crystal-forge-template-webapp',
      GITHUB_BASE_URL: process.env.GITHUB_BASE_URL ?? 'https://github.com',
    },
  });
}

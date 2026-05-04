import { execSync } from 'node:child_process';

export default async function globalSetup() {
  console.log('[e2e setup] Re-seeding dev DB...');
  execSync('pnpm db:seed', { stdio: 'inherit' });
}

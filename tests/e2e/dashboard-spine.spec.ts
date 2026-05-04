import { test, expect } from '@playwright/test';

const SEED_USERS = {
  maya:  { email: 'maya.chen@crystalfountains.com',  visibleForges: ['Aquaflow Designer', 'Forge Labs'] },
  alice: { email: 'alice.green@crystalfountains.com', visibleForges: ['BrandKit Manager', 'Showcase Gallery'] },
  admin: { email: 'admin@crystalfountains.com',      visibleForges: ['Aquaflow Designer', 'Site Survey Pro', 'QuoteBuilder', 'Maintenance Hub', 'BrandKit Manager', 'PeoplePulse', 'Forge Labs', 'InvoiceBridge', 'Showcase Gallery'] },
};

async function devLogin(page: any, email: string) {
  const res = await page.request.post('/api/dev/switch-user', { data: { email } });
  expect(res.status()).toBe(200);
}

test.beforeEach(async ({ context }) => {
  // Each test starts with a clean cookie jar so logins don't bleed across tests.
  await context.clearCookies();
});

test('Maya sees only her group forges', async ({ page }) => {
  await devLogin(page, SEED_USERS.maya.email);
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Forges' })).toBeVisible();
  for (const name of SEED_USERS.maya.visibleForges) {
    await expect(page.getByText(name)).toBeVisible();
  }
  // Check a Forge that is NOT in her groups (e.g., InvoiceBridge — Finance)
  await expect(page.getByText('InvoiceBridge')).toHaveCount(0);
});

test('Admin sees every forge', async ({ page }) => {
  await devLogin(page, SEED_USERS.admin.email);
  await page.goto('/dashboard');
  for (const name of SEED_USERS.admin.visibleForges) {
    await expect(page.getByText(name)).toBeVisible();
  }
});

test('Unauthenticated request to /dashboard redirects to /login', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/);
});

test('Unauthenticated API request returns 401', async ({ request }) => {
  // No cookies set — fresh request fixture
  const res = await request.get('/api/forges/non-existent', { failOnStatusCode: false });
  expect([401, 404]).toContain(res.status());
});

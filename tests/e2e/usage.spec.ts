import { test, expect, type Page } from '@playwright/test';

const SEED_USERS = {
  admin: 'admin@crystalfountains.com',
  maya: 'maya.chen@crystalfountains.com',
};

async function devLogin(page: Page, email: string) {
  const res = await page.request.post('/api/dev/switch-user', { data: { email } });
  expect(res.status()).toBe(200);
}

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test('an admin sees host usage charted from the seeded history', async ({ page }) => {
  await devLogin(page, SEED_USERS.admin);
  await page.goto('/admin/users');
  await page.getByRole('link', { name: /usage/i }).click();

  await expect(page.getByTestId('tile-cpu')).toBeVisible();
  await expect(page.getByTestId('tile-memory')).toContainText('GiB');
  await expect(page.getByTestId('tile-disk')).toContainText('GiB');
  await expect(page.getByTestId('tile-forges')).toContainText('2');
  await expect(page.getByText(/collecting/i)).toHaveCount(0);

  await page.getByRole('button', { name: '24h' }).click();
  await expect(page.getByTestId('tile-cpu')).toBeVisible();
});

test('a non-admin cannot read the usage API', async ({ page }) => {
  await devLogin(page, SEED_USERS.maya);
  const res = await page.request.get('/api/admin/usage?range=24h');
  expect(res.status()).toBe(403);
});

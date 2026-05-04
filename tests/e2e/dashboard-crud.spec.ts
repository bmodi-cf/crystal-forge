import { test, expect, type Page } from '@playwright/test';

const SEED_USERS = {
  maya:  'maya.chen@crystalfountains.com',
  tom:   'tom.reed@crystalfountains.com',
  admin: 'admin@crystalfountains.com',
};

async function devLogin(page: Page, email: string) {
  const res = await page.request.post('/api/dev/switch-user', { data: { email } });
  expect(res.status()).toBe(200);
}

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test('Maya creates a new Forge in Engineering and sees it on the dashboard', async ({ page }) => {
  await devLogin(page, SEED_USERS.maya);
  await page.goto('/dashboard');
  await page.getByRole('button', { name: /new forge/i }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /new forge/i })).toBeVisible();
  await dialog.getByLabel(/^name$/i).fill('E2E Create');
  await dialog.getByLabel(/description/i).fill('Created from e2e.');
  await dialog.getByRole('button', { name: /^engineering$/i }).click();
  await dialog.getByRole('button', { name: /^create$/i }).click();

  await expect(page.getByText(/forge created/i)).toBeVisible();
  await expect(page.getByText('E2E Create')).toBeVisible();

  // cleanup: find the just-created forge via a fresh GET-equivalent (api list isn't shipped in Phase 2,
  // so use the modal's response by capturing the API call). Simpler: trigger delete through the UI.
  await page.locator('article', { hasText: 'E2E Create' }).getByRole('button', { name: /^delete/i }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^delete$/i }).click();
});

test('Maya edits Forge Labs (her own) and sees the new name', async ({ page }) => {
  await devLogin(page, SEED_USERS.maya);
  await page.goto('/dashboard');

  const card = page.locator('article', { hasText: 'Forge Labs' });
  await card.getByRole('button', { name: /^edit forge labs$/i }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^name$/i).fill('Forge Labs (E2E)');
  await dialog.getByRole('button', { name: /save changes/i }).click();

  await expect(page.getByText(/forge updated/i)).toBeVisible();
  await expect(page.getByText('Forge Labs (E2E)')).toBeVisible();

  // restore so subsequent runs (without re-seed) still find it
  await page.locator('article', { hasText: 'Forge Labs (E2E)' }).getByRole('button', { name: /^edit/i }).click();
  await page.getByRole('dialog').getByLabel(/^name$/i).fill('Forge Labs');
  await page.getByRole('dialog').getByRole('button', { name: /save changes/i }).click();
  await expect(page.getByText(/forge updated/i)).toBeVisible();
});

test('Maya deletes a Forge and the card disappears', async ({ page }) => {
  await devLogin(page, SEED_USERS.maya);
  await page.goto('/dashboard');

  // Create a throwaway forge via the UI so the test owns its lifetime.
  await page.getByRole('button', { name: /new forge/i }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^name$/i).fill('E2E Delete Target');
  await dialog.getByRole('button', { name: /^engineering$/i }).click();
  await dialog.getByRole('button', { name: /^create$/i }).click();
  await expect(page.getByText('E2E Delete Target')).toBeVisible();

  // Now delete it.
  await page.locator('article', { hasText: 'E2E Delete Target' })
    .getByRole('button', { name: /^delete e2e delete target$/i }).click();

  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /delete/i })).toBeVisible();
  await dialog.getByRole('button', { name: /^delete$/i }).click();
  await expect(page.getByText(/deleted/i)).toBeVisible();
  await expect(page.locator('article', { hasText: 'E2E Delete Target' })).toHaveCount(0);
});

test('Direct DELETE on a forge the user cannot write returns 403', async ({ page }) => {
  // Maya creates a forge in Engineering.
  await devLogin(page, SEED_USERS.maya);
  const createRes = await page.request.post('/api/forges', {
    data: { name: 'E2E ACL', description: '', groups: ['Engineering'] },
  });
  expect(createRes.status()).toBe(201);
  const { forge } = await createRes.json();

  // Tom (Operations/Service, not creator, not admin) tries to DELETE.
  await page.context().clearCookies();
  await devLogin(page, SEED_USERS.tom);
  const delRes = await page.request.delete(`/api/forges/${forge.id}`);
  expect(delRes.status()).toBe(403);
  expect((await delRes.json()).error).toMatch(/cannot delete/i);

  // Admin cleans up so the DB stays tidy for re-runs.
  await page.context().clearCookies();
  await devLogin(page, SEED_USERS.admin);
  const cleanup = await page.request.delete(`/api/forges/${forge.id}`);
  expect(cleanup.status()).toBe(204);
});

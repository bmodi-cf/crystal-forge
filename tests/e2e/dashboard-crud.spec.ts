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

test('edit dialog renders the Forge name as immutable text, not an input', async ({ page }) => {
  await devLogin(page, SEED_USERS.maya);
  await page.goto('/dashboard');

  const card = page.locator('article', { hasText: 'Forge Labs' });
  await card.getByRole('button', { name: /^edit forge labs$/i }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // Name is rendered as static text — there is no form control associated with the "Name" label.
  await expect(dialog.getByLabel(/^name$/i)).toHaveCount(0);
  await expect(dialog.getByText(/forge names are immutable/i)).toBeVisible();
  await expect(dialog.getByText('Forge Labs', { exact: true })).toBeVisible();

  await dialog.getByRole('button', { name: /cancel/i }).click();
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

test('seeded Forge cards expose a "View on GitHub" link with the expected slug', async ({ page }) => {
  await devLogin(page, SEED_USERS.maya);
  await page.goto('/dashboard');

  // Forge Labs is created by Maya in the seed.
  const card = page.locator('article', { hasText: 'Forge Labs' });
  const link = card.getByRole('link', { name: /view on github: forge labs/i });
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/\/bmodi-cf\/forge-labs$/);
});

test('newly-created Forge surfaces a GitHub link with the slugified name', async ({ page }) => {
  await devLogin(page, SEED_USERS.maya);
  await page.goto('/dashboard');

  await page.getByRole('button', { name: /new forge/i }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^name$/i).fill('GH Link Probe');
  await dialog.getByRole('button', { name: /^engineering$/i }).click();
  await dialog.getByRole('button', { name: /^create$/i }).click();
  await expect(page.getByText(/forge created/i)).toBeVisible();

  const newCard = page.locator('article', { hasText: 'GH Link Probe' });
  const link = newCard.getByRole('link', { name: /view on github: gh link probe/i });
  await expect(link).toBeVisible();
  expect(await link.getAttribute('href')).toMatch(/\/bmodi-cf\/gh-link-probe$/);

  // cleanup
  await newCard.getByRole('button', { name: /^delete gh link probe$/i }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^delete$/i }).click();
  await expect(page.getByText(/deleted/i)).toBeVisible();
});

test('Forge name with illegal characters surfaces a validation message', async ({ page }) => {
  await devLogin(page, SEED_USERS.maya);
  await page.goto('/dashboard');
  await page.getByRole('button', { name: /new forge/i }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^name$/i).fill('Bad!Name');
  await dialog.getByRole('button', { name: /^engineering$/i }).click();
  await dialog.getByRole('button', { name: /^create$/i }).click();
  await expect(
    dialog.getByText(/letters, numbers, spaces, underscores and dashes/i),
  ).toBeVisible();
});

import { expect, test, type Page } from '@playwright/test';

const STORAGE_CLOUD_URL_KEY = 'rebel_cloud_url';
const STORAGE_TOKEN_KEY = 'rebel_token';

async function seedStoredCredentials(page: Page): Promise<void> {
  await page.addInitScript(
    ({ cloudUrlKey, tokenKey }) => {
      localStorage.setItem(cloudUrlKey, 'http://localhost:5173');
      localStorage.setItem(tokenKey, 'stored-token');
    },
    { cloudUrlKey: STORAGE_CLOUD_URL_KEY, tokenKey: STORAGE_TOKEN_KEY },
  );
}

async function expectAppDidNotCrash(page: Page): Promise<void> {
  await expect(page.getByTestId('auth-url-input')).toHaveCount(0);
  await expect(page.getByText('Something broke.')).toHaveCount(0);
  await expect(page.locator('main')).toBeVisible();
}

test('SPA routes load without errors', async ({ page }) => {
  await seedStoredCredentials(page);

  const routes = ['/app/conversations', '/app/inbox', '/app/approvals', '/app/help'];

  for (const route of routes) {
    await page.goto(route);
    await expect(page).toHaveURL(new RegExp(`${route}$`));
    await expectAppDidNotCrash(page);
  }
});

test('unknown routes redirect to home', async ({ page }) => {
  await seedStoredCredentials(page);
  await page.goto('/app/nonexistent');

  await expect(page).toHaveURL(/\/app\/?$/);
  await expect(page.getByTestId('quick-input')).toBeVisible();
  await expectAppDidNotCrash(page);
});

test('deep link to conversation', async ({ page }) => {
  await seedStoredCredentials(page);
  await page.goto('/app/conversations/some-id');

  await expect(page).toHaveURL(/\/app\/conversations\/some-id$/);
  await expect(page.getByText('New conversation')).toBeVisible();
  await expectAppDidNotCrash(page);
});

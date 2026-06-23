import { expect, test, type Page } from '@playwright/test';

const STORAGE_CLOUD_URL_KEY = 'rebel_cloud_url';
const STORAGE_TOKEN_KEY = 'rebel_token';

async function clearStoredCredentials(page: Page): Promise<void> {
  await page.addInitScript(
    ({ cloudUrlKey, tokenKey }) => {
      localStorage.removeItem(cloudUrlKey);
      localStorage.removeItem(tokenKey);
    },
    { cloudUrlKey: STORAGE_CLOUD_URL_KEY, tokenKey: STORAGE_TOKEN_KEY },
  );
}

async function seedStoredCredentials(page: Page): Promise<void> {
  await page.addInitScript(
    ({ cloudUrlKey, tokenKey }) => {
      localStorage.setItem(cloudUrlKey, 'http://localhost:5173');
      localStorage.setItem(tokenKey, 'stored-token');
    },
    { cloudUrlKey: STORAGE_CLOUD_URL_KEY, tokenKey: STORAGE_TOKEN_KEY },
  );
}

test('shows auth screen when not paired', async ({ page }) => {
  await clearStoredCredentials(page);
  await page.goto('/');

  await expect(page.getByTestId('auth-url-input')).toBeVisible();
  await expect(page.getByTestId('auth-token-input')).toBeVisible();
});

test('pairs via URL fragment token', async ({ page }) => {
  await clearStoredCredentials(page);
  await page.goto('/app/#token=test-token');

  await expect(page).toHaveURL(/\/app\/$/);

  // Without a backend, pairing fails and returns to AuthScreen.
  await expect(page.getByTestId('auth-url-input')).toBeVisible();
});

test('shows error on invalid credentials', async ({ page }) => {
  await clearStoredCredentials(page);
  await page.goto('/');

  await page.getByTestId('auth-url-input').fill('http://localhost:1');
  await page.getByTestId('auth-token-input').fill('invalid-token');
  await page.getByTestId('auth-connect-button').click();

  await expect(page.getByTestId('auth-error')).toBeVisible();
});

test('stores credentials in localStorage', async ({ page }) => {
  await seedStoredCredentials(page);
  await page.goto('/');

  await expect(page.getByTestId('auth-url-input')).toHaveCount(0);
  await expect(page.getByTestId('quick-input')).toBeVisible();

  await page.reload();

  await expect(page.getByTestId('auth-url-input')).toHaveCount(0);
  await expect(page.getByTestId('quick-input')).toBeVisible();
});

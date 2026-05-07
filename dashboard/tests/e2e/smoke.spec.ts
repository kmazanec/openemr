import { expect, test } from '@playwright/test';

test('dashboard root renders', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hello dashboard' })).toBeVisible();
});

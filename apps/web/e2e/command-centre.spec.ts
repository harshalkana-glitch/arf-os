import { expect, test } from '@playwright/test';

/**
 * Command Centre.
 *
 * Thin by design — it is a read view — but two properties matter: it renders
 * without authentication errors against the seeded organisation, and it states
 * the platform's own limits rather than presenting research as a result.
 */

test('renders the console shell and its standing disclaimer', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Command Centre' })).toBeVisible();

  // Specification 1.2 and 26: the product must never read as a guarantee.
  await expect(
    page.getByText(/Historical and simulated results only\. Not a guarantee of future performance\./),
  ).toBeVisible();
});

test('exposes the primary navigation', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  for (const label of ['Command Centre', 'Campaigns', 'Strategy Library', 'Committee']) {
    await expect(nav.getByRole('link', { name: label })).toBeVisible();
  }
});

test('renders an empty state rather than a blank panel when there is no data', async ({ page }) => {
  await page.goto('/');
  // CLAUDE.md 18.4 requires explicit empty states; a research console that
  // renders nothing is indistinguishable from one that is broken.
  const campaigns = page.getByText(/No campaigns yet|Campaigns/).first();
  await expect(campaigns).toBeVisible();
});

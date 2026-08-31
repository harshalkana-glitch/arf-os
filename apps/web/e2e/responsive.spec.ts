import { expect, test } from '@playwright/test';
import { readSeed } from './global-setup';

/**
 * Regression test for a bug that shipped.
 *
 * The strategy detail page used a fixed `minmax(0, 1fr) 320px` grid with no
 * breakpoint. Below roughly 1040px the flexible column starved until it
 * reached **zero width**, and the entire evidence column — chart, metrics,
 * trades, parity — disappeared. Nothing errored; the page simply rendered
 * without the only content that matters.
 *
 * That failure is invisible at desktop size, which is exactly why it survived
 * a visual check. It gets its own viewport project so it cannot regress
 * unnoticed again.
 */

const seed = readSeed();

test('the evidence column keeps a usable width at a narrow viewport', async ({ page }) => {
  await page.goto(`/strategy-versions/${seed.strategyVersionId}`);

  const evidenceHeading = page.getByRole('heading', { name: 'Metrics' });
  await expect(evidenceHeading).toBeVisible();

  // The specific failure: a column measured in single-digit pixels.
  const box = await evidenceHeading.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(300);
});

test('the chart still renders rather than collapsing to nothing', async ({ page }) => {
  await page.goto(`/strategy-versions/${seed.strategyVersionId}`);

  const chart = page.locator('.card').filter({ hasText: 'Equity and drawdown' });
  await expect(chart.locator('svg')).toHaveCount(2);

  // A zero-width container was what stalled the chart at "Measuring…", so
  // assert real geometry rather than mere presence.
  const svg = chart.locator('svg').first();
  const box = await svg.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(200);
  await expect(chart.getByText('Measuring…')).toHaveCount(0);
});

test('wide tables scroll inside their own container rather than the page', async ({ page }) => {
  await page.goto(`/strategy-versions/${seed.strategyVersionId}`);

  // A dense trade table must not force the whole document sideways.
  const documentOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(documentOverflow).toBeLessThanOrEqual(1);
});

test('the decision panel remains reachable when the layout collapses', async ({ page }) => {
  await page.goto(`/strategy-versions/${seed.strategyVersionId}`);
  // Collapsing to one column must move the panel, not drop it.
  await expect(page.locator('.card').filter({ hasText: 'Validator recommendation' })).toBeVisible();
});

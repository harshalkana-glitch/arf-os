import { expect, test } from '@playwright/test';
import { readSeed } from './global-setup';

/**
 * The evidence page.
 *
 * These assert the labelling rules that make the page trustworthy rather than
 * merely populated. Each one guards a way a reviewer could be misled by a page
 * that "looks fine": a zero standing in for an absence, a TradingView figure
 * passing as an ARF calculation, or a parity WARN reading as a pass.
 */

const seed = readSeed();

test.beforeEach(async ({ page }) => {
  await page.goto(`/strategy-versions/${seed.strategyVersionId}`);
});

test('renders the version identity and marks a tested revision read-only', async ({ page }) => {
  await expect(page.getByRole('heading', { name: /Strategy version 1/ })).toBeVisible();
  // CLAUDE.md 18.2: a tested revision is immutable; editing creates a child.
  await expect(page.getByText('read-only')).toBeVisible();
  // The id appears in the subtitle and again in the decision panel.
  await expect(page.getByText(seed.strategyVersionId).first()).toBeVisible();
});

test('states which engine produced the evidence', async ({ page }) => {
  // CLAUDE.md 18.1: a local-runner result and a TradingView result are never
  // presented as interchangeable.
  await expect(page.locator('.provenance').filter({ hasText: 'TRADINGVIEW' }).first()).toBeVisible();
});

test('never renders an unavailable value as zero', async ({ page }) => {
  /**
   * The single most important assertion on this page.
   *
   * A TradingView export carries no per-trade commission (ADR-0002). Showing
   * 0 there would tell a validator the strategy was tested without costs,
   * which specification 16.1 treats as a hard failure — so the absence would
   * hide exactly the defect the platform exists to catch.
   */
  const feesCells = page.locator('table').filter({ hasText: 'Net (USD)' }).locator('tbody td');
  await expect(feesCells.filter({ hasText: 'n/a' }).first()).toBeVisible();

  const totalFeesRow = page.getByRole('row').filter({ hasText: 'Total fees' });
  await expect(totalFeesRow).toContainText('not available');
  await expect(totalFeesRow).not.toContainText(/\b0\.00\b/);

  // And the reason is stated, not merely the absence.
  await expect(page.getByText(/no per-trade commission/)).toBeVisible();
});

test('separates ARF-calculated metrics from TradingView-reported ones', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Metrics' })).toBeVisible();
  await expect(page.getByText('Independently calculated')).toBeVisible();
  await expect(
    page.getByText('Computed by ARF-OS from the parsed trade ledger, not read from any report.'),
  ).toBeVisible();
  await expect(page.locator('.provenance').filter({ hasText: 'ARF-CALCULATED' })).toBeVisible();
});

test('shows the reconstructed trade ledger with closed trades only', async ({ page }) => {
  const rows = page.locator('table').filter({ hasText: 'Net (USD)' }).locator('tbody tr');
  // The fixture has three trades; one is still open at the end of the test.
  await expect(rows).toHaveCount(seed.tradeCount);
  await expect(page.getByText(/An open position at the end of the test is excluded/)).toBeVisible();
});

test('renders equity and drawdown as two frames, not one dual-axis chart', async ({ page }) => {
  const chart = page.locator('.card').filter({ hasText: 'Equity and drawdown' });
  await expect(chart).toBeVisible();
  // Two separate SVG frames sharing an x-axis (CLAUDE.md 18.4).
  await expect(chart.locator('svg')).toHaveCount(2);
  await expect(chart.getByRole('img', { name: /Equity curve/ })).toBeVisible();
  await expect(chart.getByRole('img', { name: /Drawdown from peak/ })).toBeVisible();
});

test('offers an accessible table view of the chart data', async ({ page }) => {
  // CLAUDE.md 18.4 requires accessible summaries; the table is always in the
  // DOM rather than behind a control a screen reader might not reach.
  const chart = page.locator('.card').filter({ hasText: 'Equity and drawdown' });
  const summary = chart.getByText(/View as table/);
  await expect(summary).toBeVisible();
  await summary.click();
  await expect(
    chart.getByText('Reconstructed equity and closed-trade drawdown, in USD.'),
  ).toBeVisible();
});

test('exports the plotted series as CSV', async ({ page }) => {
  const chart = page.locator('.card').filter({ hasText: 'Equity and drawdown' });
  const download = page.waitForEvent('download');
  await chart.getByRole('button', { name: 'Export CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('equity-curve.csv');
});

test('links the two charts with a shared crosshair and a scoped tooltip', async ({ page }) => {
  const chart = page.locator('.card').filter({ hasText: 'Equity and drawdown' });
  const equity = chart.getByRole('img', { name: /Equity curve/ });
  await equity.hover({ position: { x: 200, y: 100 } });

  // Scope and units in the tooltip (CLAUDE.md 18.4), not a bare number.
  await expect(chart.getByText(/Equity/).first()).toBeVisible();
  await expect(chart.getByText(/USD/).first()).toBeVisible();
  await expect(chart.getByText(/Historical · closed trades · simulated/)).toBeVisible();
});

test('explains the drawdown definition rather than hiding the difference', async ({ page }) => {
  // ADR-0001: ours is closed-trade, TradingView's is intra-trade. A reviewer
  // comparing against a published figure must not read that as a defect.
  await expect(page.getByText(/Drawdown is measured on/)).toBeVisible();
  await expect(page.getByText(/ADR-0001/).first()).toBeVisible();
});

test('reports parity honestly, naming what was and was not compared', async ({ page }) => {
  const parity = page.locator('.card').filter({ hasText: 'policy' });
  await expect(parity).toBeVisible();
  // Net profit was genuinely verified against TradingView's own cumulative
  // total; drawdown deliberately was not.
  await expect(parity).toContainText('Verified on');
  await expect(parity).toContainText('net_profit');
  await expect(parity).toContainText('Not comparable');
  await expect(parity).toContainText('max_drawdown');
});

test('keeps ingestion warnings visible after a successful parse', async ({ page }) => {
  // Spec 15.2: a file that parsed with an excluded open position is still
  // worth flagging, so warnings survive success.
  await expect(page.getByText(/warning\(s\) from ingestion/)).toBeVisible();
});

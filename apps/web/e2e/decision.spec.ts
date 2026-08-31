import { expect, test } from '@playwright/test';
import { readSeed } from './global-setup';

/**
 * The decision surface.
 *
 * CLAUDE.md 18.3 forbids a one-click approval that hides evidence, and
 * CLAUDE.md 28 requires rejecting a weak strategy to be *easier* than making it
 * look strong. Those are UI properties: a policy engine that refuses correctly
 * is undone by a screen where "approve" is the path of least resistance.
 *
 * So these tests assert friction where it belongs and its absence where it
 * does not.
 */

const seed = readSeed();

test.beforeEach(async ({ page }) => {
  await page.goto(`/strategy-versions/${seed.strategyVersionId}`);
});

const decisionCard = (page: import('@playwright/test').Page) =>
  page.locator('.card').filter({ hasText: 'Validator recommendation' });

test('names the exact version under review', async ({ page }) => {
  // Never implied by page context: a decision records one immutable version.
  const card = decisionCard(page);
  await expect(card).toContainText(seed.strategyVersionId);
  await expect(card).toContainText('Source hash');
});

test('shows the validator recommendation and the case against, even when absent', async ({
  page,
}) => {
  const card = decisionCard(page);
  await expect(card).toContainText('Validator recommendation');
  await expect(card).toContainText('No validation report yet');
  await expect(card).toContainText('Strongest case against');
  await expect(card).toContainText('Not recorded');
});

test('cannot record a decision without an action', async ({ page }) => {
  const card = decisionCard(page);
  // No button at all until an action is chosen — there is nothing to click
  // through.
  await expect(card.getByRole('button', { name: 'Record decision' })).toHaveCount(0);
});

test('requires a stated reason before a decision can be recorded', async ({ page }) => {
  const card = decisionCard(page);
  await card.getByRole('combobox').selectOption('REJECTED');

  const button = card.getByRole('button', { name: 'Record decision' });
  await expect(button).toBeDisabled();

  await card.getByRole('textbox').fill('Edge disappears once realistic costs are applied.');
  await expect(button).toBeEnabled();
});

test('requires acknowledging the case against before promoting', async ({ page }) => {
  const card = decisionCard(page);
  await card.getByRole('combobox').selectOption('PAPER_APPROVAL_REVIEW');
  await card.getByRole('textbox').fill('Parity verified and validation complete.');

  const button = card.getByRole('button', { name: 'Record decision' });
  // A reason alone is not enough for a promotion: the reviewer must confirm
  // they read the evidence (CLAUDE.md 18.3).
  await expect(button).toBeDisabled();

  await card.getByRole('checkbox').first().check();
  await expect(button).toBeEnabled();
});

test('itemises required evidence rather than showing a single pass/fail light', async ({
  page,
}) => {
  const card = decisionCard(page);
  await card.getByRole('combobox').selectOption('PAPER_APPROVAL_REVIEW');
  // Each requirement is named, with a glyph and a word — never colour alone.
  await expect(card.getByText('Required evidence')).toBeVisible();
  await expect(card.getByText(/parity report/)).toBeVisible();
  await expect(card.getByText(/missing/).first()).toBeVisible();
});

test('rejection is available with no evidence and no acknowledgement', async ({ page }) => {
  /**
   * CLAUDE.md 28: it must be easier to reject a weak strategy than to make it
   * look strong. Rejection asks only for a reason.
   */
  const card = decisionCard(page);
  await card.getByRole('combobox').selectOption('REJECTED');
  await card.getByRole('textbox').fill('Insufficient out-of-sample evidence.');

  // No acknowledgement checkbox is required for a non-promoting action.
  await expect(card.getByRole('button', { name: 'Record decision' })).toBeEnabled();
});

test('surfaces the API refusal with exactly what is missing', async ({ page }) => {
  /**
   * The page must not translate a policy refusal into a generic error. A
   * reviewer needs to know which artefact to go and get.
   */
  const card = decisionCard(page);
  await card.getByRole('combobox').selectOption('PAPER_APPROVAL_REVIEW');
  await card.getByRole('textbox').fill('Attempting promotion without the evidence.');
  await card.getByRole('checkbox').first().check();

  const humanApproval = card.getByRole('checkbox').nth(1);
  if (await humanApproval.isVisible()) await humanApproval.check();

  await card.getByRole('button', { name: 'Record decision' }).click();

  await expect(card.getByText('Refused.')).toBeVisible();
  // The named missing evidence, not an opaque message.
  await expect(card).toContainText(/validation report|parity report|human approval/);
});

test('records a rejection end to end and writes it to the audit timeline', async ({ page }) => {
  const card = decisionCard(page);
  await card.getByRole('combobox').selectOption('REJECTED');
  await card
    .getByRole('textbox')
    .fill('E2E: rejected because the sample is too small for the claim.');
  await card.getByRole('button', { name: 'Record decision' }).click();

  await expect(card.getByText(/Moved to REJECTED/)).toBeVisible();

  // The decision is durable and auditable, not just a message on screen.
  await page.reload();
  const audit = page.locator('.card').filter({ hasText: 'strategy_version.transition' });
  await expect(audit).toContainText('strategy_version.transition');
  await expect(audit).toContainText('E2E: rejected because the sample is too small');
});

/**
 * End-to-end global setup.
 *
 * Migrates the test database and runs the *real* seed — the one that uploads
 * a fixture to object storage and drives it through parse, reconstruction and
 * parity. The specs then assert against records that genuinely travelled the
 * pipeline, which is the only way an end-to-end test can catch a defect the
 * unit and integration suites cannot see.
 *
 * The ids are written to a file rather than scraped from a page, so a spec
 * failure means the page is wrong, not that the test could not find its way in.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Paths are resolved from the working directory rather than import.meta.
 *
 * apps/web is a Next app and so is CommonJS by package type; Playwright loads
 * this file under that type, where import.meta is a syntax error. Playwright
 * always runs from the directory holding its config, which is the repo root.
 */
const REPO_ROOT = process.cwd();

export const SEED_FILE = resolve(REPO_ROOT, 'apps/web/e2e/.seed.json');

export interface SeedIds {
  readonly organisationId: string;
  readonly externalId: string;
  readonly strategyVersionId: string;
  readonly backtestRunId: string;
  readonly verificationId: string;
  readonly tradeCount: number;
  readonly parityStatus: string;
}

/** Read the ids the seed produced. Specs call this rather than hard-coding. */
export function readSeed(): SeedIds {
  return JSON.parse(readFileSync(SEED_FILE, 'utf8')) as SeedIds;
}

export default async function globalSetup(): Promise<void> {
  const env = {
    ...process.env,
    DATABASE_URL:
      process.env['E2E_DATABASE_URL'] ?? 'postgresql://arf:arf_local_dev@localhost:5433/arf_test',
    S3_ENDPOINT: process.env['S3_ENDPOINT'] ?? 'http://localhost:9000',
    S3_ACCESS_KEY_ID: process.env['S3_ACCESS_KEY_ID'] ?? 'arf_local',
    S3_SECRET_ACCESS_KEY: process.env['S3_SECRET_ACCESS_KEY'] ?? 'arf_local_dev_secret',
    S3_BUCKET_UPLOADS: process.env['S3_BUCKET_UPLOADS'] ?? 'arf-uploads',
    // A dedicated identity, so an e2e run never collides with the developer's
    // own seeded organisation.
    ARF_DEV_USER: 'e2e-user',
    SEED_OUTPUT: SEED_FILE,
  };

  mkdirSync(dirname(SEED_FILE), { recursive: true });

  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const run = (args: string[]): void => {
    execFileSync(pnpm, args, { cwd: REPO_ROOT, env, stdio: 'inherit', shell: true });
  };

  run(['--filter', '@arf/db', 'migrate']);
  run(['--filter', '@arf/api', 'seed']);

  const seed = readSeed();
  writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2));
  console.log(`e2e seed ready: strategy version ${seed.strategyVersionId}`);
}

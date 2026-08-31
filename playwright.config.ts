import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * CLAUDE.md 21.3 requires a Playwright path for user-visible changes. These
 * tests run against the *real* stack — the same PostgreSQL, Redis and MinIO
 * the integration tests use — because the properties worth asserting here
 * (that an unavailable value never renders as zero, that the evidence column
 * does not collapse, that approval cannot be clicked through) only exist once
 * real data has travelled the whole pipeline.
 *
 * Requires: docker compose -f infra/docker/docker-compose.yml up -d
 */
const API_PORT = 3101;
const WEB_PORT = 3100;

/** Ports distinct from the dev defaults, so a running `pnpm dev` is untouched. */
const API_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

const DATABASE_URL =
  process.env['E2E_DATABASE_URL'] ?? 'postgresql://arf:arf_local_dev@localhost:5433/arf_test';

const sharedEnv = {
  DATABASE_URL,
  ARF_ENVIRONMENT: 'local',
  S3_ENDPOINT: process.env['S3_ENDPOINT'] ?? 'http://localhost:9000',
  S3_REGION: 'auto',
  S3_ACCESS_KEY_ID: process.env['S3_ACCESS_KEY_ID'] ?? 'arf_local',
  S3_SECRET_ACCESS_KEY: process.env['S3_SECRET_ACCESS_KEY'] ?? 'arf_local_dev_secret',
  S3_BUCKET_UPLOADS: process.env['S3_BUCKET_UPLOADS'] ?? 'arf-uploads',
  S3_FORCE_PATH_STYLE: 'true',
  ARF_DEV_USER: 'e2e-user',
};

export default defineConfig({
  testDir: './apps/web/e2e',
  // Seeds the database and writes the ids the specs address.
  globalSetup: './apps/web/e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'desktop',
      // Research work is dense and desktop-first (spec 15.1).
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      // The responsive spec asserts narrow-viewport behaviour; running it here
      // would pass vacuously.
      testIgnore: /responsive.spec.ts/,
    },
    {
      /**
       * A narrow viewport is a real project rather than a single test, because
       * the failure it guards against — the evidence column starving to zero
       * width and vanishing — is invisible at desktop size and was shipped
       * once already.
       */
      name: 'narrow',
      use: { ...devices['Desktop Chrome'], viewport: { width: 900, height: 900 } },
      testMatch: /responsive\.spec\.ts/,
    },
  ],

  webServer: [
    {
      command: 'pnpm --filter @arf/api start',
      url: `${API_URL}/health/ready`,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      env: {
        ...sharedEnv,
        API_PORT: String(API_PORT),
        API_HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        // The web app is a different origin, so its writes are cross-origin.
        WEB_ORIGIN: WEB_URL,
      },
    },
    {
      // exec, not the package script: a `--` passthrough would append the port
      // after the script's own -p and Next would read it as a directory.
      command: `pnpm --filter @arf/web exec next dev -p ${WEB_PORT}`,
      url: WEB_URL,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      env: {
        ...sharedEnv,
        ARF_API_URL: API_URL,
        NEXT_PUBLIC_ARF_API_URL: API_URL,
        PORT: String(WEB_PORT),
      },
    },
  ],
});

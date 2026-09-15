import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

export default defineConfig({
  testDir: 'tests/e2e',
  // tests/e2e/local/ is a git-ignored personal suite with its own config.
  testIgnore: '**/local/**',
  timeout: 60_000,
  retries: 0,
  // Specs change global settings (short gallery URLs, forced color mode), so
  // two of them running at once would see each other's state.
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    // The isolated stack from docker-compose.e2e.yml; see scripts/e2e.sh.
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:7200',
    headless: true,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 5'] } },
  ],
});

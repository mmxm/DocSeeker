import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  timeout: 60000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false,
  workers: 1, // Exécution séquentielle pour isoler IndexedDB et OPFS
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'on-first-retry',
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--disable-web-security',
            '--enable-features=SharedArrayBuffer',
          ]
        }
      },
    },
  ],
  webServer: {
    command: './run.sh',
    url: 'http://localhost:8080/',
    reuseExistingServer: true,
    timeout: 15000,
  },
});

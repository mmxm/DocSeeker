import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  timeout: 60000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false,
  workers: 1, // Exécution séquentielle pour isoler IndexedDB et OPFS
  reporter: [['list']],
  globalSetup: './tests/ui/global-setup.mjs',
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'on-first-retry',
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      // Tests déterministes : 0 retry, aucune tolérance à la flakiness
      name: 'stable',
      testMatch: ['**/ui_core.spec.*', '**/ui_offline.spec.*'],
      retries: 0,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--disable-web-security', '--enable-features=SharedArrayBuffer'],
        },
      },
    },
    {
      // Tests de stress et cas limites : 1 retry autorisé (variance environnementale)
      name: 'stress',
      testMatch: ['**/ui_stress*.spec.*', '**/ui_edge_cases.spec.*'],
      retries: 1,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--disable-web-security', '--enable-features=SharedArrayBuffer'],
        },
      },
    },
    {
      // Tests Mobile & PWA : viewport iPhone 15 Pro sur Chromium (compatibilité rapide)
      name: 'mobile',
      testMatch: ['**/ui_mobile_pwa.spec.*'],
      retries: 1,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 393, height: 852 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        launchOptions: {
          args: ['--disable-web-security', '--enable-features=SharedArrayBuffer'],
        },
      },
    },
    {
      // Tests Mobile & PWA : VRAI MOTEUR WEBKIT (Safari iOS réel)
      name: 'mobile-webkit',
      testMatch: ['**/ui_mobile_pwa.spec.*'],
      retries: 1,
      use: {
        ...devices['iPhone 15 Pro'],
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


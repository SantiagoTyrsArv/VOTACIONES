import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173', headless: true, viewport: { width: 390, height: 844 } },
  webServer: [
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:3000/live',
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        REDIS_URL: 'redis://localhost:6379/13',
        INSTANCE_ID: 'e2e-integrada',
        LOG_LEVEL: 'silent',
        PUBLIC_WINDOW_MS: '100',
        PUBLIC_DEP_WINDOW_MS: '100',
        PUBLIC_SAFETY_SWEEP_MS: '1000',
      },
    },
    { command: 'npm run dev:jurado -- --port 5173 --strictPort', url: 'http://127.0.0.1:5173', reuseExistingServer: false, timeout: 30_000 },
    { command: 'npm run dev:publico -- --port 5174 --strictPort', url: 'http://127.0.0.1:5174/publico/', reuseExistingServer: false, timeout: 30_000 },
  ],
});

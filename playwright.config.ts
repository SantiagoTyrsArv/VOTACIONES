import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173', headless: true, viewport: { width: 390, height: 844 } },
  webServer: [
    { command: 'npm run dev --workspace @preconteo/server', url: 'http://127.0.0.1:3000/live', reuseExistingServer: false, timeout: 30_000 },
    { command: 'npm run dev --workspace @preconteo/jurado -- --port 5173 --strictPort', url: 'http://127.0.0.1:5173', reuseExistingServer: false, timeout: 30_000 },
  ],
});

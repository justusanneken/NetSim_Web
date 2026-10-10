import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const bundled = '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4402',
    launchOptions: existsSync(bundled) ? { executablePath: bundled } : {},
  },
  webServer: {
    command: 'pnpm build && pnpm preview --port 4402 --strictPort',
    url: 'http://localhost:4402',
    reuseExistingServer: true,
    timeout: 240_000,
  },
});

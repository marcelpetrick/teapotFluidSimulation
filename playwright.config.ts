// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against the production build served under a sub-path,
// mirroring GitHub Pages (https://OWNER.github.io/REPOSITORY/).
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4173/teapotFluidSimulation/', trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/serve-subpath.mjs dist 4173 /teapotFluidSimulation/',
    url: 'http://127.0.0.1:4173/teapotFluidSimulation/',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});

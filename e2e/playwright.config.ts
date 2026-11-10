// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against the production build served under a sub-path,
// mirroring GitHub Pages (https://OWNER.github.io/REPOSITORY/).
export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4173/teapotFluidSimulation/', trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/serve-subpath.mjs dist 4173 /teapotFluidSimulation/',
    cwd: '..',
    url: 'http://127.0.0.1:4173/teapotFluidSimulation/',
    // Verification must exercise this checkout's build. Reusing another preview can silently
    // validate stale assets, especially when a staged-tree pipeline runs alongside a preview.
    reuseExistingServer: false,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});

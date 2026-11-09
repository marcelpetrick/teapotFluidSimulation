# AGENTS.md — working rules for coding agents

Project: **PourLab** — browser 2D fluid experiment answering "where does poured tea come from, and does
pouring mix the pot?". Spec: [`docs/vision.md`](docs/vision.md). Plan and status: [`docs/plan.md`](docs/plan.md).
Architecture: [`docs/architecture.md`](docs/architecture.md).

## Ground rules

- Work directly on `main`. Atomic commits with [Conventional Commits](https://www.conventionalcommits.org/)
  messages (`feat:`, `fix:`, `perf:`, `test:`, `docs:`, `ci:`, `build:`, `refactor:`, `chore:`).
- Semantic versioning in `package.json`: every commit bumps the patch version
  (`scripts/bump-version.sh patch`); a major feature bumps the minor version (`... minor`).
- Every commit must be green. Use `scripts/commit.sh "type(scope): subject" [body…]`: it runs the full
  pipeline on exactly the staged tree (`scripts/verify-staged.sh`) and commits and pushes only on success.
  Never pipe the verification through `tail` or similar in a way that hides its exit status.
- Keep line/statement/function coverage ≥ 95 % (branches ≥ 85 %), enforced in `vite.config.ts`.
- GPL-3.0-or-later. New files start with `// SPDX-License-Identifier: GPL-3.0-or-later` and
  `// Copyright (C) 2026 Marcel Petrick`.
- Pin dependencies exactly. **TypeScript stays on 6.0.x** until typescript-eslint supports 7.x.
- Every control in the UI needs a tooltip (`src/ui/help.ts`); a test enforces this.
- Layer colours in every look must pass the colour-vision-deficiency palette validation; colours always
  follow the immutable layer labels (glow is drawn underneath, never instead).
- Sound stays off until the user turns it on; audio is generated (Web Audio), no audio files or network.

## Physics honesty rules (from the vision)

- Never manufacture outflow or results; never delete parcels to hit a target.
- Origin labels are immutable; colours derive from labels only. Metrics come from raw parcel state.
- Numerical stabilisers are logged and swept; they are not physics.
- Keep runs deterministic: whole stable substeps only, independent of how time is chunked; record
  manual inputs.
- Performance changes must keep the reference pour bit-for-bit identical, or be justified, re-calibrated
  (`scripts/calibrate-anticipation.ts`) and documented in `docs/validation.md`.
- Show model limits beside results; label 2D-equivalent volumes.
- The browser 3D view is a **recording** of the offline CPU solver, which runs about 60× slower than real
  time. Always label it as a recording; never present it as live.
- A real-time WebGPU 3D solver is planned (`docs/plan.md`, phase F). When it is built, it must reproduce
  the CPU 3D results within the stated tolerances before it replaces or sits beside the recording.
  Without WebGPU, the page falls back to the recording.

## Layout

| Path           | Purpose                                                               |
| -------------- | --------------------------------------------------------------------- |
| `src/sim/`     | Browser-independent solver, geometry, motion, metrics, config, export |
| `src/worker/`  | Worker host (testable, time-budgeted pumping) and worker entry        |
| `src/render/`  | Canvas scene and charts                                               |
| `src/ui/`      | App, shape editor, tooltip texts                                      |
| `src/audio/`   | Generated soundscape and pour sound                                   |
| `src/sim3d/`   | Offline 3D reference solver (Node only, not part of the web app)      |
| `src/view3d/`  | Recorded-3D playback viewer (three.js, lazily loaded) and its format  |
| `public/data/` | Recorded 3D pour served with the site (`scripts/record3d.ts`)         |
| `tests/`       | Vitest unit and integration tests (happy-dom for UI)                  |
| `e2e/`         | Playwright tests against the built site under the Pages sub-path      |
| `scripts/`     | Helper scripts, documented in `scripts/README.md`                     |
| `benchmarks/`  | Benchmark, profile and performance runners plus committed results     |
| `docs/`        | Physics, validation, architecture, sources                            |
| `media/`       | Showcase GIFs, named with the version they were rendered from         |

## Commands

`npm ci`, `npm run dev`, `npm test`, `npm run coverage`, `npm run build`, `npm run e2e`,
`./localPipeline.sh`, `npx tsx benchmarks/profile.ts`, `npx tsx scripts/render-gif.ts <preset> <out.gif>`.

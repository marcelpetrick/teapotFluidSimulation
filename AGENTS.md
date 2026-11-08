# AGENTS.md — working rules for coding agents

Project: **PourLab** — browser 2D fluid experiment answering "where does poured tea come from, and does
pouring mix the pot?". Product spec: [`vision.md`](vision.md). Living plan: [`plan.md`](plan.md).

## Ground rules

- Work directly on `main`. Atomic commits with [Conventional Commits](https://www.conventionalcommits.org/)
  messages (`feat:`, `fix:`, `test:`, `docs:`, `ci:`, `build:`, `refactor:`, `perf:`, `chore:`).
- Semantic versioning in `package.json`: every commit bumps the patch version
  (`scripts/bump-version.sh patch`); a major feature bumps the minor version (`scripts/bump-version.sh minor`).
- Every commit must be green: run `./localPipeline.sh` before committing, then push.
- Keep unit/integration line coverage at or above 95 % (enforced in `vite.config.ts`).
- Licence: GPL-3.0-or-later. New source files start with the SPDX header:
  `// SPDX-License-Identifier: GPL-3.0-or-later` and `// Copyright (C) 2026 Marcel Petrick`.
- Pin dependencies to exact versions.

## Physics honesty rules (from the vision)

- Never manufacture outflow or results; never delete parcels to hit a target.
- Origin labels are immutable and never averaged; colours derive from labels only.
- Metrics come from raw parcel state, never from rendered pixels.
- Numerical stabilisers must be logged and swept; they are not physics.
- Show model limits beside results; label 2D-equivalent volumes.

## Layout

| Path | Purpose |
|---|---|
| `src/sim/` | Browser-independent solver, geometry, motion, metrics, config, export |
| `src/worker/` | Worker host (testable) and worker entry |
| `src/render/` | Canvas scene and charts |
| `src/ui/app.ts` | Main-thread app with injected dependencies |
| `tests/` | Vitest unit and integration tests |
| `e2e/` | Playwright tests against the built site under the Pages sub-path |
| `scripts/` | Reusable helper scripts (documented in `scripts/README.md`) |
| `benchmarks/` | Headless benchmark and refinement runners |
| `docs/` | Physics, validation, sources |

## Commands

`npm ci`, `npm run dev`, `npm test`, `npm run coverage`, `npm run build`, `npm run preview`,
`npm run e2e`, `./localPipeline.sh` (everything, as CI runs it).

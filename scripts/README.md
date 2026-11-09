# Scripts

Small reusable helpers. All are run from the repository root.

| Script                      | Purpose                                                                                                                                                                     | Usage                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `../localPipeline.sh`       | Full pipeline (install, format, Markdown links, lint, typecheck, coverage ≥ 95 %, build, e2e). CI runs exactly this.                                                        | `./localPipeline.sh [--no-e2e] [--no-install]`                     |
| `verify-staged.sh`          | Runs the pipeline on **exactly the staged files** (exported into a temp dir with `node_modules` linked), so a commit is proven green before it is made.                     | `scripts/verify-staged.sh [--no-e2e]`                              |
| `commit.sh`                 | Verify-then-commit: runs `verify-staged.sh` and only commits (and pushes) if it passes.                                                                                     | `scripts/commit.sh "type(scope): subject" [body] [--no-push]`      |
| `bump-version.sh`           | Bumps `package.json`/lockfile version without tagging. Patch for every commit, minor for major features. Prints the new version.                                            | `scripts/bump-version.sh patch\|minor\|major`                      |
| `calibrate-anticipation.ts` | Bisects the pour controller's return anticipation for a preset so the automated pour lands near its target. The result goes into `src/sim/config.ts`. Never removes liquid. | `npx tsx scripts/calibrate-anticipation.ts <presetId> [quality]`   |
| `serve-subpath.mjs`         | Static server for `dist/` under a sub-path, mimicking GitHub Pages; used by Playwright.                                                                                     | `node scripts/serve-subpath.mjs dist 4173 /teapotFluidSimulation/` |
| `screenshot.ts`             | Captures a full-page screenshot (default `docs/screenshot.png`; optional look and mode arguments) from the built site mid-pour with Playwright.                             | `npm run build && npx tsx scripts/screenshot.ts`                   |

More helpers:

- `check-links.mjs` — fails if a relative link or image in any tracked Markdown file is broken (pipeline
  stage): `node scripts/check-links.mjs`.

- `render-gif.ts` — renders a looping showcase GIF of a preset from the production build, frame by
  frame with single simulation steps (deterministic), via ffmpeg:
  `npm run build && npx tsx scripts/render-gif.ts glass-gentle media/pourlab-vX.Y.Z-glass-teapot.gif 12`.
- `measure-browser.ts` — frame rate and simulated-time throughput in headless Chromium and Firefox:
  `npm run build && npx tsx scripts/measure-browser.ts > benchmarks/browser.json`.
- `../benchmarks/profile.ts` — share of run time per solver phase:
  `npx tsx benchmarks/profile.ts teapot-gentle 44 3`.
- `../benchmarks/run.ts` / `../benchmarks/perf.ts` — verification/sensitivity cases and isolated
  throughput (see `docs/validation.md`).
- `../benchmarks/cavity.ts` — thermal verification, differentially heated cavity vs de Vahl Davis:
  `npx tsx benchmarks/cavity.ts 48 1000 10000 100000`.
- `../benchmarks/mg.ts` — MIC(0) vs multigrid pressure preconditioner: `npx tsx benchmarks/mg.ts 96 1`.
- `../benchmarks/run3d.ts` — offline 3D reference pour: `npx tsx benchmarks/run3d.ts 5 25` (about 12 min).
- `render3d.ts` — labelled 3D playback GIF of that run:
  `npx tsx scripts/render3d.ts media/pourlab-vX.Y.Z-3d-teapot.gif 5 14 cyber`.

Typical commit flow:

```bash
scripts/bump-version.sh patch      # or minor for a major feature
git add <files>
scripts/commit.sh "feat(sim): ..."  # verifies the staged tree, then commits and pushes
```

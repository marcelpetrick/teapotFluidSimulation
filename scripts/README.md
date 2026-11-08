# Scripts

Small reusable helpers. All are run from the repository root.

| Script                      | Purpose                                                                                                                                                                     | Usage                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `../localPipeline.sh`       | Full pipeline (install, format, lint, typecheck, coverage ≥ 95 %, build, e2e). CI runs exactly this.                                                                        | `./localPipeline.sh [--no-e2e] [--no-install]`                     |
| `verify-staged.sh`          | Runs the pipeline on **exactly the staged files** (exported into a temp dir with `node_modules` linked), so a commit is proven green before it is made.                     | `scripts/verify-staged.sh [--no-e2e]`                              |
| `commit.sh`                 | Verify-then-commit: runs `verify-staged.sh` and only commits (and pushes) if it passes.                                                                                     | `scripts/commit.sh "type(scope): subject" [body] [--no-push]`      |
| `bump-version.sh`           | Bumps `package.json`/lockfile version without tagging. Patch for every commit, minor for major features. Prints the new version.                                            | `scripts/bump-version.sh patch\|minor\|major`                      |
| `calibrate-anticipation.ts` | Bisects the pour controller's return anticipation for a preset so the automated pour lands near its target. The result goes into `src/sim/config.ts`. Never removes liquid. | `npx tsx scripts/calibrate-anticipation.ts <presetId> [quality]`   |
| `serve-subpath.mjs`         | Static server for `dist/` under a sub-path, mimicking GitHub Pages; used by Playwright.                                                                                     | `node scripts/serve-subpath.mjs dist 4173 /teapotFluidSimulation/` |
| `screenshot.ts`             | Captures the README screenshot (`docs/screenshot.png`) from the built site mid-pour with Playwright.                                                                        | `npm run build && npx tsx scripts/screenshot.ts`                   |

Typical commit flow:

```bash
scripts/bump-version.sh patch      # or minor for a major feature
git add <files>
scripts/commit.sh "feat(sim): ..."  # verifies the staged tree, then commits and pushes
```

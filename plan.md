# PourLab implementation plan

Source of truth: [`vision.md`](vision.md). This plan maps the vision to verifiable work and records
status. `[x]` done and verified (test, benchmark or e2e named), `[ ]` open.

## Decisions

- **Stack:** TypeScript, Vite, dedicated module Web Worker, Canvas 2D, no UI framework (vision §6, §18.5).
- **Solver:** own 2D PIC/FLIP on a staggered MAC grid (Bridson & Müller-Fischer); MAC-APIC as a
  switchable scheme (§18.3). No third-party simulation code.
- **Pressure:** matrix-free PCG with MIC(0), residual-controlled, failures counted, gauge fixing (§18.6).
- **Geometry:** analytic capsule-polyline SDF in pot coordinates (tabulated far field, exact near walls);
  the pot moves through a fixed world grid with gravity fixed downward (§7).
- **Walls:** free-slip, voxelised on the pressure grid (documented limitation).
- **Stabiliser:** position-only density correction, two-sided in interior cells, logged.
- **Discharge:** oriented section through the lip tip, segment-crossing test, counted once.
- **Controller:** eased tilt-in, slow hold tilt, C¹ return started from measured discharge plus calibrated
  anticipation (`scripts/calibrate-anticipation.ts`); manual tilt with recorded inputs.
- **Determinism:** whole stable substeps only; results independent of how time is chunked.
- **Worker:** steps continuously in time-budgeted chunks; rendering pulls the latest state (§6).
- **Licence:** GPL-3.0-or-later. **Docker:** dropped by the owner. **Delivery:** Actions → GitHub Pages.
- **TypeScript stays on 6.0.x** until typescript-eslint supports TypeScript 7.

## Status by phase

### A — smallest trustworthy solver (§13 A)

- [x] SI configuration, deterministic seeding, open-tank case — `tests/solver.test.ts`
- [x] Pressure residual, divergence, occupancy and ledger diagnostics — diagnostics panel, `tests/pressure.test.ts`
- [x] Hydrostatic rest and advection tests — `tests/solver.test.ts`

### B — physically meaningful pouring (§13 B)

- [x] Moving walls with wall-velocity fluxes, smooth tilt — tunnelling test
- [x] Rim pitcher, low-inlet spout teapot, German glass teapot, user-drawn pots — `tests/vessel.test.ts`
- [x] Outflow counted once, spill/loss ledger, return-to-upright controller — solver tests, ≤ 1 % of target
- [x] 1.5 L / 400 mL scenario end to end — e2e

### C — answer the question (§13 C, §8, §18.2)

- [x] Immutable origin bands, pathlines (relative to the pot), origin highlight, poured-parcel initial map
- [x] Cumulative and 50 mL composition, B ratios, region matrix, multi-scale S, survivor cohort — `tests/metrics.test.ts`
- [x] Presets from §10 incl. no-pour control, tilt-only, fast/slow, pitcher, repeated, thermal
- [x] JSON/CSV/PNG export with limitations, provenance and manual input history — e2e
- [x] Explanations of advection, stirring, diffusion and model limits; tooltips on every control

### D — verify, polish, publish (§13 D, §11, §12)

- [x] `localPipeline.sh` (format, lint, typecheck, coverage ≥ 95 %, build, e2e) mirrored by Actions
- [x] GitHub Pages deployment — <https://marcelpetrick.github.io/teapotFluidSimulation/>
- [x] Playwright e2e in Chromium and Firefox under the Pages sub-path
- [x] Refinement, APIC comparison, dissipation sweep, performance — `docs/validation.md`
- [x] README, physics, architecture (C4), validation, sources, third-party notices, showcase GIFs
- [x] `/reviewBranch` findings fixed; dependencies checked (`/updateDependencies`)
- [ ] `/githubAbout`, public release

### E — thermal and higher fidelity (§13 E, Versions 2–3)

- [x] Passive and Boussinesq-coupled temperature, diffusion, wall/surface cooling
- [x] Thermal verification: analytic diffusion decay, buoyancy direction, heat inventory
- [ ] Standard natural-convection benchmark (differentially heated cavity)
- [ ] Physical experiments and a 3D reference solver — need the owner (§14)

## Owner tasks (vision §14)

Real pot dimensions, lid/vent/tea-bag details, filmed pours with collected mass, a reference laptop for
performance sign-off. Until then the generic labelled geometries are used, as the vision prescribes.

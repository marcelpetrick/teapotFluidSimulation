# PourLab implementation plan

Source of truth: [`vision.md`](vision.md). This plan maps the vision to verifiable work and records
status. `[x]` done and verified (test, benchmark or e2e named), `[ ]` open.

Current evidence: [requirements matrix](requirements.md).
Owner-dependent inputs: [questions](../questions.md).
The represented-volume drift gate remains unmet; see [validation](validation.md).
A completed implementation phase does not establish physical validation.

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
- [x] `/reviewBranch` findings fixed (two rounds); dependencies checked (`/updateDependencies`)
- [x] `/githubAbout` applied; public releases v0.5.5 and v0.6.2
- [x] End-to-end runs of the nine most common configurations in Chromium and Firefox, checked physically

- [x] Faster solver evaluated: multigrid PCG implemented and measured, not faster than MIC(0) at these sizes (kept optional) — `benchmarks/mg.ts`

### Review and performance pass

- [x] Correct viewer lifetimes, startup races, timeline scalar data and overlapping exports — regression tests.
- [x] Improve the wall appearance, shape editor, touch targets and phone-width layout.
- [x] Profile default and maximum parcel rendering; preserve exact reference-pour state during collision acceleration.
- [x] Trace 151 vision requirements and check matrix structure in the pipeline.
- [x] Correct unsupported validation and runtime-dependency claims; provide short operating instructions.
- [ ] Physical validation and real-phone performance — owner inputs remain in `questions.md`.

### Product extras (owner requests)

- [x] Pot shape editor, manual tilt, particles per cell, finer resolution, tooltips on every control
- [x] German glass teapot model
- [x] Switchable cyber neon look (validated neon palette), light/dark/auto mode buttons
- [x] Generated space soundscape and pour sound (Web Audio, off by default)
- [x] Showcase GIFs in `media/` (lab and cyber looks), named with the rendered version
- [ ] Measure performance on a real phone

### E — thermal and higher fidelity (§13 E, Versions 2–3)

- [x] Passive and Boussinesq-coupled temperature, diffusion, wall/surface cooling
- [x] Thermal verification: analytic diffusion decay, buoyancy direction, heat inventory
- [x] Standard natural-convection benchmark: differentially heated cavity vs de Vahl Davis — `benchmarks/cavity.ts`, `tests/cavity.test.ts`
- [x] 3D reference solver (offline, cylindrical teapot with a round spout): 2D layer shares confirmed within ~3 points — `src/sim3d/`, `benchmarks/run3d.ts`
- [ ] Physical experiments — need the owner (§14)

### F — real-time 3D in the browser (WebGPU)

Goal (owner request): run the 3D teapot pour **live and interactively in the browser in real time** on the
owner's laptop: an Intel Iris Xe and an NVIDIA RTX A2000 Laptop GPU (8 GB), with 20 CPU threads.

The CPU 3D solver is about 60× slower than real time at 5 mm cells, so the page first only played a
recording (see README, "Does it hold in 3D?"). The GPU port keeps the same method family, so results stay
comparable with `src/sim3d/` and the recording. Done: the live mode runs at real time on that laptop.

- [x] Port the 3D PIC/FLIP step to WebGPU compute shaders (WGSL) — `src/gpu3d/`:
  - particle-to-grid transfer with atomic or sort-based scatter;
  - grid-to-particle transfer, advection, SDF wall handling with moving-wall fluxes;
  - density correction.
- [x] Use a GPU-parallel pressure solver, because MIC(0) is sequential (Chebyshev-preconditioned CG in one
      workgroup, same residual tolerance as the CPU solver):
  - candidates are multigrid-preconditioned CG (MGPCG) or Jacobi/red-black Gauss–Seidel PCG;
  - acceptance requires the same divergence tolerance as the CPU solver.
- [x] Verify against the CPU 3D solver for the 5 mm gentle pour — `scripts/verify-gpu.ts`,
      `benchmarks/gpu3d.json`, `e2e/gpuSolver.spec.ts` (−0.05 % volume, shares within 0.53 points):
  - poured volume within 1 %;
  - layer shares within 2 points;
  - no lost parcels;
  - add a headless test path (Node WebGPU, or a Playwright run with WebGPU enabled) to CI where feasible.
- [x] Add a live 3D mode in the existing three.js viewer — `src/view3d/live.ts`, `e2e/gpuSolver.spec.ts`:
  - start, pause and reset; tilt and preset controls;
  - ~~parcels rendered straight from the GPU buffer, with no CPU readback per frame~~ — changed: on a
    hybrid-GPU laptop Chromium cannot present a WebGPU canvas from the discrete GPU (device lost on
    the shared-image import), so the parcel positions are read back once per frame (about 1 MB) and
    drawn with WebGL. Measured: no loss of speed (the live pour holds 1.00× real time).
- [x] Performance target on the owner's laptop: at least 1× real time at 5 mm cells (about 90 k parcels, full
      pot), measured and recorded in `docs/validation.md` — 1.81× on the RTX A2000 (solver only), the
      live page holds 1.00× (capped at the chosen speed).
- [x] Fallback: if the browser has no WebGPU, keep playing the recording and tell the user why (the live
      button is disabled with the reason; a failed start says why) — `tests/app.test.ts`.

## Owner tasks (vision §14)

Real pot dimensions, lid/vent/tea-bag details, filmed pours with collected mass, a reference laptop for
performance sign-off. Until then the generic labelled geometries are used, as the vision prescribes.

# PourLab implementation plan

Source of truth: [`vision.md`](vision.md). This plan maps every vision section to concrete work,
in delivery order. Status markers: `[x]` done, `[ ]` open. Keep this file current with each commit.

## Decisions (made by the implementing agent)

- **Stack:** TypeScript, Vite, a dedicated module Web Worker, Canvas 2D, no UI framework (vision §6, §18.5).
- **Solver:** own implementation of 2D PIC/FLIP on a staggered MAC grid after Bridson & Müller-Fischer
  (no third-party simulation code copied, so no MIT notice obligations; see `THIRD_PARTY_NOTICES.md`).
  APIC (MAC formulation) as a switchable transfer scheme for the controlled comparison (§18.3, §18.7).
- **Pressure:** matrix-free PCG with MIC(0) preconditioner, residual-controlled with iteration cap,
  failure counting and gauge fixing for enclosed liquid (§18.6).
- **Geometry:** analytic capsule-polyline SDF in pot-local coordinates; vessel moves through a stationary
  world grid with gravity fixed downward; wall velocity = ω × (x − pivot) (§7).
- **Walls:** free-slip, voxelised on the pressure grid (documented limitation).
- **Numerical stabiliser:** position-only density correction (never written into parcel velocities),
  logged separately; two-sided in interior cells to avoid an expansion bias.
- **Discharge:** counted when a parcel crosses an oriented section through the spout/lip tip, detected
  on the segment between old and new pot-local positions; counted once; spills and losses separate.
- **Pour controller:** smooth tilt-in, slow further tilt during hold, C¹ Hermite return. Return starts
  when measured discharge plus anticipated in-transit flow reaches the target. Anticipation per preset is
  calibrated with `scripts/calibrate-anticipation.ts`; actual discharge and overshoot are always reported.
- **Licence:** GPL-3.0-or-later with SPDX headers. **Docker:** dropped by the owner.
- **Delivery:** GitHub Actions mirrors `localPipeline.sh` and deploys `dist/` to GitHub Pages.

## Phases

### A — smallest trustworthy solver (§13 A)

- [x] SI configuration, deterministic seeding (mulberry32), open-tank case
- [x] Pressure residual, divergence, occupancy, ledger diagnostics
- [ ] Unit tests: hydrostatic rest, projection, advection, determinism, ledger

### B — physically meaningful pouring (§13 B)

- [x] World-frame moving walls, smooth tilt trajectories, moving-wall pressure fluxes
- [x] Rim pitcher and explicit low-inlet spout teapot geometries
- [x] Outflow section crossing, spill/loss ledger, return-to-upright controller
- [ ] Tests: wall tunnelling, outflow-once, controller phases

### C — answer the question (§13 C, §8, §18.2)

- [x] Immutable origin bands (equal volume), pathlines, initial-position poured map
- [x] Cumulative + 50 mL bin composition, B ratios, origin-to-region matrix
- [x] Multi-scale segregation S, survivor-cohort analysis, plain-language summary
- [x] Presets: still, gentle, fast, slow, tilt-only, pitcher, repeated, thermal (§10)
- [x] JSON record + CSV export with limitations and provenance (§9)
- [x] Explanations of advection, stirring, diffusion, model limits

### D — verify, polish, publish (§13 D, §11, §12)

- [ ] `localPipeline.sh`: format, lint, typecheck, unit+integration tests with ≥95 % coverage, build, e2e
- [ ] GitHub Actions mirror + GitHub Pages deployment
- [ ] Playwright e2e in Chromium and Firefox under the Pages sub-path
- [ ] Benchmarks: resolution ladder, PIC/FLIP vs APIC, dissipation sweep → `docs/validation.md`
- [ ] README with badges, screenshot, setup/testing/pipeline/usage docs; `docs/physics.md`, `docs/sources.md`
- [ ] `/reviewBranch`, fixes, `/githubAbout`, final vision checklist

### E — thermal and higher fidelity (§13 E, Version 2/3)

- [x] Passive and Boussinesq-coupled temperature, diffusion, wall/surface cooling coefficients
- [ ] Thermal verification tests (diffusion decay, buoyancy direction, inventory)
- Physical experiments and a 3D reference solver require the owner (§14) and are documented as open.

# Verification and validation report

Verification asks whether the equations are solved correctly; validation asks whether the model predicts
real pouring. PourLab has **verification evidence** (below) but **no validation against physical
experiments yet** (vision §11, owner tasks §14). All numbers are reproducible:

```bash
npx tsx benchmarks/run.ts > benchmarks/results.json     # all cases (or one id / prefix*)
npx tsx benchmarks/perf.ts > benchmarks/perf.json       # isolated solver throughput
npm run build && npx tsx scripts/measure-browser.ts      # browser frame rate and throughput
```

Raw data: [`benchmarks/results.json`](../benchmarks/results.json), [`perf.json`](../benchmarks/perf.json),
[`browser.json`](../benchmarks/browser.json). Machine: 12th Gen Intel Core i9-12900H, Linux, Node 24,
Chromium 158, Firefox 159.

## Automated verification tests (`npm test`, run on every commit)

| Check              | Criterion                                                             | Result                                                                                      |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Hydrostatic rest   | max speed < 2 cm/s after 2 s, centroid drift < 2 mm, no volume change | passes (max speed 0.02 m/s at 44 cells)                                                     |
| Projection         | post-projection divergence ≤ before; PCG residual converged           | 1e-5–2e-4 1/s, 0 failures in all cases                                                      |
| Uniform advection  | median position error of a translated block                           | < 1e-5 m; only the voxelised wall layer (≤ 2/44 of parcels) is slowed — a stated limitation |
| Moving walls       | no parcel penetrates a tilting wall, no volume lost                   | max penetration 0                                                                           |
| Outflow            | each parcel counted at most once; ledger closes                       | ledger error < 1e-12 mL                                                                     |
| Determinism        | same seed → identical positions; different seed differs               | passes                                                                                      |
| Origin labels      | equal-volume bands, immutable through a run                           | passes                                                                                      |
| Analytic diffusion | decay rate of a cosine temperature mode in an insulated column        | measured 0.106 1/s vs analytic 0.0987 1/s (+7 %, cell-discretised column height)            |
| Buoyancy           | cool-over-warm overturns, warm-over-cool stays quiet                  | kinetic energy ratio > 5                                                                    |
| Cooling            | mean temperature falls; heat inventory incl. boundary losses          | inventory error < 2 %                                                                       |

## Engineering gates (vision §11)

| Gate                     | Target                                                     | Measured                                                                                      | Status |
| ------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------ |
| Represented-volume drift | < 1 % (short runs)                                         | interior parcel density 1.000 ± 0.001 with density correction (1.07 without)                  | pass   |
| Pour accuracy            | within 5 % of 400 mL                                       | 399.6 (gentle), 403.0 (fast), 400.5 (slow), 401.1 (pitcher), 397.1 (glass), 400.7 (repeat) mL | pass   |
| Refinement               | finest two resolutions within 5 points per origin fraction | 64 vs 96 cells: max difference 1.4 points                                                     | pass   |
| Browser frame rate       | ≥ 30 rendered fps with responsive controls                 | 60 fps animation; 45 (Chromium) / 47 (Firefox) fresh simulation frames per second             | pass   |
| Firefox and Chrome       | same preset completes and exports a valid record           | e2e in both, JSON record parsed                                                               | pass   |

## Thermal benchmark: differentially heated cavity (`benchmarks/cavity.ts`)

Standard natural-convection test (de Vahl Davis 1983, Pr = 0.71): closed square box filled with liquid,
hot left wall, cold right wall, adiabatic floor and lid, no-slip walls, Boussinesq buoyancy. Runs until
both wall Nusselt numbers are steady and balanced (or 150 s). Reference Nu: 1.118 / 2.243 / 4.519.

| Ra  | Cells | Nu hot | Nu cold | Nu mean | Error                      |
| --- | ----- | ------ | ------- | ------- | -------------------------- |
| 10³ | 32    | 1.146  | 1.157   | 1.151   | +3.0 %                     |
| 10³ | 48    | 1.128  | 1.157   | 1.142   | +2.2 %                     |
| 10⁴ | 32    | 2.159  | 2.187   | 2.173   | −3.1 %                     |
| 10⁴ | 48    | 2.269  | 2.283   | 2.276   | +1.5 %                     |
| 10⁵ | 32    | 3.829  | 4.052   | 3.940   | −12.8 % (not fully steady) |
| 10⁵ | 48    | 4.169  | 4.138   | 4.153   | −8.1 %                     |
| 10⁵ | 64    | 4.373  | 4.455   | 4.414   | −2.3 %                     |

Reading: the thermal mode reproduces the benchmark within ~3 % where the boundary layers are resolved,
and converges toward the reference with refinement at Ra = 10⁵ (thin boundary layers). The vision's
precondition for interpreting tea thermal experiments (§11) is met for laminar convection at these
Rayleigh numbers; real tea-pot convection (Ra ≫ 10⁸) remains beyond a 2D model. A fast version
(Ra = 10³, 24 cells, within 10 %) runs in the unit tests on every commit.

## 3D reference (`src/sim3d/`, `benchmarks/run3d.ts`)

Offline 3D PIC/FLIP solver (same method family as 2D: MAC grid, MIC(0)-PCG, moving-wall fluxes,
position-only density correction, lip-section accounting) with a **cylindrical teapot** (inner radius
6.5 cm, 1.5 L fill 11.3 cm deep) and a **round 2 cm spout** at 45° with its inlet 3.5 cm above the floor.
The pot and tilt are mirror-symmetric, so one half is simulated behind a free-slip symmetry plane. Same
pour motion and controller as the 2D gentle pour (anticipation not re-calibrated for 3D).

| Model | Cells    | Parcels     | Poured   | Bottom / middle / top | Spilled / lost |
| ----- | -------- | ----------- | -------- | --------------------- | -------------- |
| 3D    | 5 mm     | 45 k (half) | 406.8 mL | 27.7 / 51.9 / 20.3 %  | 0 / 0          |
| 3D    | 4 mm     | 89 k (half) | 410.5 mL | 29.2 / 51.0 / 19.8 %  | 0 / 0          |
| 2D    | 64 cells | 11 k        | 401.9 mL | 27.0 / 50.7 / 22.3 %  | 0 / 0          |
| 2D    | 96 cells | 25 k        | 417.6 mL | 27.4 / 49.3 / 23.3 %  | 0 / 0          |

Reading: the two 3D resolutions agree within 1.5 points per layer, and **3D agrees with 2D within about
3 points**. For a low-inlet spout teapot the 2D answer survives the step to 3D: about half of the poured
tea comes from the middle third, a little more from the bottom third than from the top. Limits: no surface tension or wetting, free-slip walls, coarse
spout resolution (4–5 cells across the bore), no physical validation; `scripts/render3d.ts` renders a
labelled playback GIF of the run.

## End-to-end configuration checks (`e2e/configurations.spec.ts`, every CI run)

Each common configuration runs to completion in the real browsers (production build, worker) and must
pour within its range with nothing spilled or lost. Measured on the last local run:

| Preset                    | Chromium | Firefox  | Layer shares bottom / middle / top |
| ------------------------- | -------- | -------- | ---------------------------------- |
| Spout teapot, gentle      | 400.2 mL | 400.2 mL | 25 / 52 / 23 %                     |
| Spout teapot, fast        | 398.5 mL | 398.5 mL | 33 / 51 / 16 %                     |
| Spout teapot, slow        | 403.9 mL | 401.6 mL | 20 / 52 / 28 %                     |
| German glass teapot       | 398.5 mL | 400.2 mL | 0 / 39 / 61 %                      |
| Pitcher                   | 396.9 mL | 400.2 mL | 1 / 41 / 58 %                      |
| Repeated 2 × 200 mL       | 397.9 mL | 398.7 mL | 21 / 49 / 30 %                     |
| Warm above cool (thermal) | 399.0 mL | 399.0 mL | 25 / 53 / 22 %                     |
| Still pot, tilt only      | 0 mL     | 0 mL     | —                                  |

Within one engine a run is reproducible (whole substeps, independent of timing). Between engines a few
mL can differ because Math functions differ in the last bits and the flow amplifies that; the vision
accepts this (§11, no bitwise equality across engines).

Phone layout (iPhone 13 viewport, emulated): no horizontal scrolling; the default pour runs at about
77 % of real time on the emulating laptop. Real-device performance was not measured.

## Refinement and numerical sensitivity (gentle 400 mL pour, teapot)

| Case                     | Parcels | Poured mL | Bottom / middle / top % | Survivor S (2 cm) start → end |
| ------------------------ | ------- | --------- | ----------------------- | ----------------------------- |
| FLIP 0.95, 44 cells      | 5 259   | 399.6     | 25.3 / 52.4 / 22.3      | 0.541 → 0.362                 |
| FLIP 0.95, 64 cells      | 11 174  | 401.9     | 27.0 / 50.7 / 22.3      | 0.543 → 0.334                 |
| FLIP 0.95, 96 cells      | 25 357  | 417.6     | 27.4 / 49.3 / 23.3      | 0.540 → 0.378                 |
| 96 cells, half time step | 25 357  | 408.9     | 26.9 / 50.2 / 22.9      | 0.540 → 0.357                 |
| APIC, 44 cells           | 5 259   | 398.7     | 26.3 / 50.5 / 23.2      | 0.539 → 0.336                 |
| APIC, 64 cells           | 11 174  | 413.9     | 27.6 / 50.0 / 22.3      | 0.543 → 0.342                 |
| FLIP 0.80                | 5 259   | 388.2     | 21.0 / 55.3 / 23.7      | 0.545 → 0.413                 |
| FLIP 1.00                | 5 259   | 400.7     | 27.0 / 50.6 / 22.4      | 0.539 → 0.303                 |
| no density correction    | 5 259   | 393.0     | 25.8 / 52.5 / 21.7      | 0.538 → 0.358                 |
| seed 2                   | 5 266   | 397.4     | 23.9 / 53.5 / 22.6      | 0.540 → 0.354                 |

Reading: the **origin composition is robust** (± 3 points across resolution, scheme, time step and seed),
so "mostly mid-height liquid plus the spout contents" is a stable answer for this geometry. The
**mixing score is more sensitive**: the FLIP fraction moves the final survivor S between 0.30 and 0.41,
so numerical dissipation influences the "how much did it stir" number. APIC was not adopted as default:
it matches PIC/FLIP within noise at higher bookkeeping cost; it stays available as a setting.

## Controls and comparisons

| Case                         | Poured                  | Survivor S (2 cm) start → end | Meaning                               |
| ---------------------------- | ----------------------- | ----------------------------- | ------------------------------------- |
| Still pot, 7 s               | 0                       | 0.531 → 0.517                 | numerical drift baseline              |
| Tilt 4° and return, no spill | 0                       | 0.530 → 0.506                 | motion alone rearranges little        |
| Gentle pour                  | 399.6 mL                | 0.541 → 0.362                 | pouring clearly rearranges what stays |
| German glass teapot          | 397.1 mL, 0 / 37 / 63 % | 0.447 → 0.364                 | top lip pours the top layer           |
| Pitcher (rim lip)            | 401.1 mL, 1 / 41 / 58 % | 0.487 → 0.344                 | rim pours from the surface            |
| Repeated 2 × 200 mL          | 400.7 mL                | 0.533 → 0.311                 | repeated tilting mixes more           |

## Performance

Solver throughput, default 400 mL pour (`benchmarks/perf.json`, Node, isolated):

| Cells across pot | Parcels | Simulated s per wall-clock s |
| ---------------- | ------- | ---------------------------- |
| 44 (default)     | 5 259   | 1.21 (faster than real time) |
| 64               | 11 174  | 0.41                         |
| 96               | 25 357  | 0.12                         |
| 128              | ~45 000 | 0.04                         |

Browser, default preset (`benchmarks/browser.json`): animation at 60 fps; fresh simulation frames 49
per second in both engines; simulated time at 0.95× (Chromium) and 0.68× (Firefox) real time. When the
browser cannot keep up, simulated time slows and the status line says so; the step never grows.

Profile (`npx tsx benchmarks/profile.ts teapot-gentle 44 3`): advection 25 %, pressure projection 21 %,
density-correction solve 17 %, cell classification 10 %, transfers 13 %. Optimisations applied so far
keep results bit-for-bit identical (verified on the reference pour): a tabulated far-field wall distance
with an exact near-wall fallback, allocation-free inner loops, and inlined viscosity masks — together
about 1.4× since the first release. Warm-starting the pressure solves was tried and **rejected**: only
2–6 % faster because the free surface changes the system every substep, while giving up bit-identical
results. The next real step would be a multigrid pressure solver or a WebAssembly/WebGPU backend
(vision §18.5), both deliberately deferred until profiling justifies them.

## Not done (needs the owner or a later version)

- Physical experiments (dyed cold-water pours, collected mass, filmed tilt) and comparison.
- A finer 3D study (more than 5 cells across the spout bore) and a 3D thermal model.
- Thermal validation against measured cooling of a real pot (the convection benchmark above verifies the
  implementation, not the tea).

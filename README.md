# PourLab — where does poured tea come from?

[![Pipeline](https://github.com/marcelpetrick/teapotFluidSimulation/actions/workflows/pipeline.yml/badge.svg?branch=main)](https://github.com/marcelpetrick/teapotFluidSimulation/actions/workflows/pipeline.yml)
[![Live demo](https://img.shields.io/badge/demo-GitHub%20Pages-0b5f99.svg)](https://marcelpetrick.github.io/teapotFluidSimulation/)
[![Latest release](https://img.shields.io/github/v/release/marcelpetrick/teapotFluidSimulation?sort=semver)](https://github.com/marcelpetrick/teapotFluidSimulation/releases/latest)
[![License: GPL v3 or later](https://img.shields.io/badge/license-GPLv3%20or%20later-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178c6.svg)](https://www.typescriptlang.org/)
[![Coverage ≥ 95%](https://img.shields.io/badge/coverage-%E2%89%A595%25-brightgreen.svg)](vite.config.ts)
[![e2e](https://img.shields.io/badge/e2e-Chromium%20%7C%20Firefox-informational.svg)](e2e/app.spec.ts)

**Pour 400 mL from a 1.5 L teapot: which water ends up in your cup, and does pouring stir the rest?**
PourLab answers that with a real 2D fluid simulation in your browser — every parcel of tea keeps the
colour of the layer it started in.

**▶ Try it: <https://marcelpetrick.github.io/teapotFluidSimulation/>** — no install, no account.

![Cyber look: German glass teapot pouring from its top layer](media/pourlab-v0.7.3-cyber-glass-teapot.gif)

| Teapot with a low spout                                                                                      | German glass teapot (lip at the top)                                       |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| ![Spout teapot pouring](media/pourlab-v0.7.3-spout-teapot.gif)                                               | ![German glass teapot pouring](media/pourlab-v0.7.3-glass-teapot.gif)      |
| Liquid leaves through a low inlet: **25 % bottom, 52 % middle, 23 % top** layer, plus what sat in the spout. | Liquid can only leave over the rim: **0 % bottom, 39 % middle, 61 % top**. |

## Does it hold in 3D?

![3D reference: cylindrical teapot with a round spout](media/pourlab-v0.9.0-3d-teapot.gif)

An offline 3D reference (cylindrical 1.5 L teapot, real round 2 cm spout) gives **29 % bottom, 51 %
middle, 20 % top** for the same pour — within about 3 points of the 2D model. The thermal mode is checked
against the standard heated-cavity benchmark. Details: [`docs/validation.md`](docs/validation.md).

**The 3D view on the live page is a recording, not a live simulation.** **Open 3D view** plays back the
output of the offline 3D solver. You can rotate, zoom and pan freely while it pours, but you cannot change
its parameters. The reason is speed: the 3D solver runs on the CPU, and computing one pour takes far too
long to watch live.

| Run                                     | Simulated pour | Compute time (one CPU core) | Compared with real time |
| --------------------------------------- | -------------- | --------------------------- | ----------------------- |
| 3D, 5 mm cells, 45 k parcels (half pot) | 11.5 s         | 684 s (≈ 11 min)            | ~60× slower             |
| 3D, 4 mm cells, 89 k parcels (half pot) | 11.5 s         | 1 636 s (≈ 27 min)          | ~140× slower            |
| 2D default (live in the browser)        | —              | —                           | 1.2× faster             |

Most of the cost is the 3D pressure solve on a 66×66×18 grid, which has about 40× the cells of the 2D
grid, at every substep. A coarser grid would not be fast enough either, and it would leave the 2 cm
spout only 2–3 cells wide, too coarse to trust the layer shares. So the pour is computed once offline
(`scripts/record3d.ts`, numbers in [`benchmarks/run3d.json`](benchmarks/run3d.json)) and replayed at
60 fps. A real-time 3D solver on the GPU (WebGPU) is planned: see [`docs/plan.md`](docs/plan.md).

## What you can do

- **Pour** to a 400 mL target automatically, or **tilt by hand** with a slider.
- Pick a **pot model** — spout teapot, German glass teapot, pitcher — or **draw your own pot**.
- Tune **fill, tilt timing, resolution (up to 128 cells), particles per cell (up to 16)**, transfer
  scheme and **thermal effects** (warm-over-cool layering, cooling convection).
- Read the answer: composition of the poured tea, over-representation per layer, a map of where the
  poured tea started, mixing scores, and how the rest was rearranged.
- Switch the **look** between a clean lab view and **cyber neon** (glass panels, glowing liquid).
- Turn on **sound**: a generated space ambience plus a pouring sound that follows the flow.
- **Share** a link that reproduces the exact experiment; export **JSON**, **CSV** and **PNG**.

Every control has a tooltip that explains what it does. Model limits are always shown next to the
results: this is a qualitative 2D model, not a calibrated digital twin of your teapot.

## Run locally

```bash
npm ci
npm run dev          # http://localhost:5173
```

Requires Node.js ≥ 22. `npm run build` produces a static `dist/` that works on any sub-path.

## Quality

|                      |                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./localPipeline.sh` | format → lint → typecheck → unit and integration tests with **≥ 95 % coverage** → build → **e2e in Chromium and Firefox**                                           |
| CI                   | [GitHub Actions](.github/workflows/pipeline.yml) runs the same script and deploys to GitHub Pages                                                                   |
| Physics checks       | hydrostatic rest, projection convergence, moving-wall tunnelling, outflow counted once, ledger closure, determinism, analytic diffusion, buoyancy, refinement study |

## Documentation

- [`docs/physics.md`](docs/physics.md) — equations, discretisation, controller, metrics and their limits
- [`docs/validation.md`](docs/validation.md) — measured verification, refinement, sensitivity and performance
- [`docs/architecture.md`](docs/architecture.md) — C4 diagrams and runtime flowcharts
- [`docs/sources.md`](docs/sources.md) — literature used
- [`scripts/README.md`](scripts/README.md) — helper scripts (verified commits, GIF rendering, calibration, …)
- [`docs/vision.md`](docs/vision.md) · [`docs/plan.md`](docs/plan.md) · [`AGENTS.md`](AGENTS.md) — specification, plan, contributor rules

## How it was built

| Area                 | What is used                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Physics              | 2D incompressible Navier–Stokes with a free surface: hybrid particle/grid **PIC/FLIP** (optional **APIC**) on a staggered MAC grid, **PCG pressure solver with MIC(0)** preconditioning, moving-wall boundary fluxes, analytic signed-distance vessel geometry, Boussinesq buoyancy for the thermal mode (verified against the de Vahl Davis heated cavity), an offline 3D reference solver — all written from the published algorithms, no simulation library |
| Language and runtime | **TypeScript** (strict), plain DOM, **Canvas 2D** rendering, **three.js** (WebGL) for the recorded 3D view, a dedicated **Web Worker** for the solver, **Web Audio API** for the generated soundscape — no UI framework, no runtime dependencies                                                                                                                                                                                                               |
| Build and hosting    | **Vite** static build, **GitHub Pages**, **GitHub Actions**                                                                                                                                                                                                                                                                                                                                                                                                    |
| Quality              | **Vitest** with V8 coverage (≥ 95 %), **happy-dom** for UI integration tests, **Playwright** end-to-end tests in Chromium and Firefox, **ESLint** (typescript-eslint), **Prettier**, one `localPipeline.sh` shared by developers and CI                                                                                                                                                                                                                        |
| Media and analysis   | **ffmpeg** for the GIFs (rendered deterministically from the real app), benchmark/profiling scripts in `benchmarks/`, a colour-vision-deficiency palette validator for the layer colours                                                                                                                                                                                                                                                                       |
| AI                   | Designed from the written specification in [`docs/vision.md`](docs/vision.md) and implemented with **Claude Code** (Anthropic, model **Claude Opus 5.5**): plan, code, tests, reviews and docs, with every commit verified by the full pipeline before it was pushed                                                                                                                                                                                           |

## License

Copyright (C) 2026 Marcel Petrick &lt;mail@marcelpetrick.it&gt;. Free software under the
[GNU GPL v3 or later](LICENSE). Generated with AI from the specification in [`docs/vision.md`](docs/vision.md).

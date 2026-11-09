# Architecture

PourLab is a static web application: everything runs in the visitor's browser. The diagrams follow the
[C4 model](https://c4model.com/) (context → containers → components) and add flowcharts for the two
runtime loops that matter: the simulation substep and the render/worker exchange.

## Level 1 — System context

```mermaid
C4Context
  title PourLab - system context
  Person(visitor, "Visitor", "Curious tea drinker, teacher or engineer")
  Person(dev, "Maintainer", "Develops and releases PourLab")
  System(pourlab, "PourLab", "Browser fluid experiment: where does poured tea come from, does pouring mix the pot?")
  System_Ext(pages, "GitHub Pages", "Static hosting of the built site")
  System_Ext(gha, "GitHub Actions", "Runs localPipeline.sh and deploys")
  Rel(visitor, pourlab, "Runs experiments, changes settings, draws pots, exports records", "HTTPS, browser")
  Rel(pages, pourlab, "Serves HTML/JS/CSS")
  Rel(dev, gha, "Pushes to main")
  Rel(gha, pages, "Deploys dist/")
```

## Level 2 — Containers

```mermaid
C4Container
  title PourLab - containers (all inside the visitor's browser)
  Person(visitor, "Visitor")
  System_Boundary(browser, "Browser tab") {
    Container(ui, "Main thread UI", "TypeScript, Canvas 2D", "Controls, settings, shape editor, rendering, charts, tables, exports, look and mode switches")
    Container(audio, "Soundscape", "Web Audio API", "Generated space ambience and a pour sound driven by the discharge rate")
    ContainerDb(prefs, "localStorage", "Per-viewer preferences", "Chosen look and light/dark mode")
    Container(worker, "Simulation worker", "TypeScript Web Worker", "Steps the solver continuously; answers frame requests with the latest state")
    ContainerDb(url, "URL query", "Query string", "All settings incl. a drawn pot: reproducible share links")
  }
  System_Ext(pages, "GitHub Pages")
  Rel(visitor, ui, "Clicks, drags, keyboard")
  Rel(ui, worker, "init / play / pause / step / tilt / speed / frame / export", "postMessage")
  Rel(worker, ui, "ready / frame (transferable snapshots) / export / error", "postMessage")
  Rel(ui, url, "Reads and writes settings")
  Rel(ui, audio, "enable / volume / pour level")
  Rel(ui, prefs, "Remembers look and mode")
  Rel(pages, ui, "Static files")
```

## Level 3 — Components

```mermaid
C4Component
  title PourLab - components
  Container_Boundary(main, "Main thread") {
    Component(app, "App", "src/ui/app.ts", "Settings form, playback, timeline, comparison, exports, tooltips")
    Component(editor, "ShapeEditor", "src/ui/shapeEditor.ts", "Drag-and-drop pot outline")
    Component(scene, "Scene renderer", "src/render/scene.ts", "Vessel, parcels, pathlines, arrows, glass, initial map")
    Component(charts, "Charts", "src/render/charts.ts", "Bins, bias, time series")
    Component(help, "Tooltips", "src/ui/help.ts", "What every control is and what it influences")
    Component(sound, "Soundscape", "src/audio/soundscape.ts", "Drones, space wind, shimmer, pour noise")
    Component(view3d, "3D viewer", "src/view3d/ (three.js, lazy chunks)", "Recorded or live 3D pour with orbit, zoom and pan")
    Component(gpu3d, "WebGPU 3D solver", "src/gpu3d/ (WGSL compute)", "Live 3D PIC/FLIP on the GPU; verified against src/sim3d")
  }
  Container_Boundary(wk, "Worker") {
    Component(host, "SimulationHost", "src/worker/host.ts", "Command handling, time-budgeted pumping, metrics snapshots")
    Component(solver, "Simulation", "src/sim/solver.ts", "MAC grid, PIC/FLIP or APIC, projection, advection, ledger, thermal")
    Component(pressure, "PressureSolver", "src/sim/pressure.ts", "PCG with MIC(0) or a multigrid V-cycle (src/sim/multigrid.ts)")
    Component(vessel, "Vessel geometry", "src/sim/vessel.ts", "Capsule SDF, outflow section, pose transforms")
    Component(motion, "PourController", "src/sim/motion.ts", "Automatic pour or manual tilt")
    Component(metrics, "Metrics", "src/sim/metrics.ts", "Composition, bins, region matrix, segregation, survivor cohort")
    Component(record, "Experiment record", "src/sim/experiment.ts", "JSON/CSV export, model limits")
  }
  Component(config, "Config", "src/sim/config.ts", "Presets, settings validation, URL round-trip, drawn pots")
  Rel(app, editor, "hosts")
  Rel(app, help, "applies")
  Rel(app, sound, "drives")
  Rel(app, view3d, "opens on demand; fetches data/pour3d.bin.gz")
  Rel(view3d, gpu3d, "live mode: steps the solver, reads positions back per frame")
  Rel(app, scene, "draws with")
  Rel(app, charts, "draws with")
  Rel(app, config, "validates settings")
  Rel(app, host, "messages")
  Rel(host, solver, "advance / snapshot")
  Rel(host, metrics, "computes")
  Rel(host, record, "exports")
  Rel(solver, pressure, "solves")
  Rel(solver, vessel, "collides / classifies")
  Rel(solver, motion, "asks for tilt")
```

## Offline verification and reference tools (Node, not shipped to the browser)

```mermaid
flowchart LR
  subgraph sim[src/sim]
    S2[2D Simulation]
  end
  subgraph s3[src/sim3d]
    S3[Simulation3D: 3D MAC grid, MIC0-PCG 3D, cylindrical teapot with round spout]
  end
  B1[benchmarks/run.ts: refinement and sensitivity] --> S2
  B2[benchmarks/cavity.ts: heated cavity vs de Vahl Davis] --> S2
  B3[benchmarks/mg.ts: MIC0 vs multigrid] --> S2
  B4[benchmarks/run3d.ts: 3D reference pour] --> S3
  R1[scripts/render-gif.ts: GIFs from the built app] --> APP[Production build]
  R2[scripts/render3d.ts: 3D playback GIF] --> S3
  R3[scripts/record3d.ts: recording for the browser 3D view] --> S3
  R3 --> D[(public/data/pour3d.bin.gz)]
  R4[scripts/verify-gpu.ts: GPU vs CPU in headless Chromium] --> G[src/gpu3d WebGPU solver]
  G -->|seeded from| S3
  R4 --> J
  B1 --> J[(benchmarks/*.json)]
  B2 --> J
  B4 --> J
  J --> V[docs/validation.md]
```

## Simulation substep

```mermaid
flowchart TD
  A[Controller: tilt at t+dt<br/>wall angular velocity] --> B[Classify cells<br/>solid / liquid / air]
  B --> C[Particles to grid<br/>PIC/FLIP or APIC]
  C --> D[Gravity, buoyancy,<br/>viscosity]
  D --> E[Moving-wall face velocities]
  E --> F[PCG pressure solve<br/>residual + divergence logged]
  F --> G[Extrapolate velocities]
  G --> H[Grid to particles]
  H --> I[Density correction<br/>positions only, logged]
  I --> J[RK2 advection<br/>SDF collision at t+dt]
  J --> K{Crossed lip section?}
  K -- yes --> L[Discharged, counted once]
  K -- no --> M{Left the pot elsewhere?}
  M -- yes --> N[Spilled]
  M -- no --> O[Stays in pot]
  L --> P[Thermal transport]
  N --> P
  O --> P
```

## Render loop and worker exchange

```mermaid
sequenceDiagram
  participant R as requestAnimationFrame
  participant A as App (main thread)
  participant W as Worker loop
  participant H as SimulationHost
  loop every 0-50 ms
    W->>H: pump(now): advance toward real time x speed,<br/>at most 12 ms of work, bounded time debt
  end
  loop every display frame
    R->>A: tick()
    alt running and no request in flight
      A->>W: {type: frame}
      W->>H: handle(frame)
      H-->>W: latest snapshot, diagnostics, metrics every 6th frame
      W-->>A: frame (transferable buffers)
      A->>A: store frame for the timeline, draw scene and panels
    end
  end
```

## Delivery pipeline

```mermaid
flowchart LR
  dev[Commit] --> vs[scripts/verify-staged.sh<br/>pipeline on the staged tree]
  vs --> push[git push main]
  push --> gha[GitHub Actions: localPipeline.sh]
  gha --> f[format] --> l[lint] --> t[typecheck] --> c[tests + coverage >= 95 %] --> b[build] --> e[e2e Chromium + Firefox]
  e --> d[Deploy dist/ to GitHub Pages]
```

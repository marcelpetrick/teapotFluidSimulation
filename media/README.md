# README demonstrations

The README now uses v0.13.8 browser captures. The v0.7.3 2D clips showed the old heavy pot
outline and omitted current interface labels. The v0.9.0 3D clip was a separate flat projection;
the replacement shows the actual browser viewer and its explicit **Recorded 3D simulation** label.
Older versioned files remain historical assets.

The 2D clips use the production build, immutable origin colours, real solver steps, and current
collector and initial-map views. The capture hides sidebar charts below the initial map to avoid
including a half-visible chart at the crop boundary. Frames target intervals of 1/15 simulated second; a capture can
overshoot a target by one UI step because the solver completes whole stable substeps.
The GIF is an illustration of the calculated flow, not a measurement of browser execution speed.
The 3D capture seeks through the existing offline CPU recording in the current viewer. It does
not rerun the CPU solver or claim live GPU computation. This is the 5 mm recording (407 mL,
28/52/20% by origin); the README identifies the separate 4 mm benchmark explicitly. All clips end with a short hold and loop.

Each GIF has an adjacent `.gif.json` sidecar with the app version, source commit and dirty source
paths, browser, preset, dimensions, frame count and captured simulation times. A version bump and
capture-script edit can be uncommitted during capture; the sidecar records that provenance explicitly.
The release commit contains the complete script and application version.

Reproduce from the repository root with ffmpeg and Playwright Chromium installed:

```bash
npm run build
npx tsx scripts/render-gif.ts glass-gentle media/pourlab-v0.13.8-cyber-glass-teapot.gif 12 960 cyber
npx tsx scripts/render-gif.ts teapot-gentle media/pourlab-v0.13.8-spout-teapot.gif 12 640 lab
npx tsx scripts/render-gif.ts glass-gentle media/pourlab-v0.13.8-glass-teapot.gif 12 640 lab
npx tsx scripts/render-gif.ts recording3d media/pourlab-v0.13.8-3d-teapot.gif 12 760 lab
```

Use a new versioned filename when controls, drawing, colours, result labels or the demonstrated
physics change. Inspect initial, pouring and final frames, check readable labels and complete crops,
then decode every frame with ffmpeg and verify the README links. A dependency-only patch does not
require new media unless it changes the picture. The README also links a still screenshot for readers
who prefer it.

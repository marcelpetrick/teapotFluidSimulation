# Performance evidence

## Follow-up: paced redraws exposed a hidden bottleneck

The original synchronous test did not measure frame cadence.
A paced test of v0.13.4 found about **10.9 redraw opportunities/s** at 180,035 parcels despite 11.6 ms CPU submission.
The browser still had expensive raster work after submission.

The new opaque origin renderer visits every parcel and writes a reusable pixel buffer.
It composites that image over the vessel. It does not change positions, statuses, labels or solver resolution.
Squares snap to canvas pixels, so their edge appearance can differ from the antialiased path renderer.
Glow, transparency, shape markers and unsupported browsers retain the ordinary renderer.

| Paced case                                    | Before redraw opportunities/s | After redraw opportunities/s | Before / after p95 frame interval |
| --------------------------------------------- | ----------------------------: | ---------------------------: | --------------------------------: |
| Desktop default, paused                       |                          60.0 |                         60.0 |                    16.7 / 16.8 ms |
| Desktop maximum, paused                       |                          10.9 |                         60.0 |                   100.1 / 16.8 ms |
| Desktop default, actively pouring             |                          60.0 |                         60.0 |                    16.7 / 16.8 ms |
| Phone-sized viewport, 4× CPU slowdown, paused |                          60.0 |                         60.0 |                    16.7 / 16.7 ms |

These are brief, sequential local samples: five warmup frames followed by thirty paced redraws.
They measure requestAnimationFrame cadence, including scheduling and event-loop work.
They do not prove GPU completion, sustained physical simulation at maximum resolution, or real-phone performance.
Raw samples and environment details: [red-team-ui.json](../benchmarks/red-team-ui.json).

`npx tsx scripts/measure-ui.ts` now records both submission cost and paced intervals, plus an active-pour case.
The ten synchronous samples below remain historical evidence from the first review.
Use the helper from tag v0.13.4 to reproduce that earlier protocol.

## What the measurements mean

Measure rendering and solver time separately.
A fast renderer does not establish real-time simulation or physical accuracy.
The maximum tested 2D configuration has **180,035 parcels**: 128 cells across the body and 16 parcels per cell.

Machine: Intel Core i9-12900H, Linux, Node 24.20.0, headless Chromium 158.
The phone case uses a 390-pixel viewport and Chromium's 4× CPU slowdown.
It does not emulate a phone GPU, battery, thermal throttling or memory limit.

## Rendering changes

The original renderer changed canvas colour for every parcel.
It also redrew the initial-position map after every position update.

The new renderer skips redundant colour changes.
Consecutive opaque rectangles share a path. Transparent colours and glow retain individual compositing.
The initial-position map updates only when the experiment, statuses or theme change.
All parcels remain in the solver and metrics. Rendering does not discard parcels or alter origin labels.

| Paused render-call cost                                | Before median | After median |       Change |
| ------------------------------------------------------ | ------------: | -----------: | -----------: |
| Desktop, default 5,259 parcels                         |        2.8 ms |       0.6 ms |  4.7× faster |
| Desktop, maximum 180,035 parcels                       |      147.4 ms |      11.2 ms | 13.2× faster |
| Phone-sized viewport, default parcels, 4× CPU slowdown |       10.6 ms |       2.0 ms |  5.3× faster |

These are ten synchronous render-call samples in a paused, initially seeded scene.
They measure CPU submission cost. They do not include asynchronous raster completion or certify an animation frame rate.
They do not measure a pouring maximum-resolution solver. Rendering every frame while pouring can invalidate the map more often.
Timings vary with background activity, browser warmup and hardware.

Run the current paced measurement:

```bash
npm run build
npx tsx scripts/measure-ui.ts
```

Before and after raw observations are stored in [review-performance.json](../benchmarks/review-performance.json).
The default running-browser measurement remains separate:

```bash
npx tsx scripts/measure-browser.ts
```

## Exact collision acceleration

The wall-distance query previously scanned every segment near a wall.
The new lookup stores possible nearest segments for each static geometry cell.
It evaluates exact distances only for those candidates, in their original order.

The candidate bound uses the distance function's Lipschitz property.
A segment farther than the nearest centre distance plus twice the cell radius cannot become nearest inside that cell.
Queries outside the table still scan all segments.

The [geometry test](../tests/vessel.test.ts) compares accelerated and full scans across all six vessel types.
It checks both distances and gradients at 12,000 deterministic sample locations.

Three full 14-second gentle pours were run in each checkout, after a warmup.
Median solver time fell from **9.064 s to 8.875 s**, about **2.1% less time**.
The lookup increases initialization cost: median **8.0 ms to 11.0 ms** in this run.
This trades a small one-time cost and packed lookup memory for repeated query savings.
The first array-per-cell prototype was rejected for higher memory use.
The packed version uses 32-bit offsets and segment indices.
Observed process peak resident memory was about 105 MiB in the separate baseline run and 110–116 MiB in the three optimized runs.
These process figures include Node, the loader, warmup and garbage collection; they are not browser memory limits.
The small solver-time difference should be treated as a local observation, not a guaranteed speedup.

Every run completed 3,157 steps with 5,259 parcels.
The before and after state hashes are identical:

```text
3f3a9d3ab48c192a165f52a7f41adc9c1d79f4b009cac82fb8a3aac1402dadc9
```

The hash covers positions, velocities, temperatures, statuses, origins, exit times, grid velocities, pressure and selected ledger history.
Wall-clock diagnostics are excluded. No change to calibration or solver tolerances was needed.

Reproduce the comparison using a clean checkout of the original commit:

```bash
npx tsx benchmarks/review-profile.ts /path/to/original-checkout 3
npx tsx benchmarks/review-profile.ts . 3
```

The original checkout is `839ccf2`. Use the same installed dependency versions in both checkouts.
Run the measurements without concurrent validation suites.
The helper also records process resident and peak resident memory. These include Node and the TypeScript loader.

## Remaining bottlenecks and limits

Pressure projection and density correction remain major solver costs.
The current numerical method is preserved; pressure tolerances were not loosened to obtain speed.
Maximum-resolution simulation still runs slower than the default.

Actual phone speed remains unmeasured. Start at 44 cells and four parcels per cell.
Use the lab look for the cheapest drawing path.
See [questions](../questions.md) for the requested reference phone.

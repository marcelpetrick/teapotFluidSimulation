# PourLab: where does poured tea come from?

> Historical specification, written before implementation. Its unchecked tasks are preserved.
> See [requirements](requirements.md) for current evidence and [plan](plan.md) for delivery status.

## 1. Purpose and handoff

Build an interactive browser experiment that answers a surprisingly difficult everyday question: **when we pour tea, which parts of the liquid leave, which parts replace them, and how much does pouring mix what remains?**

This document is the product vision, physics explanation, research starting point, implementation specification, validation plan, and task backlog. It is intended to be handed directly to a coding agent. The current deliverable is this plan; no application, simulation results, repository, or deployment is claimed to exist yet.

Research checked: 8 November 2026. Recommendations below are engineering choices, not findings from an already validated teapot simulation. Source numbers refer to the bibliography at the end.

### The user's motivating scenario

- A transparent glass teapot contains approximately 1.5 litres of tea.
- Water was initially boiling and has cooled to roughly 70 °C.
- A person tilts the pot and pours approximately 400 mL into a glass.
- They want to see whether the liquid comes mainly from near the outlet, from the surface, from the bottom, or from throughout the pot.
- They want to know whether this action meaningfully stirs the remaining tea.
- The result should be attractive, interactive, runnable in Firefox and Chrome, and publishable as a static GitHub Pages site.

Interpretation: assume “1.5 litres” refers to the initial liquid amount. Treat the tea bag as optional; its size, presence during pouring, and position remain unspecified. A 1.5 L liquid fill requires a larger vessel with headspace. Do not silently equate nominal pot capacity with liquid fill.

### Core deliverable

A visitor can press **Pour 400 mL**, watch coloured fluid parcels move through a transparent vessel, and inspect a measured origin breakdown of the discharged liquid. They can compare pouring with leaving the pot still and with tilting it without spilling. The app explains the limits of the model beside the results.

The best first version is a **2D incompressible free-surface liquid simulation using a hybrid PIC/FLIP particle-and-grid method**, with physical units, repeatable motion, material labels, and diagnostics. It is a qualitative scientific instrument under development, not a calibrated digital twin of the user's pot. The extended research and implementation decision in section 18 retain this baseline, add a controlled APIC comparison, and specify exactly which results answer the original question.

## 2. Answers to the physical questions

### Is only the water beside the outlet affected?

No. The water crossing the outlet at an instant is locally beside that outlet, but it has arrived there along a trajectory. As liquid leaves, the interior velocity and pressure fields evolve throughout the connected body of water. Other liquid moves toward the discharge path, the free surface falls and changes shape, and tilting the vessel drives additional motion.

The replacement is not a rigid queue in which the next-nearest molecule always leaves next. The full velocity field determines trajectories. Regions can feed the outlet directly, recirculate, or move comparatively little. Incompressibility means the liquid approximately preserves volume locally; it does not mean every part moves equally fast. Air enters the headspace through the open top or vent as liquid leaves. A blocked vent introduces a different, potentially glugging, problem outside the first model. [1]

### Does the liquid come mainly from the surface or the bottom?

There is no universal answer. An open mug pours over a rim; a teapot can have a spout whose inlet connects much lower in the body. These are materially different geometries. Initially, liquid already in a filled spout can leave first. Subsequent sources depend on inlet height, fill, spout resistance, tilt history, and internal circulation.

Surface-origin liquid is not guaranteed to leave first through a low inlet. Conversely, a low inlet does not guarantee that a whole bottom layer drains before anything else. Label initial regions and measure their trajectories rather than choosing either answer in advance.

### Does pouring create currents?

Yes. Gravity, pressure gradients, moving boundaries, inertia, and viscous stresses drive flow. Starting and stopping the tilt can generate sloshing; walls and the spout redirect flow. Returning the pot upright may rearrange the liquid further. A gentle pour can move liquid along relatively orderly paths, while a rapid motion can create stronger deformation and circulation. Greater visible motion does not automatically imply uniform mixing. [1]

### Is 70 °C tea uniform in temperature?

A temperature reading of 70 °C does not establish that every part is 70 °C. The answer depends on how the water was added, the waiting time, the glass and surroundings, lid state, evaporation, and existing currents.

At these temperatures, warmer water is generally less dense. Cooling at walls and at the free surface can generate descending cooler fluid and compensating circulation. Warm-over-cool layering can resist vertical overturning; surface cooling can destabilize such a layer. A real cooling pot can have both boundary currents and regions with smaller gradients. Do not assume either a perfectly stationary temperature gradient or perfectly uniform water. [4, 5]

Heat and dissolved tea do not diffuse at the same rate. A visually uniform temperature is not proof that tea concentration is uniform. An initial uniform-temperature simulation is useful for isolating pouring, but it deliberately omits thermal convection.

### Does pouring stir the entire pot?

It can redistribute and mix liquid, but the amount is an empirical question for a specified geometry and motion. Some regions may exchange strongly while others remain comparatively isolated. The answer should be reported as measurements for particular scenarios, not a universal percentage.

Separate four concepts:

| Concept | What it means | What to measure |
|---|---|---|
| Advection | Liquid parcels change position | Trajectories and origin-to-destination maps |
| Stirring | Flow stretches, folds, and interleaves material | Regional exchange and coarse-scale composition |
| Molecular mixing | Diffusion smooths concentration differences | A concentration field with an explicit diffusivity |
| Selective removal | A region disproportionately exits the pot | Discharge composition versus starting composition |

Without diffusion, an ideal material label stays attached to its parcel even if the parcels become finely interleaved. A software solver can also blur colours numerically. Neither a pretty swirl nor a smoother image alone demonstrates molecular mixing.

### Is the receiving glass relevant?

Yes, but it is a separate control volume. The incoming jet can mix the collected liquid even when the pot retains substantial stratification. First answer where the discharged liquid came from and what happens inside the pot. Simulating the receiving glass is a later extension. In version 1, show a collector composition graphic explicitly labelled as an accounting view, not simulated cup flow.

### Has this already been studied?

There is relevant literature on free-surface flows, mixing, thermal convection, selective withdrawal, and pouring. The commonly named **teapot effect** concerns liquid adhering to the outside of a spout or edge instead of detaching cleanly; it does not directly answer which interior regions mix during a 400 mL pour. Studies on liquid poured into another liquid address jet-driven mixing in the receiving container, another related but distinct question. [6, 7]

The research conducted for this brief did not establish a directly matching quantitative study for a 1.5 L glass teapot at 70 °C pouring 400 mL. This is a limited search outcome, not a claim that no such study exists. Do not import a mixing percentage from a superficially similar paper.

## 3. Questions the app must make testable

1. What fraction of the discharged 400 mL began in each initial layer or region?
2. How does the origin composition change through the first, middle, and final portions of the pour?
3. How much exchange occurs between interior regions among the liquid that remains?
4. Does returning upright contribute more rearrangement than the outward tilt?
5. How do slow and fast pours differ when they discharge the same volume?
6. How does a rim-pouring vessel differ from a low-inlet spout?
7. How do stable temperature layering and cooling-induced convection change the answer?
8. How much of an apparent result changes with numerical resolution, dissipation, and sampling scale?

Working hypotheses to test, not conclusions: outlet geometry changes origin bias; tilt acceleration matters; a visually quiet bulk can feed the outlet; repeated tilting can increase exchange; buoyancy can alter transport; some apparent homogenization can be selective removal rather than stirring.

## 4. Scope and release stages

### Version 1: an honest, compelling mechanical experiment

Include a 2D cross-section, uniform-density liquid, an open free surface, prescribed vessel motion, a functional spout or rim, material-origin colours, target-volume pouring, replay, charts, exports, and a no-pour control. Use gravity and a pressure solve; particles must not follow hand-authored paths.

Exclude boiling, evaporation, tea extraction chemistry, full air dynamics, sealed lids, surface wetting and drips, flexible tea bags, physically simulated receiving-cup mixing, and claims of quantitatively accurate 3D tea behaviour. These exclusions must be visible in an accessible model panel.

### Version 2: thermal and experimental comparison

Add temperature transport, thermal diffusion, Boussinesq buoyancy for modest temperature differences, configurable wall/surface cooling, and comparison with filmed experiments. A passive temperature colour mode may precede this, but must state that temperature does not yet affect motion.

### Version 3: higher-fidelity reference

Compare selected scenarios with a converged 3D offline solver and measured real-vessel experiments. Browser playback of precomputed results is acceptable and should be labelled as playback. A browser WebGPU or WebAssembly backend is an optimization option after the baseline works, not a prerequisite.

## 5. Methods and existing tools

Finite elements are possible for fluid simulation, but free-surface tracking, moving geometry, and browser integration add substantial work. There is no reason to require finite elements specifically for this question.

| Approach or tool | Benefit | Principal issue | Decision |
|---|---|---|---|
| Hybrid PIC/FLIP on a staggered grid | Pressure projection plus parcels whose origins can be tracked | Moving walls, free surfaces, and transfer noise need care | Recommended first implementation |
| SPH / incompressible SPH | Particle identity and free surfaces fit the visual question | Boundary consistency, density errors, neighbour search, and solver tuning | Credible alternative if a suitable tested implementation is available |
| Position-based fluids | Useful for robust interactive visuals | Constraint settings can distort physical interpretation | Optional demo route; not the default quantitative route |
| Grid finite-volume + VOF | Strong route for conservation and interface tracking | More implementation work for an interactive browser product | Offline reference or later upgrade |
| Finite element + interface tracking | Flexible discretization and multiphysics | Larger engineering scope | Not required for the first release |
| Fixed-domain smoke/dye effects | Often visually attractive and fast | May lack an actual liquid surface and moving-container physics | Reject as the core simulation |
| Rigid-body engines | Useful for solid motion | Rigid particles are not incompressible water | Do not substitute for a liquid solver |

**Ten Minute Physics:** a browser FLIP demonstration and teaching material provide a practical starting reference. They demonstrate feasibility, not validated pouring or mixing. The episode 18 HTML source inspected during follow-up research contains an MIT license header. Preserve its copyright and license notices, and record the exact revision incorporated. [2]

**SPlisHSPlasH:** an established SPH research library with multiple incompressibility solvers, 2D/3D support, and particle export. Its documentation states an MIT license. Consider it for offline reference work; do not assume it is a drop-in browser package or that an untested WebAssembly port will be quick. [3]

**Basilisk:** provides an incompressible Navier–Stokes solver and examples with two-phase flow. A candidate for specialist reference computations, not the initial web UI. [8]

**Rendering is separate from physics:** Canvas 2D is enough to start. A WebGL2 point renderer may improve throughput. Three.js is optional for later 3D presentation; choosing it does not supply a validated fluid solver.

## 6. Recommended software architecture

Use TypeScript, Vite, a dedicated Web Worker for simulation, and Canvas 2D for the first renderer. Keep the simulation core independent of browser APIs so it can run headlessly for tests. Use typed arrays and a structure-of-arrays layout. A UI framework is optional; plain TypeScript is sufficient for the initial controls.

Baseline must work without WebGPU, cross-origin isolation, SharedArrayBuffer, a backend service, or a user account. WebGPU availability remains platform-dependent; feature-detect and make any future GPU path optional. [9]

Use transferable ArrayBuffers with bounded double/triple buffering. Preserve simulation-owned state when sending snapshots; do not detach buffers still needed by the solver. Never create an unbounded queue of frames. Render independently from simulation steps.

Suggested repository layout:

```text
src/
  main.ts
  sim/
    types.ts
    grid.ts
    particles.ts
    transfer.ts
    pressure.ts
    boundaries.ts
    geometry.ts
    motion.ts
    transport.ts
    accounting.ts
    diagnostics.ts
    solver.ts
  worker/simulation.worker.ts
  render/canvas.ts
  ui/controls.ts
  ui/charts.ts
  presets/
tests/
benchmarks/
docs/physics.md
docs/validation.md
docs/sources.md
.github/workflows/pages.yml
vision.md
README.md
LICENSE
THIRD_PARTY_NOTICES.md
```

Minimal solver interface:

```ts
interface Solver {
  initialize(config: ExperimentConfig): void;
  advance(durationSeconds: number): Diagnostics;
  snapshot(): RenderSnapshot;
  exportRun(): ExperimentResult;
  dispose(): void;
}
```

Worker commands: initialize, start, pause, step, reset, changePlaybackSpeed, export. Geometry or physical-parameter changes reset the experiment unless the UI explicitly labels them as live interventions.

## 7. Physical model and implementation requirements

### Equations and units

Use metres, seconds, kilograms, pascals, and kelvin internally; display mL and °C. Start from incompressible Navier–Stokes:

```text
div(u) = 0
du/dt + (u · grad)u = -(1/rho) grad(p) + nu laplacian(u) + g
```

For a transported scalar:

```text
dc/dt + u · grad(c) = D laplacian(c) + source
```

The solver is a discretization of these equations with stated approximations. For version 1, uniform density and constant water-like viscosity are reasonable choices. Verify and record property values at the chosen reference temperature using an authoritative water-property source. Do not treat a PIC blend, particle separation coefficient, or arbitrary damping factor as the measured viscosity of water. [1, 5]

Thermal extension:

```text
dT/dt + u · grad(T) = alpha laplacian(T) + thermal source
buoyancy correction = -beta (T - Tref) g
```

The buoyancy expression is relative to the reference-density gravitational term. State the pressure convention and avoid double-counting gravity. Wall heat transfer and free-surface cooling require boundary models; an initial temperature gradient alone does not simulate cooling from boiling. Report whether thermal boundaries are prescribed temperatures, heat fluxes, or fitted heat-transfer coefficients.

### 2D volume interpretation

A 2D cross-section is not a 3D teapot. For accounting, define an effective constant depth b and use V = A b. Set b so the initial filled area represents 1.5 L. Each equal-area simulation parcel then has an assigned volume V0/N.

Label all displayed millilitres as **2D-equivalent volume**. The equivalent-depth construction does not reproduce a round pot's varying width or spout hydraulics. Use it consistently for comparisons, and do not present its seconds or mL as validated real-vessel predictions.

### Geometry

Start with an open rectangular tank for numerical tests, then add:

1. A rounded pitcher cross-section with a pouring lip.
2. A rounded teapot cross-section with an explicit channel connecting the body to a spout.

The spout must be a genuine passage through the solid geometry, not a visual overlay or arbitrary particle deletion zone. Record dimensions, pivot, headspace, inlet height, channel width, and lip position. Treat narrow passages as unresolved if they span too few cells. Aim initially for at least 6–8 cells across the narrowest passage, then test refinement; this is a design heuristic, not an accuracy guarantee.

Use a signed-distance representation or equivalent analytic boundary representation for collision queries and moving-solid sampling. Adopt a clearly stated wall treatment: no penetration is mandatory; free-slip versus no-slip is a documented model choice. A coarse free-slip demonstration cannot support claims about wall boundary layers.

### Moving the pot correctly

Prefer a stationary world grid with gravity fixed downward and the vessel moving through it. Compute solid boundary velocity from the prescribed translation and angular velocity. For rotation about a fixed pivot, wall velocity is omega cross (x - pivot).

Pressure projection must enforce moving-wall fluxes, not only static collision normals. Update swept boundaries carefully so walls neither tunnel through particles nor create unexplained loss. Include solid face fractions or another documented treatment of partial cells; test grid stair-stepping sensitivity.

Keeping the vessel fixed while rotating gravity is only a quasi-static approximation unless the rotating frame's other accelerations are included. Do not use that shortcut for human-like rapid tilting and then attribute the resulting flow to accurate inertial physics.

### Proposed substep

1. Choose a stable substep from fluid speed, wall speed, acceleration, grid size, and any explicit viscosity/diffusion restrictions.
2. Evaluate prescribed motion and moving-solid geometry at a consistent substep time.
3. Transfer particle velocities and weights to staggered grid faces; identify liquid, air, and solid regions.
4. Retain the grid velocity state needed for a correctly defined FLIP increment.
5. Apply external forces and the chosen viscosity treatment.
6. Solve pressure with atmospheric free-surface pressure and moving-wall boundary conditions.
7. Project velocities; record pressure residual and post-projection divergence.
8. Extrapolate valid velocities as needed, transfer back using a documented PIC/FLIP blend, and advect particles with at least a tested second-order integrator.
9. Resolve collisions consistently, handle outflow events, and update diagnostics.
10. In thermal mode, advance scalar transport and buoyancy with a documented coupling order.

This is an implementation outline. The agent must verify the precise transfer and boundary ordering against the chosen reference algorithm; a superficially similar sequence is insufficient. Numerical particle-separation or reseeding operations can alter apparent mixing, so log them and test their influence.

### Identity, transport, and outflow

Each parcel needs a stable ID, initial position in pot coordinates, immutable origin label, volume weight, current position and velocity, and status. Optional scalar properties include temperature and concentration. Colours encode origin unless another explicit display mode is selected. Never average away origin labels during velocity transfer.

Distinguish particles that support the fluid solver from independent passive tracers if both are used. If resampling is necessary, conserve volume and scalar quantities and preserve lineage or explicitly report lost trajectory identity. Start without reseeding if the benchmark remains stable.

Count outflow through a well-defined oriented section outside the lip. Detect segment crossings between old and new positions so fast parcels cannot skip it. Mark each parcel once; retain a counted parcel's terminal record. Separate pot contents, liquid in the spout, discharged liquid, unexpected spills, and unaccounted losses. A removed parcel still contributes to the conservation ledger.

For a user-like pour, use a smooth tilt-in, hold, and return trajectory. Define a controller that begins returning near the 400 mL target, and report actual discharge and overshoot. Do not delete precisely 400 mL to manufacture success. For fair comparisons, report both equal-time and approximately equal-volume experiments as appropriate; different motions may require different durations.

## 8. Metrics that answer the question

### Origin of poured liquid

Partition the initial fill into three equal-volume horizontal bands by default: bottom, middle, top. Calculate actual initial fractions rather than assuming equal particle counts in arbitrary geometric bands. Add front/back regions and a user-selected patch later.

For initial category k:

```text
F_k = initial volume in category k / initial total volume
P_k(t) = discharged volume from category k / total discharged volume
B_k(t) = P_k(t) / F_k
```

B above 1 means that origin is overrepresented in the discharge. Hide the ratio until discharge is nonzero and handle empty categories. Show cumulative composition plus composition in consecutive volume bins, initially 50 mL-equivalent bins. Retain partial-bin volume explicitly.

### Where remaining liquid moved

Build an origin-to-current-region matrix in pot coordinates. Use volume weights, include an outflow destination, and show row normalization clearly. Plot representative pathlines; a pathline follows a parcel over time, whereas a streamline represents the instantaneous velocity field. Label these differently.

### Coarse-scale mixing of origin labels

Use spatial sampling bins independent of the solver grid. In occupied bin j, compute the category fractions p(j,k). Weight bins by their liquid volume. One useful regional-segregation diagnostic is:

```text
S = sum_j w_j sum_k (p(j,k) - pbar(k))^2
```

Here pbar is the composition of the remaining liquid at that moment. Lower S indicates more uniform origin composition at the declared bin scale. Report bin size, minimum sample count, empty-bin handling, and sensitivity at multiple scales. A normalized index such as 1 - S/S0 is optional only when S0 is meaningful and nonzero; values need not lie between 0 and 1. Do not silently clamp or label it a universal “percent mixed.”

### Separate removal from mixing

An initially segregated population can appear more uniform simply because one category was poured away. In addition to remaining-fluid composition and S, perform a **survivor-cohort analysis**: identify particles still in the pot at the end, then compare those same particles' initial and final spatial segregation. Report the changing category fractions and cohort definition alongside this comparison. This helps expose selection effects, though it does not make a changing-domain statistic uniquely objective.

For a physical scalar, compute volume-weighted mean and variance separately for the remaining pot and total ledger. With no diffusion, sources, or losses, total material scalar inventory should be conserved. Pure parcel rearrangement can leave global scalar variance unchanged while reducing coarse-scale segregation; this is expected.

### Required diagnostic panel

- Initial, remaining, discharged, spilled, and unaccounted volume.
- Actual target overshoot and simulation time.
- Grid size, particle count, timestep/substeps, pressure residual, and divergence norm.
- PIC/FLIP blend and numerical stabilization settings.
- Wall treatment, physical viscosity, diffusion setting, and thermal mode.
- Origin fractions and coarse-scale segregation at stated sampling scales.
- Performance measurements and model version.

Conserving particle count is insufficient to prove incompressibility: also inspect density/occupancy drift, surface-height behaviour, and divergence.

## 9. Interaction and visual design

Use a clean laboratory aesthetic: a large transparent vessel, restrained background, legible controls, distinct origin colours, and charts that answer the question directly. The fluid and trajectories are the visual centrepiece.

Default flow:

1. The initial layers and the question “Which layer reaches your cup first?” are visible before playback.
2. Press **Pour 400 mL**.
3. The vessel tilts, parcels move, and the origin chart updates.
4. At the end, show actual discharged volume and measured origin fractions.
5. Offer **Compare with no pour**, **Try a slower pour**, and **Change the spout**.

Essential controls: play/pause, reset, one-step, slow playback, preset selection, origin colours, selected pathlines, velocity arrows, and diagnostics. Slow playback changes viewing rate, not the physical motion schedule. Timeline scrubbing must use stored states or deterministic replay; do not imply arbitrary backward integration works.

Progressive controls: fill amount, target discharge, tilt duration, hold angle, return duration, geometry, seed, and resolution. Thermal settings appear only when that mode exists. Avoid an unvalidated “realism” slider.

Use text labels and patterns/markers where feasible in addition to colour. Provide keyboard-operable controls, readable chart values in a table, and reduced-motion behaviour that starts paused. Manual tilt dragging can be added after automated runs work; record the entire input history for reproducibility.

Export a PNG view, CSV metrics, and a JSON experiment record. The record must contain schema version, solver version/commit, physical parameters, geometry, motion curve, resolution, seed, diagnostics, provenance, and the exact model limitations active for that run.

## 10. Presets and comparison protocol

| Preset | Purpose | Status |
|---|---|---|
| Still, uniform temperature | Numerical drift and baseline | Version 1 |
| Gentle 400 mL-equivalent pour | Main scenario | Version 1 |
| Faster pour, matched discharge | Motion sensitivity | Version 1 |
| Tilt and return without spill | Isolate motion from removal | Version 1 |
| Rim versus low-inlet spout | Geometry sensitivity | Version 1 |
| Repeated pours | Cumulative exchange | Later version 1 |
| Initially warm above cool | Stable buoyancy stratification | Version 2 |
| Surface/wall cooling | Convection before pouring | Version 2 |
| Tea bag present | Obstruction/porosity and possibly extraction | Later research |

Share identical initial conditions and seeds where the comparison permits. Run no-pour controls over the same elapsed physical time. Save both the initial temperature field and the pre-pour waiting period. A 2D moving paddle can be a controlled stirring comparison later, but cannot represent the full circulation of a real 3D spoon.

## 11. Verification, validation, and acceptance

Verification asks whether the equations were implemented correctly. Validation asks whether the model predicts the physical experiment adequately. Visual plausibility supplies neither by itself.

### Numerical tests

- Hydrostatic rest: level surface remains stable; no unexplained sustained currents or volume loss.
- Translating/rotating walls: no penetration or tunnelling; expected relative wall motion is imposed.
- Pressure projection: reduces discrete divergence and reaches the declared residual tolerance.
- Advection: known uniform-flow and reversible transport cases expose trajectory and scalar error.
- Outflow: every parcel is counted at most once, including large-step crossing cases.
- Accounting: initial volume equals all current ledger categories within floating-point/weight tolerance; distinguish this bookkeeping check from represented-volume drift.
- Colour/lineage: changing the renderer never changes material labels or metrics.
- Replay: the same implementation, configuration, seed, and input history reproduce results within stated tolerance.
- Refinement: repeat key experiments at increasing spatial resolution and reduced timestep; inspect discharge curves and origin fractions, not only screenshots.
- Dissipation sensitivity: vary PIC blend and any particle correction to identify numerical mixing.
- Thermal extension: test diffusion against an analytic case, check thermal budgets, and verify buoyancy direction and a standard convection benchmark before interpreting tea experiments.

### Provisional engineering gates

These are acceptance targets to test and revise transparently, not achieved results:

- Standard short runs have less than 1% represented-volume drift, with ledger losses separately reported.
- Automated pour finishes within 5% of the requested discharge for supported presets; show actual volume even when within tolerance.
- Two finest practical resolutions differ by no more than 5 percentage points in each cumulative origin fraction for the reference scenario. This is a preliminary stability check, not proof of convergence or physical accuracy.
- The benchmark device maintains at least 30 rendered frames/s in the default preset while controls remain responsive. Separately report simulated seconds per wall-clock second.
- Firefox and Chrome both complete the same preset and export a valid record; no guarantee of bitwise equality across engines.

Document reference hardware, OS, browser versions, quality settings, measured performance, and failures. If a gate fails, label results exploratory, keep diagnostics available, and fix or narrow scope rather than hiding the failure.

### Real-world experiment

Start with room-temperature water for mechanical validation so buoyancy is easier to control. Use a transparent vessel, food-safe dye, a scale for collected liquid, a fixed camera, dimensional reference markers, and a repeatable tilt rig or recorded tilt trajectory. Record whether dye addition itself creates a jet and allow a documented settling interval.

Coloured layers can be difficult to prepare without mixing. Avoid salt or sugar stratification unless intentionally modelling the resulting density differences. Dye colour intensity requires calibration before quantitative concentration inference. A camera image integrates through depth, so do not treat it as a precise 2D velocity map.

Record pour mass versus time, tilt angle versus time, initial fill, geometry, and visible dye arrival order. Repeat each condition at least three times to estimate variability. For thermal experiments, use appropriate temperature probes and record several positions; protect against hot-water handling and avoid thermal shock to glass. Start cold before reproducing the 70 °C scenario.

Use real measurements and eventually a 3D reference to determine whether qualitative trends survive model simplifications. A second simulation is a useful cross-check, not independent proof of physical truth.

## 12. Performance and browser delivery

Begin with a measured quality ladder around 64, 96, and 128 cells across the pot body, with roughly 4–8 initial particles per occupied cell; tune from benchmarks and resolve the spout adequately. These are starting budgets, not promised frame rates.

Use adaptive substeps under a maximum step size. When computation falls behind, slow simulated time and indicate it rather than taking unstable giant steps. Limit pathline histories and render samples without changing simulation sampling. Do not silently reduce resolution during an experiment; restart with a labelled lower-quality configuration.

A static build fits GitHub Pages: HTML, JavaScript, CSS, worker code, and assets run on the client. No server-side computation is required for the first release. Configure the correct Vite base path for a project URL such as `https://OWNER.github.io/REPOSITORY/`; test worker and asset loading under that subpath. Use GitHub Actions to build and deploy the output directory. Verify current official workflow guidance and action versions when implementing. [10, 11]

Expected commands: `npm ci`, `npm run dev`, `npm test`, `npm run build`, and `npm run preview`. Commit a lockfile and documented runtime requirements. Include a source license chosen by the project owner and attribution for incorporated third-party code. Publication requires the actual repository/account and normal access; this document does not assume credentials or publish anything.

## 13. Agent implementation backlog

### Phase A — establish the smallest trustworthy solver

- [ ] Read this document and record assumptions in an implementation plan.
- [ ] Inspect candidate reference code and licenses; select or implement the PIC/FLIP core.
- [ ] Scaffold TypeScript/Vite, headless tests, a worker, and the initial renderer.
- [ ] Implement SI-unit configuration, deterministic seeding, and a stationary open-tank case.
- [ ] Add pressure residual, divergence, occupancy, and volume-ledger diagnostics.
- [ ] Pass hydrostatic rest and basic advection tests before adding a teapot skin.

Exit criterion: an inspectable, reproducible liquid simulation with numerical evidence, even if visually plain.

### Phase B — make pouring physically meaningful

- [ ] Implement prescribed world-frame moving walls and smooth tilt trajectories.
- [ ] Test wall collision and pressure boundary handling.
- [ ] Add rim and explicit-spout geometries.
- [ ] Add robust outflow counting and a physical return-to-upright target controller.
- [ ] Record initial state, seed, motion, and actual discharge.
- [ ] Make the main 1.5 L / 400 mL-equivalent scenario run end to end.

Exit criterion: pouring is caused by the solver and vessel motion, with accountable outflow and no fabricated trajectories.

### Phase C — answer the original question

- [ ] Add immutable origin labels, pathlines, and origin selection.
- [ ] Implement cumulative and incremental discharge composition.
- [ ] Implement origin-to-region matrix, segregation scales, and survivor-cohort analysis.
- [ ] Add no-pour, no-spill tilt, and speed/geometry comparisons.
- [ ] Export reproducible JSON and CSV records.
- [ ] Display short explanations of advection, stirring, diffusion, and model limits.

Exit criterion: the visitor can tell where discharged liquid began and inspect how remaining liquid was rearranged.

### Phase D — verify, polish, and publish

- [ ] Run the numerical test suite and resolution/dissipation sweeps.
- [ ] Record browser and hardware performance; choose an honest default quality.
- [ ] Test accessibility, resizing, pause/reset, export, and worker failure handling.
- [ ] Test Chrome and Firefox, including the deployed repository subpath.
- [ ] Write README, physics assumptions, validation report, sources, and third-party notices.
- [ ] Configure GitHub Pages using the supplied repository and verify the live build when authorized access is available.
- [ ] Deliver source, runnable commands, build/test results, limitations, and a prioritized next-steps list.

Exit criterion: a demonstrable browser product whose claims match its evidence.

### Phase E — thermal and higher-fidelity work

- [ ] Add separately verified scalar diffusion and thermal coupling.
- [ ] Document cooling boundary conditions and water-property values.
- [ ] Conduct and compare physical experiments.
- [ ] Select a 3D reference solver and carry out selected refinement studies.
- [ ] Consider optional GPU acceleration only after profiling the working model.

Do not delay Phases A–D to implement an ambitious unvalidated 3D thermal solver.

## 14. My tasks — project owner

### Needed before matching a particular real pot

- [ ] Confirm whether 1.5 L is the actual liquid fill or the manufacturer's vessel capacity.
- [ ] Provide photographs or a sketch with dimensions: body height/width, spout inlet and outlet heights, channel width, and fill level.
- [ ] Confirm whether the lid is on, whether it has an open vent, and whether a tea bag or infuser remains inside.
- [ ] Provide a short side-view pouring video if the real human motion matters.

### Needed for publication

- [ ] Choose the GitHub owner/repository and give the implementing agent the required access through the available authorized workflow.
- [ ] Choose the source-code license; MIT is a reasonable proposal if compatible with incorporated code.
- [ ] Decide the public-facing name; “PourLab” is a working title.

### Useful for validation and prioritization

- [ ] Identify a representative laptop and browser for performance testing.
- [ ] Decide whether the main priority is an engaging explanation or quantitatively defensible results for one real vessel.
- [ ] Film repeatable cold-water dye pours and record collected mass if practical.
- [ ] Add multi-position temperature measurements if thermal effects become a priority.
- [ ] Review the first working demo for whether the origin colours and charts answer the original question clearly.

These tasks should not block a generic first prototype. Until measurements arrive, the agent should use a labelled generic geometry, no tea bag, an open vent, a uniform-temperature mechanical model, and a smooth automated pour.

## 15. Risks and decisions that must remain visible

| Risk | Response |
|---|---|
| 2D circulation differs from 3D | Label scope; validate trends; add selected 3D references later |
| Particle colours look mixed because of rendering | Compute metrics from raw state, never rendered pixels |
| Numerical corrections cause transport | Log and sweep correction settings |
| Selective removal looks like stirring | Report composition and survivor-cohort analysis |
| Coarse spout distorts flow | Resolve channel and run geometry/refinement sensitivity |
| Moving wall errors inject energy | Test prescribed motion and monitor rest/energy behaviour |
| Exact 400 mL is achieved artificially | Use actual measured discharge and report overshoot |
| Thermal colour suggests buoyancy that is absent | Label passive versus coupled modes explicitly |
| Browser results look authoritative | Keep model and validation status visible beside charts |
| Initial state is unknown | Offer controlled presets; avoid claiming the real pot's history |

## 16. Ready-to-use instruction for the implementing agent

> Implement the browser experiment specified in this vision.md. Begin with the smallest verified 2D incompressible PIC/FLIP liquid solver, then add moving-vessel pouring, origin tracking, outflow accounting, and comparison metrics. Prioritize a working Firefox/Chrome static application with an honest explanation of model limitations. Use a generic labelled vessel until real geometry is supplied. Preserve parcel origin identity, distinguish numerical smoothing from mixing, and do not manufacture outflow or results. Follow the staged acceptance criteria and document measured results. Prepare a GitHub Pages build and publish only through the repository and authorized access supplied for that work. Deliver the source, instructions, tests, validation notes, and remaining limitations. Thermal coupling and 3D reference work follow the working mechanical prototype.

## 17. Sources and further research

These sources support background and implementation choices. They do not establish a mixing percentage for the proposed teapot scenario. Design choices, equations specialized to this app, metrics, acceptance targets, and the backlog are this project's proposed specification.

1. **Bridson and Müller-Fischer, Fluid Simulation, SIGGRAPH 2007 course notes.** Background on incompressibility, pressure projection, advection, free surfaces, and numerical methods. [Course page](https://www.cs.ubc.ca/~rbridson/fluidsimulation/) · [Notes PDF](https://www.cs.ubc.ca/~rbridson/fluidsimulation/fluids_notes.pdf).
2. **Matthias Müller, Ten Minute Physics, episode 18: FLIP water simulator.** Browser implementation reference and a practical feasibility example. [Index](https://matthias-research.github.io/pages/tenMinutePhysics/index.html) · [Demo](https://matthias-research.github.io/pages/tenMinutePhysics/18-flip.html) · [Source](https://github.com/matthias-research/pages/blob/master/tenMinutePhysics/18-flip.html).
3. **SPlisHSPlasH official documentation.** SPH solver capabilities, export support, and license. [About](https://splishsplash.readthedocs.io/en/latest/about.html) · [Repository](https://github.com/InteractiveComputerGraphics/SPlisHSPlasH).
4. **MIT OpenCourseWare, Fundamentals of Energy in Buildings, heat-transfer notes.** Natural convection and heat-transfer background. [Notes PDF](https://ocw.mit.edu/courses/4-42j-fundamentals-of-energy-in-buildings-fall-2010/932ba308aee67d0164ea8b59cec1c4be_MIT4_42JF10_heat.pdf).
5. **NIST, Reference Correlations for Thermophysical Properties of Liquid Water at 0.1 MPa.** Authoritative starting point for temperature-dependent water properties; the implementation must evaluate and document the values actually used. [Publication](https://www.nist.gov/publications/reference-correlations-thermophysical-properties-liquid-water-01-mpa).
6. **University of Amsterdam, Why we always spill tea (2019); Investigation of the Teapot Effect (2023).** Related research on attachment and detachment at a pouring edge, not whole-pot mixing. [University report](https://iop.uva.nl/content/news/2019/05/why-we-always-spill-tea.html) · [Research article](https://appol.ifpan.edu.pl/index.php/appa/article/view/144_26).
7. **Fountain mixing in a filling box at low Reynolds numbers, Physical Review Fluids 4, 024501 (2019).** Related receiving-container mixing research, with different boundary and density conditions. [Article](https://journals.aps.org/prfluids/abstract/10.1103/PhysRevFluids.4.024501).
8. **Basilisk official solver documentation.** Reference option for incompressible flow and two-phase examples. [Centered solver](https://www.basilisk.fr/src/navier-stokes/centered.h) · [Breaking-wave example](https://www.basilisk.fr/sandbox/popinet/wave.c).
9. **MDN, WebGPU API.** Feature availability and capability detection; recheck the browser/platform matrix when implementing. [Documentation](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API).
10. **GitHub official Pages documentation.** Static hosting and deployment model. [What is GitHub Pages?](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) · [Publishing sources](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).
11. **Vite official static deployment guide.** Build deployment and GitHub Pages base paths. [Guide](https://vite.dev/guide/static-deploy).

Follow-up literature searches should target “transient draining stratified tank,” “selective withdrawal,” “tilting vessel free-surface mixing,” “Lagrangian transport pouring,” and “natural convection cooling water vessel.” For every candidate, record geometry, Reynolds/Froude/Richardson regime where relevant, thermal and density conditions, dimensionality, validation data, and exactly which claim it supports. Do not mistake similarity of title for applicability.

## 18. Extended research: the best browser approach

### 18.1 Decision, after comparing alternatives

**Start with a CPU-based 2D PIC/FLIP solver in a dedicated Web Worker, implemented in TypeScript, with a pressure projection on a staggered MAC grid. Render labelled parcels using Canvas initially; retain an interface for a WebGL point renderer. Use the MIT-licensed Ten Minute Physics implementation as a reference or audited starting point. Once moving walls and accounting work, compare APIC under identical conditions before selecting a final transfer scheme.**

This recommendation optimizes for the actual priorities: implement quickly, run in Firefox and Chrome, show where liquid originated, expose numerical errors, and deploy statically. It is a project-specific engineering judgment, not a claim that PIC/FLIP is universally the most accurate or fastest method.

The browser technology and fluid method are independent choices. “WebGPU,” “Three.js,” and “WebAssembly” do not define a fluid model. Similarly, a sound fluid algorithm can still produce misleading results when implemented with incorrect moving boundaries or overly coarse resolution.

### 18.2 What will actually answer the user's question?

The decisive deliverable is a **paired transport experiment**, not just a water animation:

1. Mark equal-volume initial layers, retaining permanent parcel identities.
2. Run a recorded tilt-and-return motion and measure actual discharge.
3. Show the original locations of all parcels that left, highlighted on the initial pot view.
4. Show the histories and final locations of the parcels that stayed.
5. Compare against the same initial state left still for the same time.
6. Repeat with altered spout location, tilt speed, and numerical resolution.

The initial-location highlight is especially important: it gives an immediate visual answer to “which water did I pour?” A cumulative colour chart alone can conceal whether a narrow pathway or a broad region supplied the outflow.

For three initially equal-volume labels, ideal unbiased discharge would contain one third of each label. Thus a 400 mL discharge would contain about 133.3 mL from each initial label **if the discharge sampled those labels in their initial proportions**. This is a comparison reference, not a predicted result. Matching that ratio does not prove that the remaining pot is well mixed; different flow arrangements can give the same output composition.

The second result must therefore show spatial segregation and regional exchange among remaining parcels, including the survivor-cohort comparison already specified. If outflow composition is balanced but remaining fluid stays layered, the answer is “the pour sampled different regions, but did not homogenize the pot at the measured scale.” If substantial regions barely exchange with their neighbours, show them rather than reporting only a single averaged score.

### 18.3 Method comparison for this project

These rankings express implementation suitability, not measured benchmark scores.

| Candidate | Why it is attractive | What could distort this experiment | Recommended role |
|---|---|---|---|
| PIC/FLIP with pressure projection | Existing small browser reference; direct parcel histories; clear incompressibility diagnostics | PIC damping, FLIP noise, wall handling, particle corrections | First working solver |
| APIC with pressure projection | Carries local velocity variation per parcel; promising treatment of rotation and transfer losses | More transfer state; implementation details on a staggered grid matter | First controlled algorithm upgrade |
| DFSPH | Particle-based transport; addresses density error and velocity divergence | Neighbourhood and boundary treatment; pressure iterations; substantial new implementation | Strong independent comparison or alternative if expertise exists |
| PBF | Practical interactive incompressibility approximation | Position corrections and stabilizers must be checked against transport metrics | Visual prototype if that becomes the explicit priority |
| MLS-MPM browser water demos | Existing attractive GPU implementations | A material model and compressibility settings must be assessed, not inferred from appearance | Rendering/GPU reference, not automatic solver replacement |
| Finite-volume/VOF | Appropriate for a conservation-focused CFD study | More interface and geometry engineering for the first browser version | Higher-fidelity offline work |

APIC augments parcel velocities with an affine local representation. The original paper studies transfer dissipation and noise and establishes angular-momentum properties under its stated assumptions. That is motivation to test it here; it does not establish that our complete moving-wall simulation conserves angular momentum or predicts mixing correctly. [12]

There is also a dedicated paper on APIC transfers for MAC grids. Use a consistent formulation from that literature rather than combining equations intended for different grid arrangements. [13]

DFSPH combines density-error correction with a divergence-free velocity objective. It is a serious alternative; the paper's reported performance and compression errors are results for its own tests, not performance promises for this browser application. [14]

PBF is designed around iterative density constraints. If evaluated, separately measure the influence of positional corrections and auxiliary stabilization on labelled parcel exchange. [15]

### 18.4 What the inspected browser implementations establish

**Ten Minute Physics episode 18:** the inspected source contains JavaScript simulation code and WebGL rendering, a PIC/FLIP control, iterative incompressibility correction, particle separation, drift compensation, and a routine that changes particle colours. It has an MIT license header. This is an educational starting point, not a finished pouring instrument. [2]

Required adaptation decisions:

- Keep `originId` separate from display RGB; the renderer derives origin colours from immutable IDs.
- Make stabilization settings explicit and log any parcel displacement they introduce.
- Add teapot geometry, prescribed wall motion, conservation accounting, and the comparison metrics specified above.
- Replace frame-dependent assumptions with explicit simulation time and stability controls.
- Keep an unchanged reference snapshot for regression comparisons during the initial modularization.

**Splash:** its repository identifies WebGPU simulation and screen-space fluid rendering, based on MLS-MPM, and presents an MIT license. It demonstrates a relevant browser implementation direction. Its attractive surface is not evidence that its model answers PourLab's mixing question. This research inspected the repository description; it did not execute or benchmark the demo. [16]

**LinzhouLi/WebGPU-Fluid-Simulation:** an additional public browser-fluid example with a linked demonstration was located. The inspected README is sparse, so it is not selected as the main dependency; implementation, license, browser behaviour, and physical model require a separate audit before reuse. [17]

No examined source established a ready-made package that already combines realistic teapot motion, origin attribution, defensible mixing metrics, thermal convection, and validation. Plan for a focused custom application built on established algorithms.

### 18.5 Execution and rendering choices

| Technology | Decision | Reason |
|---|---|---|
| JavaScript/TypeScript in a Worker | Required baseline | Easy to inspect, test, and ship; keeps simulation work away from UI events |
| Canvas 2D | Initial renderer | Minimal graphics infrastructure for labels, parcels, and trajectories |
| WebGL/WebGL2 | Profile-driven rendering upgrade | Useful for larger point counts without changing the solver |
| WebGPU compute | Optional later backend | Suitable compute API, but support and device capabilities must be checked |
| Single-thread WebAssembly inside a Worker | Optional targeted optimization | Can reuse a suitable native core without requiring shared-memory threads |
| Threaded WebAssembly | Not a baseline dependency | Adds deployment and cross-origin-isolation requirements |

MDN currently labels WebGPU as not Baseline. Do not assume every Chrome or Firefox installation exposes a usable adapter; browser version, OS, driver, and hardware matter. Test adapter/device creation and required limits. Fall back before starting a run, not by silently swapping algorithms midway through one. [9]

Web Workers support transferring ownership of buffers. Use reusable render snapshots; transferring a buffer makes it unavailable to its sender until ownership returns. Worker transport and graphics upload overhead must be included in performance measurements. [18]

Emscripten pthreads rely on SharedArrayBuffer and the appropriate isolation headers. Its documentation also calls for separate threaded and non-threaded builds when both modes are needed. A simple single-thread Worker baseline avoids making those conditions part of the GitHub Pages launch requirements. [19]

WebGL is a graphics API; using fragment shaders for simulation is possible, but do not undertake a GPU solver rewrite merely because the particle renderer is slow. Profile solver time and renderer time separately. [20]

### 18.6 Pressure solver: prioritize measurable convergence

For the first rectangular benchmark, a small iterative pressure solver is useful for debugging. For the teapot, implement a residual-controlled solver with an iteration cap, failure reporting, and tests for the actual moving-boundary discretization. A fixed iteration count alone does not establish comparable incompressibility at different grid sizes.

A matrix-free preconditioned conjugate-gradient solver is a reasonable next choice for a symmetric positive-definite pressure system; start with a simple documented preconditioner. Verify symmetry and boundary assembly before using PCG. Handle disconnected liquid regions and pressure nullspaces, including pressure gauges for any fully enclosed all-Neumann component. Do not assume PCG fixes a malformed system.

Bridson's course page provides pressure-solver reference code using modified incomplete Cholesky preconditioning. Treat that as a reference, not a requirement to port every component immediately. [21]

Record both residual and post-projection divergence. Near narrow outlets, also inspect local boundary fluxes: a small global average error can hide a physically important local defect.

### 18.7 Benchmark plan before committing to an upgrade

Build the baseline first, then run a small, controlled PIC/FLIP-versus-APIC comparison. Keep geometry, motion, initial particle distribution, grid, pressure tolerances, and diagnostics fixed. Run at least three resolutions, and repeat the finest case with a smaller maximum timestep. APIC must not be compared against an intentionally poor FLIP configuration.

Use four scenes:

1. **Transfer-only affine velocity test:** isolate the transfer operators; test constant and linear velocity fields, including rotation, under suitable support conditions. Do not confuse this with a free-surface rigidly rotating equilibrium.
2. **Hydrostatic tank:** measure spurious motion, surface drift, and pressure convergence.
3. **Tilt without spilling:** inspect wall work, circulation, and artificial parcel exchange.
4. **Spouted pour:** compare discharge history, origin fractions, retained-fluid metrics, and loss accounting.

For each, record errors, runtime per simulated second, memory, solver iterations, and stabilization activity. Select APIC only if the results justify its additional complexity. Retain the other transfer mode as a research comparison where maintainable.

Do not judge a solver solely by frames per second. A renderer can remain smooth while the simulation runs slowly, and an inexpensive under-converged pressure solve can look fast while changing the answer.

### 18.8 When 3D matters more than another browser optimization

The principal physical limitation is not the programming language: it is dimensionality and unresolved flow. A 2D slice prevents liquid from moving around the sides of the pot or an infuser and changes the routes available to feed the spout. More particles on that same slice do not remove this limitation.

If the project moves from “explain the mechanism” to “predict our actual teapot,” prioritize a measured geometry and selected 3D comparisons over elaborate rendering or endless 2D optimization. The version numbering above is a delivery plan, not a requirement to finish all thermal features before any 3D work. An isothermal 3D comparison can be more informative than adding detailed heat transfer to an unrepresentative 2D geometry.

Neither this research nor the current document supplies a measured percentage of whole-pot mixing. Any later percentage must identify the geometry, motion, initial state, measurement scale, solver settings, and validation evidence behind it.

### 18.9 Concrete additions to the agent backlog

- [ ] Pin the reference implementation revision and preserve its MIT notices.
- [ ] Add immutable origin IDs and an initial-position discharge map before visual polish.
- [ ] Add separate `TransferScheme`, `PressureSolver`, and `Renderer` interfaces without building unused backends.
- [ ] Implement residual and divergence reporting and benchmark the pressure solver.
- [ ] Add a headless benchmark runner and machine-readable results.
- [ ] Implement the four comparison scenes above.
- [ ] Compare PIC/FLIP and APIC only after moving boundaries and outflow tests pass.
- [ ] Record numerical particle-correction displacement separately from velocity-based advection.
- [ ] Document what existing demo code was reused, changed, or intentionally omitted.
- [ ] Test the baseline in both Firefox and Chrome with WebGPU unavailable.
- [ ] Add a short result explanation answering both “where did the cup's liquid start?” and “what happened to the liquid left behind?”

### 18.10 Additional research sources

12. Jiang, Schroeder, Selle, Teran, and Stomakhin, **The Affine Particle-In-Cell Method** (2015). [Author-hosted paper](https://math.ucdavis.edu/~jteran/papers/JSSTS15.pdf).
13. Ding, Shinar, and Schroeder, **Affine particle in cell method for MAC grids and fluid simulation**, Journal of Computational Physics 408 (2020). [University repository](https://escholarship.org/uc/item/0vc0g86n).
14. Bender and Koschier, **Divergence-Free Smoothed Particle Hydrodynamics** (2015). [Authors' research group page](https://animation.rwth-aachen.de/publication/054/).
15. Macklin and Müller, **Position Based Fluids** (2013). [Author-hosted paper](https://matthias-research.github.io/pages/publications/pbf_sig_preprint.pdf).
16. **Splash**, project repository and README. [Source](https://github.com/matsuoka-601/Splash).
17. **WebGPU-Fluid-Simulation**, project repository and README. [Source](https://github.com/LinzhouLi/WebGPU-Fluid-Simulation).
18. MDN, **Using Web Workers**, especially transferable objects. [Documentation](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers).
19. Emscripten, **Pthreads support**. [Documentation](https://emscripten.org/docs/porting/pthreads.html).
20. MDN, **WebGL: 2D and 3D graphics for the web**. [Documentation](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API).
21. Bridson and Müller-Fischer, **Fluid Simulation for Computer Animation**, pressure-solver reference code. [Course page](https://www.cs.ubc.ca/~rbridson/fluidsimulation/).

Research status: papers, official documentation, and selected source/README content were inspected. No candidate application was executed, no browser compatibility benchmark was performed, and no new simulation data were produced in this research update. The recommendation is ready for implementation and experimental testing, not presented as the outcome of those tests.

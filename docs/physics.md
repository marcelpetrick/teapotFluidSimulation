# Physics model and numerical method

This documents what PourLab actually computes, with the approximations stated. It implements
[`vision.md`](vision.md) §7–§8. Code references are to `src/sim/`.

## Equations and units

Internally SI (m, s, kg, Pa, K); the UI shows mL and °C. The liquid obeys the incompressible
Navier–Stokes equations with a free surface at atmospheric pressure (p = 0):

```text
div(u) = 0
du/dt + (u · grad)u = -(1/rho) grad(p) + nu laplacian(u) + g      (+ Boussinesq term in thermal mode)
```

Pressure convention: `p` is the deviation from atmospheric; gravity acts on every liquid face once.
In coupled thermal mode the vertical acceleration is `-g + g beta (T - Tref)` (Boussinesq: density
`rho0 (1 - beta (T - Tref))` appears only in the buoyancy term, so gravity is not double-counted).
`Tref` is the initial mean temperature.

## Water properties (70 °C, 0.1 MPa)

| Property                | Value                                     | Used for                                       |
| ----------------------- | ----------------------------------------- | ---------------------------------------------- |
| Density ρ               | 977.76 kg m⁻³                             | pressure scaling, parcel mass, heat capacity   |
| Dynamic viscosity μ     | 4.04 × 10⁻⁴ Pa s (ν = 4.13 × 10⁻⁷ m² s⁻¹) | explicit viscous term                          |
| Thermal conductivity k  | 0.663 W m⁻¹ K⁻¹                           | diffusivity α = k/(ρ c_p) = 1.62 × 10⁻⁷ m² s⁻¹ |
| Specific heat c_p       | 4190 J kg⁻¹ K⁻¹                           | cooling                                        |
| Expansion coefficient β | 5.84 × 10⁻⁴ K⁻¹                           | buoyancy                                       |

Values are the IAPWS formulations as tabulated by NIST (vision source [5]), rounded to 3–4
significant digits; `src/sim/config.ts: WATER_70C`. At the simulated cell sizes (2–4 mm) the physical
viscosity is far smaller than numerical dissipation, so it does not control the flow; it is applied
for completeness and can be switched off in the configuration.

## 2D volume interpretation

The model is a vertical cross-section. Each parcel represents an equal area; an effective depth
`b = V0 / (N · s²)` (N parcels on a lattice of spacing s) makes the parcel ledger equal the requested
1.5 L. All displayed millilitres are **2D-equivalent**. Because the 2D spout channel (26 mm wide, at
least 6–8 cells) is multiplied by the same depth (~8.6 cm), the spout is far wider than a real one:
**flow rates and pour durations are not real-vessel predictions**.

## Geometry and motion

- Vessels (`vessel.ts`) are unions of thick polyline segments (capsules) in pot-local coordinates, with
  an analytic signed distance. Teapot: rounded body, an inlet opening in the right wall at 45 mm and an
  inclined channel to the lip; the lower lip tip sits above the fill level, so the pot holds its liquid
  at rest. German glass teapot (`glass`): a wide cylinder (190 mm inner width, 130 mm high, small
  bottom radius) with a short, almost flat lip at the rim and no spout, so liquid can only leave over the
  top; the wall is drawn 10 mm thick because walls must span at least 2.5 cells at the coarsest
  resolution. Pitcher: rounded body with a short rising lip. Tank: open box for verification.
- The vessel rotates about a pivot through a **stationary world grid**; gravity stays fixed downward.
  Wall velocity is ω × (x − pivot), with ω the exact angle change per substep divided by dt.
- The pressure grid voxelises the walls: a cell is solid if its centre is inside the wall. Solid faces
  carry the wall-normal component of the rigid velocity, so the projection enforces **moving-wall
  fluxes**, not just static no-penetration. Parcels collide with the exact SDF and lose only the inward
  relative normal velocity (**free-slip**). Stair-stepping is a stated limitation; the verification
  tests quantify its effect on wall-adjacent parcels.

## Substep (`solver.ts: step`)

1. The controller decides the tilt at t + dt from discharge measured so far; ω = Δφ/dt.
2. Classify cells: solid (vessel at pose t, domain border), liquid (contains an in-pot parcel), air.
3. Particle → grid transfer of velocity (bilinear weights; APIC adds the affine term `C (x_face − x_p)`).
   The transferred grid is kept for the FLIP increment.
4. Gravity (+ buoyancy) on liquid-adjacent faces; explicit viscosity (zero-gradient at air and walls).
5. Solid faces get wall velocities. PCG with MIC(0) solves `Σ(q_c − q_n) = −D_c` (q = p dt/(ρh),
   air q = 0); faces are projected. Residual (max norm) and post-projection divergence are recorded;
   non-convergence is counted, never hidden.
6. Velocities are extrapolated three layers. Grid → particle: PIC/FLIP blend
   `v = (1−α) u_new + α (v + u_new − u_old)` with validity-weighted sampling, or APIC (`v = u_new`,
   `C = Σ u_i ∇w_i`).
7. **Density correction** (numerical stabiliser): parcel density per cell relative to seeding density;
   interior cells are corrected both ways, surface cells only when over-full. A second Poisson solve gives
   a divergence-only displacement used for **positions only** — it never enters parcel velocities, so it
   injects no momentum. Its total displacement is logged in the diagnostics.
8. RK2 midpoint advection in the projected field, SDF collision at pose t + dt.
9. Ledger: a parcel crossing the oriented section through the lip tip (segment test between old and new
   pot-local positions) is **discharged** once; leaving the vessel envelope or reaching the domain edge
   otherwise is a **spill**; non-finite state is **lost**. Removed parcels continue on a visual-only
   ballistic path.
10. Thermal mode: use cell temperatures transferred during step 3. Apply explicit diffusion and boundary heat transfer
    `−h (T − T_ambient)/(ρ c_p h_cell)` on wall and free-surface faces; parcels receive the
    interpolated change (FLIP-style, no smoothing). The heat inventory including boundary losses and
    removed parcels is checked every frame.

Time step: `dt = min(1/200 s, CFL · h / (|u|max + √(5 g h) + |ω| R))` with CFL 0.8. When the browser
cannot keep up, simulated time slows and the UI states the achieved fraction; the step never grows.

## Pour controller (`motion.ts`)

Wait → eased tilt-in (cosine) → hold with slow further tilt → return with a cubic Hermite curve that
starts at the current angular velocity (C¹) → rest → (repeat) → done. The return starts when
`discharged + flowRate · anticipation · returnDuration ≥ target`, where flowRate is a 0.25 s moving
average of measured discharge. Anticipation per preset is calibrated with
`scripts/calibrate-anticipation.ts`; actual discharge and overshoot are always shown. Custom settings
use the preset's anticipation and may miss the target: that miss is reported, not corrected.

## Metrics (`metrics.ts`)

- Origin bands: three **equal-volume** horizontal bands from sorting the actual parcels by initial
  height (F_k computed from counts, not assumed). Parcels initially in the spout are flagged.
- `P_k(t)`, `B_k = P_k / F_k` (hidden until discharge > 0; empty categories give n/a), cumulative and per
  50 mL bin with the partial bin retained.
- Origin → current region matrix in pot coordinates: pot zones bounded by the initial band edges,
  spout channel, discharged, spilled, lost; row-normalised.
- Segregation `S = Σ_j w_j Σ_k (p_jk − p̄_k)²` in square sampling bins of 1, 2 and 4 cm (independent of
  the solver grid), bins with < 4 parcels excluded and the excluded share reported. No clamped
  "percent mixed" is shown.
- Survivor cohort: the parcels in the pot at the time of evaluation, compared at their initial and
  current positions with the same bins and cohort composition; this separates selective removal from
  rearrangement.

## 3D solvers (`src/sim3d/`, `src/gpu3d/`)

The 3D reference uses the same equations and substep in three dimensions (half pot behind a free-slip
symmetry plane, MIC(0)-PCG, no explicit viscosity). The WebGPU port solves the same discrete problem with
other numerics:

- f32 instead of f64 arithmetic;
- parcel-to-grid sums as fixed-point integer atomics (velocity × weight scaled by 2²⁰, weights by 2²⁴),
  so the result does not depend on thread order;
- pressure and density-correction solves by CG with a degree-6 Chebyshev polynomial preconditioner for
  D⁻¹A on [0.05, 2], in one workgroup, with the CPU's stopping rule (max residual ≤ tol · max |b|);
- the stable substep and the pour controller use stats one substep older than on the CPU (pipelined
  readback).

None of these change the physics. The measured agreement with the CPU solver is in `docs/validation.md`.

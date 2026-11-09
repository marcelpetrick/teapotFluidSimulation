# Sources

Numbers refer to the bibliography in [`vision.md`](vision.md) §17 and §18.10. What each source is
used for in PourLab:

| #      | Source                                                                   | Used for                                                                                                |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 1      | Bridson & Müller-Fischer, _Fluid Simulation_, SIGGRAPH 2007 course notes | MAC grid, pressure projection, free-surface boundary, PIC/FLIP, MIC(0) PCG (`pressure.ts`, `solver.ts`) |
| 2      | Müller, Ten Minute Physics ep. 18 (MIT)                                  | Feasibility reference only; no code copied (see `THIRD_PARTY_NOTICES.md`)                               |
| 5      | NIST / IAPWS liquid-water reference correlations                         | Water properties at 70 °C (`docs/physics.md`)                                                           |
| 6      | Univ. Amsterdam, teapot effect                                           | Context for lip attachment; the model has no surface tension or wetting                                 |
| 9      | MDN WebGPU                                                               | Decision to keep a CPU worker baseline; WebGPU not required                                             |
| 10, 11 | GitHub Pages and Vite static deploy guides                               | Relative `base`, Actions deployment                                                                     |
| 12     | Jiang et al., _The Affine Particle-In-Cell Method_ (2015)                | APIC transfer option                                                                                    |
| 13     | Ding, Shinar, Schroeder, _APIC for MAC grids_ (2020)                     | Per-component affine vectors on the staggered grid                                                      |
| 18     | MDN, Using Web Workers (transferables)                                   | Fresh transferable snapshot buffers, bounded pull-based frames                                          |

Sources 3, 4, 7, 8 and 14–17 informed the method comparison in the vision (SPH/DFSPH, PBF, MLS-MPM,
Basilisk, convection background, receiving-container mixing) but are not used by the implementation.
None of them establishes a mixing percentage for this teapot scenario.

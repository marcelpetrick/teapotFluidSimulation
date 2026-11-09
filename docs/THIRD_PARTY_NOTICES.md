# Third-party notices

PourLab’s own simulation, rendering and interface code uses GPL-3.0-or-later.

The solver implements published algorithms. No source was copied from the Ten Minute Physics demo.
There is therefore no incorporated demo revision to pin.
See [sources](sources.md) for the algorithm references.

## Shipped runtime dependency

The lazy 3D bundle contains **three.js** and its OrbitControls module.
These use the MIT licence. The copyright notice and full licence are distributed with the site:
[three.js licence](../public/THREE-LICENSE.txt).

The 2D baseline does not load three.js. It uses the project’s Canvas renderer and worker solver.
The production application has one declared runtime dependency: three.js.

## Development dependencies

TypeScript, Vite, Vitest, ESLint, typescript-eslint, Prettier, Playwright, happy-dom and tsx support development and tests.
Their versions and licences are recorded by npm in `package-lock.json` and the installed packages.
They are not application runtime dependencies.

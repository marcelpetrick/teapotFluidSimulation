# Third-party notices

PourLab's simulation, rendering and UI code is original work under GPL-3.0-or-later.

- **No third-party source code is incorporated.** The solver was written from the published algorithm
  descriptions (Bridson & Müller-Fischer 2007 course notes; Jiang et al. 2015 and Ding et al. 2020 for
  APIC). The Ten Minute Physics FLIP demo (MIT) was considered as a reference in the vision but no code
  from it was copied, so no MIT notice is required for it.
- **Build- and test-time tools** (not shipped in `dist/`): TypeScript, Vite, Vitest, ESLint,
  typescript-eslint, Prettier, Playwright, happy-dom, tsx — each under its own licence (MIT or
  Apache-2.0), installed from npm at the exact versions in `package-lock.json`.
- The production bundle contains only PourLab code; it has no runtime dependencies.

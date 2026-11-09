# Repository review

Scope: the repository state starting at `839ccf2`, then the changes made during this review.
This was a risk-based review of entry points, state flow, numerical invariants and failure paths.
The initial branch was clean `main`, equal to `origin/main`; its branch diff was empty.
The owner expanded the review to code, architecture, documentation, performance and interface behaviour.

## Confirmed findings and corrections

| Priority | Category     | Finding                                                                                        | Correction                                                                          | Evidence                                                                          |
| -------- | ------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| HIGH     | Architecture | The validation report substituted interior density for the represented-volume acceptance gate. | Withdraw the pass claim. Label the gate unmet and the results exploratory.          | [raw results](../benchmarks/results.json), [validation](validation.md)            |
| MEDIUM   | Code         | Two overlapping 3D opens could install competing viewers on one canvas.                        | Serialize startup, disable the opening controls, and restore controls after errors. | [app tests](../tests/app.test.ts)                                                 |
| MEDIUM   | Code         | Live GPU failures could escape from detached asynchronous work.                                | Stop playback, report the failure, and observe pending readback rejection.          | [live tests](../tests/live3d.test.ts), [GPU tests](../tests/gpu3d.test.ts)        |
| MEDIUM   | Architecture | Replaced viewers retained scene materials, geometry or their GPU device.                       | Release scene resources and device ownership on replacement or failed startup.      | [viewer code](../src/view3d/scene.ts), [startup tests](../tests/loadLive.test.ts) |
| MEDIUM   | Code         | Timeline positions used the latest speed and temperature arrays.                               | Store those arrays with each timeline frame and include them in the memory budget.  | [app tests](../tests/app.test.ts)                                                 |
| MEDIUM   | Code         | A shared export-format flag mixed up overlapping JSON and CSV requests.                        | Carry the requested format through the worker response.                             | [app tests](../tests/app.test.ts), [worker protocol](../src/worker/host.ts)       |
| MEDIUM   | Code         | A worker crash left playback and pending-request state active.                                 | Stop playback, clear pending state and retain a retry message.                      | [app tests](../tests/app.test.ts)                                                 |
| MEDIUM   | Architecture | The no-pour comparison loaded different duration and physical settings.                        | Preserve the current settings while selecting stationary motion.                    | [app tests](../tests/app.test.ts)                                                 |
| MEDIUM   | Code         | Large parcel counts repeated canvas style updates and map redraws.                             | Batch consecutive opaque colours and invalidate the initial map only when needed.   | [performance](performance.md), [render tests](../tests/render.test.ts)            |
| MEDIUM   | Architecture | The notice file claimed no bundled runtime dependency despite shipping three.js.               | Document three.js and distribute its MIT licence with the static site.              | [notices](THIRD_PARTY_NOTICES.md), [licence](../public/THREE-LICENSE.txt)         |

Further lifecycle correction: an awaited substep from a replaced live run cannot mark the new run as finished.
Restart also synchronizes the play label; pause requests fresh result metrics.
The editor has touch-sized selection, point buttons, keyboard movement and a contained fill preview.
The phone layout places settings before the long result charts. Controls have larger touch targets.

## Architecture assessment

Keep the current boundaries. The worker owns 2D simulation state; the interface consumes snapshots.
Metrics use parcel state. They do not depend on graphics or colour blending.
The optional 3D viewer owns its scene and device. Disposal must follow that ownership boundary.

Keep the CPU reference separate from the GPU implementation.
The GPU solver uses different numerical arithmetic and needs tolerance-based verification.
A faster 2D collision lookup must preserve exact near-wall decisions and reference results.

Do not add unused renderer or transfer backends merely to match the suggested repository layout.
The current transfer implementation stays inside `Simulation`; pressure and rendering already have useful boundaries.

## Documentation assessment

The previous docs only partly met the aircraft-manual clarity goal associated with Karpathy's prompting trick.
Several sections combined long explanations, commands and qualifications in one sentence or table cell.
Two factual claims were wrong: the represented-volume gate and the absence of runtime dependencies.

The [user guide](guide.md) now gives short procedures, explicit conditions and separate result limitations.
The architecture diagrams remain useful. The [requirements matrix](requirements.md) separates evidence from unfinished work.
The original vision remains a historical specification, with a current-status link at the top.

This is a Simplified Technical English inspired edit, not certified ASD-STE100 compliance.
Scientific terms remain where precision requires them. No controlled-dictionary audit has been claimed.
The writing reference is [ASD-STE100](https://www.asd-ste100.org/).

## Review limits

A review and a green test suite do not prove the absence of defects.
Physical validation, real-phone measurements and the remaining matrix gaps stay open.
Those gaps are documented scope and evidence limits; they are not counted as fixed requirements.
See [owner questions](../questions.md) for decisions that require external measurements.

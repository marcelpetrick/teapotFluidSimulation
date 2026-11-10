# Adversarial self-review

Scope: challenge the previous review and release v0.13.4, then implement confirmed improvements.
The previous test pass was useful evidence. It did not establish complete correctness or full requirement coverage.

## Questions I should have asked earlier

| Question                                                    | What the second pass found                                                                               | Action                                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Do all scene components refer to the selected time?         | Timeline parcels and the initial map were historical; the collector still showed latest totals.          | Derive collector volume from the stored statuses. Identify charts and tables as latest measurements.   |
| Can the user recover after a GPU device is lost?            | Play could retry a failed backend, and Restart reused its device.                                        | Stop failed backends, disable stale controls and expose fresh-device startup or recording fallback.    |
| Are final live results current?                             | The last pipelined statistics could remain one step behind when the viewer stopped.                      | Flush statistics after completion. Avoid flushing pauses, which would change the substep-lag contract. |
| Does lower submission cost mean smoother displayed updates? | No. The maximum-count path submitted quickly but sustained only about 10.9 paced redraw opportunities/s. | Add paced measurements and an active-pour case. Use a pixel buffer for dense opaque origin views.      |
| Did end-to-end tests exercise the intended checkout?        | A concurrent test attached to another staged preview through Playwright server reuse.                    | Refuse existing servers. Test maximum-count native rendering in both engines.                          |
| Does a linked test file prove a requirement?                | No. The matrix identifies evidence locations; it cannot prove every assertion or physical accuracy.      | Retain explicit partial states and human review. Do not present the matrix as a certification.         |
| Did publication establish physical validity?                | No. The represented-volume drift gate remains unmet, and no real-pot validation exists.                  | Keep exploratory labels and the failed gate visible. Do not turn missing measurements into a pass.     |

## Weaknesses in my first review

I checked stored scalar arrays without checking the collector at the same timestamp.
I checked that failures stopped playback without testing the complete recovery journey.
I qualified the render-call timings in the docs, but the headline numbers still did not establish smooth frame cadence.

The corrective tests now exercise these cross-component contracts.
The high-count browser test checks native image compositing, immutable state and an intact background.
The unit tests check clipping, painter order, origin colours, highlights, buffer reuse and safe fallbacks.

## Changes and evidence

- [Application regression tests](../tests/app.test.ts): historical collector and fresh-device recovery.
- [Live viewer tests](../tests/live3d.test.ts): failed-backend lockout and final statistics flush.
- [Raster tests](../tests/dense.test.ts): exact origin colours, no state mutation, clipping and fallback rules.
- [Browser tests](../e2e/app.spec.ts): maximum-count native rendering in Chromium and Firefox.
- [Performance method](performance.md) and [raw paced samples](../benchmarks/red-team-ui.json).

The paced maximum-count sample improved from about 10.9 to 60 redraw opportunities/s.
This is a short local rendering test. It does not certify maximum-resolution solver throughput or a real smartphone.

## Follow-through after the second pass

| Follow-up                      | Result                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Investigate represented volume | Added a 14-second, three-resolution still/pour audit and measuring-grid phase probe. All cases still fail the original gate; see [validation](validation.md). Physics and thresholds remain unchanged.             |
| Measure the chosen real phone  | Requires an actual device and owner selection, Q4. Desktop CPU slowdown is explicitly separate evidence.                                                                                                           |
| Test with a screen-reader user | Requires the named browser/assistive setup and a person, Q8. Automated keyboard tests remain available.                                                                                                            |
| Trace critical assertions      | Added nine named test/assertion contracts, checked by the pipeline, including a negative stale-reference check. See [contracts](requirement-assertions.json). This is targeted, not exhaustive assertion coverage. |
| Longer rendering samples       | Added 600 measured frames × three repetitions per case, both maximum-count pot layouts, active pouring and CPU slowdown. See [performance](performance.md).                                                        |

Owner-dependent questions are in [questions.md](../questions.md).
Routine implementation decisions were made directly; no additional approval was introduced.

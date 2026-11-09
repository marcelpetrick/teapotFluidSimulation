# Questions for the owner

These questions do not block the generic browser experiment or this release.
The defaults below stay in use until you provide an answer.

| ID  | Question                                                                                  | Current default                                              | Why the answer matters                                                   |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Q1  | Does 1.5 L mean liquid fill or the pot’s nominal capacity?                                | 1.5 L of liquid, with headspace.                             | Sets the initial volume and fill level.                                  |
| Q2  | What are the real pot dimensions and spout dimensions?                                    | Generic labelled geometry.                                   | Required before predicting a specific pot.                               |
| Q3  | Is the lid fitted? Is its vent open? Is an infuser present?                               | Open vent, no lid interaction, no infuser.                   | Changes air entry and internal flow.                                     |
| Q4  | Which phone and browser should define the mobile performance target?                      | Desktop browsers plus a narrow viewport with CPU throttling. | Emulation cannot certify phone speed, heat or battery use.               |
| Q5  | Can you provide repeated cold-water pours with collected mass and tilt history?           | Numerical verification only.                                 | Needed for independent physical validation.                              |
| Q6  | Are thermal predictions a priority? Are several temperature-probe measurements available? | Thermal modes remain exploratory.                            | Needed to fit and validate cooling boundaries.                           |
| Q7  | Is the main goal explanation or quantitative prediction of your pot?                      | Explain transport with visible model limits.                 | Quantitative prediction needs measured geometry and a convergence study. |

Repository, project name and licence are already resolved: PourLab, this repository, GPL-3.0-or-later.
No further approval is needed for routine implementation choices or the requested public release.

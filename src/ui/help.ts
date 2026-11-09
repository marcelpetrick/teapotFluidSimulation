// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Tooltip texts: what each control is and what it influences. Applied as `title` (hover
// tooltip) and `aria-description` (screen readers) by the App.

/** Help for static page controls, by element id. */
export const CONTROL_HELP: Record<string, string> = {
  skin: 'Switch the look: clean lab, or cyber neon with glass panels and glowing liquid. Remembered in this browser.',
  'mode-auto': 'Follow the light or dark setting of your system.',
  'mode-light': 'Always use the light colours (lab look).',
  'mode-dark': 'Always use the dark colours (lab look). Cyber neon is always dark.',
  soundToggle:
    'Turn the generated soundscape on or off: a calm space ambience, plus a pouring sound whose loudness follows how much tea is flowing.',
  volume: 'Overall sound volume.',
  open3d:
    'Load the recorded 3D reference pour (about 2 MB, loaded only now) and view it in 3D: drag to rotate, scroll to zoom, right-drag to pan.',
  v3play: 'Play or pause the 3D recording. You can rotate and zoom the view at any time.',
  v3restart: 'Play the 3D recording from the start.',
  v3speed: 'Playback speed of the 3D recording.',
  v3reset: 'Return the camera to the starting view.',
  v3scrub: 'Jump to any moment of the 3D recording.',
  pour: 'Start the experiment: the pot tilts, liquid leaves through the spout or lip, then the pot returns upright near the target volume.',
  play: 'Play or pause the simulation (keyboard: Space). Pausing keeps the state; nothing is lost.',
  step: 'Advance exactly 1/60 s of simulated time, then pause. Useful to inspect the flow frame by frame.',
  reset: 'Restart the current experiment from its initial state with the same settings and seed.',
  speed:
    'Playback speed: how fast simulated time runs compared with real time. It changes only the viewing rate, not the physics or the pour motion.',
  tiltSlider:
    'Tilt the pot by hand (degrees). The pot follows smoothly like a hand would; every input is recorded in the JSON export so the run can be reproduced.',
  scrub:
    'Scrub through stored frames of this run (pause first). Frames are stored states, not a backward simulation.',
  mode: 'Colour the parcels by their starting layer, show only poured parcels, colour by speed, or by temperature (thermal mode).',
  highlight: 'Show one starting layer in colour and dim the others, to follow where that layer goes.',
  pathlines:
    'Trails of 30 sample parcels relative to the pot. Solid dot = current position, hollow ring = where the parcel left through the lip.',
  arrows: 'Arrows show the instantaneous velocity of the liquid (direction and speed) on a coarse grid.',
  markers:
    'Draw the three layers with different shapes (circle, square, triangle) as well as colours, for colour-blind readers and print.',
  diagToggle:
    'Open the diagnostics: volume ledger, pressure solver convergence, divergence, density drift, numerical corrections and performance.',
  cmpStill:
    'Load the control experiment: the same pot left upright for the same time, to see how much the numerics alone move the liquid.',
  cmpSlow:
    'Load the slower pour with the same 400 mL target, to compare how pouring speed changes the result.',
  cmpSpout:
    'Cycle through the pot models: teapot with a low spout -> German glass teapot with a top lip -> pitcher.',
  initialMap:
    'The pot at the start. Parcels that have already been poured are coloured by layer; the rest are grey. It answers: which water did I pour?',
  binsChart:
    'Composition of each successive 50 mL of poured liquid. Hover a bar for numbers. The last bar can be partial.',
  biasChart:
    'B = share of a layer in the cup / share in the pot at the start. B = 1 means that layer was poured in proportion; above 1, over-represented.',
  dischargeChart: 'Poured volume over time; the dashed line is the target.',
  angleChart: 'Tilt angle of the pot over time.',
  expPng: 'Download the current view as a PNG image.',
  expJson:
    'Download the full experiment record: settings, geometry, motion and manual inputs, diagnostics, metrics, history and model limits.',
  expCsv: 'Download the time history and the 50 mL composition bins as CSV for spreadsheets.',
  preset:
    'Ready-made experiments from the project vision: pours, controls, pot models, thermal cases and numerical tests.',
  apply:
    'Check the settings and restart the experiment with them. Invalid values are explained below the form.',
  share: 'Copy a link that reproduces exactly these settings (including a drawn pot) for anyone.',
  shapeCanvas:
    'Pot shape editor. Drag points to reshape the wall; double-click a wall to add a point; select a point and press Delete to remove it.',
  shapeUse:
    'Use the drawn outline as the pot and restart. The fill is lowered automatically if the pot would overflow.',
  shapeRemove: 'Remove the selected wall point (a pot needs at least three).',
  'shape-glass': 'Start the editor from the German glass teapot: wide cylinder, lip at the top.',
  'shape-pitcher': 'Start the editor from the pitcher: rounded body with a rising rim lip.',
  'shape-bowl': 'Start the editor from a wide, shallow bowl with sloped sides.',
  'shape-jug': 'Start the editor from a tall, narrow jug with a flared lip.',
};

/** Help for settings fields, by setting key. */
export const SETTING_HELP: Record<string, string> = {
  vessel:
    'Pot model. Teapot: low inlet and spout. German glass teapot: wide glass cylinder with a lip at the top, so it pours from the surface. Pitcher: rim lip. Drawn pot: your own shape from the editor. Heated cavity: closed box for the thermal benchmark.',
  control:
    'Automatic: the pot tilts and returns by itself near the target. Tilt by hand: you control the angle with the slider.',
  fillMl:
    'How much tea is in the pot at the start (2D-equivalent mL). More fill raises the level and adds parcels; it is limited so the pot does not overflow at rest.',
  targetMl:
    'How much the automatic pour aims to pour. The pot starts returning upright shortly before this; the actual amount is always reported.',
  tiltDuration:
    'Seconds the automatic pour takes to tilt the pot to the hold angle. Shorter = more abrupt, more sloshing.',
  holdAngle:
    'Tilt angle reached by the automatic pour, after which the pot tilts slowly further while pouring.',
  returnDuration: 'Seconds to bring the pot back upright. A slow return lets more liquid follow.',
  duration: 'Total simulated time of the experiment, including the settling after the pour.',
  quality:
    'Resolution: grid cells across the pot body. Higher = finer flow detail and more parcels, but slower (each step roughly doubles the cost).',
  ppc: 'Liquid parcels per grid cell at the start (4, 9 or 16). More parcels = smoother transport and finer colour detail, slower.',
  transfer:
    'How velocities move between parcels and the grid. PIC/FLIP blends a smooth and a lively scheme; APIC keeps rotation better. A numerical choice.',
  flipRatio:
    'FLIP fraction of the PIC/FLIP blend: 1 = lively, little numerical damping; lower = smoother but more artificial mixing.',
  seed: 'Random seed for the tiny jitter of the starting parcel positions. Same seed + settings = identical run.',
  thermal:
    'Off: uniform temperature. Passive: temperature is carried along as a colour but does not move the liquid. Coupled: warm liquid rises (buoyancy).',
  topC: 'Starting temperature at the top of the liquid (degC). A linear profile is used between bottom and top.',
  bottomC: 'Starting temperature at the bottom of the liquid (degC).',
  coolingWm2K:
    'Heat-transfer coefficient for walls and surface (W/m2K). 0 = no cooling. Large values exaggerate cooling so convection appears within seconds.',
};

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { showWebgpuHelp } from '../src/ui/webgpuHelp';

it('preserves the user’s expanded/collapsed help state across repeated failures', () => {
  document.body.innerHTML = '<aside id="webgpuHelp" hidden></aside>';
  showWebgpuHelp(document, true);
  const details = document.querySelector('details')!;
  details.open = false;
  showWebgpuHelp(document, true);
  expect(document.querySelector('details')).toBe(details);
  expect(details.open).toBe(false);
  showWebgpuHelp(document, false);
  expect(document.getElementById('webgpuHelp')!.hidden).toBe(true);
  document.body.innerHTML = '';
  expect(() => showWebgpuHelp(document, true)).not.toThrow();
});

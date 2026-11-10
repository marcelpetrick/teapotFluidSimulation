// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
// Shared setup guidance: inspect runtime capability rather than guessing from the browser name.
export function showWebgpuHelp(doc: Document, visible: boolean): void {
  const box = doc.getElementById('webgpuHelp');
  if (!box) return;
  box.hidden = !visible;
  if (!visible || box.childElementCount) return;
  box.innerHTML = `
    <p><strong>WebGPU is not enabled or available in this browser session.</strong>
      The 2D simulation and the recorded 3D pour work without it.</p>
    <details open>
      <summary title="Browser settings and checks for live GPU simulation">Enable WebGPU — Linux, Firefox and Chrome</summary>
      <p><strong>Firefox on Linux:</strong> open <code>about:config</code>, find
        <code>dom.webgpu.enabled</code> and set it to <code>true</code>.
        Restart Firefox, then reload this page. Linux support is experimental;
        Firefox Nightly enables it by default. If it still fails, inspect
        <code>about:support</code> for WebGPU and graphics failure details.</p>
      <p><strong>Chrome / Chromium on Linux:</strong> enable graphics acceleration in
        <code>chrome://settings/system</code>. Open
        <code>chrome://flags/#enable-unsafe-webgpu</code> and enable it; also enable
        <code>chrome://flags/#enable-vulkan</code> if listed. Relaunch the browser.
        Check <code>chrome://gpu</code> for “WebGPU: Hardware accelerated”.
        If the Vulkan flag is absent, Google's guide describes launching with
        <code>--enable-features=Vulkan</code> and <code>--enable-unsafe-webgpu</code>.</p>
      <p>Use <strong>HTTPS or localhost</strong>, and a GPU driver with Vulkan support on Linux.
        Experimental settings do not guarantee that your browser can use the GPU.</p>
      <p><strong>Android phones:</strong> Chrome supports WebGPU on compatible devices.
        Firefox Android stable does not currently enable it; Beta/Nightly support is experimental.
        The 2D simulation and recording are available without changing browsers.</p>
      <p>Browser support changes. Current instructions:
        <a href="https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Experimental_features#webgpu_api">Firefox</a>,
        <a href="https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips">Chrome</a>,
        <a href="https://github.com/gpuweb/gpuweb/wiki/Implementation-Status">Android and platform status</a>.</p>
    </details>`;
}

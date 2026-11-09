// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
//
// Check that every relative link and image in the tracked Markdown files points to an existing
// file or directory. External URLs and in-page anchors are skipped. Exit code 1 on broken links.
// Usage: node scripts/check-links.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

const SKIP = new Set(['node_modules', 'dist', 'coverage', 'test-results', 'playwright-report', '.git']);
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name)) return [];
    const p = dir === '.' ? e.name : join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.md') ? [p] : [];
  });
}
// Tracked Markdown files; outside a git checkout (e.g. scripts/verify-staged.sh) scan the tree.
let files;
try {
  files = execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .filter(Boolean);
} catch {
  files = walk('.');
}
const broken = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, ''); // ignore code blocks
  for (const m of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = decodeURIComponent(target.split('#')[0]);
    if (!path) continue;
    if (!existsSync(join(dirname(file), path))) broken.push(`${file}: ${target}`);
  }
}
if (broken.length) {
  console.error(`Broken links (${broken.length}):\n${broken.join('\n')}`);
  process.exit(1);
}
console.log(`All relative links OK in ${files.length} Markdown files.`);

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marcel Petrick
// Check matrix structure and summary counts. This cannot establish scientific coverage.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import process from 'node:process';

const file = process.argv[2] ?? 'docs/requirements.md';
const text = readFileSync(file, 'utf8');
const rows = text
  .split('\n')
  .filter((line) => /^\|\s*R\d+\s*\|/.test(line))
  .map((line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );
const allowed = new Set(['Verified', 'Partial', 'Deferred', 'Owner', 'Decision']);
const ids = new Set();
const sections = new Set();
const counts = new Map();
const errors = [];
const vision = readFileSync('docs/vision.md');
const fingerprint = /Vision SHA-256: `([a-f0-9]{64})`/.exec(text)?.[1];
if (fingerprint !== createHash('sha256').update(vision).digest('hex'))
  errors.push('Vision changed: review affected requirements and then update the matrix fingerprint.');
for (const row of rows) {
  const [id, source, requirement, status, implementation, evidence, qualification] = row;
  if (row.length !== 7 || !requirement || !qualification) errors.push(`Incomplete row ${id}`);
  if (ids.has(id)) errors.push(`Duplicate ID ${id}`);
  ids.add(id);
  if (!allowed.has(status)) errors.push(`Unknown status ${status} for ${id}`);
  counts.set(status, (counts.get(status) ?? 0) + 1);
  const section = /§(\d+)/.exec(source)?.[1];
  if (section) sections.add(section);
  else errors.push(`Missing vision section for ${id}`);
  if (!implementation?.includes('](') || !evidence?.includes(']('))
    errors.push(`Missing evidence link for ${id}`);
}
for (const status of allowed) {
  const summary = new RegExp(`^\\|\\s*${status}\\s*\\|\\s*(\\d+)\\s*\\|`, 'm').exec(text);
  if (!summary || Number(summary[1]) !== (counts.get(status) ?? 0))
    errors.push(`Incorrect ${status} summary count`);
}
const declared = /contains \*\*(\d+) requirements\*\*/.exec(text);
if (!declared || Number(declared[1]) !== rows.length) errors.push('Incorrect total requirement count');
for (const match of vision.toString('utf8').matchAll(/^## (\d+)\./gm))
  if (!sections.has(match[1])) errors.push(`Vision section ${match[1]} has no mapped requirement`);
// Critical contracts name both the test and an assertion inside its body. The full
// pipeline executes these tests; this check detects stale trace links, not correctness.
const contracts = JSON.parse(readFileSync('docs/requirement-assertions.json', 'utf8'));
for (const contract of contracts) {
  const { requirement, file: testFile, test, assertion } = contract;
  if (!ids.has(requirement)) errors.push(`Unknown assertion requirement ${requirement}`);
  const source = readFileSync(testFile, 'utf8');
  const declaration = `it('${test}'`;
  const start = source.indexOf(declaration);
  const next = source.indexOf('\n  it(', start + declaration.length);
  const body = source.slice(start, next < 0 ? undefined : next);
  if (start < 0 || !assertion.startsWith('expect(') || !body.includes(assertion))
    errors.push(`Stale assertion evidence: ${requirement}: ${testFile}: ${test}`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(
  `Requirements: ${rows.length} unique rows; ${sections.size} vision sections; status counts agree; ${contracts.length} named assertion contracts exist.`,
);

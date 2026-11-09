#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Marcel Petrick
#
# Local pipeline, mirrored 1:1 by .github/workflows/pipeline.yml.
# Stages: install -> format check -> markdown links -> lint -> typecheck -> unit+integration tests with
# coverage (>= 95 % lines, enforced by vite.config.ts) -> production build -> e2e
# (Chromium + Firefox against the build served under the GitHub Pages sub-path).
#
# Usage: ./localPipeline.sh [--no-e2e] [--no-install]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
RUN_E2E=1
RUN_INSTALL=1
for arg in "$@"; do
  case "$arg" in
    --no-e2e) RUN_E2E=0 ;;
    --no-install) RUN_INSTALL=0 ;;
    -h|--help) sed -n '4,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

declare -a SUMMARY=()
stage() {
  local name="$1"; shift
  local start=$SECONDS
  printf '\n==> %s\n' "$name"
  if "$@"; then
    SUMMARY+=("PASS  $name ($((SECONDS - start)) s)")
  else
    SUMMARY+=("FAIL  $name ($((SECONDS - start)) s)")
    printf '\n%s\n' "${SUMMARY[@]}"
    echo "Pipeline FAILED at: $name" >&2
    exit 1
  fi
}

if [[ $RUN_INSTALL == 1 ]]; then stage "install (npm ci)" npm ci --no-audit --no-fund; fi
stage "format check (prettier)" npm run --silent format:check
stage "markdown links" node scripts/check-links.mjs
stage "lint (eslint)" npm run --silent lint
stage "typecheck (tsc)" npm run --silent typecheck
stage "unit + integration tests with coverage" npm run --silent coverage
stage "build (vite)" npm run --silent build
if [[ $RUN_E2E == 1 && -d e2e ]]; then
  if [[ -n "${CI:-}" ]]; then stage "install e2e browsers" npx playwright install --with-deps chromium firefox
  else stage "install e2e browsers" npx playwright install chromium firefox; fi
  stage "e2e (playwright: chromium, firefox)" npm run --silent e2e
fi

printf '\n==> Summary\n'
printf '%s\n' "${SUMMARY[@]}"
echo "Pipeline PASSED"

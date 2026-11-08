#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Marcel Petrick
#
# Run ./localPipeline.sh against exactly what is staged (the next commit), not the
# working tree. Exports the index into a temporary directory, links node_modules,
# runs the pipeline there and cleans up. Extra arguments go to localPipeline.sh.
# Usage: scripts/verify-staged.sh [--no-e2e]
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pourlab-staged.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
git -C "$ROOT" checkout-index -a --prefix="$TMP/"
ln -s "$ROOT/node_modules" "$TMP/node_modules"
cd "$TMP"
./localPipeline.sh --no-install "$@"

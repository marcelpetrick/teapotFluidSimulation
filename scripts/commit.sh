#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Marcel Petrick
#
# Verify-then-commit: runs scripts/verify-staged.sh on the staged tree and only
# commits (and pushes) when it passes. Refuses to commit otherwise.
# Usage: scripts/commit.sh "type(scope): subject" ["body paragraph" ...] [--no-push]
set -euo pipefail
PUSH=1
declare -a MSG=()
for a in "$@"; do
  if [[ "$a" == "--no-push" ]]; then PUSH=0; else MSG+=(-m "$a"); fi
done
[[ ${#MSG[@]} -gt 0 ]] || { echo "usage: $0 \"type(scope): subject\" [body...] [--no-push]" >&2; exit 2; }
ROOT="$(git rev-parse --show-toplevel)"
if ! "$ROOT/scripts/verify-staged.sh"; then
  echo "verification FAILED - nothing committed" >&2
  exit 1
fi
git commit "${MSG[@]}"
if [[ $PUSH == 1 ]]; then git push; fi

#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Marcel Petrick
#
# Bump the semantic version in package.json and package-lock.json without tagging.
# Every commit bumps "patch"; a major feature bumps "minor". Prints the new version.
# Usage: scripts/bump-version.sh patch|minor|major
set -euo pipefail
LEVEL="${1:-patch}"
case "$LEVEL" in patch|minor|major) ;; *) echo "usage: $0 patch|minor|major" >&2; exit 2 ;; esac
cd "$(git rev-parse --show-toplevel)"
npm version "$LEVEL" --no-git-tag-version >/dev/null
node -p "require('./package.json').version"

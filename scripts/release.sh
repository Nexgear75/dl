#!/usr/bin/env bash
# Publishes a new version: bumps every version field, runs the checks,
# commits, tags vX.Y.Z and pushes. GitHub Actions then builds the binaries
# and creates the release; installed copies pick it up within the hour.
# Usage: scripts/release.sh 0.2.0
set -euo pipefail

RUST_DIR=daemon

VERSION="${1:?usage: $0 X.Y.Z}"
VERSION="${VERSION#v}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must look like 1.2.3" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean: commit first" >&2; exit 1; }
git rev-parse "v$VERSION" >/dev/null 2>&1 && { echo "tag v$VERSION already exists" >&2; exit 1; }

# package.json + Cargo.toml ([package] version is the first version line)
sed -i '' -E "s/^(  \"version\": )\"[^\"]+\"/\1\"$VERSION\"/" tui/package.json
sed -i '' -E "1,/^version = /s/^version = \"[^\"]+\"/version = \"$VERSION\"/" "$RUST_DIR/Cargo.toml"
(cd "$RUST_DIR" && cargo update --workspace --quiet)

echo "› checks"
(cd "$RUST_DIR" && cargo build --release --quiet)
(cd tui && bun install --frozen-lockfile >/dev/null && bun run typecheck >/dev/null && bun test 2>&1 | tail -1)

git add tui/package.json "$RUST_DIR/Cargo.toml" "$RUST_DIR/Cargo.lock"
git commit -q -m "Release v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"
git push -q origin HEAD "v$VERSION"
echo "✓ v$VERSION pushed — the build runs at https://github.com/$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')/actions"

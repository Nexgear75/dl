#!/usr/bin/env bash
# Builds the release archive for one macOS architecture:
#   dist/release/dl-darwin-<arch>.tar.gz  (dl + dl-daemon)
# Usage: scripts/build-release.sh arm64|x64
set -euo pipefail

NAME=dl
RUST_DIR=daemon
RUST_BIN=dl-daemon

ARCH="${1:?usage: $0 arm64|x64}"
case "$ARCH" in
  arm64) TRIPLE=aarch64-apple-darwin ;;
  x64) TRIPLE=x86_64-apple-darwin ;;
  *) echo "unknown arch: $ARCH" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/release/$ARCH"
rm -rf "$OUT" && mkdir -p "$OUT"

echo "› $RUST_BIN ($TRIPLE)"
(cd "$ROOT/$RUST_DIR" && cargo build --release --locked --target "$TRIPLE")
cp "$ROOT/$RUST_DIR/target/$TRIPLE/release/$RUST_BIN" "$OUT/"

echo "› $NAME (bun-darwin-$ARCH)"
(cd "$ROOT/tui" && bun install --frozen-lockfile && bun build src/index.tsx --compile --minify \
  --target="bun-darwin-$ARCH" --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  --outfile "$OUT/$NAME")

# ad-hoc signature (required on Apple Silicon, harmless on Intel)
codesign --force --sign - "$OUT/$NAME" "$OUT/$RUST_BIN"

tar -czf "$ROOT/dist/release/$NAME-darwin-$ARCH.tar.gz" -C "$OUT" "$NAME" "$RUST_BIN"
echo "✓ dist/release/$NAME-darwin-$ARCH.tar.gz"

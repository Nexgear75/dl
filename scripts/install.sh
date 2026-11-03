#!/usr/bin/env bash
# Builds dl (TUI) and dl-daemon (Rust) and installs both into $PREFIX (default ~/.local/bin).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${PREFIX:-$HOME/.local/bin}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' is required ($2)" >&2; exit 1; }; }
want() { command -v "$1" >/dev/null 2>&1 || echo "warning: '$1' not found — $2" >&2; }

need cargo "https://rustup.rs"
need bun "https://bun.sh"
want aria2c "install it with: brew install aria2"
want yt-dlp "video links will not work (brew install yt-dlp)"
want ffmpeg "yt-dlp needs it to merge video and audio (brew install ffmpeg)"

echo "› building dl-daemon (release)"
(cd "$ROOT/daemon" && cargo build --release --quiet)

echo "› building dl"
(cd "$ROOT/tui" && bun install --frozen-lockfile >/dev/null && bun run build >/dev/null)

# stop a running daemon so the new binary is used on next launch
if command -v dl >/dev/null 2>&1; then dl --stop >/dev/null 2>&1 || true; fi

mkdir -p "$PREFIX"
install -m 755 "$ROOT/daemon/target/release/dl-daemon" "$PREFIX/dl-daemon"
install -m 755 "$ROOT/dist/dl" "$PREFIX/dl"

echo "✓ installed $PREFIX/dl and $PREFIX/dl-daemon"
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "note: add $PREFIX to your PATH (e.g. in ~/.zshrc: export PATH=\"$PREFIX:\$PATH\")" ;;
esac

#!/usr/bin/env bash
# Installs dl (download manager) and/or tf (torrent search) on macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/Nexgear75/dl/master/install.sh | bash
#
# Non-interactive:   … | bash -s -- dl tf       (or: dl · tf · --yes)
# Uninstall:         … | bash -s -- --uninstall
# Install folder:    PREFIX=~/bin … | bash      (default ~/.local/bin)
#
# The same file lives in github.com/Nexgear75/dl and github.com/Nexgear75/torrent-finder.
set -euo pipefail

PREFIX="${PREFIX:-$HOME/.local/bin}"

DL_REPO="Nexgear75/dl"
TF_REPO="Nexgear75/torrent-finder"

# ---------------------------------------------------------------- output
if [ -t 1 ]; then
  B=$'\033[1m' D=$'\033[2m' G=$'\033[32m' Y=$'\033[33m' R=$'\033[31m' C=$'\033[36m' N=$'\033[0m'
else
  B='' D='' G='' Y='' R='' C='' N=''
fi
step() { printf '%s›%s %s\n' "$C" "$N" "$*"; }
ok() { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*" >&2; }
die() { printf '%s✗%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# prompts read the keyboard even when the script comes from `curl | bash`
HAS_TTY=0
if [ -z "${CI:-}" ] && (exec </dev/tty) 2>/dev/null; then HAS_TTY=1; fi
ASSUME_YES=0

# ask "Question?" default(y|n) → returns 0 for yes
ask() {
  local q="$1" def="${2:-y}" hint ans
  [ "$def" = y ] && hint='[Y/n]' || hint='[y/N]'
  if [ "$ASSUME_YES" = 1 ] || [ "$HAS_TTY" = 0 ]; then [ "$def" = y ]; return; fi
  printf '%s %s%s%s ' "$q" "$D" "$hint" "$N" >/dev/tty
  read -r ans </dev/tty || ans=''
  ans="$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')"
  [ -z "$ans" ] && ans="$def"
  [ "$ans" = y ] || [ "$ans" = yes ] || [ "$ans" = o ] || [ "$ans" = oui ]
}

# ---------------------------------------------------------------- homebrew
BREW=''
find_brew() {
  for b in "$(command -v brew 2>/dev/null || true)" /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -n "$b" ] && [ -x "$b" ]; then BREW="$b"; return 0; fi
  done
  return 1
}

ensure_brew() {
  find_brew && return 0
  echo
  echo "Homebrew (brew.sh) installs the tools dl and tf rely on (aria2, yt-dlp, ffmpeg, Jackett)."
  ask "Install Homebrew now? It will ask for your password." y || die "Homebrew is required. Install it from https://brew.sh and run this again."
  if [ "$HAS_TTY" = 1 ]; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty
  else
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
  find_brew || die "Homebrew installation failed"
  eval "$("$BREW" shellenv)"
}

# brew_need <command> <formula>: installs the formula unless the command exists
brew_need() {
  local cmd="$1" formula="$2"
  if command -v "$cmd" >/dev/null 2>&1 || { [ -n "$BREW" ] && [ -x "$(dirname "$BREW")/$cmd" ]; }; then
    printf '  %s%-8s%s already installed\n' "$D" "$formula" "$N"
    return 0
  fi
  ensure_brew
  step "brew install $formula"
  HOMEBREW_NO_ENV_HINTS=1 "$BREW" install --quiet "$formula" || die "brew install $formula failed"
}

# ---------------------------------------------------------------- releases
TMP=''
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; return 0; }
trap cleanup EXIT

# install_release <repo> <name> <bin...>
install_release() {
  local repo="$1" name="$2"; shift 2
  local asset="$name-darwin-$ARCH.tar.gz"
  local base="https://github.com/$repo/releases/latest/download"
  local dir="$TMP/$name"
  mkdir -p "$dir"
  step "downloading $name"
  curl -fsSL --retry 3 -o "$dir/$asset" "$base/$asset" || die "cannot download $base/$asset"
  curl -fsSL --retry 3 -o "$dir/checksums.txt" "$base/checksums.txt" || die "cannot download $base/checksums.txt"
  local expected actual
  expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$dir/checksums.txt")"
  actual="$(shasum -a 256 "$dir/$asset" | awk '{ print $1 }')"
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || die "checksum mismatch for $asset"
  tar -xzf "$dir/$asset" -C "$dir"
  mkdir -p "$PREFIX"
  local b
  for b in "$@"; do
    [ -f "$dir/$b" ] || die "$b missing from $asset"
    chmod 755 "$dir/$b"
    mv -f "$dir/$b" "$PREFIX/$b"
  done
  ok "$("$PREFIX/$name" --version 2>/dev/null || echo "$name") → $PREFIX"
}

# ---------------------------------------------------------------- PATH
ensure_path() {
  case ":$PATH:" in *":$PREFIX:"*) return 0 ;; esac
  local shell rc line
  shell="$(basename "${SHELL:-zsh}")"
  # shellcheck disable=SC2016
  if [ "$PREFIX" = "$HOME/.local/bin" ]; then line='export PATH="$HOME/.local/bin:$PATH"'; else line="export PATH=\"$PREFIX:\$PATH\""; fi
  case "$shell" in
    zsh) rc="$HOME/.zshrc" ;;
    bash) rc="$HOME/.bash_profile" ;;
    fish)
      mkdir -p "$HOME/.config/fish/conf.d"
      echo "fish_add_path $PREFIX" >"$HOME/.config/fish/conf.d/dl-tf.fish"
      ok "added $PREFIX to PATH (~/.config/fish/conf.d/dl-tf.fish)"
      NEW_SHELL=1
      return 0
      ;;
    *) warn "add $PREFIX to your PATH"; return 0 ;;
  esac
  if ! grep -qsF "$line" "$rc"; then
    printf '\n# dl / tf\n%s\n' "$line" >>"$rc"
    ok "added $PREFIX to PATH (${rc/#$HOME/~})"
  fi
  NEW_SHELL=1
}

# ---------------------------------------------------------------- uninstall
uninstall() {
  echo "${B}Uninstall dl / tf${N}"
  if [ -x "$PREFIX/dl" ]; then "$PREFIX/dl" --stop >/dev/null 2>&1 || true; fi
  local b removed=0
  for b in dl dl-daemon tf tf-backend; do
    if [ -e "$PREFIX/$b" ]; then rm -f "$PREFIX/$b"; removed=1; fi
  done
  [ "$removed" = 1 ] && ok "removed the binaries from $PREFIX" || warn "nothing installed in $PREFIX"
  if ask "Also delete settings, history and download queue (~/.local/share/dl, ~/.local/share/torrent-finder, ~/.config/dl)?" n; then
    rm -rf "$HOME/.local/share/dl" "$HOME/.local/share/torrent-finder" "$HOME/.config/dl"
    ok "data deleted"
  fi
  echo "${D}Homebrew packages (aria2, yt-dlp, ffmpeg, jackett) were kept: brew uninstall them if you want.${N}"
}

# ---------------------------------------------------------------- main
main() {
  local want_dl=0 want_tf=0 do_uninstall=0 a
  for a in "$@"; do
    case "$a" in
      dl) want_dl=1 ;;
      tf) want_tf=1 ;;
      all | both) want_dl=1; want_tf=1 ;;
      -y | --yes) ASSUME_YES=1 ;;
      --uninstall) do_uninstall=1 ;;
      -h | --help) echo "usage: install.sh [dl] [tf] [--yes] [--uninstall]   (PREFIX=… to change $PREFIX)"; return ;;
      *) die "unknown option: $a (use: dl, tf, --yes, --uninstall)" ;;
    esac
  done

  if [ "$do_uninstall" = 1 ]; then uninstall; return; fi

  [ "$(uname -s)" = Darwin ] || die "dl and tf run on macOS only"
  ARCH="$(uname -m)"
  # a shell running under Rosetta still gets the native Apple Silicon build
  if [ "$ARCH" = x86_64 ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null)" = 1 ]; then ARCH=arm64; fi
  case "$ARCH" in arm64) ;; x86_64) ARCH=x64 ;; *) die "unsupported CPU: $ARCH" ;; esac

  echo
  echo "${B}dl${N} ${D}— download manager: links, torrents, magnets, YouTube & co.${N}"
  echo "${B}tf${N} ${D}— torrent search engine across every site, sends results to dl${N}"
  echo

  if [ "$want_dl$want_tf" = 00 ]; then
    if [ "$HAS_TTY" = 1 ] && [ "$ASSUME_YES" = 0 ]; then
      echo "What do you want to install?"
      echo "  ${B}1${N}) both  ${D}(recommended)${N}"
      echo "  ${B}2${N}) dl only"
      echo "  ${B}3${N}) tf only"
      printf 'Choice %s[1]%s ' "$D" "$N" >/dev/tty
      read -r a </dev/tty || a=''
      case "${a:-1}" in
        1) want_dl=1; want_tf=1 ;;
        2) want_dl=1 ;;
        3) want_tf=1 ;;
        *) die "unknown choice: $a" ;;
      esac
    else
      want_dl=1; want_tf=1
    fi
  fi
  if [ "$want_tf" = 1 ] && [ "$want_dl" = 0 ] && [ ! -x "$PREFIX/dl-daemon" ]; then
    if ask "tf hands its downloads to dl. Install dl too?" y; then want_dl=1; else warn "without dl, tf can search but not download"; fi
  fi

  echo
  step "dependencies"
  find_brew || true
  if [ "$want_dl" = 1 ]; then
    brew_need aria2c aria2
    brew_need yt-dlp yt-dlp
    brew_need ffmpeg ffmpeg
  fi
  if [ "$want_tf" = 1 ]; then
    brew_need jackett jackett
  fi

  TMP="$(mktemp -d)"
  echo
  [ "$want_dl" = 1 ] && install_release "$DL_REPO" dl dl dl-daemon
  [ "$want_tf" = 1 ] && install_release "$TF_REPO" tf tf tf-backend

  NEW_SHELL=0
  ensure_path

  echo
  ok "${B}done${N}"
  local run=''
  [ "$want_tf" = 1 ] && run="tf"
  [ "$want_dl" = 1 ] && run="${run:+$run or }dl"
  if [ "$NEW_SHELL" = 1 ]; then
    echo "  Open a new terminal (or run ${B}exec \$SHELL${N}), then type ${B}$run${N}."
  else
    echo "  Type ${B}$run${N} to start."
  fi
  echo "  ${D}Updates install themselves in the background. Uninstall: same command with ${N}bash -s -- --uninstall"
}

main "$@"

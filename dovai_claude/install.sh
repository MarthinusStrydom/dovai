#!/usr/bin/env bash
# Dovai bootstrap — idempotent one-time setup.
#
# What this does:
#   1. Checks for required CLI tools (node, claude, brew, etc.)
#   2. Installs missing host extractors via Homebrew (pdftotext, ocrmypdf,
#      tesseract, pandoc) if you say yes
#   3. Runs `npm install` in the project
#   4. Symlinks a `dovai` command into a PATH-accessible bin folder
#      (prefers ~/.local/bin, falls back to /usr/local/bin with sudo)
#
# Run it as many times as you like — it only does the parts that aren't
# already done.
#
# Usage:
#   ./install.sh           interactive
#   ./install.sh --yes     assume yes to every prompt

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ASSUME_YES=0
if [ "${1:-}" = "--yes" ] || [ "${1:-}" = "-y" ]; then
  ASSUME_YES=1
fi

# ---------- pretty printing ----------
c_reset="\033[0m"; c_dim="\033[2m"; c_bold="\033[1m"
c_blue="\033[34m"; c_green="\033[32m"; c_yellow="\033[33m"; c_red="\033[31m"

say()   { printf "${c_blue}●${c_reset} %s\n" "$*"; }
ok()    { printf "${c_green}✓${c_reset} %s\n" "$*"; }
warn()  { printf "${c_yellow}!${c_reset} %s\n" "$*"; }
fail()  { printf "${c_red}✗${c_reset} %s\n" "$*" >&2; }
header(){ printf "\n${c_bold}%s${c_reset}\n" "$*"; }

ask_yn() {
  local prompt="$1" default="${2:-y}"
  if [ "$ASSUME_YES" = "1" ]; then return 0; fi
  local yn
  if [ "$default" = "y" ]; then prompt="$prompt [Y/n] "; else prompt="$prompt [y/N] "; fi
  printf "  %s" "$prompt"
  read -r yn
  yn="${yn:-$default}"
  case "$yn" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# ---------- step 1: node ----------
header "1. Node.js"
if have node; then
  NODE_MAJOR=$(node -v | sed -E 's/v([0-9]+).*/\1/')
  if [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
    ok "node $(node -v)"
  else
    fail "node $(node -v) is too old — need Node 20 or newer"
    warn "install from https://nodejs.org/ or run: brew install node"
    exit 1
  fi
else
  fail "node is not installed"
  warn "install from https://nodejs.org/ or run: brew install node"
  exit 1
fi

# ---------- step 2: claude code ----------
header "2. Claude Code"
if have claude; then
  ok "claude $(claude --version 2>/dev/null | head -1 || echo installed)"
else
  warn "claude is not installed — Dovai uses Claude Code as its agent runtime"
  warn "install from https://docs.anthropic.com/en/docs/claude-code"
  if ! ask_yn "continue anyway?" n; then exit 1; fi
fi

# ---------- step 3: homebrew + extractors ----------
header "3. File extractors (optional but recommended)"
PLATFORM=$(uname -s)
if [ "$PLATFORM" = "Darwin" ]; then
  if have brew; then
    ok "homebrew present"
    MISSING=""
    have pdftotext || MISSING="$MISSING poppler"
    have tesseract || MISSING="$MISSING tesseract"
    have pandoc    || MISSING="$MISSING pandoc"
    have ocrmypdf  || MISSING="$MISSING ocrmypdf"

    if [ -n "$MISSING" ]; then
      warn "missing extractors:$MISSING"
      warn "without these, PDFs / images / office files can't be summarised"
      if ask_yn "install them with brew now?" y; then
        # shellcheck disable=SC2086
        brew install $MISSING
        ok "extractors installed"
      else
        warn "skipping — you can run this again later"
      fi
    else
      ok "all extractors present (pdftotext, tesseract, pandoc, ocrmypdf)"
    fi
  else
    warn "homebrew not found — skipping extractor installation"
    warn "install from https://brew.sh/ and rerun this script"
  fi
else
  warn "non-macOS platform ($PLATFORM) — install poppler, tesseract, pandoc, ocrmypdf via your package manager"
fi

# ---------- step 4: npm install ----------
header "4. Project dependencies"
cd "$SCRIPT_DIR"
if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
  ok "node_modules already present (run 'npm install' manually to update)"
else
  say "running npm install…"
  npm install
  ok "dependencies installed"
fi

# ---------- step 5: symlink command-line shortcuts ----------
header "5. Command-line shortcuts"

# Pick the best bin directory on PATH
pick_bindir() {
  local candidates="$HOME/.local/bin /usr/local/bin /opt/homebrew/bin"
  for d in $candidates; do
    case ":$PATH:" in
      *":$d:"*) echo "$d"; return 0 ;;
    esac
  done
  echo ""
  return 1
}

BINDIR=$(pick_bindir)
if [ -z "$BINDIR" ]; then
  warn "no standard bin directory is on your PATH"
  warn "creating ~/.local/bin — add this to your shell rc:"
  warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  mkdir -p "$HOME/.local/bin"
  BINDIR="$HOME/.local/bin"
fi

# Symlink each shortcut into BINDIR.
link_shortcut() {
  local name="$1"
  local target="$SCRIPT_DIR/bin/$name"
  local link="$BINDIR/$name"
  if [ ! -x "$target" ]; then
    fail "bin/$name is missing or not executable — something is wrong with this checkout"
    return 1
  fi
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
    ok "$name already linked at $link"
    return 0
  fi
  if [ -e "$link" ]; then
    warn "$link exists but points somewhere else"
    if ask_yn "overwrite it?" y; then
      if [ -w "$BINDIR" ]; then
        ln -sf "$target" "$link"
      else
        sudo ln -sf "$target" "$link"
      fi
      ok "$name linked at $link"
    else
      warn "skipped $name — run it from $target instead"
    fi
  else
    if [ -w "$BINDIR" ]; then
      ln -s "$target" "$link"
    else
      say "need sudo to write to $BINDIR"
      sudo ln -s "$target" "$link"
    fi
    ok "$name linked at $link"
  fi
}

link_shortcut dovai
link_shortcut cdovai

# ---------- done ----------
header "Done"
cat <<EOF

You can now run Dovai from anywhere:

  ${c_bold}dovai${c_reset}                launch Sarah (start server + AI CLI)
  ${c_bold}dovai --new-window${c_reset}   same, in a new Terminal.app window

Server management:
  ${c_dim}dovai start${c_reset}          start the server daemon only
  ${c_dim}dovai stop${c_reset}           stop the server
  ${c_dim}dovai status${c_reset}         pre-flight + server status
  ${c_dim}dovai doctor${c_reset}         check prerequisites
  ${c_dim}dovai help${c_reset}           full usage

EOF

#!/usr/bin/env bash
#
# Lockstep updater for the pi browser-automation pair.
#
# pi-agent-browser-native (a pi package) and agent-browser (a global npm binary)
# are hard-coupled: each wrapper release targets ONE exact upstream version and
# ships no compatibility shims. They also live in different package managers, so
# `pi update` moves one and not the other.
#
# This script updates both together, or neither. It reads the wrapper's own
# declared baseline rather than assuming "latest" upstream is correct.
#
# Usage:
#   ./scripts/update-agent-browser.sh            # update if a new wrapper exists
#   ./scripts/update-agent-browser.sh --check    # report only, change nothing
#
set -euo pipefail

WRAPPER="pi-agent-browser-native"
UPSTREAM="agent-browser"
PI_NPM_ROOT="${HOME}/.pi/agent/npm/node_modules"
BASELINE_REL="scripts/agent-browser-capability-baseline.mjs"

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

log()  { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Read CAPABILITY_BASELINE.targetVersion from an installed wrapper.
read_baseline() {
  # Note: declare then assign. `local a=$1 b=$a` marks both names local before
  # expanding, so $a reads as unset under `set -u`.
  local dir
  local file
  dir="$1"
  file="$dir/$BASELINE_REL"
  [[ -f "$file" ]] || fail "no baseline file at $file"
  BASELINE_FILE="$file" node --input-type=module -e '
      import(new URL(`file://${process.env.BASELINE_FILE}`).href)
        .then((m) => {
          const v = m?.CAPABILITY_BASELINE?.targetVersion;
          if (!v) { process.exit(3); }
          process.stdout.write(v);
        })
        .catch(() => process.exit(3));
    ' || fail "could not read targetVersion from $file"
}

installed_wrapper() {
  node -e "process.stdout.write(require('$PI_NPM_ROOT/$WRAPPER/package.json').version)" 2>/dev/null || true
}

installed_upstream() {
  command -v "$UPSTREAM" >/dev/null 2>&1 || return 0
  "$UPSTREAM" --version 2>/dev/null | awk '{print $NF}' || true
}

# The wrapper doctor shells out to `pi` and enforces a minimum version. A
# repo-local node_modules/.bin/pi shadows the real CLI and causes a false
# runtime-floor failure.
#
# `cd $HOME` alone is NOT enough: `npm run` and `npm exec` both prepend
# node_modules/.bin to PATH, so an older pi is already on PATH before we chdir.
# (Real cases: mical-pi ships pi 0.82.1, ~/Coding/Linny ships 0.81.1, while the
# installed CLI is 0.84.2.) So strip those entries outright.
sanitized_path() {
  printf '%s' "$PATH" | tr ':' '\n' \
    | grep -vE '(^|/)node_modules/\.bin/?$' \
    | paste -sd: -
}

run_doctor() {
  local clean
  clean="$(sanitized_path)"
  ( cd "$HOME" && PATH="$clean" npm exec --package "$WRAPPER" -- pi-agent-browser-doctor )
}

command -v node >/dev/null || fail "node not found"
command -v pi   >/dev/null || fail "pi not found"

HAVE_WRAPPER="$(installed_wrapper)"
HAVE_UPSTREAM="$(installed_upstream)"
[[ -n "$HAVE_WRAPPER" ]] || fail "$WRAPPER is not installed; run: pi install npm:$WRAPPER@<version>"

LATEST_WRAPPER="$(npm view "$WRAPPER" version 2>/dev/null)" \
  || fail "could not reach npm to resolve $WRAPPER"

log "wrapper:  installed $HAVE_WRAPPER, latest $LATEST_WRAPPER"
log "upstream: installed ${HAVE_UPSTREAM:-<none>}, baseline $(read_baseline "$PI_NPM_ROOT/$WRAPPER")"

if [[ "$HAVE_WRAPPER" == "$LATEST_WRAPPER" ]]; then
  log "wrapper is current; verifying the pair is still consistent"
  run_doctor
  exit $?
fi

if (( CHECK_ONLY )); then
  log "update available: $HAVE_WRAPPER -> $LATEST_WRAPPER (re-run without --check to apply)"
  exit 0
fi

log ""
log "==> updating wrapper to $LATEST_WRAPPER"
pi install "npm:$WRAPPER@$LATEST_WRAPPER"

NEW_BASELINE="$(read_baseline "$PI_NPM_ROOT/$WRAPPER")"
log "==> wrapper $LATEST_WRAPPER targets $UPSTREAM $NEW_BASELINE"

if [[ "$NEW_BASELINE" != "$HAVE_UPSTREAM" ]]; then
  log "==> updating $UPSTREAM ${HAVE_UPSTREAM:-<none>} -> $NEW_BASELINE"
  npm install -g "$UPSTREAM@$NEW_BASELINE"
else
  log "==> $UPSTREAM already at $NEW_BASELINE"
fi

log ""
log "==> verifying"
if run_doctor; then
  log ""
  log "updated: wrapper $LATEST_WRAPPER + $UPSTREAM $NEW_BASELINE"
  exit 0
fi

log ""
log "!! doctor failed; rolling back to wrapper $HAVE_WRAPPER + $UPSTREAM ${HAVE_UPSTREAM:-<none>}" >&2
pi install "npm:$WRAPPER@$HAVE_WRAPPER" || log "!! wrapper rollback failed" >&2
if [[ -n "$HAVE_UPSTREAM" ]]; then
  npm install -g "$UPSTREAM@$HAVE_UPSTREAM" || log "!! upstream rollback failed" >&2
fi
fail "update rejected and rolled back; inspect the doctor output above"

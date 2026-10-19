#!/usr/bin/env bash
# Runs Gnaude in a throwaway headless GNOME Shell against the mock API.
#
# Everything (HOME, XDG dirs, runtime dir, D-Bus session, keyring) lives in a
# temporary directory, so the real session and its settings are not touched.
# Usage: [GNAUDE_E2E_LANGUAGE=fr] test/e2e/run.sh [OUTPUT_DIR]
#
# Visual check next to other installed extensions, using copies of their settings:
#   GNAUDE_E2E_SCENARIO=visual GNAUDE_E2E_EXTRA=blur-my-shell@aunetx \
#   GNAUDE_E2E_DCONF=/org/gnome/shell/extensions/blur-my-shell/ test/e2e/run.sh

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
REAL_EXTENSIONS="$HOME/.local/share/gnome-shell/extensions"
OUT=${1:-$(mktemp -d -t gnaude-e2e-XXXXXX)}
SANDBOX=$(mktemp -d -t gnaude-e2e-home-XXXXXX)
PORT=${MOCK_PORT:-18766}
mkdir -p "$OUT"
rm -f "$OUT/done" "$OUT/result.json"

# Settings of the extra extensions, copied from the real session (read-only there).
for path in ${GNAUDE_E2E_DCONF:-}; do
    dconf dump "$path" > "$SANDBOX/$(echo "$path" | tr / _).ini"
done

export HOME="$SANDBOX/home"
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share"
export XDG_CACHE_HOME="$HOME/.cache" XDG_STATE_HOME="$HOME/.local/state"
# Short path: Wayland socket paths are limited to 108 bytes.
export XDG_RUNTIME_DIR=$(mktemp -d /tmp/gnaude-run-XXXXXX)
export WAYLAND_DISPLAY=gnaude-e2e GDK_BACKEND=wayland
export GNAUDE_E2E_OUT="$OUT" GNAUDE_E2E_MOCK="http://127.0.0.1:$PORT"
export GNAUDE_E2E_SCENARIO=${GNAUDE_E2E_SCENARIO:-full} GNAUDE_E2E_EXTRA=${GNAUDE_E2E_EXTRA:-}
# UI language under test; LANGUAGE works without the matching locale being generated.
export GNAUDE_E2E_LANGUAGE=${GNAUDE_E2E_LANGUAGE:-en}
export LANG=en_US.UTF-8 LANGUAGE=$GNAUDE_E2E_LANGUAGE
unset DISPLAY DBUS_SESSION_BUS_ADDRESS LC_ALL LC_MESSAGES
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_DATA_HOME/gnome-shell/extensions"
chmod 700 "$XDG_RUNTIME_DIR"

make -C "$ROOT" --quiet schemas translations
ln -s "$ROOT" "$XDG_DATA_HOME/gnome-shell/extensions/gnaude@n2soft.de"
ln -s "$ROOT/test/e2e/gnaude-e2e@test" "$XDG_DATA_HOME/gnome-shell/extensions/gnaude-e2e@test"
for uuid in $GNAUDE_E2E_EXTRA; do
    ln -s "$REAL_EXTENSIONS/$uuid" "$XDG_DATA_HOME/gnome-shell/extensions/$uuid"
done

python3 "$ROOT/test/mock_server.py" "$PORT" &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null; rm -rf "$SANDBOX" "$XDG_RUNTIME_DIR"' EXIT

dbus-run-session -- bash -euo pipefail -c '
    echo -n e2e | gnome-keyring-daemon --unlock --components=secrets >/dev/null
    gjs -m "$0/test/e2e/store-key.js"

    for ini in "$1"/*.ini; do
        [ -e "$ini" ] || continue
        path=$(basename "$ini" .ini | tr _ /)
        dconf load "$path" < "$ini"
    done
    # Individual overrides on top, e.g. GNAUDE_E2E_DCONF_SET="/org/x/key=true"
    for setting in ${GNAUDE_E2E_DCONF_SET:-}; do
        dconf write "${setting%%=*}" "${setting#*=}"
    done

    # The driver comes first, so disabling Gnaude does not reload the driver.
    extensions="\"gnaude-e2e@test\", \"gnaude@n2soft.de\""
    for uuid in $GNAUDE_E2E_EXTRA; do extensions="$extensions, \"$uuid\""; done
    gsettings set org.gnome.shell enabled-extensions "[$extensions]"
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"

    gnome-shell --headless --wayland --no-x11 --virtual-monitor 1600x1000 \
        --wayland-display "$WAYLAND_DISPLAY" >"$GNAUDE_E2E_OUT/shell.log" 2>&1 &
    shell=$!
    for _ in $(seq 120); do
        [ -e "$GNAUDE_E2E_OUT/done" ] && break
        sleep 1
    done
    kill $shell 2>/dev/null || true
    wait $shell 2>/dev/null || true
' "$ROOT" "$SANDBOX"

if [ ! -e "$OUT/result.json" ]; then
    echo "E2E run did not finish; see $OUT/shell.log" >&2
    exit 1
fi

python3 - "$OUT" <<'EOF'
import json, sys
out = sys.argv[1]
results = json.load(open(f"{out}/result.json"))
for r in results:
    print(("ok   " if r["ok"] else "FAIL ") + r["name"] + ("" if r["ok"] else f" -- {r['detail']}"))
failed = [r for r in results if not r["ok"]]
errors = [l for l in open(f"{out}/shell.log", errors="replace")
          if ("JS ERROR" in l or "JS WARNING" in l or "Gnaude" in l or "gnaude" in l)]
print("\nShell log lines mentioning JS errors/warnings or Gnaude:")
print("".join(errors) or "  (none)")
print(f"{len(results) - len(failed)}/{len(results)} checks passed; screenshots in {out}")
sys.exit(1 if failed else 0)
EOF

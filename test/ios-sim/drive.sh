#!/usr/bin/env bash
# Drives the built app on a simulator: install, launch, wait for the in-app self-test to write its
# report, then take the screenshots the owner reviews. No Apple account, no signing, no device.
#
# Everything here is `xcrun simctl` — the same tool Xcode uses — so the whole iOS check runs on a
# GitHub macOS runner with plain shell, no XCUITest target and no third-party action.
#
# Usage (from the repository root, after test/ios-sim/prepare-www.js + xcodebuild):
#   test/ios-sim/drive.sh --app ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app --out .tmp/ios-ui
set -euo pipefail

APP=""
OUT=".tmp/ios-ui"
LIBRARY=
# --tour switches the screenshot phase to the page-driven tour; a default is not optional here, the
# script runs under `set -u` and referencing an unset TOUR aborted a whole run (line 128) after the app
# had already done its work — the report was written, the screenshots never taken.
TOUR=""
DEVICE="${DG_SIM_DEVICE:-iPhone 17}"
BUNDLE="gift.dhamma.mobile"
WAIT_SECONDS="${DG_SELFTEST_TIMEOUT:-300}"

while [ $# -gt 0 ]; do
    case "$1" in
        --app) APP="$2"; shift 2 ;;
        --out) OUT="$2"; shift 2 ;;
        --device) DEVICE="$2"; shift 2 ;;
        --library) LIBRARY="$2"; shift 2 ;;
        --tour) TOUR=1; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

[ -d "$APP" ] || { echo "drive: no .app at $APP" >&2; exit 1; }
mkdir -p "$OUT"

# Pick the newest available runtime for the requested device name, so this keeps working when the
# runner image replaces iOS 26.x with 26.y — the device list, not a hardcoded UDID, is the contract.
UDID=$(xcrun simctl list devices available | grep -E "^ *$DEVICE \(" | tail -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
[ -n "$UDID" ] || { echo "drive: no available simulator named '$DEVICE'" >&2; xcrun simctl list devices available >&2; exit 1; }
echo "drive: device $DEVICE = $UDID"

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
# A fresh container every run: the offline library must be downloaded by THIS build, or a stale
# OPFS copy from an earlier run would make a broken build look healthy.
xcrun simctl uninstall "$UDID" "$BUNDLE" 2>/dev/null || true

xcrun simctl install "$UDID" "$APP"

# --library: put the packaged fixture where DgDownloadPlugin downloads to (Application Support,
# excluded from backup), BEFORE the first launch. That is the whole point of the run: the app must
# find the archive in its own storage and import it, with no network involved at all.
if [ -n "$LIBRARY" ]; then
    CONTAINER=$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data)
    mkdir -p "$CONTAINER/Library/Application Support/dg-library"
    cp "$LIBRARY"/* "$CONTAINER/Library/Application Support/dg-library/"
    ls -la "$CONTAINER/Library/Application Support/dg-library"
fi
# --console-pty keeps the app's stdout/stderr in the job log, which is where NSString NSLog lines
# and WebKit's own complaints show up. Backgrounded: the run below waits on a file, not on the
# process (simctl launch stays in the foreground for as long as the app lives).
xcrun simctl launch --console-pty "$UDID" "$BUNDLE" > "$OUT/app-console.log" 2>&1 &

DATA_DIR=""
REPORT=""
for i in $(seq 1 "$WAIT_SECONDS"); do
    if [ -z "$DATA_DIR" ]; then
        DATA_DIR=$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data 2>/dev/null || true)
    fi
    if [ -n "$DATA_DIR" ] && [ -f "$DATA_DIR/Documents/selftest.json" ]; then
        REPORT="$DATA_DIR/Documents/selftest.json"
        # The write is atomic, so a file that exists is complete.
        break
    fi
    sleep 1
done

if [ -z "$REPORT" ]; then
    echo "drive: the app never wrote Documents/selftest.json within ${WAIT_SECONDS}s" >&2
    xcrun simctl io "$UDID" screenshot "$OUT/ios-timeout.png" 2>/dev/null || true
    echo "--- app console (last 80 lines) ---" >&2
    tail -80 "$OUT/app-console.log" >&2 || true
    exit 1
fi

cp "$REPORT" "$OUT/selftest.json"
echo "drive: self-test report at $REPORT"

# The deep link, opened by the page itself (selftest.js, dhammagift://route/toc). NOT through
# `simctl openurl`: that is an open from OUTSIDE the app, and iOS answers it with SpringBoard's
# "Open in Dhamma.gift?" confirmation — which no headless run can tap, and which then sits in every
# screenshot. The chain being tested is the same either way: CFBundleURLTypes, SceneDelegate,
# Capacitor's appUrlOpen event, src/deep-link.js's mapping. What is different is only the tap, and
# that is what a device test is for.
for i in $(seq 1 20); do
    cp "$REPORT" "$OUT/selftest.json" 2>/dev/null || true
    if grep -q '"currentPath": "/toc' "$OUT/selftest.json" 2>/dev/null; then break; fi
    sleep 1
done
cp "$REPORT" "$OUT/selftest.json"

# One pass of the screenshot tour: relaunch (so the tour runs again), then take a picture every time
# the page announces it has reached a view. The announcement is a file (DgSelfTest.stage →
# Documents/stage.txt) overwritten per stage; a screenshot taken at a guessed moment is worse than
# none, because it looks like a bug.
tour_pass() {
    TAG="$1"; LANG_ARGS="${2:-}"
    xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
    [ -n "$DATA_DIR" ] && rm -f "$DATA_DIR/Documents/stage.txt"
    if [ -n "$LANG_ARGS" ]; then
        # shellcheck disable=SC2086
        xcrun simctl launch "$UDID" "$BUNDLE" $LANG_ARGS >/dev/null 2>&1 || true
    else
        xcrun simctl launch --console-pty "$UDID" "$BUNDLE" >> "$OUT/app-console.log" 2>&1 &
    fi
    LAST=""
    for i in $(seq 1 180); do
        S=$(cat "$DATA_DIR/Documents/stage.txt" 2>/dev/null || true)
        if [ -n "$S" ] && [ "$S" != "$LAST" ]; then
            LAST="$S"
            echo "drive: stage $S ($TAG)"
            if [ "$S" = "done" ]; then return 0; fi
            sleep 1
            xcrun simctl io "$UDID" screenshot "$OUT/ios-$S-$TAG.png" >/dev/null
        fi
        sleep 1
    done
    return 0
}

if [ -n "$TOUR" ]; then
    tour_pass light-en
    xcrun simctl ui "$UDID" appearance dark
    tour_pass dark-en
    # Russian, dark: the second language the reader is built for, and the one whose layout differs
    # most (longer words, its own strings). AppleLanguages is what a real Russian phone reports.
    tour_pass dark-ru "-AppleLanguages (ru) -AppleLocale ru_RU"
else
# The self-test navigates the app to search results served from the local database on its way out
# (see selftest.js), so these screenshots show the app with real local data, not its home screen.
# Light/dark is the simulator's own appearance switch, which is exactly what the site's theme
# follows (prefers-color-scheme).
sleep 6
xcrun simctl io "$UDID" screenshot "$OUT/ios-light-en.png" >/dev/null
xcrun simctl ui "$UDID" appearance dark
sleep 3
xcrun simctl io "$UDID" screenshot "$OUT/ios-dark-en.png" >/dev/null

# Russian, dark: the second language the reader is built for, and the one whose layout differs most
# (longer words, its own strings). AppleLanguages is what a real Russian phone reports.
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl launch "$UDID" "$BUNDLE" -AppleLanguages '(ru)' -AppleLocale ru_RU >/dev/null 2>&1 || true
sleep 12
xcrun simctl io "$UDID" screenshot "$OUT/ios-dark-ru.png" >/dev/null
fi

echo "drive: screenshots in $OUT"
# Stop the app so the backgrounded `simctl launch --console-pty` returns instead of holding the step
# open until the runner kills the process group.
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
ls -la "$OUT"

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
DEVICE="${DG_SIM_DEVICE:-iPhone 17}"
BUNDLE="gift.dhamma.mobile"
WAIT_SECONDS="${DG_SELFTEST_TIMEOUT:-300}"

while [ $# -gt 0 ]; do
    case "$1" in
        --app) APP="$2"; shift 2 ;;
        --out) OUT="$2"; shift 2 ;;
        --device) DEVICE="$2"; shift 2 ;;
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

# A deep link, opened the way the system opens one: while the app is up, through its scheme. The
# page records where it ended up (selftest.js's route watcher), which is the only way to see this
# from outside the WebView — and it proves the whole chain at once: Info.plist's CFBundleURLTypes,
# SceneDelegate, Capacitor's appUrlOpen event, and src/deep-link.js's mapping.
xcrun simctl openurl "$UDID" "dhammagift://route/toc" || echo "drive: openurl failed" >&2
for i in $(seq 1 15); do
    cp "$REPORT" "$OUT/selftest.json"
    if grep -q '"/toc' "$OUT/selftest.json" 2>/dev/null; then break; fi
    sleep 1
done
cp "$REPORT" "$OUT/selftest.json"

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

echo "drive: screenshots in $OUT"
# Stop the app so the backgrounded `simctl launch --console-pty` returns instead of holding the step
# open until the runner kills the process group.
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
ls -la "$OUT"

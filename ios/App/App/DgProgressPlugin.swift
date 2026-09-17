import UIKit
import Capacitor

// Mirror of Android's DgProgressPlugin — same name, same two methods, deliberately: native-bridge.js
// already calls Capacitor.Plugins.DgProgress.update({title,text,percent}) / clear() while the
// offline library downloads, so iOS needs no web-side change at all.
//
// What it does NOT do is what Android's does. Android shows an ongoing notification with a
// determinate bar; iOS has no such thing (a local notification cannot render a percentage), and the
// page's own progress card is already the progress UI. The one thing that genuinely has to be
// native here is the IDLE TIMER: when the screen locks, iOS suspends the WebView's JavaScript and
// the 216 MB transfer dies mid-way — Android solved that with a foreground service and a wake lock,
// iOS solves it with isIdleTimerDisabled for as long as progress events keep arriving.
//
// ponytail: no Live Activity, no notification permission, no widget target. Add a Live Activity if
// the reader ever needs progress visible while the app is in the background; the app cannot finish
// that download in the background anyway (a native URLSession will, and that is the change which
// makes it worth doing).
@objc(DgProgressPlugin)
public class DgProgressPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DgProgressPlugin"
    public let jsName = "DgProgress"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]

    // Both touch UIKit state, so both go to the main thread.
    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = true
            call.resolve(["awake": true])
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = false
            call.resolve(["awake": false])
        }
    }
}

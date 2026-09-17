import UIKit
import Capacitor

// The app's own bridge view controller: CAPBridgeViewController plus the plugins that live in this
// target rather than in an npm package.
//
// Capacitor loads the npm plugins (App, Browser, Dialog, Network, Share, StatusBar) from the
// package list `cap sync` writes; anything written here has to be registered by hand, and it has to
// happen before the page loads. capacitorDidLoad() is Capacitor's own hook for exactly that: the
// bridge exists, the first navigation has not started.
//
// What is registered here, and why:
//   DgProgressPlugin  the idle timer that keeps the screen awake while the library downloads
//   DgTtsPlugin       the reader's voice (WKWebView's own speechSynthesis has no voices)
//   DgSelfTestPlugin  debug builds only: the CI simulator run's way of getting results out
//
// Note for the next plugin: Capacitor 8's iOS CAPPlugin has no handleOnDestroy (Android's has), so a
// cleanup hook has to be a deinit — an @objc override of it fails the build with "does not override
// any method from its superclass".
class DgBridgeViewController: CAPBridgeViewController {

    override func capacitorDidLoad() {
        // Ships in the app: it keeps the screen awake while the offline library downloads
        // (DgProgressPlugin.swift), which is what stops iOS suspending the transfer mid-way.
        bridge?.registerPluginInstance(DgProgressPlugin())
        // Also shipped: the WebView's own speechSynthesis has no voices (see DgTtsPlugin.swift), and
        // the reader's voice player is part of the reader.
        bridge?.registerPluginInstance(DgTtsPlugin())

        #if DEBUG
        // Debug builds only, and deliberately so: this plugin lets the page write a file into the
        // app's Documents directory, which no shipped build may be able to do on a web page's
        // behalf. A release build's `Capacitor.Plugins.DgSelfTest` is therefore undefined.
        bridge?.registerPluginInstance(DgSelfTestPlugin())
        #endif
    }
}

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
// Today there is one such plugin — DgSelfTest, which the CI simulator run uses to get results out of
// the WebView (see test/ios-sim/). The downloader, TTS, quick-action and progress plugins will
// register here too, so this stays the single list of what native code this app adds.
class DgBridgeViewController: CAPBridgeViewController {

    override func capacitorDidLoad() {
        #if DEBUG
        // Debug builds only, and deliberately so: this plugin lets the page write a file into the
        // app's Documents directory, which no shipped build may be able to do on a web page's
        // behalf. A release build's `Capacitor.Plugins.DgSelfTest` is therefore undefined.
        bridge?.registerPluginInstance(DgSelfTestPlugin())
        #endif
    }
}

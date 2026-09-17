import Foundation
import Capacitor

// Writes a JSON report handed over by the page into the app's Documents directory, so a simulator
// run can read it straight out of the container:
//
//     xcrun simctl get_app_container booted gift.dhamma.mobile data
//
// Why this exists at all: the checks that matter for iOS run INSIDE the WKWebView (did the offline
// library download into OPFS, does the search core answer from it), and a GitHub runner has no
// debugger and no Xcode UI to look at. The page has no filesystem of its own, so it needs one native
// call to hand its results out. The alternative — an XCUITest target — means a second Xcode target
// plus accessibility plumbing, for results that are already plain JSON.
//
// Registered only in DEBUG builds (see DgBridgeViewController) and never in a shipped app.
@objc(DgSelfTestPlugin)
public class DgSelfTestPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DgSelfTestPlugin"
    public let jsName = "DgSelfTest"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise)
    ]

    @objc func write(_ call: CAPPluginCall) {
        guard let json = call.getString("json") else {
            call.reject("missing json")
            return
        }
        do {
            let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let url = dir.appendingPathComponent("selftest.json")
            try json.write(to: url, atomically: true, encoding: .utf8)
            // Also a line in the system log, so `simctl launch --console` or the job log shows the
            // result's path even when reading the container is awkward.
            NSLog("DG_SELFTEST_WRITTEN %@", url.path)
            call.resolve(["path": url.path])
        } catch {
            call.reject("could not write selftest.json: \(error.localizedDescription)")
        }
    }
}

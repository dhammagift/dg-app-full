import AppIntents
import SwiftUI
import WidgetKit

// Control Center (iOS 18+): a control that opens the Dhamma.gift library, added in
// Settings → Control Center or from the + button in Control Center itself.
//
// It is a widget extension because that is the only place a ControlWidget can be declared: the
// system discovers controls in extension binaries carrying the NSExtensionPointIdentifier
// com.apple.widgetkit-extension, never in the app target.
//
// The extension process has no Capacitor and no running WebView, so there is no DgShortcutsPlugin
// to post to. Instead the control's intent returns .result(opensIntent: OpenURLIntent(...)) — the
// documented iOS 18 way for a control to open its app — handing over the same dhammagift://route
// URL every other launch path uses (src/deep-link.js maps it; SceneDelegate → Capacitor's App
// plugin → the page). An in-app copy of the open intent (DgAppIntents.swift) exists so the phrase
// also works from Siri and the Shortcuts app in the app's own process.
//
// iOS 26 introduced a ControlWidgetButton initializer taking an OpenURLIntent directly; the
// AppIntent form is used here because it is the one iOS 18.0 also has — the deployment target of
// this extension is 18.0, and the button must build against both.
@available(iOS 18.0, *)
struct DgOpenLibraryControlIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Dhamma.gift"
    static let description = IntentDescription("Opens the Dhamma.gift library.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & OpensIntent {
        let route = URL(string: "dhammagift://route/")
            ?? URL(string: "dhammagift://")!
        return .result(opensIntent: OpenURLIntent(route))
    }
}

@available(iOS 18.0, *)
struct DgLibraryControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "gift.dhamma.mobile.DgLibraryControl") {
            ControlWidgetButton(action: DgOpenLibraryControlIntent()) {
                Label("Dhamma.gift", systemImage: "book")
            }
        }
        .displayName("Dhamma.gift")
        .description("Opens the offline Pāli canon library.")
    }
}

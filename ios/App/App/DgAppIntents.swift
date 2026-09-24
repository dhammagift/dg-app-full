import AppIntents
import Foundation

// App Intents: Siri, the Shortcuts app and Spotlight speak these.
//
// The app's inputs are ROUTES (SPA paths like /toc, /mn1) and search terms, and the app's tested
// way of opening them is the dhammagift:// URL scheme mapped by src/deep-link.js — the same
// contract test/deep-link.test.js checks, the same tap path the static and dynamic quick actions
// take (DgShortcutsPlugin.perform). Nothing here builds URLs on its own beyond `dhammagift://route`
// + the route the caller already uses, so a change in how the app opens a page cannot fork into a
// second implementation.
//
// Localization: the phrases live in AppShortcuts.strings (en, ru — variant groups in the Xcode
// project); their keys repeat the phrase with ${applicationName}/${section}/${query} placeholders,
// and every key MUST contain ${applicationName} — that is the App Intents compiler's rule, not a
// style preference. Intent titles, parameter titles and the section names below are translated in
// Localizable.strings of the same two variant groups.
//
// The Control Center control is a different surface and lives in the DgControls extension target
// (DgControls/DgControlWidget.swift): a ControlWidget must be declared in an app extension, whose
// process has no Capacitor and no bridge to post to — so it opens the app with an OpenURLIntent
// instead of reusing the router below.

// The App Shortcuts Siri offers out of the box. Every phrase carries \(.applicationName) (the
// compiler requires it) and the parameterized ones project their parameter so Siri enumerates the
// values ("open Dhamma.gift dictionary"). The icon is the app's own brand mark (DgGlyph in
// Assets.xcassets), not a system glyph — these tiles appear in Siri suggestions and the Shortcuts
// app next to the app's icon, and "book" could be any reader.
struct DgAppShortcuts: AppShortcutsProvider {
    @AppShortcutsBuilder
    var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: DgOpenAppIntent(),
            phrases: [
                "Open \(.applicationName)",
                "Открыть \(.applicationName)"
            ],
            shortTitle: "Open Dhamma.gift",
            systemImageName: "DgGlyph"
        )
        AppShortcut(
            intent: DgOpenSectionIntent(),
            phrases: [
                "Open \(.applicationName) \(\.$section)"
            ],
            shortTitle: "Open a section",
            systemImageName: "DgGlyph"
        )
        AppShortcut(
            intent: DgSearchIntent(),
            phrases: [
                "Search \(.applicationName) for \(\.$query)"
            ],
            shortTitle: "Search the library",
            systemImageName: "DgGlyph"
        )
    }
}

// MARK: - The routing part

// Every intent funnels into this: one place turns a route into the app's own deep-link URL and
// posts it exactly where a tapped Home Screen quick action goes. perform() of an openAppWhenRun
// intent runs in the app's own process (Siri, Shortcuts, Spotlight), so DgShortcutsPlugin's
// NotificationCenter post reaches the running bridge — and if the app is cold, the system delivers
// the URL as its launch URL and the same bridge path runs after startup.
enum DgAppIntentsRouter {
    static func open(route: String) {
        DgShortcutsPlugin.perform(route: route)
    }

    // /search?q=… is the site's dedicated results page (a route the deep-link contract already
    // maps: dhammagift://route/search?q=kacchapa in test/deep-link.test.js). The query value is
    // percent-encoded here, before DgShortcutsPlugin turns the route into a URL — its fallback
    // encodes with .urlPathAllowed, which would turn the ? separator itself into %3F and the
    // search into a path segment. Only unreserved characters survive, so &, # and ? in a spoken
    // query cannot break the URL's structure.
    static func openSearch(query: String) {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        let encoded = query.addingPercentEncoding(withAllowedCharacters: allowed) ?? query
        DgAppIntentsRouter.open(route: "/search?q=" + encoded)
    }
}

// The routes Siri can name: the reader plus the four static quick actions from Info.plist — the
// same five destinations, one vocabulary for both surfaces, and every one of them is a route the
// deep-link contract already maps (each is exercised in test/deep-link.test.js). Case titles carry
// the app name so Siri reads "Dhamma.gift Reader" rather than a bare "Reader" that could collide
// with another app's intent; the display names are translated in Localizable.strings (en, ru).
enum DgAppSection: String, AppEnum {
    case reader = "/mn1"
    case favorites = "/4as"
    case tableOfContents = "/toc"
    case memo = "/memo"
    case dictionary = "/dict"

    static var typeDisplayRepresentation: TypeDisplayRepresentation {
        TypeDisplayRepresentation(name: "Dhamma.gift section")
    }

    static var caseDisplayRepresentations: [DgAppSection: DisplayRepresentation] {
        [
            .reader: DisplayRepresentation(title: "Dhamma.gift Reader", image: DisplayRepresentation.Icon(systemName: "book")),
            .favorites: DisplayRepresentation(title: "Dhamma.gift Favorites", image: DisplayRepresentation.Icon(systemName: "heart")),
            .tableOfContents: DisplayRepresentation(title: "Dhamma.gift Table of Contents", image: DisplayRepresentation.Icon(systemName: "list.bullet")),
            .memo: DisplayRepresentation(title: "Dhamma.gift Memo", image: DisplayRepresentation.Icon(systemName: "square.and.pencil")),
            .dictionary: DisplayRepresentation(title: "Dhamma.gift Dictionary", image: DisplayRepresentation.Icon(systemName: "character.book.closed")),
        ]
    }

    var route: String { rawValue }
}

// MARK: - Intents

// "Open Dhamma.gift": the home page, no parameter, no dialog.
struct DgOpenAppIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Dhamma.gift"
    // No categoryName/resultValueName: the IntentDescription overload that takes them is iOS 17+,
    // and this app still ships to 16.4 (project.pbxproj). They only group and label the action
    // inside the Shortcuts app, so dropping them costs presentation, not behavior.
    static let description = IntentDescription("Opens Dhamma.gift.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        DgAppIntentsRouter.open(route: "/")
        return .result()
    }
}

// The parameterized "Open section". Unspecified parameter: Siri asks, and the fall-back
// destination is the table of contents — the section a first-time user is most likely to mean by
// "open the app somewhere".
struct DgOpenSectionIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Section"
    static let description = IntentDescription(
        "Opens a section of Dhamma.gift: the reader, favorites, the table of contents, memo or the dictionary."
    )
    static let openAppWhenRun = true

    @Parameter(title: "Section", requestValueDialog: "Which section?")
    var section: DgAppSection?

    static var parameterSummary: some ParameterSummary {
        Summary("Open \(\.$section)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        let target = section ?? .tableOfContents
        DgAppIntentsRouter.open(route: target.route)
        return .result()
    }
}

// Voice search: "Search Dhamma.gift for kacchapa" — the same ?q= delivery the share extension
// uses (dhammagift://search?q=…), so the offline library answers the moment it is downloaded.
struct DgSearchIntent: AppIntent {
    static let title: LocalizedStringResource = "Search Dhamma.gift"
    static let description = IntentDescription("Searches the offline Pāli canon library.")
    static let openAppWhenRun = true

    // No inputBehavior: that parameter belongs to an iOS 17+ overload of the @Parameter
    // initializer, and leaving it out only changes how the field accepts dropped text.
    @Parameter(title: "Query", requestValueDialog: "What should I search for?")
    var query: String

    static var parameterSummary: some ParameterSummary {
        Summary("Search for \(\.$query)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { return .result() }
        DgAppIntentsRouter.openSearch(query: term)
        return .result()
    }
}

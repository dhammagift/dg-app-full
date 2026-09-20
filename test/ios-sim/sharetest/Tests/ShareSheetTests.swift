import XCTest

// Share → Dhamma.gift, checked from the outside: Safari's own share button, the system sheet, our
// extension in it, and our sheet staying open with its content — the thing builds 170–195 could
// only be checked on the owner's phone.
//
// XCUITest and not Maestro (caa7f97 dropped that check): Maestro finds neither the system share
// sheet's buttons by id nor by their label (the name sits in accessibilityText), and worse, it
// reports a tap on an element that is not on screen as done. XCUITest sees the whole accessibility
// tree, including the share sheet and the extension's remote view inside Safari, and fails
// honestly when something is not there.
//
// Preconditions (build-app.yml): the app is installed on the booted simulator (drive.sh did that,
// with the fixture library) and Safari has been sent to a page with `simctl openurl`.
final class ShareSheetTests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testSharingFromSafariOpensTheDhammaGiftSheet() throws {
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        safari.activate()
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 30), "Safari did not come to the foreground")
        // A page fully on screen before anything is tapped: on a simulator that never ran Safari
        // before, the toolbar is not drawn until the page has settled.
        _ = safari.otherElements.firstMatch.waitForExistence(timeout: 10)

        // A simulator's first-ever Safari launch shows a one-time tip ("View Bookmarks, Share
        // Menu, and Open Tabs — you can now view these items in the ⊙ menu") over a TipView
        // popover, and it eats the first tap if not dismissed.
        let tipClose = safari.buttons["xmark.circle.fill"]
        if tipClose.waitForExistence(timeout: 5) { tipClose.tap() }

        // This Safari's compact toolbar folded Bookmarks/Share/Tabs into one overflow button — the
        // tip above says so, and the accessibility tree confirms it: no "Share"-labelled button
        // exists directly in the toolbar any more, only 'MoreMenuButton' ("More"). Older Safari
        // (still what devices run today) keeps a direct "ShareButton"/"Share" button, so both are
        // tried before assuming which shape this run has.
        let direct = [
            safari.buttons["ShareButton"],
            safari.toolbars.buttons["Share"],
        ]
        var share: XCUIElement?
        for candidate in direct where candidate.waitForExistence(timeout: 5) {
            share = candidate
            break
        }
        if share == nil {
            let more = safari.buttons["MoreMenuButton"]
            if more.waitForExistence(timeout: 15) {
                more.tap()
                let menuShare = safari.buttons.matching(NSPredicate(format: "label == 'Share'")).firstMatch
                if menuShare.waitForExistence(timeout: 10) { share = menuShare }
            }
        }
        guard let share = share else {
            print("--- Safari accessibility tree (share button not found) ---")
            print(safari.debugDescription)
            XCTFail("Safari's share button is not on screen (tried the toolbar and the More menu)")
            return
        }
        share.tap()
        attach("1-share-sheet", safari)

        // The extension's row in the sheet. Apps sit in a horizontal strip that may need a swipe
        // before a new one is visible; the label is the extension's CFBundleDisplayName.
        let ours = safari.descendants(matching: .any).matching(NSPredicate(format: "label == 'Dhamma.gift'")).firstMatch
        var tries = 0
        while !ours.exists && tries < 4 {
            if let strip = safari.scrollViews.allElementsBoundByIndex.first(where: { $0.isHittable }) {
                strip.swipeLeft()
            }
            tries += 1
        }
        XCTAssertTrue(ours.waitForExistence(timeout: 10), "Dhamma.gift is not offered in the share sheet")
        ours.tap()

        // Our ShareViewController: the Done button is native and ours; the web view is the app's
        // own page loaded from the bundle at capacitor://localhost.
        let done = safari.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 30), "the Dhamma.gift sheet did not open (no Done button)")
        let web = safari.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 30), "the sheet has no web view")
        _ = web.staticTexts.firstMatch.waitForExistence(timeout: 20)
        attach("2-dhamma-gift-sheet", safari)
        XCTAssertTrue(done.exists, "the sheet closed by itself")

        // Offline search inside the sheet: Safari shared a link (not a word), so the extension
        // already ran that link as its own query (search(for:) in ShareViewController.swift — it is
        // not dhamma.gift, so the raw URL became `?q=https://example.com/`, which the search core
        // rejects as an invalid regular expression, run 229's actual screenshot). The real query is
        // typed into the page's own search box over whatever that left behind.
        //
        // NOT `web.searchFields` — the 251 failure's accessibility dump showed why: `web` (from
        // `safari.webViews.firstMatch`) matched Safari's OWN page's webview (the shared
        // "Example Domain" tab, first in the tree), not our extension's, which lives in a separate
        // top-level window below it. The dump also settled the earlier guess: the field's real type
        // IS `SearchField` (placeholder "e.g. Kāyagat or sn56.11") — the type wasn't the problem,
        // the scope was. Queried app-wide instead: Safari's own address bar is a plain `TextField`
        // (identifier 'TabBarItemTitle'), so `searchFields` has exactly one match regardless of
        // which window it is in.
        let box = safari.searchFields.firstMatch
        guard box.waitForExistence(timeout: 20) else {
            print("--- Safari accessibility tree (search box not found) ---")
            print(safari.debugDescription)
            XCTFail("the page's search box is not there")
            return
        }
        // A WKWebView input's first tap after its window/sheet appears does not always pick up
        // keyboard focus in the simulator (run 252's failure: "Failed to synthesize event: Neither
        // element nor any descendant has keyboard focus", right after a plain tap()) — retapping
        // after a short pause is the usual fix for this XCUITest quirk. XCUIElement has no
        // `hasKeyboardFocus` in this SDK (253's compile error), so the software keyboard's own
        // appearance is the readable signal that the tap actually landed.
        let keyboard = safari.keyboards.firstMatch
        for _ in 0..<5 where !keyboard.exists {
            box.tap()
            _ = keyboard.waitForExistence(timeout: 2)
        }
        guard keyboard.exists else {
            XCTFail("could not give the search box keyboard focus (no keyboard appeared)")
            return
        }
        // The failed link-search left its own query in the box; backspace it out by its own length
        // rather than assume the field starts empty (an empty web input can report its placeholder
        // as `.value`, which is harmless to over-delete into).
        if let existing = box.value as? String, !existing.isEmpty {
            box.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
        }
        box.typeText("kacchapa\n")
        // App-wide too, for the same reason `box` is: the result lives in the extension's own
        // window, not in `web` (Safari's page webview).
        let hit = safari.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Mahāsatipaṭṭhānasutta'")).firstMatch
        XCTAssertTrue(hit.waitForExistence(timeout: 45), "no offline result for kacchapa in the sheet")
        attach("3-offline-results", safari)
    }

    private func attach(_ name: String, _ app: XCUIApplication) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}

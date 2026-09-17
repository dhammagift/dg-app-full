# iOS / App Store / CI research — dhamma.gift offline reader (Capacitor 8)

Date of research: 2026-09-17. All facts verified against primary docs fetched that day.

---

## 1. Guideline 4.2 "Minimum Functionality" and WebView wrappers

**What the guideline actually says** (verbatim, current text):

- 4.2: "Your app should include features, content, and UI that elevate it beyond a repackaged website. If your app is not particularly useful, unique, or 'app-like,' it doesn't belong on the App Store... Apps that are simply a book or game guide should be submitted to the Apple Books Store."
- 4.2.2: "Other than catalogs, apps shouldn't primarily be marketing materials, advertisements, web clippings, content aggregators, or a collection of links."
- 4.2.3(i): app must work on its own without installing another app.
- 4.2.3(ii): "If your app needs to download additional resources in order to function on initial launch, disclose the size of the download and prompt users before doing so."
- 2.1(a): review gets final builds; incomplete/crashing apps rejected; reviewer must be able to use it.

**What reviewers reject (observed pattern)**: not WebView/Capacitor per se. The rejection trigger is "the same content works identically in Safari with no meaningful loss" — i.e. a URL-pointing shell with no offline behavior, no native APIs, no native shell layout, sometimes after N resubmissions with no new explanation.

**Documented/observed mitigations** (consensus of practitioner guides; none is a guarantee):
1. Real offline behavior — content bundled in the binary or downloaded and served locally; no blank screen/spinner when offline.
2. At least one genuinely native platform feature a browser tab can't offer: home-screen widget, Face ID-gated content, share extension, background sync, real push tied to user-relevant events.
3. Native shell layout: fixed header + scrollable content + 3–5 item bottom tab bar, safe-area handling (`viewport-fit=cover`), hidden scrollbars, no browser chrome, bottom sheets instead of centered modals, haptics on interactions, 44px tap targets.
4. Explicit App Review notes listing the native features and how the app differs from the website; reviewer must get past any login/demo account.

**Assessment for this app**: locally bundled UI + local SQLite + fully offline reading (plus a one-time 216 MB dataset) is materially stronger than the typical rejected wrapper; the main residual 4.2 risk is "it's a book/reader → send it to Apple Books" phrasing, which argues for adding at least one or two native integrations (widget / Spotlight / App Intents / share) and a precise review note.

**Sources**
- https://developer.apple.com/app-store/review/guidelines/ (4.2, 4.2.2, 4.2.3, 2.1(a))
- https://blog.despia.com/convert-a-website-to-a-mobile-app-without-rejection (updated 2026-06-28)
- https://acceptmy.app/guides/web-app-to-ios-app-store-requirements (updated 2026-08)
- Apple Developer Forums thread on 4.2: https://developer.apple.com/forums/thread/806726 (thread exists; content not machine-readable — treat as unverified)
- StackOverflow, Capacitor offline app + 4.2.2 concern: https://stackoverflow.com/questions/79938748

**Confidence**: High on guideline text; Medium on enforcement predictability (no Apple-published WebView policy; reports are anecdotal).
**Plan implication**: ship bundled/offline-first UI, add ≥1–2 native integrations, and write a review note that lists offline data, local DB, and native features.

---

## 2. Donations — 3.1.1 / 3.2.1 / 3.2.2

**Guideline text (verbatim essentials)**:
- 3.1.1 covers unlocking *features or functionality / digital content* — donations are not digital content and are not governed by 3.1.1.
- 3.2.1(vi): "Approved nonprofits may fundraise directly within their own apps or third-party apps, provided those fundraising campaigns adhere to all App Review Guidelines and offer Apple Pay support..." (disclosure of use of funds, tax receipts, approval).
- 3.2.2(iv): "Unless you are an approved nonprofit or otherwise permitted under Section 3.2.1 (vi) above, collecting funds within the app for charities and fundraisers [is not acceptable]. Apps that seek to raise money for such causes must be **free** on the App Store and may only collect funds **outside of the app, such as via Safari or SMS**."
- 3.2.1(vii) is about **individual person-to-person gifts** (optional, 100% to the receiver) — it is *not* the charitable-donation rule. The relevant clauses are 3.2.1(vi) + 3.2.2(iv).
- Apple Pay donations (developer.apple.com/apple-pay/nonprofits/): Apple charges no fees/commission; requires approval — US orgs need a Candid Seal of Transparency, non-US orgs are approved via Benevity.

**Answer to the concrete question**: for a free app by a project that is **not** an Apple-approved nonprofit, a "Donate" button that opens the donation page in Safari/`SFSafariViewController` is exactly the sanctioned path. Do **not** add an in-app donation UI or a "Donate with Apple Pay" button without going through the nonprofit approval process. Also: never gate content behind a donation (that becomes IAP/3.1.1 territory), and do not present other purchase CTAs in-app.

**Sources**: https://developer.apple.com/app-store/review/guidelines/ (3.1.1, 3.2.1(vi), 3.2.1(vii), 3.2.2(iv)); https://developer.apple.com/apple-pay/nonprofits/

**Confidence**: High.
**Plan implication**: free app + external Safari donate link only; no Apple Pay donation button, no in-app fundraising copy that implies collection inside the app.

---

## 3. Building/signing/uploading to TestFlight from GitHub Actions without a Mac

**Current standard stack (all names verified in docs)**:

1. **App Store Connect API key** — create a **Team Key** (Users and Access → Integrations → App Store Connect API), role Admin or App Manager. You get `issuer_id` + `key_id` + a one-time `.p8` download. Store all three in GitHub Secrets. Apple states: "Individual keys aren't able to use **Provisioning** endpoints" — so a Team Key is mandatory for certs/profiles.
2. **The API can manage signing material**: the ASC API's *Provisioning* section covers Bundle IDs, Bundle ID Capabilities, Certificates ("Create, download, and revoke signing certificates"), Devices, and Profiles ("Create, delete, and download provisioning profiles"). fastlane's `cert`, `sigh`, `match` all support API-key auth (fastlane docs table: Apple ID **and** API Key = Yes for pilot/deliver/sigh/cert/match/download_dsyms/app_store_build_number).
3. **fastlane path (recommended default)**: `app_store_connect_api_key(key_id:, issuer_id:, key_filepath:)` → `setup_ci` (temp keychain; without it CI can freeze) → `match(type: "appstore", readonly: is_ci)` (certs/profiles in a private git repo or S3/GCS, encrypted, `MATCH_PASSWORD` secret) → `build_app` → `upload_to_testflight`. fastlane runs from a macOS runner (see §4). Official GH Actions recipe: `runs-on: macos-latest`, Ruby setup, `fastlane beta`, env `MATCH_PASSWORD`. Note: `match`'s `template_name` (managed capabilities/additional entitlements) was removed from the ASC API in May 2025 and is deprecated — avoid profiles needing custom entitlements.
4. **Raw xcodebuild path (no fastlane)**: `xcodebuild archive -workspace ... -scheme ... -allowProvisioningUpdates -authenticationKeyPath AuthKey_XXX.p8 -authenticationKeyID XXX -authenticationKeyIssuerID <uuid>` then `xcodebuild -exportArchive -archivePath ... -exportPath ... -exportOptionsPlist ExportOptions.plist`. Per the xcodebuild man page, `-allowProvisioningUpdates` makes xcodebuild talk to the Apple Developer website: for automatically signed targets it "will create and update profiles, app IDs, and certificates"; for manually signed targets it downloads missing/updated profiles. The three `-authenticationKey*` flags are the documented way to authenticate without adding an Apple ID to Xcode's Accounts pane (which a CI runner cannot have).
5. **Manual `.p12` + `.mobileprovision` in GitHub Secrets** (import into a temporary keychain with `security create-keychain` / `security import` / `security set-key-partition-list`, install the profile, then build with manual signing) still works and is the least moving machinery for a single app, at the cost of manual renewal when the distribution certificate expires. fastlane `match` exists to remove that cost; for a one-app non-commercial project either is defensible, but `match` (or at minimum `cert`/`sigh` with the API key) is the lower-maintenance option.
6. **Upload**: `xcrun altool --upload-app -f app.ipa -t ios ...` is still the documented CLI path, plus Transporter CLI with the same JWTs, or the ASC API `POST /v1/buildUploads`. Xcode Cloud is the other option.

**Important scheduling fact**: App Store Connect's "Upload builds" help now states iOS/iOS app-extension builds must be **built using Xcode 26 or later** to upload (macOS apps 6+, tvOS 26+, visionOS 26+), and "starting in 2026, you'll be required to use Xcode 14 or later." Capacitor 8 requires **Xcode 26.0 minimum**. → pin the runner/Xcode to 26.x.

**Sources**
- https://docs.fastlane.tools/actions/match/ ; https://docs.fastlane.tools/app-store-connect-api/ ; https://docs.fastlane.tools/actions/app_store_connect_api_key/ ; https://docs.fastlane.tools/best-practices/continuous-integration/github/
- https://developer.apple.com/documentation/appstoreconnectapi (Provisioning: Certificates, Profiles, Bundle IDs, Devices) ; https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api (Team vs Individual keys)
- xcodebuild flags: https://keith.github.io/xcode-man-pages/xcodebuild.1.html (man-page mirror: `-allowProvisioningUpdates`, `-authenticationKeyPath/ID/IssuerID`, `-exportArchive`, `-exportOptionsPlist`)
- https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/ (Xcode 26 requirement, altool/Transporter/API upload)
- https://capacitorjs.com/docs/getting-started/environment-setup ("Capacitor 8 requires a minimum of Xcode 26.0")

**Confidence**: High.
**Plan implication**: Team API key (Admin/App Manager) in GH Secrets + fastlane `match` readonly + `build_app` + `upload_to_testflight` on a macOS 26 runner with Xcode 26.6; keep a manual `.p12`/profile fallback documented.

---

## 4. GitHub Actions macOS runners (as of 2026-09-17)

**Labels that exist now** (runner-images `main` README):

| Label | Arch | OS |
|---|---|---|
| `macos-latest`, `macos-26`, `macos-26-xlarge` | arm64 | macOS 26 (Tahoe) |
| `macos-latest-large`, `macos-26-intel`, `macos-26-large` | x64 | macOS 26 |
| `macos-15`, `macos-15-xlarge` | arm64 | macOS 15 (Sequoia) |
| `macos-15-intel`, `macos-15-large` | x64 | macOS 15 |
| `macos-14`, `macos-14-xlarge` | arm64 | macOS 14 — **deprecated, fully unsupported 2026-11-02** |
| `macos-14-large` | x64 | macOS 14 — deprecated |
| `xcode-27`, `xcode-27-xlarge` | arm64 | preview image with Xcode 27 beta |

There is **no** `macos-26-arm64` label: arm64 is the plain `macos-26`. Standard runner hardware: macOS arm64 = 3-core M1, 7 GB RAM, 14 GB SSD; Intel = 4-core, 14 GB RAM, 14 GB SSD.

**Xcode versions shipped** (image READMEs, image versions dated 2026-08/09):
- `macos-26` (arm64): default **Xcode 26.6**; also 26.5, 26.4.1, 26.3, 26.2, 26.1.1, 26.0.1. iOS 26.0–26.5 SDKs; simulators iPhone 17 / iPhone Air / iPad Pro M5 etc. (iOS 26.2–26.5).
- `macos-15` (arm64): default **Xcode 16.4**; also 26.0.1–26.3 and 16.0–16.3. iOS 18.x/26.x SDKs and simulators.
- `macos-26-intel` / `macos-15-intel`: Intel variant, Xcode up to 26.3.

**Billing**
- Standard GitHub-hosted runners are **free and unlimited for public repositories**; larger runners are always billed, even for public repos.
- Private repos: included minutes/month — Free 2,000; Pro 3,000; Free-for-orgs 2,000; Team 3,000; Enterprise 50,000. Beyond that, per-minute: standard macOS **$0.062/min**, `macos_l` (12-core) $0.077/min, `macos_xl` (M2 Pro) $0.102/min. Linux $0.006, Windows $0.010.
- **Minimum billing increment**: "GitHub rounds the minutes and partial minutes each job uses up to the nearest whole minute."
- Job execution limit for GitHub-hosted runners: **6 hours per job** (cannot be increased). macOS concurrency cap: 5 concurrent macOS jobs (Free/Pro/Team), 50 (Enterprise).

**UI tests (XCUITest / `xcodebuild test`)**
- iOS simulators and full Xcode are preinstalled, so `xcodebuild test -destination 'platform=iOS Simulator,name=iPhone 17'` is the normal approach; no device/signing needed for simulator tests.
- Known real problems: runner-images issue #12777 "iOS test simulators fail to start on 20250811 macOS-15 build" — `xcodebuild test` fails with `No matching device ... in set at /Users/runner/Library/Developer/XCTestDevices` on `macos-15-arm64`; opened Aug 2025, **still open** (40 comments, last update Jul 2026). Pin Xcode explicitly (`sudo xcode-select -s`), or use `macos-26`, or pre-boot/erase a simulator via `xcrun simctl` before the test action.
- **No nested virtualization** on macOS runners (limitation of Apple's Virtualization.framework): no VMs inside the job, no accelerated Android emulator; arm64 runners have no static UDID (Intel runners have `4203018E-580F-C1B5-9525-B745CECA79EB`), so "sign on runner, install on a fixed UDID device" workflows require Intel runners. Community actions may lack arm64 builds and must be installed at runtime.
- Arm64 (M1) runners are significantly faster than the Intel ones for Xcode builds; the 7 GB RAM ceiling is the main practical constraint.

**Sources**
- https://github.com/actions/runner-images (README label table) ; https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md ; .../macos-15-arm64-Readme.md
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners (specs, arm64 limitations) ; https://docs.github.com/en/billing/reference/actions-runner-pricing (rounding + rates) ; https://docs.github.com/en/billing/concepts/product-billing/github-actions (public repo free) ; https://docs.github.com/en/billing/reference/product-usage-included (included minutes) ; https://docs.github.com/en/actions/reference/limits (6 h job, macOS concurrency)
- https://github.com/actions/runner-images/issues/12777 (simulator startup failure)
- https://github.com/actions/runner-images/issues/13518 (macOS 14 deprecation)

**Confidence**: High on labels/Xcode/pricing; Medium on UI-test reliability (history of flaky simulator startup).
**Plan implication**: run CI on `macos-26` (arm64, Xcode 26.6) since Capacitor 8 and App Store upload need Xcode 26; add `sudo xcode-select -s /Applications/Xcode_26.6.app` and a `xcrun simctl boot`/erase step before `xcodebuild test`; keep UI tests lean (7 GB RAM, 6 h cap).

**4b. Fallbacks**
- **Xcode Cloud**: 25 compute hours/month included with Apple Developer Program membership; extra tiers $49.99/100 h, $99.99/250 h, $399.99/1,000 h, $3,999.99/10,000 h. Built into Xcode/App Store Connect, integrates with TestFlight, works with GitHub-hosted repos, but workflows are configured in Xcode/ASC (not YAML in the repo) and it is Apple-only. Source: https://developer.apple.com/xcode-cloud/
- **Codemagic**: free tier = **500 free macOS M2 minutes/month**, 1 parallel build, **120-minute build-duration limit**, 30-day build history/artifact storage, community support; beyond that M2 $0.095/min, M4 $0.114/min; their pricing FAQ says free accounts are available for teachers, students and **non-profits**. Source: https://codemagic.io/pricing/
**Plan implication**: if GitHub macOS minutes or runner flakiness become a problem, Codemagic's free 500 min/month (and non-profit program) is the cheapest fallback; Xcode Cloud's 25 h/month is effectively free with the membership and is the lowest-effort upload path.

---

## 5. The 216 MB first-run download

**Rules that bite**
- **4.2.3(ii)**: if the app needs to download additional resources to work on initial launch, you must **disclose the size of the download and prompt the user before doing so**. → a first-run screen stating "≈216 MB" with explicit Continue/Cancel is required, not optional.
- **2.5.2**: apps must be self-contained in their bundles and may not download/install/execute **code** that adds or changes functionality. Downloading *data* (SQLite/JSON/text) is not prohibited; downloading JS bundles that change app functionality would be.
- **2.1(a)**: the reviewer will open a virgin build. The app must launch, be navigable, and not crash before/without the dataset: show the reader shell, an offline notice, a resumable download with progress, cancel/retry, and a clear error state. Do not gate the first screen on the network.
- No guideline requires the content to be Apple-hosted. Developer-CDN downloads of data are fine.
- App Store cellular prompts (the "over 200 MB, download over cellular?" dialog) apply to App Store *app* downloads, not to in-app downloads; in-app behaviour is yours to design (still: offer Wi-Fi-only default, honour Low Data Mode, allow resume).
- Apple-hosted alternatives, if ever wanted: **On-Demand Resources** (Apple-hosted; ≤8 GB per asset pack on iOS 18+, 70 GB total — but **deprecated as of iOS 27**, migration to Background Assets recommended) and **Apple-hosted asset packs / Managed Background Assets** (iOS 26+, Apple hosts; limits 200 GB total and 200 packs). Both add platform coupling and tooling (asset-pack manifests, BackgroundAssets framework) for no review benefit here.

**Sources**
- https://developer.apple.com/app-store/review/guidelines/ (4.2.3(ii), 2.5.2, 2.1(a))
- https://developer.apple.com/help/app-store-connect/reference/app-uploads/on-demand-resources-size-limits (limits + iOS 27 deprecation)
- https://developer.apple.com/help/app-store-connect/manage-asset-packs/overview-of-apple-hosted-asset-packs and .../apple-hosted-asset-pack-size-limits (200 GB / 200 packs, iOS 26+)

**Confidence**: High on the disclosure/completeness obligations; Medium on the exact current in-app cellular guidance (no single Apple primary source found that regulates in-app download size over cellular).
**Plan implication**: keep the current self-hosted 216 MB download, add a mandatory size-disclosure consent screen with progress/resume/retry, keep a usable offline shell before the download completes, and put the size in the review notes.

import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        // DgBridgeViewController, not CAPBridgeViewController: the app's own subclass, which is
        // where its in-target plugins get registered (see DgBridgeViewController.swift).
        window?.rootViewController = DgBridgeViewController()
        window?.makeKeyAndVisible()

        // A quick action that LAUNCHED the app: the bridge and its plugins do not exist yet, so
        // DgShortcutsPlugin holds it until capacitorViewDidAppear (see its load()).
        if let shortcut = connectionOptions.shortcutItem {
            DgShortcutsPlugin.pendingLaunchShortcut = shortcut
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    // A quick action tapped while the app is running — the four static ones declared in Info.plist and
    // the dynamic "recently read" items both arrive here. Until this existed, a tap on the static ones
    // did nothing at all on iOS.
    func windowScene(_ windowScene: UIWindowScene,
                     performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        DgShortcutsPlugin.perform(shortcutItem: shortcutItem)
        completionHandler(true)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

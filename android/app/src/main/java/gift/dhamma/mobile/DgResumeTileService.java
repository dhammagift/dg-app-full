package gift.dhamma.mobile;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.TileService;

import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;

import java.util.List;

/**
 * "Продолжить чтение" — a Quick Settings tile (the pull-down shade), the Android counterpart of
 * the Control Center control the iOS side ships (ios/App/DgControls, branch siri). A tile is
 * reachable from the lock screen and from inside other apps, which a launcher icon or a launcher
 * shortcut is not.
 *
 * What it opens is nothing new: the TOP dynamic shortcut the page already hands over through
 * DgShortcutsPlugin.set (native-bridge.js collectRecent — favorites and history filtered to real
 * texts, ranked) is the text the reader last had open. Its intent carries the same "route" extra
 * the static shortcuts in res/xml/shortcuts.xml use, so MainActivity.handleIntent takes it with
 * no new wiring — the tile only picks the destination, it adds no second way into the app.
 *
 * With no recent text (fresh install, cleared history, or the plugin never ran) the tile
 * degrades to opening the app plain — the launcher-icon tap.
 *
 * No active Tile state and no click listener with a picker: a tile should reflect STATE, and the
 * only state here is "which text is next" — which changes under the tile's feet as the reader
 * reads. The shade rebinds (onStartListening) every time it is pulled down, so onClick always
 * launches with the freshest shortcut list; unlockAndRun covers the locked-shade case where
 * launching an activity must wait for the keyguard to dismiss.
 */
public class DgResumeTileService extends TileService {

    @Override
    public void onClick() {
        Runnable launch = this::launchResume;
        // From the locked shade an activity cannot start until the device is unlocked;
        // unlockAndRun runs it right after, or immediately when already unlocked. API 24 —
        // the same floor as the project's minSdkVersion (android/variables.gradle).
        if (isLocked() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            unlockAndRun(launch);
        } else {
            launch.run();
        }
    }

    private void launchResume() {
        Intent intent = resumeIntent();
        if (intent == null) {
            // No "recently read" yet: open the app the way the launcher icon does.
            intent = new Intent(this, MainActivity.class)
                    .setAction(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LAUNCHER);
        }
        // API 34+ requires an activity launched from the shade to go through a PendingIntent;
        // the compat helper below picks that form on 34+ and the plain intent call before it.
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startActivityAndCollapse(pendingIntent);
        } else {
            startActivityAndCollapse(intent);
        }
    }

    // The top-ranked dynamic shortcut's intent, or null. DgShortcutsPlugin pushes at most 15,
    // ranked: the "recently read" texts carry ranks from 10 up, and ShortcutManager keeps the
    // list rank-ordered — the first entry is the one the reader last had open. The list is
    // re-pushed whenever the reader leaves the app (native-bridge.js appStateChange), which is
    // exactly when the shade is most likely to be pulled down next.
    private Intent resumeIntent() {
        try {
            List<ShortcutInfoCompat> shortcuts = ShortcutManagerCompat.getDynamicShortcuts(this);
            for (ShortcutInfoCompat shortcut : shortcuts) {
                Intent intent = shortcut.getIntent();
                // Only our own route-carrying intents: anything else in the list was put there
                // by an older build (its comment in DgShortcutsPlugin tells that story) and its
                // intent may not be a route launch at all.
                if (intent != null && intent.getStringExtra("route") != null) {
                    return new Intent(intent)
                            .setClass(this, MainActivity.class)
                            .setAction("gift.dhamma.mobile.SHORTCUT");
                }
            }
        } catch (Exception e) {
            // ShortcutManagerCompat can throw on some OEM builds; a tile must never crash the shade.
        }
        return null;
    }
}

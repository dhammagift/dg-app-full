package gift.dhamma.pali;

import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Dynamic App Shortcuts ("recent words") — the one thing a web manifest cannot do, and the reason
 * the dictionary app is Capacitor and not the Trusted Web Activity it replaced. A web manifest's
 * shortcuts are static, and a TWA cannot reach ShortcutManager at all: the owner's report was
 * exactly that ("нет истории в шорткатах").
 *
 * The native side cannot read localStorage, so the page (www/dict-bridge.js, injected by
 * MainActivity) reads the site's own lookup history and hands over a ready list:
 *
 *     Capacitor.Plugins.DgShortcuts.set({ items: [ { id, label, route } ], programmed: false })
 *
 * Each item becomes a launcher shortcut that starts MainActivity with the same "route" extra the
 * static shortcuts in res/xml/shortcuts.xml use, and MainActivity loads it into the WebView. Labels
 * are clamped to Android's limits rather than rejected: a shortcut with a too-long label throws
 * IllegalArgumentException at build time and would fail the whole call, losing every other item.
 *
 * No-ops (resolving, not rejecting) on anything older than API 25 and on any per-item error —
 * shortcuts are a convenience, and a reader must never see a failed search because the launcher
 * refused one item.
 *
 * Adapted from dg-app-full's DgShortcutsPlugin; only the package and PROGRAMMED_IDS differ.
 */
@CapacitorPlugin(name = "DgShortcuts")
public class DgShortcutsPlugin extends Plugin {

    private static final int MAX_SHORTCUTS = 15;   // ShortcutManager's own cap for a single app
    private static final int SHORT_LABEL_MAX = 10; // characters, Android's documented limit
    private static final int LONG_LABEL_MAX = 25;

    @PluginMethod
    public void set(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            call.resolve();
            return;
        }
        Context context = getContext();

        JSArray items = call.getArray("items");
        if (items == null) {
            call.resolve();
            return;
        }

        List<ShortcutInfoCompat> shortcuts = new ArrayList<>();
        for (int i = 0; i < items.length() && shortcuts.size() < MAX_SHORTCUTS; i++) {
            JSONObject item;
            try {
                item = items.getJSONObject(i);
            } catch (Exception e) {
                continue;
            }
            String id = item.optString("id", "");
            String label = item.optString("label", "");
            String route = item.optString("route", "");
            if (id.isEmpty() || label.isEmpty() || route.isEmpty()) continue;
            int rank = item.optInt("rank", 100);
            try {
                Intent intent = new Intent(context, MainActivity.class);
                // Not ACTION_MAIN: a shortcut intent must be a distinct action so the launcher
                // treats two items with the same route as different shortcuts.
                intent.setAction("gift.dhamma.pali.SHORTCUT");
                intent.putExtra("route", route);
                shortcuts.add(new ShortcutInfoCompat.Builder(context, id)
                        .setShortLabel(clamp(label, SHORT_LABEL_MAX))
                        .setLongLabel(clamp(label, LONG_LABEL_MAX))
                        .setRank(rank)
                        // The launcher icon rather than a per-item drawable: recent words have no
                        // icon of their own, and the app's own mark reads better than a generic
                        // glyph repeated down the menu.
                        .setIcon(IconCompat.createWithResource(context, R.mipmap.ic_launcher))
                        .setLongLived(true)
                        .setIntent(intent)
                        .build());
            } catch (Exception e) {
                // One bad item must not cost the reader the others.
            }
        }

        try {
            ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts);
            // No enable/disable of static shortcuts here any more. The plugin used to hide the three
            // programmed ones while "recent words" were on, exactly as the reader app does — and
            // that is the shape that showed the owner two words out of three: the launcher counts
            // the shortcuts DECLARED in res/xml/shortcuts.xml against its four-entry menu even when
            // they are disabled. One static entry is declared there now (Favorites & History) and
            // the rest of the menu is this list, whichever set the page decided on.
            JSObject result = new JSObject();
            result.put("count", shortcuts.size());
            call.resolve(result);
        } catch (Exception e) {
            call.reject("DgShortcuts.set failed: " + e.getMessage());
        }
    }

    private static String clamp(String text, int max) {
        String trimmed = text.trim();
        if (trimmed.length() <= max) return trimmed;
        return trimmed.substring(0, max - 1) + "…";
    }
}

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
 * Adapted from the main application's DgShortcutsPlugin (android/app/src/main/java/gift/dhamma/
 * mobile/): the two are the same code apart from the package name, the intent action and the
 * comments — whoever changes one should look at the other.
 */
@CapacitorPlugin(name = "DgShortcuts")
public class DgShortcutsPlugin extends Plugin {

    private static final int MAX_SHORTCUTS = 15;   // ShortcutManager's own cap for a single app
    // The launcher renders the SHORT label and ellipsizes whatever does not fit its own width, so
    // these are caps on absurdity, not a layout decision. Android's "10 characters" is the guidance
    // its docs give, NOT something the platform enforces — ShortcutInfo.Builder.setShortLabel only
    // rejects an empty label and ShortcutService validates no label length at all — and clamping to
    // it made every recent text read "mn6 Ākank…" in a menu with room for the whole name (owner,
    // 2026-09-25: "почему текст обрезается раньше, хотя в статике достаточно места"). The static
    // entries show full 19-character labels on the same launcher, which is what settled it.
    private static final int SHORT_LABEL_MAX = 25;
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
                        .setIcon(iconFor(context, item.optString("icon", "")))
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

    /**
     * The icon a page asked for, by drawable name — or the app's own mark when it asked for none.
     *
     * A dynamic shortcut must be given a drawable, so every entry used to get R.mipmap.ic_launcher:
     * the three programmed entries lost the icons they had while they were declared in
     * res/xml/shortcuts.xml (drawable/shortcut_0, _2, _3), and the owner's report was exactly that
     * — they showed the same mark as the recent words ("иконки при статических шорткатах...
     * показываются те же, что и для слов"). The name is resolved at runtime rather than switched
     * on, so the page stays the one place that decides which entry gets which artwork.
     *
     * An unknown or missing name falls back to the launcher mark instead of failing the item:
     * shortcuts are a convenience, and one bad icon must not cost a reader the entry.
     */
    private static IconCompat iconFor(Context context, String name) {
        if (name != null && !name.isEmpty()) {
            int res = context.getResources().getIdentifier(name, "drawable", context.getPackageName());
            if (res != 0) return IconCompat.createWithResource(context, res);
        }
        return IconCompat.createWithResource(context, R.mipmap.ic_launcher);
    }

    private static String clamp(String text, int max) {
        String trimmed = text.trim();
        if (trimmed.length() <= max) return trimmed;
        return trimmed.substring(0, max - 1) + "…";
    }
}

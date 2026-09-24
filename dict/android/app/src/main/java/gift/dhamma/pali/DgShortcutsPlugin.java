package gift.dhamma.pali;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ShortcutManager;
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
import java.util.Arrays;
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
            // The other half of the setting: the four programmed shortcuts live in
            // res/xml/shortcuts.xml. The launcher's long-press menu holds four entries, so when
            // the reader wants recent words instead, the three beyond Favorites & History are
            // hidden rather than deleted — a static shortcut can be disabled and enabled again at
            // runtime, and that is the only way to keep them declared (so they exist in the
            // launcher the moment the app is installed, before it has ever run) while showing one
            // set or the other. Four programmed OR one programmed + three recent, never a mixture.
            setProgrammedVisible(context, call.getBoolean("programmed", false));
            JSObject result = new JSObject();
            result.put("count", shortcuts.size());
            call.resolve(result);
        } catch (Exception e) {
            call.reject("DgShortcuts.set failed: " + e.getMessage());
        }
    }

    // The programmed shortcuts that step aside when "recent words" take their slots. Favorites &
    // History is not here: it is the one that stays in both sets.
    private static final List<String> PROGRAMMED_IDS =
            Arrays.asList("toc", "dharmamitra", "aksharamukha");

    // ShortcutManager itself, not the Compat class: enableShortcuts/disableShortcuts exist there
    // since API 25 and take ids, which is exactly what a static shortcut is addressed by. Fails
    // silently on older releases and on any error — a shortcut the launcher refused must never
    // turn into a failed search.
    private void setProgrammedVisible(Context context, boolean visible) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return;
        try {
            ShortcutManager manager = context.getSystemService(ShortcutManager.class);
            if (manager == null) return;
            if (visible) manager.enableShortcuts(PROGRAMMED_IDS);
            else manager.disableShortcuts(PROGRAMMED_IDS);
        } catch (Exception e) {
            // Nothing to report: the menu keeps whatever it had.
        }
    }

    private static String clamp(String text, int max) {
        String trimmed = text.trim();
        if (trimmed.length() <= max) return trimmed;
        return trimmed.substring(0, max - 1) + "…";
    }
}

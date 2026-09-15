package gift.dhamma.mobile;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.os.Build;

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
 * Dynamic App Shortcuts ("recently read") — the one thing a web manifest cannot do, and the
 * reason this app is Capacitor and not a Trusted Web Activity (docs/OFFLINE_PWA_PLAN.md,
 * "Решение (2026-09-11): делаем приложение на Capacitor").
 *
 * The native side cannot read localStorage, so the page (our own site build, native-bridge.js)
 * reads its own history and hands over a ready list:
 *
 *     Capacitor.Plugins.DgShortcuts.set({ items: [ { id, label, route } ] })
 *
 * Each item becomes a launcher shortcut that starts MainActivity with the same "route" extra the
 * static shortcuts in res/xml/shortcuts.xml use (MainActivity.handleIntent turns it into
 * https://localhost/?_nativeRoute=..., and the page rewrites the visible URL before its own
 * bootstrap reads it). Labels are clamped to Android's limits rather than rejected: a shortcut
 * with a too-long label throws IllegalArgumentException at build time and would fail the whole
 * call, losing every other item with it.
 *
 * No-ops (resolving, not rejecting) on anything older than API 25 and on any per-item error —
 * shortcuts are a convenience, and a reader must never see a failed search because the launcher
 * refused one item.
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
        ShortcutManager manager = (ShortcutManager) context.getSystemService(Context.SHORTCUT_SERVICE);
        if (manager == null) {
            call.resolve();
            return;
        }

        JSArray items = call.getArray("items");
        if (items == null) {
            call.resolve();
            return;
        }

        List<ShortcutInfo> shortcuts = new ArrayList<>();
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
            // Rank decides the order the launcher shows them in (lower = higher priority): the
            // page pins Contents and Favorites at 0/1 and ranks "recently read" below.
            int rank = item.optInt("rank", 100);
            try {
                Intent intent = new Intent(context, MainActivity.class);
                // Not ACTION_MAIN: a shortcut intent must be a distinct action so the launcher
                // treats two items with the same route as different shortcuts.
                intent.setAction("gift.dhamma.mobile.SHORTCUT");
                intent.putExtra("route", route);
                shortcuts.add(new ShortcutInfo.Builder(context, id)
                        .setShortLabel(clamp(label, SHORT_LABEL_MAX))
                        .setLongLabel(clamp(label, LONG_LABEL_MAX))
                        .setRank(rank)
                        // The launcher icon rather than a per-item drawable: recent texts have no
                        // icon of their own, and a monochrome launcher mark reads better than a
                        // generic glyph repeated in the menu.
                        .setIcon(Icon.createWithResource(context, R.mipmap.ic_launcher))
                        .setIntent(intent)
                        .build());
            } catch (Exception e) {
                // One bad item must not cost the reader the others.
            }
        }

        try {
            manager.setDynamicShortcuts(shortcuts);
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

package gift.dhamma.uposatha;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The launcher icon follows the moon: the manifest holds one activity-alias per phase (IconPhase0..7, each with its
 * own icon and the launcher intent filter) and exactly one of them is enabled. The page works the phases out (the
 * same astronomy as its calendar) and hands over the next weeks as a schedule of {at, i}: from the moment `at` the
 * icon of phase `i`. That is stored here, so the icon keeps changing with the days while the app is closed, and after a
 * reboot or an update (DgIconReceiver). With no schedule it goes back to the full moon, the one it is installed with.
 *
 * Changing the enabled alias is what makes a launcher redraw the icon. Some launchers drop the icon a reader has
 * pinned to the home screen when its alias is disabled; the page has a switch (MOON_LAUNCHER_ICON) to turn all
 * of this off, which stops calling set().
 */
@CapacitorPlugin(name = "DgIcon")
public class DgIconPlugin extends Plugin {

    private static final String PREFS = "dg_icon";
    private static final String KEY = "schedule";
    private static final int DEFAULT_PHASE = 4;   // the full moon: the alias that is enabled in the manifest
    static final String ACTION = "gift.dhamma.uposatha.ICON_PHASE";

    @PluginMethod
    public void set(PluginCall call) {
        Context context = getContext();
        JSArray items = call.getArray("items");
        SharedPreferences.Editor edit = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        if (items == null || items.length() == 0) edit.remove(KEY); else edit.putString(KEY, items.toString());
        edit.apply();
        int phase = apply(context);
        com.getcapacitor.JSObject result = new com.getcapacitor.JSObject();
        result.put("phase", phase);
        call.resolve(result);
    }

    /** Enables the alias of the phase in force now, disables the others, and sets the alarm for the next change. Returns the phase. */
    static int apply(Context context) {
        long now = System.currentTimeMillis();
        int phase = DEFAULT_PHASE;
        long next = 0;
        try {
            String stored = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null);
            if (stored != null) {
                JSONArray list = new JSONArray(stored);
                long best = Long.MIN_VALUE;
                for (int k = 0; k < list.length(); k++) {
                    JSONObject o = list.getJSONObject(k);
                    long at = o.getLong("at");
                    if (at <= now && at >= best) { best = at; phase = o.getInt("i"); }
                    if (at > now && (next == 0 || at < next)) next = at;
                }
            }
        } catch (Exception e) {
            phase = DEFAULT_PHASE;   // a broken schedule must not cost the reader the icon
        }
        if (phase < 0 || phase > 7) phase = DEFAULT_PHASE;
        show(context, phase);
        schedule(context, next);
        return phase;
    }

    private static void show(Context context, int phase) {
        PackageManager pm = context.getPackageManager();
        String pkg = context.getPackageName();
        // The wanted one first, so the app never has no launcher entry.
        ComponentName want = new ComponentName(pkg, pkg + ".IconPhase" + phase);
        if (pm.getComponentEnabledSetting(want) != PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                && !(phase == DEFAULT_PHASE && pm.getComponentEnabledSetting(want) == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT)) {
            pm.setComponentEnabledSetting(want, PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP);
        }
        for (int i = 0; i < 8; i++) {
            if (i == phase) continue;
            ComponentName other = new ComponentName(pkg, pkg + ".IconPhase" + i);
            int state = pm.getComponentEnabledSetting(other);
            boolean off = state == PackageManager.COMPONENT_ENABLED_STATE_DISABLED
                    || (state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && i != DEFAULT_PHASE);
            if (!off) pm.setComponentEnabledSetting(other, PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP);
        }
    }

    private static void schedule(Context context, long at) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        Intent intent = new Intent(context, DgIconReceiver.class).setAction(ACTION);
        PendingIntent pending = PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        if (alarms == null) return;
        if (at <= 0) { alarms.cancel(pending); return; }
        // Inexact is enough: an icon a few minutes late is not a reason to wake the phone up.
        alarms.set(AlarmManager.RTC, at, pending);
    }
}

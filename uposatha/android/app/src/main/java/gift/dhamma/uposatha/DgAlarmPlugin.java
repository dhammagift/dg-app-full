package gift.dhamma.uposatha;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.Map;

/**
 * The sound of a reminder, played the way an alarm clock plays it.
 *
 * A notification channel's sound is a notification's: Do Not Disturb silences it, the notification volume
 * and the phone's sound mode silence it, and a phone maker's own layers (One UI, MIUI) add more. An alarm
 * clock is not a notification: it plays on the ALARM stream at a moment the system's alarm manager wakes it
 * for, and Do Not Disturb lets alarms through by default. So for "Alarm" as the sound source the reminder is
 * two things at the same minute: the notification (silent channel, the banner and the tray entry, from
 * LocalNotifications) and this: an exact alarm whose receiver plays the sound on the alarm stream.
 *
 *     Capacitor.Plugins.DgAlarm.schedule({ items: [ { id, at (ms since 1970), sound } ] })
 *     Capacitor.Plugins.DgAlarm.cancel({ ids: [ ... ] })
 *
 * sound is the name of a res/raw file ("gong", "gong2", ..., "church"), or "own" for the file the reader picked
 * (DgSoundPlugin keeps its address). What is scheduled is kept in SharedPreferences and set again after a
 * reboot (DgAlarmReceiver.BOOT), because the alarm manager forgets every alarm then.
 */
@CapacitorPlugin(name = "DgAlarm")
public class DgAlarmPlugin extends Plugin {

    static final String PREFS = "dg_alarms";
    static final String ACTION_PLAY = "gift.dhamma.uposatha.PLAY_REMINDER";

    @PluginMethod
    public void schedule(PluginCall call) {
        JSArray items = call.getArray("items");
        if (items == null) {
            call.resolve();
            return;
        }
        Context context = getContext();
        SharedPreferences.Editor prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        for (int i = 0; i < items.length(); i++) {
            try {
                JSONObject item = items.getJSONObject(i);
                int id = item.getInt("id");
                long at = item.getLong("at");
                String sound = item.optString("sound", "");
                if (sound.isEmpty()) continue;
                set(context, id, at, sound);
                prefs.putString(String.valueOf(id), at + "|" + sound);
            } catch (Exception e) {
                // One bad item must not cost the reader the others.
            }
        }
        prefs.apply();
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        JSArray ids = call.getArray("ids");
        Context context = getContext();
        SharedPreferences.Editor prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        if (ids != null) {
            for (int i = 0; i < ids.length(); i++) {
                try {
                    int id = ids.getInt(i);
                    unset(context, id);
                    prefs.remove(String.valueOf(id));
                } catch (Exception e) {
                    // Nothing to cancel.
                }
            }
        }
        prefs.apply();
        call.resolve();
    }

    static PendingIntent intentFor(Context context, int id, String sound) {
        Intent intent = new Intent(context, DgAlarmReceiver.class);
        intent.setAction(ACTION_PLAY);
        intent.putExtra("sound", sound);
        intent.putExtra("id", id);
        return PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void set(Context context, int id, long at, String sound) {
        AlarmManager manager = context.getSystemService(AlarmManager.class);
        if (manager == null) return;
        PendingIntent pending = intentFor(context, id, sound);
        // Exact and allowed while the phone dozes; USE_EXACT_ALARM (manifest) is what lets the app ask for that without a prompt.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.canScheduleExactAlarms()) {
            manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        } else {
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        }
    }

    static void unset(Context context, int id) {
        AlarmManager manager = context.getSystemService(AlarmManager.class);
        if (manager == null) return;
        manager.cancel(intentFor(context, id, ""));
    }

    /** After a reboot: every reminder whose time has not passed is set again. */
    static void restore(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        SharedPreferences.Editor edit = prefs.edit();
        for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
            try {
                String[] parts = String.valueOf(entry.getValue()).split("\\|", 2);
                long at = Long.parseLong(parts[0]);
                if (at <= now) {
                    edit.remove(entry.getKey());
                    continue;
                }
                set(context, Integer.parseInt(entry.getKey()), at, parts[1]);
            } catch (Exception e) {
                edit.remove(entry.getKey());
            }
        }
        edit.apply();
    }
}

package gift.dhamma.uposatha;

import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.Settings;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * "My own sound" for the reminders.
 *
 * Android fixes the sound of a notification per CHANNEL, not per notification, so a sound the
 * reader picks is a channel of its own. The built-in gongs are channels the page creates itself
 * (res/raw + LocalNotifications.createChannel); this plugin is the part the page cannot do:
 *
 *     Capacitor.Plugins.DgSound.pick()  ->  { channelId, name }
 *
 * It opens the system file picker for audio, copies the chosen file where the system UI can read it
 * at any time, creates a notification channel whose sound is that copy, and answers with the
 * channel id and the file's name. The page then schedules its reminders on that channel
 * (uposatha-calendar.js, state.rem.ownChannel).
 *
 * Where the copy lives: on Android 10+ in the shared Notifications collection (MediaStore, no
 * permission needed for a file the app itself inserts); before that in the app's own files/sounds/
 * behind a FileProvider URI granted to the system UI. Only ONE own sound is kept — picking another
 * replaces the previous channel and file, so channels and files do not pile up.
 *
 * A cancelled picker rejects with "cancelled" (the page treats any rejection as "nothing changed").
 *
 * The SOUND SOURCE. A notification channel plays its sound on an audio stream chosen when the
 * channel is created, and LocalNotifications creates every channel on the NOTIFICATION stream: the
 * gong follows the notification volume, and is silent when that is turned down or the phone is on
 * silent — the alarm goes off, the signal does not. The same sound on the ALARM stream plays at the
 * alarm volume, like a clock. The stream cannot be changed on an existing channel, so each sound
 * has a second channel with the suffix "-alarm" and the page bridge (uposatha-bridge.js) picks the
 * one the reader's setting names:
 *
 *     Capacitor.Plugins.DgSound.channel({ id, name, sound, importance, vibration, stream })
 *
 * creates one channel of a built-in sound (a res/raw name; empty = silent) on the "alarm" or the
 * "notification" stream. pick() creates BOTH streams' channels of the sound it copies.
 *
 * DO NOT DISTURB. With "Do not disturb" on, Android silences the notification channels of apps that may not
 * override it; a reminder then arrives with no sound (the alarm channels too, unless alarms are let through).
 * An app may make a channel override it ({@code setBypassDnd}) only once the reader has given it "Do Not
 * Disturb access", a page in the system settings the app can open but not switch on:
 *
 *     Capacitor.Plugins.DgSound.dndAccess()         ->  { granted }
 *     Capacitor.Plugins.DgSound.requestDndAccess()      opens that settings page
 *
 * Channels are made with {@code bypass: true}; it takes effect when the access is granted, and a channel's
 * override cannot be changed afterwards, so the bridge makes the channels again (under other ids) when the access
 * arrives.
 */
@CapacitorPlugin(name = "DgSound")
public class DgSoundPlugin extends Plugin {

    private static final String CHANNEL_PREFIX = "uposatha-own-";
    static final String ALARM_SUFFIX = "-alarm";
    private static final long MAX_BYTES = 10L * 1024 * 1024;   // a notification sound, not a track

    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("audio/*");
        startActivityForResult(call, intent, "pickResult");
    }

    @PluginMethod
    public void dndAccess(PluginCall call) {
        JSObject out = new JSObject();
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        out.put("granted", manager != null && manager.isNotificationPolicyAccessGranted());
        call.resolve(out);
    }

    @PluginMethod
    public void requestDndAccess(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("could not open the settings: " + e.getMessage());
        }
    }

    /** A channel of a built-in sound on the stream the reader chose (see the class comment). */
    @PluginMethod
    public void channel(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) {
            call.reject("id is required");
            return;
        }
        Context context = getContext();
        try {
            String sound = call.getString("sound");
            Uri uri = null;
            if (sound != null && !sound.isEmpty()) {
                int dot = sound.lastIndexOf('.');
                String base = dot > 0 ? sound.substring(0, dot) : sound;
                if (context.getResources().getIdentifier(base, "raw", context.getPackageName()) != 0) {
                    uri = Uri.parse("android.resource://" + context.getPackageName() + "/raw/" + base);
                }
            }
            makeChannel(context, id, call.getString("name", id), uri, "alarm".equals(call.getString("stream")),
                    call.getInt("importance", NotificationManager.IMPORTANCE_HIGH), call.getBoolean("vibration", true),
                    Boolean.TRUE.equals(call.getBoolean("bypass", false)));
            call.resolve();
        } catch (Exception e) {
            call.reject("DgSound.channel failed: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("cancelled");
            return;
        }
        Uri source = result.getData().getData();
        Context context = getContext();
        try {
            String display = displayName(context, source);
            String ext = extensionOf(context, source, display);
            long stamp = System.currentTimeMillis();
            String channelId = CHANNEL_PREFIX + stamp;
            Uri sound = copyForSystem(context, source, channelId + "." + ext, mimeOf(context, source, ext));
            if (sound == null) {
                call.reject("could not copy the file");
                return;
            }
            makeChannel(context, channelId, display, sound, false);
            makeChannel(context, channelId + ALARM_SUFFIX, display, sound, true);
            JSObject out = new JSObject();
            out.put("channelId", channelId);
            out.put("name", display);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("DgSound.pick failed: " + e.getMessage());
        }
    }

    // ---- the copy ---------------------------------------------------------------------------

    private static Uri copyForSystem(Context context, Uri source, String fileName, String mime) throws Exception {
        ContentResolver resolver = context.getContentResolver();
        removeOldCopies(context);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Audio.Media.DISPLAY_NAME, fileName);
            values.put(MediaStore.Audio.Media.MIME_TYPE, mime);
            values.put(MediaStore.Audio.Media.RELATIVE_PATH, "Notifications/");
            values.put(MediaStore.Audio.Media.IS_NOTIFICATION, 1);
            values.put(MediaStore.Audio.Media.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values);
            if (uri == null) return null;
            try (InputStream in = resolver.openInputStream(source); OutputStream out = resolver.openOutputStream(uri)) {
                if (in == null || out == null || !copy(in, out)) {
                    resolver.delete(uri, null, null);
                    return null;
                }
            }
            values.clear();
            values.put(MediaStore.Audio.Media.IS_PENDING, 0);
            resolver.update(uri, values, null, null);
            return uri;
        }
        File dir = new File(context.getFilesDir(), "sounds");
        if (!dir.isDirectory() && !dir.mkdirs()) return null;
        File file = new File(dir, fileName);
        try (InputStream in = resolver.openInputStream(source); OutputStream out = new FileOutputStream(file)) {
            if (in == null || !copy(in, out)) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                return null;
            }
        }
        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
        // The system UI plays the channel's sound: it needs read access to the file.
        context.grantUriPermission("com.android.systemui", uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return uri;
    }

    private static boolean copy(InputStream in, OutputStream out) throws Exception {
        byte[] buffer = new byte[16384];
        long total = 0;
        int n;
        while ((n = in.read(buffer)) > 0) {
            total += n;
            if (total > MAX_BYTES) return false;
            out.write(buffer, 0, n);
        }
        return total > 0;
    }

    private static void removeOldCopies(Context context) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                context.getContentResolver().delete(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
                        MediaStore.Audio.Media.DISPLAY_NAME + " LIKE ?", new String[] { CHANNEL_PREFIX + "%" });
            }
            File[] old = new File(context.getFilesDir(), "sounds").listFiles();
            if (old != null) for (File f : old) //noinspection ResultOfMethodCallIgnored
                f.delete();
        } catch (Exception e) {
            // Leftovers cost some kilobytes; they must not cost the reader the new sound.
        }
    }

    // ---- the channel ------------------------------------------------------------------------

    private static void makeChannel(Context context, String id, String name, Uri sound, boolean alarm) {
        makeChannel(context, id, name, sound, alarm, NotificationManager.IMPORTANCE_HIGH, true, true);
    }

    private static void makeChannel(Context context, String id, String name, Uri sound, boolean alarm, int importance, boolean vibration, boolean bypass) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        // One own sound at a time: the previous one's channels (both streams) are dropped.
        if (id.startsWith(CHANNEL_PREFIX)) {
            String base = id.endsWith(ALARM_SUFFIX) ? id.substring(0, id.length() - ALARM_SUFFIX.length()) : id;
            for (NotificationChannel c : manager.getNotificationChannels()) {
                String other = c.getId();
                if (other.startsWith(CHANNEL_PREFIX) && !other.equals(base) && !other.equals(base + ALARM_SUFFIX)) {
                    manager.deleteNotificationChannel(other);
                }
            }
        }
        NotificationChannel channel = new NotificationChannel(id, name, importance);
        channel.setDescription("Uposatha reminders");
        channel.enableVibration(vibration);
        // Only a silent channel has nothing to override; the rest ask to sound through Do Not Disturb (honoured once the
        // reader has given the app that access).
        if (bypass && sound != null && manager.isNotificationPolicyAccessGranted()) channel.setBypassDnd(true);
        if (sound != null) {
            channel.setSound(sound, new AudioAttributes.Builder()
                    .setUsage(alarm ? AudioAttributes.USAGE_ALARM : AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
        } else {
            channel.setSound(null, null);   // silent
        }
        manager.createNotificationChannel(channel);
    }

    // ---- what the picker gave ---------------------------------------------------------------

    private static String displayName(Context context, Uri uri) {
        String name = null;
        try (Cursor cursor = context.getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
        } catch (Exception e) {
            // Fall through to the URI's last segment.
        }
        if (name == null || name.isEmpty()) name = uri.getLastPathSegment() == null ? "sound" : uri.getLastPathSegment();
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }

    private static String extensionOf(Context context, Uri uri, String display) {
        String mime = context.getContentResolver().getType(uri);
        String ext = mime == null ? null : MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
        return ext == null || ext.isEmpty() ? "mp3" : ext;
    }

    private static String mimeOf(Context context, Uri uri, String ext) {
        String mime = context.getContentResolver().getType(uri);
        if (mime != null && mime.startsWith("audio/")) return mime;
        String fromExt = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return fromExt == null ? "audio/mpeg" : fromExt;
    }
}

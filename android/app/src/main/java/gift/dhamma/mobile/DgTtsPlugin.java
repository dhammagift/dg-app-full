package gift.dhamma.mobile;

import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Android's own TextToSpeech for the reader's voice player. Android System WebView has no
 * window.speechSynthesis, so read/js/voice.js (the site's player, unchanged) found nothing to
 * speak with and threw on its first call — no sound, and a close button that never closed.
 * src/platform.js installs a small speechSynthesis stand-in over this plugin.
 *
 *   speak({ id, text, lang, rate, voice })  -> resolves when queued; "tts" event {id, type:end|error}
 *   cancel()                                 -> stops; no event, like Web Speech after onend=null
 *   getVoices()                              -> { voices: [{ name, lang, localService }] }
 */
@CapacitorPlugin(name = "DgTts")
public class DgTtsPlugin extends Plugin implements TextToSpeech.OnInitListener {

    private TextToSpeech tts;
    private Boolean ready = null; // null until the engine has answered onInit
    private final List<Runnable> waiting = new ArrayList<>();

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), this);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) { }
            @Override public void onDone(String id) { emit(id, "end", null); }
            @Override public void onError(String id) { emit(id, "error", "synthesis failed"); }
            @Override public void onError(String id, int code) { emit(id, "error", "synthesis failed: " + code); }
        });
    }

    @Override
    public void onInit(int status) {
        synchronized (waiting) {
            ready = status == TextToSpeech.SUCCESS;
            for (Runnable r : waiting) r.run();
            waiting.clear();
        }
    }

    // Runs now if the engine is up, otherwise right after onInit (the first speak can arrive first).
    private void whenReady(PluginCall call, Runnable work) {
        synchronized (waiting) {
            if (ready == null) { waiting.add(() -> whenReady(call, work)); return; }
        }
        if (!ready) { call.reject("TextToSpeech is not available on this device"); return; }
        work.run();
    }

    private void emit(String id, String type, String error) {
        JSObject o = new JSObject();
        o.put("id", id);
        o.put("type", type);
        if (error != null) o.put("error", error);
        notifyListeners("tts", o);
    }

    @PluginMethod
    public void speak(PluginCall call) {
        whenReady(call, () -> {
            String id = call.getString("id", "");
            String voiceName = call.getString("voice");
            String lang = call.getString("lang");
            Voice chosen = null;
            Set<Voice> voices = tts.getVoices();
            if (voiceName != null && voices != null) {
                for (Voice v : voices) if (v.getName().equals(voiceName)) chosen = v;
            }
            if (chosen != null) {
                tts.setVoice(chosen);
            } else if (lang != null && !lang.isEmpty()) {
                int r = tts.setLanguage(Locale.forLanguageTag(lang));
                // A rejection is what lets the player fall back to another language (pi-dev -> sa-IN -> ...).
                if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                    call.reject("language not supported: " + lang);
                    return;
                }
            }
            tts.setSpeechRate(call.getDouble("rate", 1.0).floatValue());
            if (tts.speak(call.getString("text", ""), TextToSpeech.QUEUE_FLUSH, null, id) == TextToSpeech.SUCCESS) {
                call.resolve();
            } else {
                call.reject("speak failed");
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        if (tts != null) tts.stop();
        call.resolve();
    }

    @PluginMethod
    public void getVoices(PluginCall call) {
        whenReady(call, () -> {
            JSArray list = new JSArray();
            Set<Voice> voices = tts.getVoices();
            if (voices != null) {
                for (Voice v : voices) {
                    JSObject o = new JSObject();
                    o.put("name", v.getName());
                    o.put("lang", v.getLocale().toLanguageTag());
                    o.put("localService", !v.isNetworkConnectionRequired());
                    list.put(o);
                }
            }
            JSObject result = new JSObject();
            result.put("voices", list);
            call.resolve(result);
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) tts.shutdown();
    }
}

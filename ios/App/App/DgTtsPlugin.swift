import AVFoundation
import Capacitor

// Mirror of Android's DgTtsPlugin. Both exist for the same reason: the app's WebView has a Web
// Speech API that cannot speak. Android System WebView has no window.speechSynthesis at all; iOS
// WKWebView exposes one with ZERO voices and a speak() that never starts (measured in a simulator:
// voices=0, speaks=timeout), so the site's voice player (read/js/voice.js) found a synthesizer that
// silently did nothing. src/tts.js installs a Web-Speech-shaped shim over this plugin wherever the
// native API cannot speak.
//
//   speak({ id, text, lang, rate, voice })  -> resolves when queued; "tts" event {id, type:end|error}
//   cancel()                                 -> stops; no event, like Web Speech after onend=null
//   getVoices()                              -> { voices: [{ name, lang, localService }] }
//
// AVSpeechSynthesizer has no per-utterance id, so the id being spoken is kept here and every delegate
// callback is reported against it: the web side keys its pending utterances by id, and without this
// the player's "end" never arrives and its close button never closes (the exact Android bug this
// mirrors).
@objc(DgTtsPlugin)
public class DgTtsPlugin: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    public let identifier = "DgTtsPlugin"
    public let jsName = "DgTts"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getVoices", returnType: CAPPluginReturnPromise)
    ]

    private let synth = AVSpeechSynthesizer()
    private var currentId: String?

    override public func load() {
        synth.delegate = self
        // The app declares the audio background mode (Info.plist) so the reader keeps reading with
        // the screen locked; that only works if the session is playback and active.
        // ponytail: no mixWithOthers/duckOthers tuning until someone wants to read over music.
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio)
            try session.setActive(true)
        } catch {
            CAPLog.print("DgTts: audio session not configured: \(error.localizedDescription)")
        }
    }

    @objc func speak(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.isEmpty else {
            call.reject("no text to speak")
            return
        }

        let utterance = AVSpeechUtterance(string: text)

        // A named voice wins; otherwise the language decides. An unsupported language is REJECTED,
        // not silently ignored — that rejection is what lets the player fall back to the next
        // language on its list (pi -> sa -> en), the same contract Android's plugin implements.
        if let wanted = call.getString("voice"), !wanted.isEmpty, let voice = voice(named: wanted) {
            utterance.voice = voice
        } else if let lang = call.getString("lang"), !lang.isEmpty {
            guard let voice = AVSpeechSynthesisVoice(language: lang) else {
                call.reject("language not supported: \(lang)")
                return
            }
            utterance.voice = voice
        }

        // Web Speech's rate is 1.0 for normal speech and AVSpeechUtterance's default is 0.5, so the
        // two only agree if the requested rate is applied to the default rather than used raw.
        let rate = Float(call.getDouble("rate") ?? 1.0)
        let maxRate = Float(AVSpeechUtteranceMaximumSpeechRate)
        utterance.rate = min(max(AVSpeechUtteranceDefaultSpeechRate * rate, 0.0), maxRate)

        currentId = call.getString("id") ?? ""
        synth.speak(utterance)
        call.resolve()
    }

    @objc func cancel(_ call: CAPPluginCall) {
        synth.stopSpeaking(at: .immediate)
        currentId = nil
        call.resolve()
    }

    @objc func getVoices(_ call: CAPPluginCall) {
        let list = AVSpeechSynthesisVoice.speechVoices().map { voice -> [String: Any] in
            [
                "name": voice.name,
                "lang": voice.language,
                // Every voice iOS hands out is on the device; there is no network-backed engine to
                // report honestly here, and the player uses this to prefer offline voices.
                "localService": true
            ]
        }
        call.resolve(["voices": list])
    }

    private func voice(named name: String) -> AVSpeechSynthesisVoice? {
        AVSpeechSynthesisVoice.speechVoices().first { $0.name == name || $0.identifier == name }
    }

    private func emit(_ type: String, error: String? = nil) {
        var data: [String: Any] = ["id": currentId ?? "", "type": type]
        if let error = error { data["error"] = error }
        notifyListeners("tts", data: data)
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        emit("end")
        currentId = nil
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        // No event on purpose: a cancel is the caller's own doing, and Web Speech callers null their
        // handlers before cancelling (Android's plugin behaves the same way).
        currentId = nil
    }

    // No teardown hook: Capacitor 8's iOS CAPPlugin has no handleOnDestroy (Android's has one), and
    // the synthesizer dies with the plugin instance. A cancel is the only stop that matters.
}

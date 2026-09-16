import { useState, useEffect } from "react";

const VOICE_LANG_KEY = "gb-voice-language";
const VOICE_WAKE_KEY = "gb-voice-wake";
const VOICE_TTS_KEY = "gb-voice-tts";

export type VoiceLanguage = "auto" | "zh-CN" | "en-US";

export function getVoiceLanguage(): VoiceLanguage {
  const raw = localStorage.getItem(VOICE_LANG_KEY);
  return raw === "zh-CN" || raw === "en-US" ? raw : "auto";
}
export function setVoiceLanguage(lang: VoiceLanguage) {
  localStorage.setItem(VOICE_LANG_KEY, lang);
}

export function getVoiceWakeEnabled(): boolean {
  return localStorage.getItem(VOICE_WAKE_KEY) === "true";
}
export function setVoiceWakeEnabled(v: boolean) {
  localStorage.setItem(VOICE_WAKE_KEY, String(v));
}

export function getTtsEnabled(): boolean {
  return localStorage.getItem(VOICE_TTS_KEY) === "true";
}
export function setTtsEnabled(v: boolean) {
  localStorage.setItem(VOICE_TTS_KEY, String(v));
}

export function VoiceSettings() {
  const [lang, setLang] = useState<VoiceLanguage>(() => getVoiceLanguage());
  const [wake, setWake] = useState(() => getVoiceWakeEnabled());
  const [tts, setTts] = useState(() => getTtsEnabled());

  useEffect(() => setVoiceLanguage(lang), [lang]);
  useEffect(() => setVoiceWakeEnabled(wake), [wake]);
  useEffect(() => setTtsEnabled(tts), [tts]);

  return (
    <div className="space-y-6 p-4">
      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">Voice input language</h3>
        <div className="rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <div className="flex gap-2">
            {([
              { id: "auto", label: "🌐 Auto-detect" },
              { id: "zh-CN", label: "🇨🇳 中文" },
              { id: "en-US", label: "🇺🇸 English" },
            ] as const).map((opt) => (
              <button
                key={opt.id}
                onClick={() => setLang(opt.id)}
                className={`rounded px-3 py-1.5 text-xs transition-colors ${
                  lang === opt.id
                    ? "bg-gb-accent/15 text-gb-text"
                    : "bg-gb-bg text-gb-muted hover:text-gb-text"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-gb-muted">
            Passed to the browser's speech-recognition engine. Auto uses the
            system language.
          </p>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">Voice wake</h3>
        <label className="flex cursor-pointer items-center justify-between rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <div>
            <p className="text-xs font-medium text-gb-text">Wake word</p>
            <p className="mt-0.5 text-[11px] text-gb-muted">
              Experimental. Start recording when you say "Hey Grok" while the
              app is focused. (Browser speech recognition only; no always-on
              listening.)
            </p>
          </div>
          <button
            role="switch"
            aria-checked={wake}
            onClick={() => setWake(!wake)}
            className={`relative h-5 w-9 rounded-full transition-colors ${
              wake ? "bg-gb-accent" : "bg-gb-border"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                wake ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        </label>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">Text-to-speech</h3>
        <label className="flex cursor-pointer items-center justify-between rounded-lg border border-gb-border bg-gb-surface px-4 py-3">
          <div>
            <p className="text-xs font-medium text-gb-text">Read replies aloud</p>
            <p className="mt-0.5 text-[11px] text-gb-muted">
              Use the browser's speechSynthesis API to read assistant replies.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={tts}
            onClick={() => setTts(!tts)}
            className={`relative h-5 w-9 rounded-full transition-colors ${
              tts ? "bg-gb-accent" : "bg-gb-border"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                tts ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        </label>
      </section>
    </div>
  );
}

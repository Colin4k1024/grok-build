import { useState, useRef, useCallback, useEffect } from "react";
import {
  next as voiceNext,
  isDegradedReason,
  type VoiceState,
} from "../lib/voiceMachine";

// Minimal Web Speech API typing
interface SpeechRecognitionEvent extends Event {
  results: {
    length: number;
    [index: number]: {
      length: number;
      [index: number]: { transcript: string; confidence: number };
      isFinal: boolean;
    };
  };
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type Lang = "auto" | "zh-CN" | "en-US";

export function useVoiceInput(
  onTranscript: (text: string, isFinal: boolean) => void
) {
  const [isRecording, setIsRecording] = useState(false);
  const [language, setLanguage] = useState<Lang>("auto");
  const [interimText, setInterimText] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // ISS-082: formal voice session machine + explicit degradation channel.
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [degraded, setDegraded] = useState<string | null>(null);
  const mutedRef = useRef(false);
  const advance = (event: Parameters<typeof voiceNext>[1]) =>
    setVoiceState((st) => voiceNext(st, event));

  const createRecognition = useCallback((): SpeechRecognitionLike | null => {
    const SR = (window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    });
    const Ctor = SR.SpeechRecognition || SR.webkitSpeechRecognition;
    if (!Ctor) return null;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = language === "auto" ? "" : language;
    return rec;
  }, [language]);

  const startRecording = useCallback(() => {
    const rec = createRecognition();
    if (!rec) {
      // Negative (ISS-082): no engine → explicit degraded notice, never a
      // silent no-op.
      setDegraded("此环境不支持语音识别 — 已降级为键盘输入");
      advance({ type: "start-requested", supported: false });
      return;
    }
    advance({ type: "start-requested", supported: true });

    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }
      if (interim) {
        advance({ type: "first-audio" });
        setInterimText(interim);
        onTranscript(interim, false);
      }
      if (final) {
        setInterimText("");
        onTranscript(final, true);
      }
    };

    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      console.error("Speech recognition error:", e.error);
      advance({ type: "engine-error", reason: e.error });
      setIsRecording(false);
      if (isDegradedReason(e.error)) {
        setDegraded(
          e.error === "network"
            ? "网络不可用 — 语音已降级回键盘输入"
            : "麦克风不可用/未授权 — 语音已降级回键盘输入"
        );
      }
    };

    rec.onend = () => {
      // Auto-restart while live (silence timeouts); muted/ended stay down.
      if (recognitionRef.current === rec && isRecording && !mutedRef.current) {
        try { rec.start(); } catch { /* already started */ }
      } else {
        setIsRecording(false);
        setInterimText("");
      }
    };

    recognitionRef.current = rec;
    try {
      rec.start();
      setIsRecording(true);
      advance({ type: "engine-started" });
    } catch (e) {
      console.error("Failed to start recognition:", e);
      advance({ type: "engine-error", reason: "start-failed" });
    }
  }, [createRecognition, onTranscript, isRecording]);

  const stopRecording = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      rec.onend = null; // prevent auto-restart
      try { rec.stop(); } catch { /* already stopped */ }
    }
    recognitionRef.current = null;
    setIsRecording(false);
    setInterimText("");
    advance({ type: "stop-requested" });
  }, []);

  /** Mute pauses capture while the session stays open (ISS-082). */
  const mute = useCallback(() => {
    mutedRef.current = true;
    const rec = recognitionRef.current;
    if (rec) {
      rec.onend = null;
      try { rec.stop(); } catch { /* already stopped */ }
    }
    setInterimText("");
    advance({ type: "mute-requested" });
  }, []);

  const unmute = useCallback(() => {
    mutedRef.current = false;
    const rec = recognitionRef.current;
    if (rec) {
      rec.onend = null;
      try { rec.start(); } catch { /* already started */ }
      advance({ type: "unmute-requested" });
    }
  }, []);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  // Keyboard shortcut: Cmd/Ctrl+Shift+V
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = navigator.platform.toUpperCase().includes("MAC") ? "Meta" : "Control";
      if (e.key === "v" && e.shiftKey && e.getModifierState(mod)) {
        e.preventDefault();
        toggleRecording();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const rec = recognitionRef.current;
      if (rec) {
        try { rec.abort(); } catch { /* ignore */ }
      }
    };
  }, []);

  return {
    isRecording,
    interimText,
    language,
    setLanguage,
    toggleRecording,
    startRecording,
    stopRecording,
    // ISS-082 additions
    voiceState,
    degraded,
    dismissDegraded: useCallback(() => setDegraded(null), []),
    mute,
    unmute,
  };
}

import { useState, useRef, useCallback, useEffect } from "react";

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
      console.error("Speech Recognition not supported in this browser");
      return;
    }

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
      setIsRecording(false);
    };

    rec.onend = () => {
      // Auto-restart if still recording (some browsers stop after silence)
      if (recognitionRef.current === rec && isRecording) {
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
    } catch (e) {
      console.error("Failed to start recognition:", e);
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
    stopRecording,
  };
}

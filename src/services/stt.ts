// stt.ts — Native Speech-to-Text service for Nexus (Web Speech API)
// Focus: low-latency dictation into CommandBar without backend sidecars.

type SpeechRecognitionLikeCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: ((this: SpeechRecognitionLike, ev: Event) => unknown) | null;
  onresult: ((this: SpeechRecognitionLike, ev: SpeechRecognitionResultEventLike) => unknown) | null;
  onerror: ((this: SpeechRecognitionLike, ev: SpeechRecognitionErrorEventLike) => unknown) | null;
  onend: ((this: SpeechRecognitionLike, ev: Event) => unknown) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionResultEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
}

interface SpeechRecognitionWindow extends Window {
  SpeechRecognition?: SpeechRecognitionLikeCtor;
  webkitSpeechRecognition?: SpeechRecognitionLikeCtor;
}

export interface DictationOptions {
  lang?: string;
  initialText?: string;
  onText: (text: string) => void;
  onStart?: () => void;
  onEnd?: (finalText: string) => void;
  onError?: (message: string) => void;
}

interface DictationSession {
  recognition: SpeechRecognitionLike;
  options: DictationOptions;
  baseText: string;
  finalText: string;
  closed: boolean;
}

const DEFAULT_LANG = "pt-BR";

let activeSession: DictationSession | null = null;

function getRecognitionCtor(): SpeechRecognitionLikeCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as SpeechRecognitionWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function normalizeBaseText(text: string): string {
  return text.trim();
}

function joinBaseAndTranscript(base: string, transcript: string): string {
  const cleanBase = normalizeBaseText(base);
  const cleanTranscript = transcript.trim();

  if (!cleanBase) return cleanTranscript;
  if (!cleanTranscript) return cleanBase;
  return `${cleanBase} ${cleanTranscript}`;
}

function normalizeRecognitionError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Permissão de microfone negada. Habilite o acesso ao microfone nas permissões do sistema/WebView.";
    case "no-speech":
      return "Nenhuma fala detectada.";
    case "audio-capture":
      return "Não foi possível acessar o microfone.";
    case "network":
      return "Falha de rede durante o reconhecimento de voz.";
    case "aborted":
      return "Reconhecimento de voz interrompido.";
    default:
      return `Erro no reconhecimento de voz (${code}).`;
  }
}

function closeSession(session: DictationSession) {
  if (session.closed) return;
  session.closed = true;
  if (activeSession === session) {
    activeSession = null;
  }
}

export function isSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export function isDictating(): boolean {
  return activeSession !== null;
}

export function startDictation(options: DictationOptions): void {
  const Ctor = getRecognitionCtor();
  if (!Ctor) {
    throw new Error("Reconhecimento de voz não suportado neste ambiente.");
  }

  if (activeSession) {
    stopDictation();
  }

  const recognition = new Ctor();
  const session: DictationSession = {
    recognition,
    options,
    baseText: normalizeBaseText(options.initialText ?? ""),
    finalText: "",
    closed: false,
  };

  recognition.lang = options.lang ?? DEFAULT_LANG;
  recognition.interimResults = true;
  recognition.continuous = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    session.options.onStart?.();
  };

  recognition.onresult = (event) => {
    let interimText = "";

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const piece = result[0]?.transcript?.trim() ?? "";
      if (!piece) continue;

      if (result.isFinal) {
        session.finalText = `${session.finalText} ${piece}`.trim();
      } else {
        interimText = `${interimText} ${piece}`.trim();
      }
    }

    const mergedTranscript = `${session.finalText} ${interimText}`.trim();
    const mergedText = joinBaseAndTranscript(session.baseText, mergedTranscript);
    session.options.onText(mergedText);
  };

  recognition.onerror = (event) => {
    if (event.error === "aborted") {
      return;
    }
    session.options.onError?.(normalizeRecognitionError(event.error));
  };

  recognition.onend = () => {
    const finalMerged = joinBaseAndTranscript(session.baseText, session.finalText);
    session.options.onEnd?.(finalMerged);
    closeSession(session);
  };

  activeSession = session;
  recognition.start();
}

export function stopDictation(): void {
  const session = activeSession;
  if (!session) return;

  try {
    session.recognition.stop();
  } catch {
    session.recognition.abort();
  }
}

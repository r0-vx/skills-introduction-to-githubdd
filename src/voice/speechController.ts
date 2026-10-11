export type RecognitionMode = 'command' | 'dictation' | 'conversation';
export type SpeechStatus = 'idle' | 'listening' | 'restarting' | 'paused' | 'processing' | 'speaking' | 'error' | 'unavailable';

interface SpeechRecognitionEventLike extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export interface SpeechControllerCallbacks {
  onTranscript: (text: string, isFinal: boolean, mode: RecognitionMode) => void;
  onStatus: (status: SpeechStatus, message?: string) => void;
}

export interface SpeechStartOptions {
  /** Keep recognition alive when the browser ends a session for silence or privacy reasons. */
  autoRestart?: boolean;
}

function recognitionConstructor(): SpeechRecognitionConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  const speechWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
}

function errorMessage(code: string): string {
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'Microphone permission was denied or speech recognition is blocked. Allow microphone access, then retry.';
  if (code === 'audio-capture') return 'No microphone input is available. Connect or select a microphone, then retry.';
  if (code === 'network') return 'The browser speech service could not connect. HandFree will retry while the assistant remains enabled.';
  if (code === 'language-not-supported') return 'This browser does not support the selected recognition language.';
  if (code === 'no-speech') return 'No speech was detected. HandFree will keep listening.';
  return 'Speech recognition stopped unexpectedly. HandFree will retry while the assistant remains enabled.';
}

function isPermanentError(code: string): boolean {
  return code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture' || code === 'language-not-supported';
}

/**
 * The one recognition primitive used by the dashboard, Demo Lab and Railway
 * surfaces. It owns exactly one native SpeechRecognition instance and guards
 * restart/speech-synthesis races so pages cannot accidentally create a loop
 * of microphone sessions.
 */
export class SpeechController {
  private recognition: SpeechRecognitionLike | null = null;
  private mode: RecognitionMode = 'command';
  private lastSpoken = '';
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private wantsListening = false;
  private paused = false;
  private autoRestart = true;
  private speaking = false;
  private starting = false;
  status: SpeechStatus = 'idle';
  readonly supported: boolean;

  constructor(private readonly callbacks: SpeechControllerCallbacks) {
    this.supported = Boolean(recognitionConstructor());
  }

  get currentMode(): RecognitionMode { return this.mode; }
  get isActive(): boolean { return this.wantsListening && !this.paused; }

  start(mode: RecognitionMode = 'command', options: SpeechStartOptions = {}): void {
    if (!this.supported) {
      this.wantsListening = false;
      this.paused = false;
      this.setStatus('unavailable', 'VOICE_RECOGNITION_UNAVAILABLE: This browser does not expose Web Speech recognition. Use a supported Chrome build and allow microphone access, then retry.');
      return;
    }
    const nextAutoRestart = options.autoRestart ?? true;
    const alreadyRunning = this.wantsListening && !this.paused && this.mode === mode && (this.recognition !== null || this.status === 'restarting' || this.starting);
    this.autoRestart = nextAutoRestart;
    this.mode = mode;
    this.paused = false;
    this.wantsListening = true;
    if (alreadyRunning) return;
    this.clearRestartTimer();
    this.detachRecognition();
    this.startRecognition(++this.generation);
  }

  pause(): void {
    this.wantsListening = false;
    this.paused = true;
    this.clearRestartTimer();
    this.detachRecognition();
    this.setStatus('paused', 'HandFree is paused. Resume listening when you are ready.');
  }

  resume(): void {
    if (!this.supported) {
      this.setStatus('unavailable', 'VOICE_RECOGNITION_UNAVAILABLE: This browser does not expose Web Speech recognition.');
      return;
    }
    this.paused = false;
    this.wantsListening = true;
    this.clearRestartTimer();
    if (!this.recognition) this.startRecognition(++this.generation);
  }

  stop(): void {
    this.wantsListening = false;
    this.paused = false;
    this.clearRestartTimer();
    this.detachRecognition();
    this.setStatus('idle', 'HandFree voice listening is off.');
  }

  speak(text: string, rate = 1, volume = 1): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || !text.trim()) return;
    this.lastSpoken = text;
    this.speaking = true;
    // Recognition must be detached while feedback is spoken, otherwise the
    // browser can feed HandFree's own voice back into its command parser.
    this.detachRecognition();
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = Math.max(0.5, Math.min(2, rate));
    utterance.volume = Math.max(0, Math.min(1, volume));
    const finish = () => {
      this.speaking = false;
      if (this.wantsListening && !this.paused) this.startRecognition(++this.generation);
      else if (!this.paused) this.setStatus('idle');
    };
    utterance.onstart = () => this.setStatus('speaking');
    utterance.onend = finish;
    utterance.onerror = finish;
    this.setStatus('speaking');
    window.speechSynthesis.speak(utterance);
  }

  stopSpeaking(): void {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    this.speaking = false;
    if (this.wantsListening && !this.paused) this.startRecognition(++this.generation);
    else if (!this.paused) this.setStatus('idle');
  }

  repeat(rate = 1, volume = 1): void {
    if (this.lastSpoken) this.speak(this.lastSpoken, rate, volume);
  }

  destroy(): void {
    this.stop();
    this.stopSpeaking();
  }

  private startRecognition(generation: number): void {
    if (!this.wantsListening || this.paused || this.speaking || this.recognition) return;
    const ctor = recognitionConstructor();
    if (!ctor) {
      this.wantsListening = false;
      this.setStatus('unavailable', 'VOICE_RECOGNITION_UNAVAILABLE: This browser does not expose Web Speech recognition.');
      return;
    }
    const recognition = new ctor();
    this.recognition = recognition;
    this.starting = true;
    recognition.continuous = true;
    recognition.interimResults = this.mode === 'dictation';
    recognition.lang = 'en-US';
    recognition.onstart = () => {
      if (generation !== this.generation || this.recognition !== recognition) return;
      this.starting = false;
      this.setStatus('listening');
    };
    recognition.onresult = (event) => {
      if (generation !== this.generation || this.recognition !== recognition) return;
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript?.trim();
        if (transcript) this.callbacks.onTranscript(transcript, result.isFinal, this.mode);
      }
    };
    recognition.onerror = (event) => {
      if (generation !== this.generation || this.recognition !== recognition) return;
      const code = event.error || 'unknown';
      this.detachRecognition();
      if (isPermanentError(code)) {
        this.wantsListening = false;
        this.setStatus(code === 'not-allowed' || code === 'service-not-allowed' ? 'unavailable' : 'error', `VOICE_RECOGNITION_UNAVAILABLE (${code}): ${errorMessage(code)}`);
      } else if (this.wantsListening && this.autoRestart) {
        this.setStatus('restarting', `Recognition paused (${code}). ${errorMessage(code)}`);
        this.scheduleRestart();
      } else {
        this.setStatus('error', `VOICE_RECOGNITION_UNAVAILABLE (${code}): ${errorMessage(code)}`);
      }
    };
    recognition.onend = () => {
      if (generation !== this.generation || this.recognition !== recognition) return;
      this.detachRecognition(false);
      if (this.wantsListening && !this.paused && !this.speaking && this.autoRestart) {
        this.setStatus('restarting', 'Recognition ended. Restarting listening…');
        this.scheduleRestart();
      } else if (this.paused) {
        this.setStatus('paused', 'HandFree is paused.');
      } else if (!this.speaking) {
        this.setStatus('idle');
      }
    };
    try {
      recognition.start();
    } catch (error) {
      this.detachRecognition();
      if (this.wantsListening && this.autoRestart) {
        this.setStatus('restarting', 'The browser did not accept the microphone start yet. Retrying…');
        this.scheduleRestart();
      } else {
        this.wantsListening = false;
        this.setStatus('error', `The microphone could not be started: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer !== null || !this.wantsListening || this.paused || this.speaking) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wantsListening && !this.paused && !this.speaking) this.startRecognition(++this.generation);
    }, 350);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private detachRecognition(abort = true): void {
    const current = this.recognition;
    this.recognition = null;
    this.starting = false;
    if (!current) return;
    current.onstart = null;
    current.onresult = null;
    current.onend = null;
    current.onerror = null;
    if (abort) {
      try { current.abort(); } catch { /* the browser may already have ended it */ }
    }
  }

  private setStatus(status: SpeechStatus, message?: string): void {
    this.status = status;
    this.callbacks.onStatus(status, message);
  }
}

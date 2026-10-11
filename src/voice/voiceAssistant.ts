import { parseVoiceCommand, stripWakePhrase, type VoiceIntent } from './commandParser';
import { SpeechController, type RecognitionMode, type SpeechStatus } from './speechController';

export interface VoiceAssistantSnapshot {
  enabled: boolean;
  paused: boolean;
  mode: RecognitionMode;
  status: SpeechStatus;
  supported: boolean;
  currentTranscript: string;
  lastTranscript: string;
  lastCommand: string;
  message: string;
  error: string;
  history: string[];
  pendingConfirmation: string;
  sessionCount: number;
}

export type VoiceCommandHandler = (transcript: string, intent: VoiceIntent) => void | Promise<void>;
export type VoiceDictationHandler = (text: string) => void | Promise<void>;
export type VoiceConversationHandler = (text: string) => void | Promise<void>;
export type VoiceAssistantListener = (snapshot: VoiceAssistantSnapshot) => void;

const HELP_MESSAGE = 'You can say: click, scroll, open, read, type, search, select, or send.';

function initialSnapshot(supported: boolean): VoiceAssistantSnapshot {
  return {
    enabled: false,
    paused: false,
    mode: 'command',
    status: supported ? 'idle' : 'unavailable',
    supported,
    currentTranscript: '',
    lastTranscript: '',
    lastCommand: '',
    message: supported ? 'Voice Assistant is off.' : 'VOICE_RECOGNITION_UNAVAILABLE: this browser does not expose Web Speech recognition.',
    error: supported ? '' : 'Web Speech recognition is unavailable in this browser.',
    history: [],
    pendingConfirmation: '',
    sessionCount: 0
  };
}

/** One assistant per extension page. Every page uses this same controller API. */
export class VoiceAssistantController {
  private readonly speech: SpeechController;
  private readonly listeners = new Set<VoiceAssistantListener>();
  private commandHandler: VoiceCommandHandler | null = null;
  private dictationHandler: VoiceDictationHandler | null = null;
  private conversationHandler: VoiceConversationHandler | null = null;
  private lastCommandAt = 0;
  private lastNormalizedCommand = '';
  private feedbackEnabled = true;
  private wakePhraseEnabled = false;
  private speechRate = 1;
  private speechVolume = 1;
  private snapshot: VoiceAssistantSnapshot;

  constructor() {
    this.speech = new SpeechController({
      onTranscript: (text, isFinal, mode) => this.handleTranscript(text, isFinal, mode),
      onStatus: (status, message) => {
        this.snapshot = {
          ...this.snapshot,
          status,
          paused: status === 'paused' || this.snapshot.paused,
          error: status === 'error' || status === 'unavailable' ? message ?? this.snapshot.error : '',
          message: message ?? this.snapshot.message
        };
        this.emit();
      }
    });
    this.snapshot = initialSnapshot(this.speech.supported);
  }

  get state(): VoiceAssistantSnapshot { return this.snapshot; }
  get controller(): SpeechController { return this.speech; }

  subscribe(listener: VoiceAssistantListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  setHandlers(commandHandler: VoiceCommandHandler | null, dictationHandler: VoiceDictationHandler | null, conversationHandler: VoiceConversationHandler | null = null): void {
    this.commandHandler = commandHandler;
    this.dictationHandler = dictationHandler;
    this.conversationHandler = conversationHandler;
  }

  setPreferences(preferences: { feedbackEnabled?: boolean; wakePhraseEnabled?: boolean; speechRate?: number; speechVolume?: number }): void {
    if (preferences.feedbackEnabled !== undefined) this.feedbackEnabled = preferences.feedbackEnabled;
    if (preferences.wakePhraseEnabled !== undefined) this.wakePhraseEnabled = preferences.wakePhraseEnabled;
    if (preferences.speechRate !== undefined) this.speechRate = preferences.speechRate;
    if (preferences.speechVolume !== undefined) this.speechVolume = preferences.speechVolume;
  }

  enable(mode: RecognitionMode = this.snapshot.mode): void {
    this.snapshot = { ...this.snapshot, enabled: true, paused: false, mode, error: '', message: 'Requesting microphone access…', sessionCount: this.snapshot.sessionCount + 1 };
    this.emit();
    this.speech.start(mode, { autoRestart: true });
  }

  disable(message = 'HandFree voice listening is off.'): void {
    this.speech.stop();
    this.snapshot = { ...this.snapshot, enabled: false, paused: false, status: 'idle', mode: 'command', pendingConfirmation: '', message, error: '' };
    this.emit();
  }

  pause(): void {
    if (!this.snapshot.enabled) return;
    this.speech.pause();
    this.snapshot = { ...this.snapshot, paused: true, status: 'paused', message: 'HandFree is paused. Resume listening when you are ready.' };
    this.emit();
  }

  resume(): void {
    if (!this.snapshot.enabled) {
      this.enable();
      return;
    }
    this.snapshot = { ...this.snapshot, paused: false, error: '', message: 'Resuming voice listening…' };
    this.emit();
    this.speech.resume();
  }

  setMode(mode: RecognitionMode): void {
    this.snapshot = {
      ...this.snapshot,
      mode,
      message: mode === 'dictation'
        ? 'Dictation is listening. Say stop dictation when finished.'
        : mode === 'conversation'
          ? 'Guided conversation is listening. Answer the current question naturally.'
          : 'Voice commands are listening.'
    };
    this.emit();
    if (this.snapshot.enabled) this.speech.start(mode, { autoRestart: true });
  }

  retry(): void {
    this.enable(this.snapshot.mode);
  }

  resetSession(): void {
    this.speech.stopSpeaking();
    this.disable('Voice session reset.');
    this.snapshot = { ...this.snapshot, currentTranscript: '', lastTranscript: '', lastCommand: '', history: [], pendingConfirmation: '' };
    this.emit();
  }

  clearStatus(): void {
    this.snapshot = { ...this.snapshot, currentTranscript: '', lastTranscript: '', lastCommand: '', message: this.snapshot.enabled ? 'Listening for a command.' : 'Voice Assistant is off.', error: '' };
    this.emit();
  }

  speak(text: string): void {
    if (!this.feedbackEnabled) return;
    this.speech.speak(text, this.speechRate, this.speechVolume);
  }

  stopSpeaking(): void { this.speech.stopSpeaking(); }
  repeat(): void { this.speech.repeat(this.speechRate, this.speechVolume); }
  announce(message: string, speak = false): void { this.setMessage(message, speak); }

  private handleTranscript(text: string, isFinal: boolean, mode: RecognitionMode): void {
    this.snapshot = {
      ...this.snapshot,
      currentTranscript: isFinal ? '' : text,
      lastTranscript: isFinal ? text : this.snapshot.lastTranscript,
      message: isFinal ? `Heard: “${text}”` : `Listening: ${text}`
    };
    if (!isFinal) {
      this.emit();
      return;
    }
    const normalized = text.trim().toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    if (this.wakePhraseEnabled && !stripWakePhrase(text).woke) {
      this.setMessage('Waiting for “Hey HandFree” before processing speech.', false);
      return;
    }
    const now = Date.now();
    if (normalized === this.lastNormalizedCommand && now - this.lastCommandAt < 900) return;
    this.lastNormalizedCommand = normalized;
    this.lastCommandAt = now;
    this.snapshot = { ...this.snapshot, history: [text, ...this.snapshot.history].slice(0, 12) };

    const intent = parseVoiceCommand(text);
    if (!intent) {
      if (mode === 'dictation') void this.dictationHandler?.(text);
      else if (mode === 'conversation') void this.conversationHandler?.(text);
      else this.setMessage(`I did not understand “${text}”. Say help for examples.`, false);
      return;
    }
    if (mode === 'dictation' && intent.type !== 'stop-dictation') {
      if (intent.type === 'dictate') void this.dictationHandler?.(intent.text ?? text);
      else void this.dictationHandler?.(text);
      this.setMessage('Dictation captured. It was not submitted.', false);
      return;
    }
    void this.dispatch(text, intent);
  }

  private async dispatch(transcript: string, intent: VoiceIntent): Promise<void> {
    this.snapshot = { ...this.snapshot, lastCommand: intent.type, pendingConfirmation: this.snapshot.pendingConfirmation };
    if (intent.type === 'confirm' && this.snapshot.pendingConfirmation) {
      const pending = this.snapshot.pendingConfirmation;
      const pendingIntent = parseVoiceCommand(pending);
      this.snapshot = { ...this.snapshot, pendingConfirmation: '' };
      this.emit();
      if (pendingIntent) await this.commandHandler?.(pending, pendingIntent);
      this.setMessage('Confirmed.', true);
      return;
    }
    if (intent.type === 'cancel' && this.snapshot.pendingConfirmation) {
      this.snapshot = { ...this.snapshot, pendingConfirmation: '' };
      this.setMessage('I cancelled that action.', true);
      return;
    }
    if (intent.type === 'reload' || intent.type === 'close' || intent.type === 'exit' || intent.type === 'submit') {
      this.snapshot = { ...this.snapshot, pendingConfirmation: transcript, message: 'This action needs confirmation. Say confirm to continue or cancel to stop.' };
      this.emit();
      this.speak('This action needs confirmation. Say confirm to continue or cancel to stop.');
      return;
    }
    switch (intent.type) {
      case 'wake':
      case 'start-listening':
      case 'resume-listening':
        this.snapshot.enabled ? this.resume() : this.enable();
        this.setMessage('HandFree is listening.', true);
        return;
      case 'stop-listening':
      case 'pause-listening':
      case 'sleep':
        this.pause();
        this.setMessage(intent.type === 'sleep' ? 'HandFree is now inactive.' : 'HandFree is paused.', true);
        return;
      case 'help':
        this.setMessage(HELP_MESSAGE, true);
        return;
      case 'repeat':
        this.repeat();
        return;
      case 'start-dictation':
        this.setMode('dictation');
        this.setMessage('Dictation started. Say stop dictation when finished.', true);
        return;
      case 'stop-dictation':
        this.setMode('command');
        this.setMessage('Dictation stopped. Nothing was submitted automatically.', true);
        return;
      case 'cancel':
        this.setMessage('I cancelled that action.', true);
        await this.commandHandler?.(transcript, intent);
        return;
      default:
        await this.commandHandler?.(transcript, intent);
    }
    this.emit();
  }

  private setMessage(message: string, speak: boolean): void {
    this.snapshot = { ...this.snapshot, message, error: '' };
    this.emit();
    if (speak) this.speak(message);
  }

  private emit(): void {
    const snapshot = this.snapshot;
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

let sharedAssistant: VoiceAssistantController | null = null;

export function getVoiceAssistant(): VoiceAssistantController {
  if (!sharedAssistant) sharedAssistant = new VoiceAssistantController();
  return sharedAssistant;
}

export { HELP_MESSAGE };

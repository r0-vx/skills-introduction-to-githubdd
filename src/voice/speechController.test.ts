import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechController, type RecognitionMode } from './speechController';

type FakeResultEvent = { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> };

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = '';
  onstart: (() => void) | null = null;
  onresult: ((event: FakeResultEvent) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  startCount = 0;
  aborted = false;
  constructor() { FakeRecognition.instances.push(this); }
  start(): void { this.startCount += 1; this.onstart?.(); }
  stop(): void { this.onend?.(); }
  abort(): void { this.aborted = true; this.onend?.(); }
  emit(text: string, isFinal = true): void { this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text } }] }); }
  emitEnd(): void { this.onend?.(); }
  emitError(error: string): void { this.onerror?.({ error }); }
}

function installSpeechGlobals(): void {
  FakeRecognition.instances = [];
  vi.stubGlobal('window', {
    SpeechRecognition: FakeRecognition,
    speechSynthesis: { cancel: vi.fn(), speak: vi.fn() }
  });
  vi.stubGlobal('SpeechSynthesisUtterance', class { rate = 1; volume = 1; onstart: (() => void) | null = null; onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(public text: string) {} });
}

describe('SpeechController', () => {
  beforeEach(() => { vi.useFakeTimers(); installSpeechGlobals(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('does not create duplicate recognition sessions when start is repeated', () => {
    const controller = new SpeechController({ onTranscript: () => undefined, onStatus: () => undefined });
    controller.start('command');
    controller.start('command');
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(FakeRecognition.instances[0].startCount).toBe(1);
    controller.destroy();
  });

  it('restarts after the browser ends recognition while enabled', () => {
    const statuses: string[] = [];
    const controller = new SpeechController({ onTranscript: () => undefined, onStatus: (status) => statuses.push(status) });
    controller.start('command');
    FakeRecognition.instances[0].emitEnd();
    expect(statuses).toContain('restarting');
    vi.advanceTimersByTime(350);
    expect(FakeRecognition.instances).toHaveLength(2);
    controller.destroy();
  });

  it('stops retrying on microphone permission errors and supports pause/resume', () => {
    const statuses: string[] = [];
    const controller = new SpeechController({ onTranscript: () => undefined, onStatus: (status) => statuses.push(status) });
    controller.start('command');
    FakeRecognition.instances[0].emitError('not-allowed');
    expect(statuses.at(-1)).toBe('unavailable');
    expect(controller.isActive).toBe(false);
    controller.start('command');
    controller.pause();
    expect(statuses.at(-1)).toBe('paused');
    controller.resume();
    expect(controller.isActive).toBe(true);
    controller.destroy();
  });

  it('keeps the selected recognition mode when delivering transcripts', () => {
    const modes: RecognitionMode[] = [];
    const controller = new SpeechController({ onTranscript: (_text, _final, mode) => modes.push(mode), onStatus: () => undefined });
    controller.start('dictation');
    FakeRecognition.instances[0].emit('a sentence');
    expect(modes).toEqual(['dictation']);
    controller.destroy();
  });
});

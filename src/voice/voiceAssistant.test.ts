import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceAssistantController } from './voiceAssistant';

class AssistantRecognition {
  static instances: AssistantRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = '';
  onstart: (() => void) | null = null;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  constructor() { AssistantRecognition.instances.push(this); }
  start(): void { this.onstart?.(); }
  stop(): void { this.onend?.(); }
  abort(): void { this.onend?.(); }
  emit(text: string): void { this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] }); }
}

describe('VoiceAssistantController', () => {
  beforeEach(() => {
    AssistantRecognition.instances = [];
    vi.stubGlobal('window', { SpeechRecognition: AssistantRecognition, speechSynthesis: { cancel: vi.fn(), speak: vi.fn() } });
    vi.stubGlobal('SpeechSynthesisUtterance', class { rate = 1; volume = 1; onstart: (() => void) | null = null; onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(public text: string) {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('uses one recognition session and protects send actions with confirmation', async () => {
    const commands: string[] = [];
    const assistant = new VoiceAssistantController();
    assistant.setPreferences({ feedbackEnabled: false });
    assistant.setHandlers((transcript, intent) => { commands.push(`${intent.type}:${transcript}`); }, null);
    assistant.enable();
    assistant.enable();
    expect(AssistantRecognition.instances).toHaveLength(1);
    AssistantRecognition.instances[0].emit('send message');
    expect(commands).toEqual([]);
    expect(assistant.state.pendingConfirmation).toBe('send message');
    AssistantRecognition.instances[0].emit('confirm');
    await Promise.resolve();
    expect(commands).toEqual(['submit:send message']);
    assistant.disable();
  });

  it('routes final dictation separately and never submits it', async () => {
    const dictation: string[] = [];
    const commands: string[] = [];
    const assistant = new VoiceAssistantController();
    assistant.setPreferences({ feedbackEnabled: false });
    assistant.setHandlers((_transcript, intent) => { commands.push(intent.type); }, (text) => { dictation.push(text); });
    assistant.enable();
    assistant.setMode('dictation');
    const recognition = AssistantRecognition.instances.at(-1)!;
    recognition.emit('A sentence for the focused field');
    await Promise.resolve();
    expect(dictation).toEqual(['A sentence for the focused field']);
    expect(commands).toEqual([]);
    assistant.disable();
  });

  it('requires the wake phrase when wake phrase mode is enabled', async () => {
    const commands: string[] = [];
    const assistant = new VoiceAssistantController();
    assistant.setPreferences({ feedbackEnabled: false, wakePhraseEnabled: true });
    assistant.setHandlers((_transcript, intent) => { commands.push(intent.type); }, null);
    assistant.enable();
    const recognition = AssistantRecognition.instances[0];
    recognition.emit('scroll down');
    expect(commands).toEqual([]);
    expect(assistant.state.message).toContain('Waiting for');
    recognition.emit('Hey HandFree scroll down');
    await Promise.resolve();
    expect(commands).toEqual(['scroll']);
    assistant.disable();
  });

  it('lets guided conversation consume an ambiguous class transcript before global commands', async () => {
    const conversation: string[] = [];
    const commands: string[] = [];
    const assistant = new VoiceAssistantController();
    assistant.setPreferences({ feedbackEnabled: false });
    assistant.setHandlers((_transcript, intent) => { commands.push(intent.type); }, null, (text) => { conversation.push(text); });
    assistant.enable('conversation');
    AssistantRecognition.instances[0].emit('sleep');
    await Promise.resolve();
    expect(conversation).toEqual(['sleep']);
    expect(commands).toEqual([]);
    assistant.disable();
  });
});

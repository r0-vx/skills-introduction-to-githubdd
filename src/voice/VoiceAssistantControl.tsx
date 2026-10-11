import { useEffect, useRef, useState } from 'react';
import type { HandFreeSettings } from '../shared/types';
import { sendMessage, subscribeToRuntimeMessages } from '../shared/runtime';
import { Icon } from '../shared/icons';
import { getVoiceAssistant, type VoiceAssistantSnapshot, type VoiceCommandHandler, type VoiceConversationHandler, type VoiceDictationHandler } from './voiceAssistant';
import type { VoiceIntent } from './commandParser';
import '../ui/voice-assistant.css';

const VOICE_OWNER_KEY = 'handfree-voice-owner';

interface VoiceAssistantControlProps {
  settings: HandFreeSettings;
  onSettings: (patch: Partial<HandFreeSettings>) => void | Promise<void>;
  onCommand?: VoiceCommandHandler;
  onDictation?: VoiceDictationHandler;
  onConversation?: VoiceConversationHandler;
  onConversationStart?: () => void;
  compact?: boolean;
  title?: string;
}

function stateLabel(snapshot: VoiceAssistantSnapshot): string {
  if (!snapshot.supported) return 'Unavailable';
  if (snapshot.status === 'listening') return snapshot.mode === 'dictation' ? 'Dictating' : snapshot.mode === 'conversation' ? 'Guided conversation' : 'Listening';
  if (snapshot.status === 'restarting') return 'Restarting';
  if (snapshot.status === 'paused' || snapshot.paused) return 'Paused';
  if (snapshot.status === 'speaking') return 'Speaking';
  if (snapshot.status === 'error') return 'Needs attention';
  return snapshot.enabled ? 'Starting' : 'Off';
}

function runtimeVoice(snapshot: VoiceAssistantSnapshot): 'unavailable' | 'idle' | 'listening' | 'restarting' | 'paused' | 'processing' | 'speaking' | 'error' {
  if (!snapshot.supported) return 'unavailable';
  if (snapshot.status === 'listening' || snapshot.status === 'restarting' || snapshot.status === 'paused' || snapshot.status === 'speaking' || snapshot.status === 'processing' || snapshot.status === 'error') return snapshot.status;
  return 'idle';
}

export function VoiceAssistantControl({ settings, onSettings, onCommand, onDictation, onConversation, onConversationStart, compact = false, title = 'Voice Assistant' }: VoiceAssistantControlProps) {
  const assistantRef = useRef(getVoiceAssistant());
  const [snapshot, setSnapshot] = useState<VoiceAssistantSnapshot>(assistantRef.current.state);
  const [microphoneTest, setMicrophoneTest] = useState<'idle' | 'testing' | 'passed' | 'failed'>('idle');
  const ownerIdRef = useRef(`voice-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const ownsSessionRef = useRef(false);
  const commandRef = useRef(onCommand);
  const dictationRef = useRef(onDictation);
  const conversationRef = useRef(onConversation);
  const settingsRef = useRef(settings);
  commandRef.current = onCommand;
  dictationRef.current = onDictation;
  conversationRef.current = onConversation;
  settingsRef.current = settings;

  useEffect(() => {
    const assistant = assistantRef.current;
    const unsubscribe = assistant.subscribe((next) => {
      setSnapshot(next);
      void sendMessage({
        type: 'VOICE_STATUS',
        voice: runtimeVoice(next),
        message: next.message,
        assistantEnabled: next.enabled,
        assistantPaused: next.paused,
        transcript: next.lastTranscript,
        command: next.lastCommand
      });
    });
    const stopResults = subscribeToRuntimeMessages((message) => {
      if (document.visibilityState === 'visible' && message.type === 'VOICE_COMMAND_RESULT') assistant.announce(message.message, message.speak ?? true);
    });
    assistant.setHandlers(
      (transcript, intent) => commandRef.current ? commandRef.current(transcript, intent) : sendMessage({ type: 'VOICE_COMMAND', transcript }).then(() => undefined),
      (text) => dictationRef.current ? dictationRef.current(text) : sendMessage({ type: 'DICTATION_TEXT', text, isFinal: true }).then(() => undefined),
      (text) => conversationRef.current ? conversationRef.current(text) : sendMessage({ type: 'VOICE_COMMAND', transcript: text }).then(() => undefined)
    );
    assistant.setPreferences({
      feedbackEnabled: settingsRef.current.voiceFeedbackEnabled,
      wakePhraseEnabled: settingsRef.current.voiceWakePhraseEnabled,
      speechRate: settingsRef.current.speechRate,
      speechVolume: settingsRef.current.speechVolume
    });
    let mounted = true;
    const autoStart = async () => {
      if (!settingsRef.current.voiceAssistantEnabled || assistant.state.enabled) return;
      if (await claimVoiceOwner(ownerIdRef.current)) {
        ownsSessionRef.current = true;
        if (mounted) assistant.enable();
      } else if (mounted) {
        assistant.announce('Voice Assistant is already running in another HandFree surface.', false);
      }
    };
    void autoStart();
    return () => {
      mounted = false;
      assistant.setHandlers(null, null, null);
      unsubscribe();
      stopResults();
      assistant.disable('Voice Assistant page closed.');
      void releaseVoiceOwner(ownerIdRef.current);
    };
  }, []);

  useEffect(() => {
    assistantRef.current.setPreferences({
      feedbackEnabled: settings.voiceFeedbackEnabled,
      wakePhraseEnabled: settings.voiceWakePhraseEnabled,
      speechRate: settings.speechRate,
      speechVolume: settings.speechVolume
    });
  }, [settings.voiceFeedbackEnabled, settings.voiceWakePhraseEnabled, settings.speechRate, settings.speechVolume]);

  async function testMicrophone(): Promise<void> {
    if (microphoneTest === 'testing' || snapshot.enabled) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicrophoneTest('failed');
      return;
    }
    setMicrophoneTest('testing');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((track) => track.stop());
      setMicrophoneTest('passed');
    } catch {
      setMicrophoneTest('failed');
    }
  }

  async function toggleAssistant(): Promise<void> {
    const assistant = assistantRef.current;
    if (snapshot.enabled) {
      assistant.disable();
      ownsSessionRef.current = false;
      await releaseVoiceOwner(ownerIdRef.current);
      void onSettings({ voiceAssistantEnabled: false, voiceAssistantPaused: false });
    } else {
      if (!(await claimVoiceOwner(ownerIdRef.current))) {
        assistant.announce('Voice Assistant is already running in another HandFree surface.', false);
        return;
      }
      ownsSessionRef.current = true;
      void onSettings({ voiceAssistantEnabled: true, voiceAssistantPaused: false, enabledModes: Array.from(new Set([...settings.enabledModes, 'voice' as const])) });
      assistant.enable();
    }
  }

  async function toggleConversation(): Promise<void> {
    const assistant = assistantRef.current;
    if (snapshot.enabled && snapshot.mode === 'conversation') {
      assistant.setMode('command');
      return;
    }
    if (!snapshot.enabled) {
      if (!(await claimVoiceOwner(ownerIdRef.current))) {
        assistant.announce('Voice Assistant is already running in another HandFree surface.', false);
        return;
      }
      ownsSessionRef.current = true;
      void onSettings({ voiceAssistantEnabled: true, voiceAssistantPaused: false, enabledModes: Array.from(new Set([...settings.enabledModes, 'voice' as const])) });
      assistant.enable('conversation');
      onConversationStart?.();
      return;
    }
    onConversationStart?.();
    assistant.setMode('conversation');
  }

  function togglePause(): void {
    const assistant = assistantRef.current;
    if (snapshot.paused || snapshot.status === 'paused') {
      assistant.resume();
      void onSettings({ voiceAssistantPaused: false });
    } else {
      assistant.pause();
      void onSettings({ voiceAssistantPaused: true });
    }
  }

  function updateRate(value: number): void {
    void onSettings({ speechRate: value });
  }

  const statusTone = !snapshot.supported || snapshot.status === 'error' ? 'is-error' : snapshot.status === 'listening' ? 'is-live' : snapshot.status === 'restarting' || snapshot.status === 'paused' ? 'is-warn' : '';
  return <section className={`voice-assistant-control${compact ? ' voice-assistant-control--compact' : ''}`} aria-labelledby="voice-assistant-title">
    <div className="voice-assistant-header">
      <div className="voice-assistant-title-row">
        <span className={`voice-assistant-icon ${statusTone}`}><Icon name="mic" /></span>
        <div><span className="voice-assistant-eyebrow">Always-on browser assistant</span><h2 id="voice-assistant-title">{title}</h2></div>
      </div>
      <button type="button" className="voice-assistant-switch" role="switch" aria-checked={snapshot.enabled} aria-label={`${snapshot.enabled ? 'Disable' : 'Enable'} Voice Assistant`} onClick={() => void toggleAssistant()}><span /></button>
    </div>
    <div className="voice-assistant-status" role={snapshot.status === 'error' || snapshot.status === 'unavailable' || !snapshot.supported ? 'alert' : 'status'} aria-live="polite"><span className={`voice-assistant-dot ${statusTone}`} aria-hidden="true" /><strong>{stateLabel(snapshot)}</strong><span>{snapshot.message}</span></div>
    {(snapshot.lastTranscript || snapshot.lastCommand || snapshot.pendingConfirmation) && <div className="voice-assistant-readout"><span>Last heard</span><strong>{snapshot.lastTranscript || '—'}</strong>{snapshot.lastCommand && <small>Command: {snapshot.lastCommand}</small>}{snapshot.pendingConfirmation && <small>Waiting for “confirm” or “cancel”.</small>}</div>}
    <div className="voice-assistant-actions">
      <button type="button" className="button button--primary" onClick={() => void toggleAssistant()} aria-pressed={snapshot.enabled}><Icon name="mic" />{snapshot.enabled ? 'Assistant on' : 'Enable assistant'}</button>
      {onConversation && <button type="button" className="button button--conversation" onClick={() => void toggleConversation()} aria-pressed={snapshot.enabled && snapshot.mode === 'conversation'} disabled={!snapshot.supported}><Icon name="target" />{snapshot.enabled && snapshot.mode === 'conversation' ? 'Stop guided flow' : 'Start guided flow'}</button>}
      <button type="button" className="button" onClick={togglePause} disabled={!snapshot.enabled || !snapshot.supported}><Icon name={snapshot.paused ? 'play' : 'pause'} />{snapshot.paused ? 'Resume' : 'Pause'}</button>
      <button type="button" className="button" onClick={() => snapshot.status === 'error' || snapshot.status === 'unavailable' ? assistantRef.current.retry() : void testMicrophone()} disabled={microphoneTest === 'testing'}>{snapshot.status === 'error' || snapshot.status === 'unavailable' ? 'Retry voice' : microphoneTest === 'testing' ? 'Testing…' : 'Test microphone'}</button>
    </div>
    <details className="voice-assistant-options">
      <summary>Voice settings</summary>
      <div className="voice-assistant-option-grid">
        <label><span>Voice feedback</span><input type="checkbox" checked={settings.voiceFeedbackEnabled} onChange={(event) => void onSettings({ voiceFeedbackEnabled: event.target.checked })} /></label>
        <label><span>Wake phrase mode</span><input type="checkbox" checked={settings.voiceWakePhraseEnabled} onChange={(event) => void onSettings({ voiceWakePhraseEnabled: event.target.checked })} /></label>
        <label className="voice-assistant-rate" htmlFor="voice-assistant-rate"><span>Speech rate <output>{settings.speechRate.toFixed(1)}×</output></span><input id="voice-assistant-rate" type="range" min="0.6" max="1.6" step="0.1" value={settings.speechRate} onChange={(event) => updateRate(Number(event.target.value))} /></label>
      </div>
      <div className="voice-assistant-option-actions"><button type="button" className="button" onClick={() => assistantRef.current.speak('You can say: click, scroll, open, read, type, search, select, or send.')}>Command help</button><button type="button" className="button" onClick={() => assistantRef.current.clearStatus()}>Clear status</button><button type="button" className="button button--danger" onClick={() => { assistantRef.current.resetSession(); void onSettings({ voiceAssistantEnabled: false, voiceAssistantPaused: false }); }}>Reset voice session</button></div>
    </details>
    {microphoneTest === 'passed' && <p className="voice-assistant-note" role="status">Microphone permission works. The short test track was released.</p>}
    {microphoneTest === 'failed' && <p className="voice-assistant-note voice-assistant-note--error" role="alert">Microphone test failed. Check browser permission and input device, then retry.</p>}
  </section>;
}

export type { VoiceIntent };

async function claimVoiceOwner(ownerId: string): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return true;
  try {
    const stored = await chrome.storage.session.get(VOICE_OWNER_KEY);
    const current = stored[VOICE_OWNER_KEY];
    if (typeof current === 'string' && current !== ownerId) return false;
    await chrome.storage.session.set({ [VOICE_OWNER_KEY]: ownerId });
    return true;
  } catch {
    return true;
  }
}

async function releaseVoiceOwner(ownerId: string): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
  try {
    const stored = await chrome.storage.session.get(VOICE_OWNER_KEY);
    if (stored[VOICE_OWNER_KEY] === ownerId) await chrome.storage.session.remove(VOICE_OWNER_KEY);
  } catch {
    // Session coordination is a safety guard, not a reason to break the page.
  }
}

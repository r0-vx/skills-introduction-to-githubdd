import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { HandFreeSettings, HandGesture, HandPointerPosition, HandPose, RuntimeStatus, TargetInfo, PointerPosition } from '../shared/types';
import { DEFAULT_SETTINGS, DEFAULT_STATUS } from '../shared/types';
import { Icon } from '../shared/icons';
import { extensionUrl, subscribeToRuntimeMessages } from '../shared/runtime';
import { loadSettings, saveSettings, subscribeToSettings } from '../shared/storage';
import { normalizeRuntimeStatus, formatConfidence } from '../shared/sessionState';
import { SessionManager } from '../session/sessionManager';
import { CameraOwnership } from '../dashboard/cameraOwnership';
import { TouchViewEngine, type TouchViewEngineEvent } from '../touchview/touchViewEngine';
import { FistScrollController, type FistScrollEvent } from '../tracking/fistScroll';
import { AccessibilityControls, accessibilityClassNames } from '../ui/AccessibilityControls';
import { getVoiceAssistant } from '../voice/voiceAssistant';
import type { RecognitionMode, SpeechStatus } from '../voice/speechController';
import { VoiceAssistantControl } from '../voice/VoiceAssistantControl';
import { answerPageQuery, extractPageIndex } from '../accessibility/pageExtractor';
import { drawTrackingOverlay, clearTrackingOverlay } from '../dashboard/trackingOverlay';
import { recordAnalytics } from '../analytics/analytics';
import type { TrackingCallbacks } from '../tracking/trackingController';
import { parseVoiceCommand } from '../voice/commandParser';
import {
  availableRailwayTrains,
  buildBookingReference,
  defaultRailwayForm,
  fareFor,
  findRailwayTrain,
  formatRailwayDate,
  RAILWAY_CLASSES,
  RAILWAY_FLOW,
  RAILWAY_STATIONS,
  type RailwayClass,
  type RailwayForm,
  type RailwayJourney,
  type RailwayStep,
  type RailwayTrain
} from './railwayData';
import { parseRailwayCommand, parseRailwayGuidedAnswer, railwayVoiceHelp, type RailwayGuidedField, type RailwayVoiceIntent } from './railwayVoice';

type DictationField = 'from' | 'to' | 'passengerName' | 'passengerDetails' | 'contact';
type SenseRead = 'page' | 'form' | 'results' | 'fare' | 'required' | 'confirmation';

function statusLabel(status: RuntimeStatus): string {
  if (status.engineState === 'ERROR') return 'Tracking error';
  if (status.engineState === 'PAUSED') return 'Paused';
  if (status.cameraState === 'active' && status.handTracking === 'tracking') return 'Hand tracking live';
  if (status.cameraState === 'active' && status.faceDetected) return 'Head tracking live';
  if (status.cameraState === 'active') return 'Camera ready';
  return 'Camera off';
}

function classLabel(value: RailwayClass): string {
  return RAILWAY_CLASSES.find((item) => item.value === value)?.label ?? value;
}

function stepIndex(step: RailwayStep): number {
  const index = RAILWAY_FLOW.findIndex((item) => item.step === step);
  return index < 0 ? 0 : index;
}

function promptForStep(step: RailwayStep, form: RailwayForm): string {
  switch (step) {
    case 'WELCOME': return 'Welcome to the local Railway Booking Demo. Say start booking or use the form below.';
    case 'DEPARTURE': return `Where are you departing from? Current departure is ${form.from}. Say from followed by a station name.`;
    case 'ARRIVAL': return `Where are you travelling to? Current arrival is ${form.to}. Say to followed by a station name.`;
    case 'DATE': return `What date would you like to travel? Say today, tomorrow, or a date such as 2026 slash 12 slash 24.`;
    case 'JOURNEY_TYPE': return 'Do you want a one way or return journey?';
    case 'PASSENGERS': return `How many passengers? The current count is ${form.passengers}.`;
    case 'CLASS': return `Which class would you like? Choose general, sleeper, AC chair, or first AC.`;
    case 'SEARCHING': return 'Searching the local demo timetable.';
    case 'RESULTS': return 'The train options are ready. I will read each option. Say choose option 1, option 2, or option 3, then confirm the option you want.';
    case 'TRAIN_SELECTION': return 'Choose a train to continue to passenger details.';
    case 'PASSENGER_DETAILS': return 'Enter the passenger name and contact details, then say next or review booking.';
    case 'REVIEW': return 'I will read the complete ticket review now. Say confirm booking when every detail is correct, or say go back to edit.';
    case 'APPROVAL': return 'Final approval. Say confirm booking to create the fictional local reference, or say go back to edit.';
    case 'CONFIRMED': return 'The simulated booking is confirmed. Say start over to create another demo booking.';
  }
}

function trainOptionNarration(train: RailwayTrain, form: RailwayForm, option: number): string {
  const seats = train.availability[form.className];
  const availability = seats > 0 ? `${seats} seats available` : 'waitlist only';
  return `Option ${option}: ${train.name}, train ${train.number}, departs at ${train.departure}, arrives at ${train.arrival}, duration ${train.duration}, ${classLabel(form.className)} fare rupees ${fareFor(train, form.className, form.passengers).toLocaleString()} for ${form.passengers} passenger${form.passengers === 1 ? '' : 's'}, ${availability}.`;
}

function trainResultsNarration(trains: RailwayTrain[], form: RailwayForm): string {
  const options = trains.map((train, index) => trainOptionNarration(train, form, index + 1)).join(' ');
  const optionNames = trains.map((_, index) => `option ${index + 1}`).join(', ');
  return `I found ${trains.length} demo train options from ${form.from} to ${form.to} for ${formatRailwayDate(form.date)}. ${options} Say choose ${optionNames}. After you choose, I will repeat your selection and ask you to say confirm option followed by its number.`;
}

function modeText(mode: RecognitionMode): string {
  return mode === 'dictation' ? 'Dictation' : mode === 'conversation' ? 'Guided conversation' : 'Voice commands';
}

function guidedFieldForStep(step: RailwayStep): RailwayGuidedField | null {
  if (step === 'DEPARTURE') return 'from';
  if (step === 'ARRIVAL') return 'to';
  if (step === 'DATE') return 'date';
  if (step === 'JOURNEY_TYPE') return 'journey';
  if (step === 'PASSENGERS') return 'passengers';
  if (step === 'CLASS') return 'class';
  if (step === 'PASSENGER_DETAILS') return 'passengerName';
  return null;
}

function SettingRange({ id, label, value, min, max, step, suffix, onChange }: { id: string; label: string; value: number; min: number; max: number; step: number; suffix: string; onChange: (value: number) => void }) {
  return <label className="railway-setting-range" htmlFor={id}><span><strong>{label}</strong><output>{suffix}</output></span><input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function RailwayToggle({ id, label, checked, onChange, disabled = false }: { id: string; label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className="railway-toggle" htmlFor={id}><span><strong>{label}</strong></span><input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><i aria-hidden="true" /></label>;
}

function TrainCard({ train, form, selected, onChoose }: { train: RailwayTrain; form: RailwayForm; selected: boolean; onChoose: (train: RailwayTrain) => void }) {
  const fare = fareFor(train, form.className, form.passengers);
  const seats = train.availability[form.className];
  return <article className={`railway-train-card${selected ? ' is-selected' : ''}`} data-sense="train result">
    <div className="railway-train-card__line"><span className="railway-train-code">{train.number}</span><span className={seats > 0 ? 'availability' : 'availability unavailable'}>{seats > 0 ? `${seats} seats` : 'Waitlist only'}</span></div>
    <div className="railway-train-card__main"><div><h3>{train.name}</h3><p>{train.from} to {train.to}</p></div><div className="railway-times"><strong>{train.departure}</strong><span>{train.duration}</span><strong>{train.arrival}</strong></div></div>
    <div className="railway-train-card__bottom"><span>{classLabel(form.className)} · ₹{fare.toLocaleString()} total for {form.passengers} passenger{form.passengers === 1 ? '' : 's'}</span><button type="button" className="railway-button railway-button--small" onClick={() => onChoose(train)} disabled={seats === 0}>{selected ? 'Selected' : 'Choose train'}</button></div>
  </article>;
}

export function RailwayBookingDemo() {
  const [settings, setSettings] = useState<HandFreeSettings>({ ...DEFAULT_SETTINGS });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [status, setStatus] = useState<RuntimeStatus>({ ...DEFAULT_STATUS });
  const statusRef = useRef(status);
  statusRef.current = status;
  const [form, setForm] = useState<RailwayForm>(() => defaultRailwayForm());
  const formRef = useRef(form);
  formRef.current = form;
  const [step, setStep] = useState<RailwayStep>('WELCOME');
  const stepRef = useRef(step);
  stepRef.current = step;
  const [results, setResults] = useState<RailwayTrain[]>([]);
  const resultsRef = useRef(results);
  resultsRef.current = results;
  const [selectedTrainId, setSelectedTrainId] = useState<string | null>(null);
  const selectedTrainRef = useRef(selectedTrainId);
  selectedTrainRef.current = selectedTrainId;
  const pendingTrainSelectionRef = useRef<{ id: string; option: number } | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [notice, setNotice] = useState('This is a local simulation. No real ticket, payment or railway provider is contacted.');
  const [bookingReference, setBookingReference] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [touchViewEnabled, setTouchViewEnabled] = useState(false);
  const touchViewRef = useRef(false);
  const [headEnabled, setHeadEnabled] = useState(false);
  const headRef = useRef(false);
  const [handEnabled, setHandEnabled] = useState(false);
  const handRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [blindMode, setBlindMode] = useState(false);
  const blindRef = useRef(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [cameraMessage, setCameraMessage] = useState('Camera is off. Start it when you want physical pointer control.');
  const [pointerLabel, setPointerLabel] = useState('No pointer update yet');
  const [targetLabel, setTargetLabel] = useState('No target under the pointer');
  const [gestureLabel, setGestureLabel] = useState('Released');
  const [activationMessage, setActivationMessage] = useState('Move the pointer over a real control.');
  const [voiceStatus, setVoiceStatus] = useState<SpeechStatus>('idle');
  const [voiceMessage, setVoiceMessage] = useState('Voice commands are optional. The form remains fully keyboard accessible.');
  const [lastTranscript, setLastTranscript] = useState('');
  const [dictationField, setDictationField] = useState<DictationField>('passengerName');
  const dictationFieldRef = useRef(dictationField);
  dictationFieldRef.current = dictationField;
  const [voiceMode, setVoiceMode] = useState<RecognitionMode>('command');
  const [senseOutput, setSenseOutput] = useState('Choose a Sense action to read the visible booking page.');
  const [senseStatus, setSenseStatus] = useState<'ready' | 'reading'>('ready');
  const [scrollActive, setScrollActive] = useState(false);
  const [showAdvancedStatus, setShowAdvancedStatus] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const trackerRef = useRef<SessionManager | null>(null);
  const ownershipRef = useRef(new CameraOwnership());
  const touchEngineRef = useRef<TouchViewEngine | null>(null);
  const speechRef = useRef(getVoiceAssistant().controller);
  const fistScrollRef = useRef(new FistScrollController());
  const searchTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const voiceIntentRef = useRef<(text: string, mode: RecognitionMode) => void>(() => undefined);
  const guidedFieldRef = useRef<RailwayGuidedField | null>(null);
  const lastPointerUiAtRef = useRef(0);
  const lastTargetRef = useRef<TargetInfo | null>(null);

  const activeTrain = findRailwayTrain(selectedTrainId);
  const currentClass = RAILWAY_CLASSES.find((item) => item.value === form.className);

  const persistSettings = useCallback(async (patch: Partial<HandFreeSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    await saveSettings(next);
  }, []);

  const updateForm = useCallback((patch: Partial<RailwayForm>) => {
    const next = { ...formRef.current, ...patch };
    formRef.current = next;
    setForm(next);
  }, []);

  const announce = useCallback((text: string, speak = false) => {
    setVoiceMessage(text);
    setNotice(text);
    if (speak) speechRef.current?.speak(text, settingsRef.current.speechRate, settingsRef.current.speechVolume);
  }, []);

  const setFlowStep = useCallback((next: RailwayStep, speak = false) => {
    stepRef.current = next;
    setStep(next);
    const prompt = promptForStep(next, formRef.current);
    announce(prompt, speak);
  }, [announce]);

  const narrateTicketReview = useCallback(() => {
    const current = formRef.current;
    const selected = resultsRef.current.find((train) => train.id === selectedTrainRef.current) ?? findRailwayTrain(selectedTrainRef.current);
    const journey = current.journey === 'return'
      ? `a return journey with a return date of ${formatRailwayDate(current.returnDate)}`
      : 'a one-way journey';
    const train = selected
      ? `${selected.name}, train ${selected.number}, departing at ${selected.departure}, arriving at ${selected.arrival}, with a journey time of ${selected.duration}`
      : 'no train selected';
    const fare = selected
      ? `The total fare is rupees ${fareFor(selected, current.className, current.passengers).toLocaleString()}.`
      : 'The total fare is not available until a train is selected.';
    const note = current.passengerDetails.trim()
      ? `Accessibility or seating note: ${current.passengerDetails.trim()}.`
      : 'No accessibility or seating note was provided.';
    const narration = [
      'Complete ticket review.',
      `Route: ${current.from} to ${current.to}.`,
      `Travel date: ${formatRailwayDate(current.date)}.`,
      `Journey: ${journey}.`,
      `Train: ${train}.`,
      `Passengers: ${current.passengers}.`,
      `Class: ${classLabel(current.className)}.`,
      `Passenger name: ${current.passengerName.trim()}.`,
      `Contact number: ${current.contact.trim()}.`,
      note,
      fare,
      'This is a local simulation only. No real ticket will be booked and no payment will be taken.',
      'When you are ready, say confirm booking to continue to final confirmation, or say go back to edit.'
    ].join(' ');
    setVoiceMessage(narration);
    setNotice('Ticket review read aloud. Say “confirm booking” when every detail is correct.');
    speechRef.current?.speak(narration, settingsRef.current.speechRate, settingsRef.current.speechVolume);
  }, []);

  const updatePointer = useCallback((position: PointerPosition | HandPointerPosition, gesture: HandGesture = 'release') => {
    if ((!touchViewRef.current && !headRef.current && !handRef.current) || blindRef.current || pausedRef.current) return;
    touchEngineRef.current?.update(position, gesture, position.confidence);
    const now = performance.now();
    if (now - lastPointerUiAtRef.current > 90) {
      lastPointerUiAtRef.current = now;
      setPointerLabel(`${position.source === 'head-tracking' ? 'Head' : 'Hand'} pointer · ${Math.round(position.x * 100)}%, ${Math.round(position.y * 100)}% · ${formatConfidence(position.confidence)}`);
    }
  }, []);

  const handleTouchEvent = useCallback((event: TouchViewEngineEvent) => {
    if (event.type === 'target-hovered') {
      setActivationMessage('Target locked. Pinch or hold still to activate.');
      void recordAnalytics({ type: 'target-highlighted', timestamp: Date.now(), mode: 'touchview', outcome: 'success', targetName: event.target?.accessibleName });
    } else if (event.type === 'pinch-started' || event.type === 'hold-started') {
      setActivationMessage(`${event.method === 'pinch' ? 'Pinch' : 'Stable hold'} detected. Keep it steady…`);
    } else if (event.type === 'hold-cancelled' || event.type === 'hand-lost') {
      setActivationMessage(event.type === 'hand-lost' ? 'Tracking lost. Activation cancelled safely.' : 'Activation cancelled. Return to the target and try again.');
    } else if (event.type === 'activated') {
      setActivationMessage(`Activated ${event.target?.accessibleName || 'the selected control'} with ${event.method === 'pinch' ? 'pinch' : 'stable hold'}.`);
      void recordAnalytics({ type: 'dwell-completed', timestamp: Date.now(), mode: 'touchview', outcome: 'success', targetName: event.target?.accessibleName, duration: event.duration });
    }
  }, []);

  const handleTarget = useCallback((target: TargetInfo | null) => {
    lastTargetRef.current = target;
    setTargetLabel(target ? `${target.accessibleName || 'Unnamed control'} · ${target.tagName.toUpperCase()}` : 'No target under the pointer');
  }, []);

  const processScroll = useCallback((position: HandPointerPosition, pose: HandPose) => {
    const events = fistScrollRef.current.update({ x: position.x, y: position.y, pose, confidence: position.confidence, now: performance.now() }, {
      enabled: settingsRef.current.fistScrollEnabled && touchViewRef.current && handRef.current && !pausedRef.current,
      sensitivity: settingsRef.current.scrollSensitivity,
      confirmationDuration: settingsRef.current.fistConfirmationDuration,
      deadZone: settingsRef.current.scrollDeadZone,
      maxScrollSpeed: settingsRef.current.maxScrollSpeed,
      invertDirection: settingsRef.current.invertScroll,
      cooldownDuration: settingsRef.current.scrollCooldownDuration
    });
    for (const event of events) {
      if (event.type === 'start') {
        setScrollActive(true);
        touchEngineRef.current?.setPaused(true);
        setActivationMessage('Fist scroll active. Move up or down. Open your hand to stop.');
      } else if (event.type === 'update') {
        setScrollActive(true);
        window.scrollBy({ top: event.deltaY, left: 0, behavior: 'auto' });
      } else {
        setScrollActive(false);
        touchEngineRef.current?.setPaused(false);
        setActivationMessage(event.reason === 'tracking-lost' ? 'Tracking lost. Scrolling stopped safely.' : 'Scroll stopped. Move over a control when ready.');
      }
    }
    return fistScrollRef.current.state === 'FIST_CONFIRMED' || fistScrollRef.current.state === 'SCROLLING' || events.some((event) => event.type === 'start' || event.type === 'update');
  }, []);

  const callbacks = useMemo<TrackingCallbacks>(() => ({
    onStatus: (partial) => {
      if (!mountedRef.current) return;
      setStatus((current) => normalizeRuntimeStatus(current, partial));
      if (partial.handTracking === 'lost' || partial.trackingPhase === 'lost' || partial.cameraState === 'paused' || partial.cameraState === 'stopped') {
        touchEngineRef.current?.handLost();
        setGestureLabel('Tracking lost');
        if (fistScrollRef.current.state !== 'IDLE') fistScrollRef.current.reset();
        setScrollActive(false);
        touchEngineRef.current?.setPaused(Boolean(partial.cameraState === 'paused' || pausedRef.current));
      }
      if (partial.permission === 'denied') setCameraMessage('Camera permission was denied. Allow access for HandFree, then retry.');
      if (partial.permission === 'active') setCameraMessage('Camera active. Move a finger or face reference into the camera view.');
      if (partial.error) setCameraMessage(partial.error);
    },
    onPointer: (position) => {
      if (headRef.current && !handRef.current && !scrollActive) updatePointer(position, 'release');
    },
    onPosition: () => undefined,
    onCoordinate: () => undefined,
    onHand: (position, gesture, hand) => {
      if (!handRef.current && !touchViewRef.current) return;
      setGestureLabel(gesture === 'pinch' ? 'Pinch' : hand.pose === 'fist' ? 'Fist' : hand.pose === 'open-palm' ? 'Open palm' : hand.pose === 'pointing' ? 'Pointing' : 'Released');
      const consumed = processScroll(position, hand.pose);
      if (!consumed) updatePointer(position, gesture);
    },
    onLandmarks: (frame) => {
      drawTrackingOverlay(canvasRef.current, { ...frame, faceOpacity: settingsRef.current.touchViewFaceOpacity, handOpacity: settingsRef.current.touchViewHandOpacity, mirrored: settingsRef.current.touchViewMirrorCamera });
    }
  }), [processScroll, updatePointer]);

  useEffect(() => {
    const engine = new TouchViewEngine({
      holdDuration: settingsRef.current.touchViewHoldDuration,
      cooldownDuration: settingsRef.current.cooldownDuration,
      stableHoldEnabled: settingsRef.current.touchViewStableHoldEnabled,
      cursorSize: settingsRef.current.touchViewCursorSize,
      cursorColor: settingsRef.current.touchViewCursorColor,
      feedbackEnabled: settingsRef.current.touchViewFeedbackEnabled,
      onEvent: handleTouchEvent,
      onTarget: handleTarget
    });
    touchEngineRef.current = engine;
    engine.setActive(false);
    return () => { engine.destroy(); touchEngineRef.current = null; };
  }, [handleTarget, handleTouchEvent]);

  useEffect(() => {
    const engine = touchEngineRef.current;
    if (!engine) return;
    engine.setOptions({
      holdDuration: settings.touchViewHoldDuration,
      cooldownDuration: settings.cooldownDuration,
      stableHoldEnabled: settings.touchViewStableHoldEnabled,
      cursorSize: settings.touchViewCursorSize,
      cursorColor: settings.touchViewCursorColor,
      feedbackEnabled: settings.touchViewFeedbackEnabled,
      onEvent: handleTouchEvent,
      onTarget: handleTarget
    });
    engine.setActive((touchViewEnabled || headEnabled || handEnabled) && !blindMode);
    engine.setPaused(paused || scrollActive);
    document.documentElement.style.setProperty('--railway-cursor-opacity', String(settings.touchViewCursorOpacity));
    document.documentElement.style.setProperty('--railway-target-opacity', String(settings.touchViewHighlightOpacity));
  }, [settings, touchViewEnabled, headEnabled, handEnabled, blindMode, paused, scrollActive, handleTarget, handleTouchEvent]);

  useEffect(() => {
    const tracker = new SessionManager(callbacks);
    trackerRef.current = tracker;
    return () => {
      mountedRef.current = false;
      if (videoRef.current && tracker.camera.currentStream) tracker.stop(videoRef.current);
      tracker.clearConsumers();
      ownershipRef.current.release();
      touchEngineRef.current?.handLost();
      clearTrackingOverlay(canvasRef.current);
    };
  }, [callbacks]);

  useEffect(() => {
    let active = true;
    const unsubscribeSettings = subscribeToSettings((saved) => {
      if (!active || !mountedRef.current) return;
      settingsRef.current = saved;
      setSettings(saved);
    });
    void loadSettings().then((saved) => {
      if (!active) return;
      settingsRef.current = saved;
      setSettings(saved);
      setTouchViewEnabled(false);
      touchViewRef.current = false;
      setHeadEnabled(false);
      headRef.current = false;
      setHandEnabled(false);
      handRef.current = false;
    });
    return () => { active = false; unsubscribeSettings(); };
  }, []);

  const stopCamera = useCallback(async (disableModes = false) => {
    const tracker = trackerRef.current;
    if (tracker && videoRef.current && (tracker.camera.currentStream || statusRef.current.engineState !== 'STOPPED')) tracker.stop(videoRef.current);
    tracker?.clearConsumers();
    ownershipRef.current.release();
    fistScrollRef.current.reset();
    touchEngineRef.current?.handLost();
    setScrollActive(false);
    clearTrackingOverlay(canvasRef.current);
    setCameraMessage('Camera is off. Start it when you want physical pointer control.');
    if (disableModes) {
      touchViewRef.current = false;
      handRef.current = false;
      headRef.current = false;
      setTouchViewEnabled(false);
      setHandEnabled(false);
      setHeadEnabled(false);
      await persistSettings({ enabled: false, touchViewEnabled: false, touchViewPaused: false, enabledModes: [] });
    }
  }, [persistSettings]);

  const startCamera = useCallback(async () => {
    if (cameraBusy || trackerRef.current?.camera.currentStream || blindRef.current) return;
    const tracker = trackerRef.current;
    const video = videoRef.current;
    if (!tracker || !video) return;
    setCameraBusy(true);
    setCameraMessage('Requesting camera access and loading the existing MediaPipe models…');
    const claim = await ownershipRef.current.claim(navigator.locks);
    if (claim !== 'owned') {
      setCameraBusy(false);
      setCameraMessage(claim === 'busy' ? 'The shared camera is already owned by another HandFree page. Stop it there, then retry.' : 'Camera ownership is unavailable in this browser. Use the main dashboard camera.');
      setStatus((current) => normalizeRuntimeStatus(current, { engineState: 'ERROR', cameraState: 'error', trackingState: 'error', permission: 'unavailable', error: 'CAMERA_ALREADY_IN_USE' }));
      return;
    }
    const enabledModes = Array.from(new Set([
      ...(touchViewRef.current || handRef.current ? ['hand' as const] : []),
      ...(headRef.current ? ['head' as const] : []),
      ...(touchViewRef.current ? ['touchview' as const] : [])
    ]));
    if (!enabledModes.length) enabledModes.push('hand');
    const next = { ...settingsRef.current, enabled: true, paused: false, touchViewPaused: false, touchViewEnabled: touchViewRef.current, enabledModes };
    settingsRef.current = next;
    setSettings(next);
    tracker.clearConsumers();
    if (touchViewRef.current) tracker.acquire('touchview');
    if (handRef.current || touchViewRef.current) tracker.acquire('hand');
    if (headRef.current) tracker.acquire('head');
    try {
      await tracker.start(video, next);
      if (!mountedRef.current) return;
      await saveSettings(next);
      setCameraMessage('Camera active. Move your pointer over the visible controls.');
      void recordAnalytics({ type: 'mode-enabled', timestamp: Date.now(), mode: touchViewRef.current ? 'touchview' : headRef.current ? 'head' : 'hand', outcome: 'success' });
    } catch (error) {
      tracker.clearConsumers();
      if (tracker.camera.currentStream) tracker.stop(video);
      ownershipRef.current.release();
      setCameraMessage(`Camera could not start. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCameraBusy(false);
    }
  }, [cameraBusy]);

  const applyTrackingModes = useCallback(async (nextTouch: boolean, nextHead: boolean, nextHand: boolean) => {
    touchViewRef.current = nextTouch;
    headRef.current = nextHead;
    handRef.current = nextHand;
    setTouchViewEnabled(nextTouch);
    setHeadEnabled(nextHead);
    setHandEnabled(nextHand);
    const modes = Array.from(new Set([
      ...(nextTouch || nextHand ? ['hand' as const] : []),
      ...(nextHead ? ['head' as const] : []),
      ...(nextTouch ? ['touchview' as const] : [])
    ]));
    const next = { ...settingsRef.current, enabled: Boolean(modes.length), touchViewEnabled: nextTouch, enabledModes: modes };
    settingsRef.current = next;
    setSettings(next);
    await saveSettings(next);
    const tracker = trackerRef.current;
    if (!tracker?.camera.currentStream || blindRef.current) return;
    tracker.clearConsumers();
    if (nextTouch) tracker.acquire('touchview');
    if (nextTouch || nextHand) tracker.acquire('hand');
    if (nextHead) tracker.acquire('head');
    try {
      await tracker.restart(videoRef.current as HTMLVideoElement, next);
      setCameraMessage('Tracking mode changed. The shared camera loop restarted once with the selected models.');
    } catch (error) {
      setCameraMessage(`Tracking mode could not be changed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const toggleTouchView = useCallback(() => {
    const next = !touchViewRef.current;
    void applyTrackingModes(next, next ? headRef.current : headRef.current, next || handRef.current);
    if (next && !trackerRef.current?.camera.currentStream) void startCamera();
    if (!next) announce('TouchView is off. The page remains usable with keyboard and mouse.', false);
    else announce('TouchView is on. Move the hand pointer over a real button, link or form field.', false);
  }, [announce, applyTrackingModes, startCamera]);

  const toggleHead = useCallback(() => {
    const next = !headRef.current;
    void applyTrackingModes(touchViewRef.current, next, handRef.current || touchViewRef.current);
    if (next && !trackerRef.current?.camera.currentStream) void startCamera();
  }, [applyTrackingModes, startCamera]);

  const toggleHand = useCallback(() => {
    const next = !handRef.current;
    void applyTrackingModes(touchViewRef.current, headRef.current, next || touchViewRef.current);
    if (next && !trackerRef.current?.camera.currentStream) void startCamera();
  }, [applyTrackingModes, startCamera]);

  const togglePause = useCallback(async () => {
    const tracker = trackerRef.current;
    if (!tracker?.camera.currentStream || !videoRef.current) {
      announce('Start the camera before pausing physical interaction.', false);
      return;
    }
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    touchEngineRef.current?.setPaused(next);
    if (next) {
      tracker.pause(videoRef.current);
      fistScrollRef.current.reset();
      setScrollActive(false);
      announce('Tracking paused. Resume when you are ready.', false);
    } else {
      tracker.resume(videoRef.current);
      announce('Tracking resumed. The pointer will move after a stable sample.', false);
    }
    await persistSettings({ paused: next, touchViewPaused: next });
  }, [announce, persistSettings]);

  const startSearch = useCallback(() => {
    const current = formRef.current;
    if (!current.from || !current.to || current.from === current.to) {
      setErrorMessage('Choose two different stations before searching.');
      return;
    }
    if (!current.date) {
      setErrorMessage('Choose a departure date before searching.');
      return;
    }
    if (current.journey === 'return' && !current.returnDate) {
      setErrorMessage('Choose a return date for a return journey.');
      return;
    }
    setErrorMessage('');
    setSelectedTrainId(null);
    selectedTrainRef.current = null;
    pendingTrainSelectionRef.current = null;
    setStep('SEARCHING');
    stepRef.current = 'SEARCHING';
    setNotice(`Searching local demo trains from ${current.from} to ${current.to}…`);
    if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      const found = availableRailwayTrains(current);
      resultsRef.current = found;
      setResults(found);
      stepRef.current = 'RESULTS';
      setStep('RESULTS');
      const narration = trainResultsNarration(found, current);
      setNotice(`${found.length} train options are ready. Say choose option 1, 2, or 3.`);
      setVoiceMessage(narration);
      speechRef.current?.speak(narration, settingsRef.current.speechRate, settingsRef.current.speechVolume);
      void recordAnalytics({ type: 'task-started', timestamp: Date.now(), mode: 'voice', outcome: 'success', metadata: { resultCount: found.length } });
    }, 420);
  }, []);

  const chooseTrain = useCallback((train: RailwayTrain) => {
    pendingTrainSelectionRef.current = null;
    setSelectedTrainId(train.id);
    selectedTrainRef.current = train.id;
    guidedFieldRef.current = 'passengerName';
    setFlowStep('PASSENGER_DETAILS', blindRef.current);
    setNotice(`${train.name} selected. Complete the passenger details.`);
  }, [setFlowStep]);

  const requestTrainSelection = useCallback((index: number) => {
    const list = resultsRef.current;
    if (!list.length) {
      announce('There are no train options yet. Say search trains first.', true);
      return;
    }
    const safeIndex = Math.max(0, Math.min(list.length - 1, index));
    const train = list[safeIndex];
    const option = safeIndex + 1;
    setSelectedTrainId(train.id);
    selectedTrainRef.current = train.id;
    pendingTrainSelectionRef.current = { id: train.id, option };
    const message = `${trainOptionNarration(train, formRef.current, option)} You selected option ${option}. Say confirm option ${option} to continue, or choose another option.`;
    setNotice(`Option ${option} selected. Say confirm option ${option} to continue.`);
    setVoiceMessage(message);
    speechRef.current?.speak(message, settingsRef.current.speechRate, settingsRef.current.speechVolume);
  }, [announce]);

  const confirmTrainOption = useCallback((option: number) => {
    if (stepRef.current !== 'RESULTS' && stepRef.current !== 'TRAIN_SELECTION') {
      announce('Train options are not active right now. Search for trains first.', true);
      return;
    }
    const pending = pendingTrainSelectionRef.current;
    if (!pending) {
      announce('Choose option 1, option 2, or option 3 first. I will then ask you to confirm it.', true);
      return;
    }
    if (pending.option !== option) {
      announce(`Option ${pending.option} is selected. Say confirm option ${pending.option}, or choose another option.`, true);
      return;
    }
    const train = resultsRef.current.find((candidate) => candidate.id === pending.id);
    if (!train) {
      pendingTrainSelectionRef.current = null;
      announce('That train option is no longer available. Please search again.', true);
      return;
    }
    pendingTrainSelectionRef.current = null;
    chooseTrain(train);
    announce(`Option ${option} confirmed. ${train.name} selected. Enter the passenger name and contact details, then say review booking.`, true);
  }, [announce, chooseTrain]);

  const submitPassenger = useCallback((event?: FormEvent) => {
    event?.preventDefault();
    const current = formRef.current;
    if (!current.passengerName.trim()) {
      setErrorMessage('Passenger name is required before review.');
      return;
    }
    if (!current.contact.trim()) {
      setErrorMessage('A local demo contact value is required before review.');
      return;
    }
    setErrorMessage('');
    setFlowStep('REVIEW', false);
    narrateTicketReview();
  }, [narrateTicketReview, setFlowStep]);

  const goBack = useCallback(() => {
    const current = stepRef.current;
    const previous: Partial<Record<RailwayStep, RailwayStep>> = { ARRIVAL: 'DEPARTURE', DATE: 'ARRIVAL', JOURNEY_TYPE: 'DATE', PASSENGERS: 'JOURNEY_TYPE', CLASS: 'PASSENGERS', RESULTS: 'CLASS', TRAIN_SELECTION: 'RESULTS', PASSENGER_DETAILS: 'RESULTS', REVIEW: 'PASSENGER_DETAILS', APPROVAL: 'REVIEW', CONFIRMED: 'APPROVAL' };
    const next = previous[current] ?? 'WELCOME';
    setErrorMessage('');
    setFlowStep(next, blindRef.current);
  }, [setFlowStep]);

  const goNext = useCallback(() => {
    const current = stepRef.current;
    if (current === 'WELCOME') return setFlowStep('DEPARTURE', blindRef.current);
    if (current === 'DEPARTURE') return setFlowStep('ARRIVAL', blindRef.current);
    if (current === 'ARRIVAL') return setFlowStep('DATE', blindRef.current);
    if (current === 'DATE') return setFlowStep('JOURNEY_TYPE', blindRef.current);
    if (current === 'JOURNEY_TYPE') return setFlowStep('PASSENGERS', blindRef.current);
    if (current === 'PASSENGERS') return setFlowStep('CLASS', blindRef.current);
    if (current === 'CLASS') return startSearch();
    if (current === 'RESULTS' && resultsRef.current[0]) return chooseTrain(resultsRef.current[0]);
    if (current === 'PASSENGER_DETAILS') return submitPassenger();
    if (current === 'REVIEW') return setFlowStep('APPROVAL', blindRef.current);
    if (current === 'APPROVAL') return confirmBooking();
  }, [chooseTrain, setFlowStep, startSearch, submitPassenger]);

  const confirmBooking = useCallback(() => {
    if (stepRef.current !== 'APPROVAL' && stepRef.current !== 'REVIEW') {
      announce('Review the booking before confirming it.', blindRef.current);
      return;
    }
    if (stepRef.current === 'REVIEW') {
      setFlowStep('APPROVAL', blindRef.current);
      return;
    }
    const reference = buildBookingReference();
    setBookingReference(reference);
    setFlowStep('CONFIRMED', false);
    const message = `Demo booking confirmed. Your local reference is ${reference}.`;
    setNotice(message);
    setVoiceMessage(message);
    speechRef.current?.speak(message, settingsRef.current.speechRate, settingsRef.current.speechVolume);
    void recordAnalytics({ type: 'submission-confirmed', timestamp: Date.now(), mode: blindRef.current ? 'voice' : 'touchview', outcome: 'success', metadata: { reference } });
    void recordAnalytics({ type: 'task-completed', timestamp: Date.now(), mode: blindRef.current ? 'voice' : 'touchview', outcome: 'success' });
  }, [announce, setFlowStep]);

  const clearBooking = useCallback(() => {
    const fresh = defaultRailwayForm();
    formRef.current = fresh;
    setForm(fresh);
    setResults([]);
    resultsRef.current = [];
    setSelectedTrainId(null);
    selectedTrainRef.current = null;
    pendingTrainSelectionRef.current = null;
    setBookingReference('');
    setErrorMessage('');
    setFlowStep('WELCOME', blindRef.current);
    announce('The local booking form has been cleared.', blindRef.current);
  }, [announce, setFlowStep]);

  const moveResultSelection = useCallback((direction: 1 | -1) => {
    const list = resultsRef.current;
    if (!list.length) return;
    const currentIndex = Math.max(0, list.findIndex((item) => item.id === selectedTrainRef.current));
    const nextIndex = (currentIndex + direction + list.length) % list.length;
    requestTrainSelection(nextIndex);
  }, [requestTrainSelection]);

  const readSense = useCallback((kind: SenseRead) => {
    const root = contentRef.current;
    if (!root) return;
    const nodes = extractPageIndex(root);
    const query = kind === 'results' ? 'train availability fare' : kind === 'form' ? 'booking form field' : kind === 'fare' ? 'fare price' : kind === 'required' ? 'required passenger contact' : kind === 'confirmation' ? 'confirmation reference' : 'railway booking page';
    const extracted = answerPageQuery(nodes, query);
    const selected = findRailwayTrain(selectedTrainRef.current);
    const extra = kind === 'fare' && selected ? `${selected.name} costs ₹${fareFor(selected, formRef.current.className, formRef.current.passengers).toLocaleString()} for ${formRef.current.passengers} passenger${formRef.current.passengers === 1 ? '' : 's'}.` : '';
    const message = [extracted, extra].filter(Boolean).join(' ');
    setSenseOutput(message || 'No visible information matched that Sense request.');
    setSenseStatus('reading');
    speechRef.current?.speak(message || 'No visible information matched that request.', settingsRef.current.speechRate, settingsRef.current.speechVolume);
    window.setTimeout(() => setSenseStatus('ready'), 500);
  }, []);

  const startDictation = useCallback((field: DictationField) => {
    dictationFieldRef.current = field;
    setDictationField(field);
    getVoiceAssistant().setMode('dictation');
    setVoiceMessage(`Dictation started for ${field === 'passengerName' ? 'passenger name' : field === 'passengerDetails' ? 'passenger details' : field}. Say stop dictation when finished.`);
  }, []);

  const startGuidedConversation = useCallback(() => {
    const currentStep = stepRef.current;
    if (currentStep === 'WELCOME' || currentStep === 'CONFIRMED') {
      guidedFieldRef.current = 'from';
      setFlowStep('DEPARTURE', true);
      return;
    }
    guidedFieldRef.current = guidedFieldForStep(currentStep);
    if (guidedFieldRef.current) {
      announce(`Guided booking is ready. ${promptForStep(currentStep, formRef.current)}`, true);
    } else {
      announce('Guided booking is ready. Use the current page controls or say review booking.', true);
    }
  }, [announce, setFlowStep]);

  const handleGuidedConversation = useCallback((text: string) => {
    const field = guidedFieldRef.current ?? guidedFieldForStep(stepRef.current);
    if (!field) {
      const command = parseRailwayCommand(text);
      if (command) {
        voiceIntentRef.current(text, 'command');
        return true;
      }
      if (parseVoiceCommand(text)) return false;
      announce('I am not waiting for an answer right now. Say start over or review booking.', true);
      return true;
    }
    const answer = parseRailwayGuidedAnswer(text, field);
    if (!answer) {
      const command = parseRailwayCommand(text);
      if (command) {
        voiceIntentRef.current(text, 'command');
        return true;
      }
      // Let global controls such as pause, resume and stop listening reach the
      // shared assistant instead of being treated as a bad field value.
      if (parseVoiceCommand(text)) return false;
      const prompt = field === 'from' || field === 'to'
        ? 'Please say a station, for example Pune Junction.'
        : field === 'date'
          ? 'Please say today, tomorrow, or a date such as 18 November 2026.'
          : field === 'passengers'
            ? 'Please say how many passengers, such as two passengers.'
            : field === 'class'
              ? 'Please say general, sleeper, AC chair, or first AC.'
              : field === 'contact'
                ? 'Please say a contact number.'
                : field === 'passengerName'
                  ? 'Please say the passenger name.'
                  : 'Say an accessibility note, or say none to skip it.';
      void recordAnalytics({ type: 'clarification-requested', timestamp: Date.now(), mode: 'voice', outcome: 'ambiguous', metadata: { field } });
      announce(`I heard “${text}”. ${prompt}`, true);
      return true;
    }

    void recordAnalytics({ type: 'voice-command-executed', timestamp: Date.now(), mode: 'voice', outcome: 'success', metadata: { command: `guided-${answer.field}` } });
    if (answer.field === 'from') {
      updateForm({ from: answer.value });
      guidedFieldRef.current = 'to';
      setFlowStep('ARRIVAL', true);
    } else if (answer.field === 'to') {
      updateForm({ to: answer.value });
      guidedFieldRef.current = 'date';
      setFlowStep('DATE', true);
    } else if (answer.field === 'date') {
      updateForm({ date: answer.value });
      guidedFieldRef.current = 'journey';
      setFlowStep('JOURNEY_TYPE', true);
    } else if (answer.field === 'journey') {
      updateForm({ journey: answer.value });
      guidedFieldRef.current = 'passengers';
      setFlowStep('PASSENGERS', true);
    } else if (answer.field === 'passengers') {
      updateForm({ passengers: answer.value });
      guidedFieldRef.current = 'class';
      setFlowStep('CLASS', true);
    } else if (answer.field === 'class') {
      updateForm({ className: answer.value });
      guidedFieldRef.current = null;
      startSearch();
    } else if (answer.field === 'passengerName') {
      updateForm({ passengerName: answer.value });
      guidedFieldRef.current = 'contact';
      announce('Thanks. What contact number should I use for this local demo?', true);
    } else if (answer.field === 'contact') {
      updateForm({ contact: answer.value });
      guidedFieldRef.current = 'passengerDetails';
      announce('Any accessibility or seating note? Say none to skip this optional field.', true);
    } else {
      updateForm({ passengerDetails: answer.value });
      guidedFieldRef.current = null;
      announce('Passenger details captured. Say review booking when you are ready.', true);
    }
  }, [announce, setFlowStep, startSearch, updateForm]);

  const applyVoiceIntent = useCallback((intent: RailwayVoiceIntent) => {
    switch (intent.type) {
      case 'open': setFlowStep('DEPARTURE', true); return;
      case 'set-from': updateForm({ from: intent.value }); setFlowStep('ARRIVAL', blindRef.current); return;
      case 'set-to': updateForm({ to: intent.value }); setFlowStep('DATE', blindRef.current); return;
      case 'request-date': announce('Tell me today, tomorrow, or the date in year month day format.', true); return;
      case 'set-date': updateForm({ date: intent.value }); setFlowStep('JOURNEY_TYPE', blindRef.current); return;
      case 'set-journey': updateForm({ journey: intent.value }); setFlowStep('PASSENGERS', blindRef.current); return;
      case 'set-passengers': updateForm({ passengers: intent.value }); setFlowStep('CLASS', blindRef.current); return;
      case 'set-class': updateForm({ className: intent.value }); startSearch(); return;
      case 'search': startSearch(); return;
      case 'choose': {
        const list = resultsRef.current;
        if (!list.length) { announce('There are no train results yet. Say search trains first.', true); return; }
        let index = intent.value === 'first' ? 0 : typeof intent.value === 'number' ? intent.value - 1 : intent.value === 'cheapest' ? list.reduce((best, train, candidate) => fareFor(train, formRef.current.className, formRef.current.passengers) < fareFor(list[best], formRef.current.className, formRef.current.passengers) ? candidate : best, 0) : list.reduce((best, train, candidate) => train.duration < list[best].duration ? candidate : best, 0);
        index = Math.max(0, Math.min(list.length - 1, index));
        requestTrainSelection(index);
        return;
      }
      case 'confirm-option': confirmTrainOption(intent.value); return;
      case 'next-option': moveResultSelection(1); return;
      case 'previous-option': moveResultSelection(-1); return;
      case 'next': goNext(); return;
      case 'back': goBack(); return;
      case 'review': submitPassenger(); return;
      case 'confirm': confirmBooking(); return;
      case 'cancel': clearBooking(); return;
      case 'clear': clearBooking(); return;
      case 'read': readSense(intent.value); return;
      case 'stop-reading': speechRef.current?.stopSpeaking(); setSenseStatus('ready'); setSenseOutput('Sense stopped reading. The visible results remain available.'); return;
      case 'help': announce(railwayVoiceHelp(), true); return;
      case 'repeat': speechRef.current?.repeat(settingsRef.current.speechRate, settingsRef.current.speechVolume); return;
      case 'start-over': clearBooking(); return;
      case 'pause': void togglePause(); return;
      case 'resume': if (pausedRef.current) void togglePause(); return;
      case 'close-settings': setSettingsOpen(false); return;
      case 'exit-blind-mode': setBlindMode(false); blindRef.current = false; getVoiceAssistant().disable(); announce('Blind Mode is off. Visual controls are available again.', false); return;
    }
  }, [announce, chooseTrain, clearBooking, confirmBooking, confirmTrainOption, goBack, goNext, moveResultSelection, readSense, requestTrainSelection, setFlowStep, startSearch, submitPassenger, togglePause, updateForm]);

  voiceIntentRef.current = (text, mode) => {
    setLastTranscript(text);
    void recordAnalytics({ type: 'voice-command-received', timestamp: Date.now(), mode: mode === 'dictation' ? 'dictation' : 'voice', metadata: { length: text.length } });
    if (mode === 'dictation') {
      const field = dictationFieldRef.current;
      updateForm({ [field]: text } as Partial<RailwayForm>);
      setVoiceMessage(`Dictation captured for ${field === 'passengerName' ? 'passenger name' : field}.`);
      return;
    }
    const intent = parseRailwayCommand(text);
    if (!intent) {
      setVoiceMessage(`I did not understand “${text}”. Say help for railway commands.`);
      return;
    }
    void recordAnalytics({ type: 'voice-command-executed', timestamp: Date.now(), mode: 'voice', outcome: 'success', metadata: { command: intent.type } });
    applyVoiceIntent(intent);
  };

  useEffect(() => {
    const assistant = getVoiceAssistant();
    speechRef.current = assistant.controller;
    const stopAssistantUpdates = assistant.subscribe((snapshot) => {
      setVoiceStatus(snapshot.status);
      setVoiceMode(snapshot.mode);
      if (snapshot.lastTranscript) setLastTranscript(snapshot.lastTranscript);
      if (snapshot.message) setVoiceMessage(snapshot.message);
    });
    const stopRuntimeMessages = subscribeToRuntimeMessages((message) => {
      if (document.visibilityState === 'visible' && message.type === 'VOICE_COMMAND') {
        const intent = parseRailwayCommand(message.transcript);
        if (intent) voiceIntentRef.current(message.transcript, 'command');
      }
      if (document.visibilityState === 'visible' && message.type === 'DICTATION_TEXT' && message.isFinal) voiceIntentRef.current(message.text, 'dictation');
    });
    return () => { stopAssistantUpdates(); stopRuntimeMessages(); };
  }, []);

  useEffect(() => () => {
    mountedRef.current = false;
    if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current);
  }, []);

  const toggleBlindMode = useCallback(() => {
    const next = !blindRef.current;
    blindRef.current = next;
    setBlindMode(next);
    if (next) {
      pausedRef.current = false;
      setPaused(false);
      touchViewRef.current = false;
      handRef.current = false;
      headRef.current = false;
      setTouchViewEnabled(false);
      setHandEnabled(false);
      setHeadEnabled(false);
      touchEngineRef.current?.setActive(false);
      void stopCamera(false);
      setFlowStep('DEPARTURE', false);
      const message = 'Blind Mode is on. Voice guidance is active. Tell me your departure station.';
      setVoiceMessage(message);
      getVoiceAssistant().speak(message);
      getVoiceAssistant().enable('command');
    } else {
      getVoiceAssistant().disable();
      announce('Blind Mode is off. Visual controls are available again.', false);
    }
  }, [announce, setFlowStep, stopCamera]);

  const onFormChange = (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = event.target;
    if (name === 'passengers') updateForm({ passengers: Math.max(1, Math.min(9, Number(value) || 1)) });
    else if (name === 'journey') updateForm({ journey: value as RailwayJourney });
    else if (name === 'className') updateForm({ className: value as RailwayClass });
    else updateForm({ [name]: value } as Partial<RailwayForm>);
    setErrorMessage('');
  };

  const renderSearchForm = () => <form className="railway-booking-form" aria-labelledby="search-title" onSubmit={(event) => { event.preventDefault(); startSearch(); }}>
    <div className="railway-section-heading"><div><span className="railway-eyebrow">01 · SEARCH</span><h2 id="search-title">Find a local demo train</h2></div><span className="railway-form-note">All data is fictional</span></div>
    <div className="railway-form-grid railway-form-grid--route">
      <label htmlFor="railway-from"><span>From</span><select id="railway-from" name="from" value={form.from} onChange={onFormChange}>{RAILWAY_STATIONS.map((station) => <option key={station}>{station}</option>)}</select></label>
      <button type="button" className="railway-swap" aria-label="Swap departure and arrival stations" onClick={() => updateForm({ from: form.to, to: form.from })}><span aria-hidden="true">↔</span></button>
      <label htmlFor="railway-to"><span>To</span><select id="railway-to" name="to" value={form.to} onChange={onFormChange}>{RAILWAY_STATIONS.map((station) => <option key={station}>{station}</option>)}</select></label>
    </div>
    <div className="railway-form-grid railway-form-grid--four">
      <label htmlFor="railway-date"><span>Departure date</span><input id="railway-date" name="date" type="date" value={form.date} onChange={onFormChange} /></label>
      {form.journey === 'return' && <label htmlFor="railway-return-date"><span>Return date</span><input id="railway-return-date" name="returnDate" type="date" value={form.returnDate} onChange={onFormChange} /></label>}
      <label htmlFor="railway-passengers"><span>Passengers</span><input id="railway-passengers" name="passengers" type="number" min="1" max="9" value={form.passengers} onChange={onFormChange} /></label>
      <label htmlFor="railway-class"><span>Class</span><select id="railway-class" name="className" value={form.className} onChange={onFormChange}>{RAILWAY_CLASSES.map((item) => <option key={item.value} value={item.value}>{item.label} · {item.description}</option>)}</select></label>
    </div>
    <fieldset className="railway-radio-group"><legend>Journey type</legend><label><input type="radio" name="journey" value="one-way" checked={form.journey === 'one-way'} onChange={onFormChange} />One way</label><label><input type="radio" name="journey" value="return" checked={form.journey === 'return'} onChange={onFormChange} />Return</label></fieldset>
    <div className="railway-form-actions"><button id="railway-search" className="railway-button railway-button--primary" type="submit"><Icon name="arrow" />Search demo trains</button><button type="button" className="railway-button railway-button--quiet" onClick={clearBooking}>Clear form</button></div>
    {errorMessage && <p className="railway-error" role="alert">{errorMessage}</p>}
  </form>;

  const renderResults = () => <section className="railway-results" aria-labelledby="results-title"><div className="railway-section-heading"><div><span className="railway-eyebrow">02 · RESULTS</span><h2 id="results-title">Available demo trains</h2></div><span className="railway-form-note">{results.length} options · {formatRailwayDate(form.date)}</span></div><p className="railway-section-copy">Choose a visible train card with a keyboard, voice command, TouchView pinch or stable hold.</p><div className="railway-train-list">{results.map((train) => <TrainCard key={train.id} train={train} form={form} selected={train.id === selectedTrainId} onChoose={chooseTrain} />)}</div><div className="railway-inline-actions"><button type="button" className="railway-button railway-button--quiet" onClick={goBack}>Back to search</button>{selectedTrainId && <button type="button" className="railway-button railway-button--primary" onClick={() => setFlowStep('PASSENGER_DETAILS', false)}>Continue with selected train</button>}</div></section>;

  const renderPassengerDetails = () => <form className="railway-details" aria-labelledby="details-title" onSubmit={submitPassenger}><div className="railway-section-heading"><div><span className="railway-eyebrow">03 · PASSENGER</span><h2 id="details-title">Passenger details</h2></div><span className="railway-form-note">Required for the demo review</span></div><p className="railway-section-copy">These details stay in this local page. Dictation writes only into the field you select.</p><div className="railway-form-grid railway-form-grid--two"><label htmlFor="railway-name"><span>Passenger name <b>*</b></span><input id="railway-name" name="passengerName" value={form.passengerName} onFocus={() => setDictationField('passengerName')} onChange={onFormChange} placeholder="e.g. Asha Rao" autoComplete="name" /><button type="button" className="railway-field-mic" onClick={() => startDictation('passengerName')}><Icon name="mic" />Dictate name</button></label><label htmlFor="railway-contact"><span>Contact number <b>*</b></span><input id="railway-contact" name="contact" value={form.contact} onFocus={() => setDictationField('contact')} onChange={onFormChange} placeholder="e.g. 9876543210" inputMode="tel" autoComplete="tel" /><button type="button" className="railway-field-mic" onClick={() => startDictation('contact')}><Icon name="mic" />Dictate contact</button></label></div><label htmlFor="railway-details"><span>Accessibility or seating note</span><textarea id="railway-details" name="passengerDetails" rows={4} value={form.passengerDetails} onFocus={() => setDictationField('passengerDetails')} onChange={onFormChange} placeholder="Optional note for this local demo" /><button type="button" className="railway-field-mic" onClick={() => startDictation('passengerDetails')}><Icon name="mic" />Dictate note</button></label><div className="railway-inline-actions"><button type="button" className="railway-button railway-button--quiet" onClick={goBack}>Back</button><button id="railway-review" className="railway-button railway-button--primary" type="submit">Review booking</button></div></form>;

  const renderReview = () => <section className="railway-review" aria-labelledby="review-title"><div className="railway-section-heading"><div><span className="railway-eyebrow">04 · REVIEW</span><h2 id="review-title">Review before approval</h2></div><span className="railway-form-note">No payment is collected</span></div><div className="railway-summary-grid"><div><span>Route</span><strong>{form.from} → {form.to}</strong></div><div><span>Date</span><strong>{formatRailwayDate(form.date)}{form.journey === 'return' ? ` · return ${formatRailwayDate(form.returnDate)}` : ''}</strong></div><div><span>Train</span><strong>{activeTrain?.name ?? 'Choose a train'}</strong></div><div><span>Passenger</span><strong>{form.passengerName}</strong></div><div><span>Class</span><strong>{currentClass?.label}</strong></div><div><span>Total fare</span><strong>₹{activeTrain ? fareFor(activeTrain, form.className, form.passengers).toLocaleString() : '0'}</strong></div></div><p className="railway-review-note">Read the visible summary with HandFree Sense, then continue to the explicit approval step. This cannot issue a real ticket.</p><div className="railway-inline-actions"><button type="button" className="railway-button railway-button--quiet" onClick={goBack}>Edit details</button><button id="railway-review-approve" type="button" className="railway-button railway-button--primary" onClick={() => setFlowStep('APPROVAL', blindRef.current)}>Continue to approval</button></div></section>;

  const renderApproval = () => <section className="railway-approval" aria-labelledby="approval-title"><div className="railway-approval-icon" aria-hidden="true"><Icon name="shield" /></div><div><span className="railway-eyebrow">05 · EXPLICIT APPROVAL</span><h2 id="approval-title">Confirm the simulated booking?</h2><p>This local demo will create a fictional reference only. It will not contact a railway provider, reserve a seat or take payment.</p></div><div className="railway-approval-actions"><button type="button" className="railway-button railway-button--quiet" onClick={goBack}>Go back</button><button id="railway-confirm" type="button" className="railway-button railway-button--danger" onClick={confirmBooking}>Confirm simulated booking</button></div></section>;

  const renderConfirmed = () => <section className="railway-confirmed" aria-labelledby="confirmed-title"><div className="railway-confirmed-icon" aria-hidden="true"><Icon name="check" /></div><span className="railway-eyebrow">06 · CONFIRMED</span><h2 id="confirmed-title">Your demo booking is complete</h2><p>The local booking flow completed successfully. Nothing was sent outside this browser.</p><div className="railway-reference"><span>Local reference</span><strong>{bookingReference}</strong></div><div className="railway-inline-actions"><button type="button" className="railway-button railway-button--primary" onClick={clearBooking}>Start another demo booking</button><a className="railway-button railway-button--quiet" href={extensionUrl('dashboard.html')}>Return to Control Center</a></div></section>;

  return <div className={`railway-app${settings.touchViewContrast ? ' railway-app--contrast' : ''} ${accessibilityClassNames(settings)}`}>
    <header className="railway-header"><a className="railway-brand" href={extensionUrl('dashboard.html')}><span className="railway-brand-mark"><Icon name="crosshair" /></span><span><strong>HandFree</strong><small>RAILWAY BOOKING DEMO</small></span></a><div className="railway-header-meta"><AccessibilityControls compact settings={settings} onSettings={persistSettings} /><span className="railway-local-badge">SIMULATED · LOCAL ONLY</span><a href={extensionUrl('demo.html')}>Open Demo Lab</a><a href={extensionUrl('dashboard.html')}>Control Center</a></div></header>
    <div className="railway-shell">
      <main className="railway-main" ref={contentRef}>
        <section className="railway-hero"><div><span className="railway-eyebrow">A REALISTIC PRACTICE FLOW</span><h1>Book a journey at your own pace.</h1><p>Use the keyboard, voice, TouchView hand pointer, head dwell or HandFree Sense. Every action below is real inside this local demo, with an explicit approval step before the fictional confirmation.</p></div><div className="railway-hero-status"><span className="status-dot" /><strong>{statusLabel(status)}</strong><small>{notice}</small></div></section>
        <section className="railway-camera-strip" aria-label="HandFree tracking workspace"><div className="railway-camera-preview"><video ref={videoRef} className="railway-camera-video" style={{ opacity: settings.touchViewCameraOpacity, transform: settings.touchViewMirrorCamera ? 'scaleX(-1)' : 'none' }} autoPlay muted playsInline aria-label="HandFree camera preview" /><canvas ref={canvasRef} className="railway-landmarks" aria-hidden="true" /><div className="railway-camera-empty"><Icon name="camera" /><span>{status.cameraState === 'active' ? 'Live tracking surface' : 'Camera preview'}</span></div></div><div className="railway-camera-copy"><span className="railway-eyebrow">LIVE CONTROL</span><strong>{pointerLabel}</strong><span>{targetLabel}</span><span>Gesture · {gestureLabel}</span><span>Confidence · {formatConfidence(status.handConfidence || status.confidence)}</span></div><div className="railway-camera-actions"><button type="button" className="railway-button railway-button--primary" onClick={() => void startCamera()} disabled={cameraBusy || status.cameraState === 'active' || blindMode}><Icon name="camera" />{cameraBusy ? 'Starting…' : status.cameraState === 'active' ? 'Camera active' : 'Start camera'}</button><button type="button" className="railway-button railway-button--quiet" onClick={() => void stopCamera(true)} disabled={status.cameraState !== 'active'}>Stop</button><span className="railway-camera-message">{cameraMessage}</span></div></section>
        <section className="railway-mode-bar" aria-label="Interaction controls"><button id="railway-touchview-toggle" type="button" role="switch" aria-checked={touchViewEnabled} className={`railway-mode-button${touchViewEnabled ? ' is-on' : ''}`} onClick={toggleTouchView}><span className="mode-indicator" />TouchView <small>{touchViewEnabled ? 'On' : 'Off'}</small></button><button type="button" role="switch" aria-checked={headEnabled} className={`railway-mode-button${headEnabled ? ' is-on' : ''}`} onClick={toggleHead}><span className="mode-indicator" />Head pointer <small>{headEnabled ? 'On' : 'Off'}</small></button><button type="button" role="switch" aria-checked={handEnabled} className={`railway-mode-button${handEnabled ? ' is-on' : ''}`} onClick={toggleHand}><span className="mode-indicator" />Hand pointer <small>{handEnabled ? 'On' : 'Off'}</small></button><button type="button" className={`railway-mode-button${paused ? ' is-paused' : ''}`} onClick={() => void togglePause()}><span className="mode-indicator" />{paused ? 'Resume tracking' : 'Pause tracking'}</button><button type="button" className="railway-mode-button railway-mode-button--blind" onClick={toggleBlindMode}><Icon name="mic" />{blindMode ? 'Exit Blind Mode' : 'Blind Mode'}</button><button type="button" className="railway-icon-button" aria-label="Open Railway Demo settings" onClick={() => setSettingsOpen(true)}><Icon name="settings" /></button></section>
        <section className="railway-progress" aria-label="Booking progress"><div className="railway-progress-track"><span style={{ width: `${Math.min(100, Math.max(4, (stepIndex(step) / (RAILWAY_FLOW.length - 1)) * 100))}%` }} /></div><div className="railway-progress-label"><span>Current stage: <strong>{RAILWAY_FLOW.find((item) => item.step === step)?.label ?? step}</strong></span><span>{step === 'SEARCHING' ? 'Searching local data…' : `${Math.min(stepIndex(step) + 1, RAILWAY_FLOW.length)} of ${RAILWAY_FLOW.length}`}</span></div></section>
        <section className="railway-stage" style={{ opacity: settings.touchViewWebsiteOpacity }} aria-live="polite"><div className="railway-stage-header"><div><span className="railway-eyebrow">{step === 'WELCOME' ? 'START HERE' : `STAGE ${String(stepIndex(step) + 1).padStart(2, '0')}`}</span><h2>{promptForStep(step, form)}</h2></div>{step !== 'WELCOME' && step !== 'CONFIRMED' && <button type="button" className="railway-button railway-button--quiet" onClick={goBack}>Back</button>}</div>{step === 'WELCOME' && <div className="railway-welcome-callout"><div><h3>One flow, four ways to interact.</h3><p>Start with the form or say “open railway booking”. Then search fictional trains, choose one, enter passenger details and approve the simulated result.</p></div><button type="button" className="railway-button railway-button--primary" onClick={() => setFlowStep('DEPARTURE', false)}>Start booking</button></div>}{renderSearchForm()}{(step === 'RESULTS' || step === 'TRAIN_SELECTION') && renderResults()}{step === 'PASSENGER_DETAILS' && renderPassengerDetails()}{step === 'REVIEW' && renderReview()}{step === 'APPROVAL' && renderApproval()}{step === 'CONFIRMED' && renderConfirmed()}</section>
        <section className="railway-feedback" aria-live="polite"><div><span className="railway-eyebrow">LIVE FEEDBACK</span><strong>{activationMessage}</strong></div><span>{lastTranscript ? `Last voice input: “${lastTranscript}”` : 'TouchView activation and voice status appear here.'}</span></section>
      </main>
      <aside className="railway-sidebar" aria-label="HandFree Railway controls"><section className="railway-sidebar-card railway-sidebar-card--state"><div className="railway-sidebar-heading"><div><span className="railway-eyebrow">HANDfree STATE</span><h2>Assistive controls</h2></div><span className={`railway-state-dot ${status.cameraState === 'active' ? 'is-good' : ''}`} /></div><p>Use one mode at a time while you learn the local flow. All data stays on this page.</p><div className="railway-state-grid"><span>Camera<strong>{status.cameraState === 'active' ? 'Active' : 'Off'}</strong></span><span>Target<strong>{targetLabel === 'No target under the pointer' ? 'None' : 'Locked'}</strong></span><span>Voice<strong>{voiceStatus === 'listening' ? 'Listening' : voiceStatus === 'unavailable' ? 'Unavailable' : 'Ready'}</strong></span><span>Stage<strong>{RAILWAY_FLOW.find((item) => item.step === step)?.label}</strong></span></div><button type="button" className="railway-text-button" onClick={() => setShowAdvancedStatus((current) => !current)}>{showAdvancedStatus ? 'Hide diagnostics' : 'Show diagnostics'}</button>{showAdvancedStatus && <dl className="railway-diagnostics"><div><dt>Engine</dt><dd>{status.engineState}</dd></div><div><dt>Pointer</dt><dd>{status.pointerSource}</dd></div><div><dt>Face</dt><dd>{status.faceDetected ? 'detected' : 'not detected'}</dd></div><div><dt>Hand</dt><dd>{status.handTracking}</dd></div><div><dt>Loops</dt><dd>{status.activeFaceLoops + status.activeHandLoops}</dd></div></dl>}</section>
        <VoiceAssistantControl settings={settings} onSettings={persistSettings} onCommand={(transcript) => voiceIntentRef.current(transcript, 'command')} onDictation={(text) => voiceIntentRef.current(text, 'dictation')} onConversation={handleGuidedConversation} onConversationStart={startGuidedConversation} title="Voice Assistant + dictation" />
        <section className="railway-sidebar-card"><div className="railway-sidebar-heading"><div><span className="railway-eyebrow">VOICE GUIDE</span><h2>Speak naturally</h2></div><Icon name="mic" /></div><p>Use Start guided flow for a pre-made booking conversation. HandFree asks the next question, understands answers like “station is Pune Junction”, and keeps confirmation explicit.</p><div className="railway-voice-status" role="status"><strong>{modeText(voiceMode)} · {voiceStatus}</strong><span>{voiceMessage}</span></div><div className="railway-command-hint"><span>Try saying</span><strong>“station is Pune Junction”</strong><strong>“two passengers”</strong><strong>“confirm booking”</strong></div></section>
        <section className="railway-sidebar-card"><div className="railway-sidebar-heading"><div><span className="railway-eyebrow railway-eyebrow--purple">HANDFREE SENSE</span><h2>Read what is visible</h2></div><Icon name="target" /></div><p>Sense reads the actual visible form, results and confirmation instead of a hidden script.</p><div className="railway-sense-actions"><button type="button" onClick={() => readSense('page')}>Read page</button><button type="button" onClick={() => readSense('form')}>Read booking form</button><button type="button" onClick={() => readSense('results')}>Read trains</button><button type="button" onClick={() => readSense('fare')}>Read fare</button><button type="button" onClick={() => readSense('required')}>Read required fields</button><button type="button" onClick={() => readSense('confirmation')}>Read confirmation</button><button type="button" className="is-stop" onClick={() => { speechRef.current?.stopSpeaking(); setSenseStatus('ready'); setSenseOutput('Sense stopped reading.'); }}>Stop reading</button></div><div id="railway-sense-output" className="railway-sense-output" role="status"><span>{senseStatus === 'reading' ? 'Reading…' : 'Ready'}</span><p>{senseOutput}</p></div></section>
        <section className="railway-sidebar-card"><div className="railway-sidebar-heading"><div><span className="railway-eyebrow">FLOW</span><h2>Where you are</h2></div></div><ol className="railway-step-list">{RAILWAY_FLOW.map((item, index) => <li key={item.step} className={index === stepIndex(step) ? 'is-current' : index < stepIndex(step) ? 'is-done' : ''} aria-current={index === stepIndex(step) ? 'step' : undefined}><span>{String(index + 1).padStart(2, '0')}</span>{item.label}</li>)}</ol></section>
      </aside>
    </div>
    {settingsOpen && <><button type="button" className="railway-drawer-backdrop" aria-label="Dismiss Railway Demo settings" onClick={() => setSettingsOpen(false)} /><aside className="railway-settings-drawer" role="dialog" aria-modal="true" aria-labelledby="railway-settings-title"><div className="railway-drawer-header"><div><span className="railway-eyebrow">SETTINGS</span><h2 id="railway-settings-title">Tune this demo</h2></div><button type="button" className="railway-icon-button" aria-label="Close Railway Demo settings" onClick={() => setSettingsOpen(false)}><Icon name="crosshair" /></button></div><p>These controls reuse HandFree’s shared local settings. They do not change the fictional railway data.</p><SettingRange id="railway-camera-opacity" label="Camera opacity" value={settings.touchViewCameraOpacity} min={0.15} max={1} step={0.05} suffix={`${Math.round(settings.touchViewCameraOpacity * 100)}%`} onChange={(value) => void persistSettings({ touchViewCameraOpacity: value })} /><SettingRange id="railway-page-opacity" label="Website layer opacity" value={settings.touchViewWebsiteOpacity} min={0.55} max={1} step={0.05} suffix={`${Math.round(settings.touchViewWebsiteOpacity * 100)}%`} onChange={(value) => void persistSettings({ touchViewWebsiteOpacity: value })} /><SettingRange id="railway-cursor-size" label="Cursor size" value={settings.touchViewCursorSize} min={18} max={64} step={2} suffix={`${settings.touchViewCursorSize}px`} onChange={(value) => void persistSettings({ touchViewCursorSize: value })} /><SettingRange id="railway-hold-duration" label="Hold duration" value={settings.touchViewHoldDuration} min={450} max={2400} step={50} suffix={`${settings.touchViewHoldDuration}ms`} onChange={(value) => void persistSettings({ touchViewHoldDuration: value })} /><SettingRange id="railway-dwell-duration" label="Head dwell duration" value={settings.dwellDuration} min={500} max={2500} step={100} suffix={`${settings.dwellDuration}ms`} onChange={(value) => void persistSettings({ dwellDuration: value })} /><SettingRange id="railway-highlight-opacity" label="Target highlight" value={settings.touchViewHighlightOpacity} min={0.45} max={1} step={0.05} suffix={`${Math.round(settings.touchViewHighlightOpacity * 100)}%`} onChange={(value) => void persistSettings({ touchViewHighlightOpacity: value })} /><RailwayToggle id="railway-stable-hold" label="Stable-hold activation" checked={settings.touchViewStableHoldEnabled} onChange={(value) => void persistSettings({ touchViewStableHoldEnabled: value })} /><RailwayToggle id="railway-high-contrast" label="High contrast" checked={settings.touchViewContrast} onChange={(value) => void persistSettings({ touchViewContrast: value })} /><div className="railway-drawer-footer"><button type="button" className="railway-button railway-button--quiet" onClick={() => void persistSettings({ calibration: null, touchViewCalibration: null })}>Reset shared calibration</button><button type="button" className="railway-button railway-button--primary" onClick={() => setSettingsOpen(false)}>Done</button></div></aside></>}
  </div>;
}

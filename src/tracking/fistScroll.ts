import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { HandPose, ScrollDirection } from '../shared/types';

export type { HandPose, ScrollDirection } from '../shared/types';
export type FistScrollState = 'IDLE' | 'FIST_CANDIDATE' | 'FIST_CONFIRMED' | 'SCROLLING' | 'RELEASE_WAIT' | 'COOLDOWN';

export interface FistClassification {
  pose: HandPose;
  isFist: boolean;
  confidence: number;
  foldedFingers: number;
  thumbFolded: boolean;
}

export interface FistScrollSettings {
  enabled: boolean;
  sensitivity: number;
  confirmationDuration: number;
  deadZone: number;
  maxScrollSpeed: number;
  invertDirection: boolean;
  cooldownDuration: number;
}

export interface FistScrollInput {
  pose: HandPose;
  confidence: number;
  x: number;
  y: number;
  now: number;
}

export type FistScrollEvent =
  | { type: 'start'; x: number; y: number; progress: number }
  | { type: 'update'; x: number; y: number; deltaY: number; direction: ScrollDirection; velocity: number; progress: number }
  | { type: 'stop'; reason: 'released' | 'tracking-lost' | 'disabled' | 'reset' };

const CONFIDENCE_THRESHOLD = 0.55;
const FIST_LOSS_GRACE_DURATION = 90;
const FINGER_TIPS = [8, 12, 16, 20] as const;
const FINGER_PIPS = [6, 10, 14, 18] as const;
const FINGER_MCPS = [5, 9, 13, 17] as const;

function distance(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

function palmCenter(landmarks: NormalizedLandmark[]): NormalizedLandmark {
  const points = [landmarks[0], landmarks[5], landmarks[9], landmarks[13], landmarks[17]];
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    z: points.reduce((sum, point) => sum + (point.z ?? 0), 0) / points.length
  } as NormalizedLandmark;
}

function fingerFolded(landmarks: NormalizedLandmark[], tipIndex: number, pipIndex: number, mcpIndex: number, palm: NormalizedLandmark, wrist: NormalizedLandmark): boolean {
  const tipToPalm = distance(landmarks[tipIndex], palm);
  const pipToPalm = distance(landmarks[pipIndex], palm);
  const mcpToPalm = distance(landmarks[mcpIndex], palm);
  const tipToWrist = distance(landmarks[tipIndex], wrist);
  const pipToWrist = distance(landmarks[pipIndex], wrist);

  // A real closed hand is not rigid: the fingertips may curl sideways,
  // overlap one another, or be partly hidden. Use both palm and wrist
  // geometry instead of the old single 4% palm-distance comparison.
  const curledAgainstPalm = tipToPalm <= pipToPalm * 1.22 && tipToPalm <= mcpToPalm * 1.65;
  const curledTowardWrist = tipToWrist <= pipToWrist * 1.1;
  return curledAgainstPalm || curledTowardWrist;
}

function fingerExtended(landmarks: NormalizedLandmark[], tipIndex: number, pipIndex: number, palm: NormalizedLandmark, wrist: NormalizedLandmark): boolean {
  const tipToPalm = distance(landmarks[tipIndex], palm);
  const pipToPalm = distance(landmarks[pipIndex], palm);
  const tipToWrist = distance(landmarks[tipIndex], wrist);
  const pipToWrist = distance(landmarks[pipIndex], wrist);
  return tipToPalm > pipToPalm * 1.08 && tipToWrist > pipToWrist * 1.08;
}

/** Classify pose from one MediaPipe frame without creating another inference loop. */
export function classifyHandPose(landmarks: NormalizedLandmark[], confidence: number, pinchThreshold = 0.08): FistClassification {
  if (landmarks.length < 21 || confidence < CONFIDENCE_THRESHOLD) {
    return { pose: 'unknown', isFist: false, confidence, foldedFingers: 0, thumbFolded: false };
  }

  const wrist = landmarks[0];
  const palm = palmCenter(landmarks);
  const palmScale = Math.max(distance(wrist, landmarks[9]), distance(landmarks[5], landmarks[17]), 0.001);
  const pinchDistance = distance(landmarks[4], landmarks[8]) / palmScale * 0.2;
  const foldedFingers = FINGER_TIPS.reduce((count, tipIndex, index) => {
    return count + (fingerFolded(landmarks, tipIndex, FINGER_PIPS[index], FINGER_MCPS[index], palm, wrist) ? 1 : 0);
  }, 0);
  const thumbToPalm = distance(landmarks[4], palm);
  const thumbToIndexMcp = distance(landmarks[4], landmarks[5]);
  const thumbFolded = thumbToPalm <= palmScale * 1.55 || thumbToIndexMcp <= palmScale * 1.08;
  const indexExtended = fingerExtended(landmarks, 8, 6, palm, wrist);
  const openFingers = FINGER_TIPS.reduce((count, tipIndex, index) => {
    return count + (fingerExtended(landmarks, tipIndex, FINGER_PIPS[index], palm, wrist) ? 1 : 0);
  }, 0);

  if (pinchDistance < pinchThreshold && indexExtended) return { pose: 'pinch', isFist: false, confidence, foldedFingers, thumbFolded };
  if (foldedFingers === 4 && thumbFolded && !indexExtended) return { pose: 'fist', isFist: true, confidence, foldedFingers, thumbFolded };
  if (openFingers === 4) return { pose: 'open-palm', isFist: false, confidence, foldedFingers, thumbFolded };
  const otherFingersFolded = [12, 16, 20].every((tipIndex, index) => fingerFolded(landmarks, tipIndex, [10, 14, 18][index], [9, 13, 17][index], palm, wrist));
  if (indexExtended && otherFingersFolded) return { pose: 'pointing', isFist: false, confidence, foldedFingers, thumbFolded };
  return { pose: 'unknown', isFist: false, confidence, foldedFingers, thumbFolded };
}

/** Stable fist confirmation and throttled vertical motion state machine. */
export class FistScrollController {
  state: FistScrollState = 'IDLE';
  private candidateStartedAt = 0;
  private cooldownUntil = 0;
  private anchorY = 0;
  private lastY = 0;
  private lastAt = 0;
  private smoothedY = 0;
  private lastValidFistAt = 0;

  update(input: FistScrollInput, settings: FistScrollSettings): FistScrollEvent[] {
    const events: FistScrollEvent[] = [];
    const validFist = settings.enabled && input.confidence >= CONFIDENCE_THRESHOLD && input.pose === 'fist';
    if (validFist) this.lastValidFistAt = input.now;
    if (!validFist) {
      // MediaPipe can briefly flip to unknown while a closed finger crosses
      // another finger. Keep an already-confirmed scroll session alive for a
      // short grace window, but do not produce movement from that uncertain
      // frame. A sustained open hand still releases normally.
      const withinGrace = (this.state === 'FIST_CONFIRMED' || this.state === 'SCROLLING') && input.now - this.lastValidFistAt <= FIST_LOSS_GRACE_DURATION;
      if (withinGrace) return events;
      if (this.state === 'FIST_CONFIRMED' || this.state === 'SCROLLING') {
        events.push({ type: 'stop', reason: settings.enabled ? input.confidence < CONFIDENCE_THRESHOLD ? 'tracking-lost' : 'released' : 'disabled' });
        this.state = 'RELEASE_WAIT';
        this.cooldownUntil = input.now + Math.max(0, settings.cooldownDuration);
      } else if (this.state === 'FIST_CANDIDATE') {
        this.state = 'IDLE';
      } else if (this.state === 'RELEASE_WAIT' && input.now >= this.cooldownUntil) {
        this.state = 'COOLDOWN';
      }
      return events;
    }

    if (this.state === 'RELEASE_WAIT') {
      if (input.now < this.cooldownUntil) return events;
      this.state = 'COOLDOWN';
    }
    if (this.state === 'COOLDOWN') {
      if (input.now < this.cooldownUntil) return events;
      this.state = 'IDLE';
    }
    if (this.state === 'IDLE') {
      this.state = 'FIST_CANDIDATE';
      this.candidateStartedAt = input.now;
      this.smoothedY = input.y;
      this.lastY = input.y;
      this.lastAt = input.now;
    }
    if (this.state === 'FIST_CANDIDATE') {
      const elapsed = input.now - this.candidateStartedAt;
      this.smoothedY += (input.y - this.smoothedY) * 0.34;
      this.lastY = this.smoothedY;
      this.lastAt = input.now;
      if (elapsed < Math.max(0, settings.confirmationDuration)) return events;
      this.anchorY = this.smoothedY;
      this.lastY = this.smoothedY;
      this.lastAt = input.now;
      this.state = 'FIST_CONFIRMED';
      events.push({ type: 'start', x: input.x, y: this.smoothedY, progress: 1 });
      return events;
    }

    if (this.state !== 'FIST_CONFIRMED' && this.state !== 'SCROLLING') return events;
    this.smoothedY += (input.y - this.smoothedY) * 0.34;
    const elapsed = Math.max(1, input.now - this.lastAt);
    const fromAnchor = this.smoothedY - this.anchorY;
    if (Math.abs(fromAnchor) < Math.max(0, settings.deadZone)) {
      this.lastY = this.smoothedY;
      this.lastAt = input.now;
      return events;
    }
    const normalizedStep = this.smoothedY - this.lastY;
    const directionSign = settings.invertDirection ? -1 : 1;
    const rawDelta = normalizedStep * 900 * Math.max(0.1, settings.sensitivity) * directionSign;
    const maxStep = Math.max(1, settings.maxScrollSpeed);
    const deltaY = Math.max(-maxStep, Math.min(maxStep, rawDelta));
    this.lastY = this.smoothedY;
    this.lastAt = input.now;
    if (Math.abs(deltaY) < 0.5) return events;
    this.state = 'SCROLLING';
    const direction: ScrollDirection = deltaY < 0 ? 'up' : 'down';
    events.push({ type: 'update', x: input.x, y: this.smoothedY, deltaY, direction, velocity: Math.abs(deltaY) / (elapsed / 1000), progress: Math.min(1, Math.abs(fromAnchor) / Math.max(settings.deadZone, 0.001)) });
    return events;
  }

  reset(): FistScrollEvent[] {
    const events: FistScrollEvent[] = this.state === 'FIST_CONFIRMED' || this.state === 'SCROLLING' ? [{ type: 'stop', reason: 'reset' }] : [];
    this.state = 'IDLE';
    this.candidateStartedAt = 0;
    this.cooldownUntil = 0;
    this.anchorY = 0;
    this.lastY = 0;
    this.lastAt = 0;
    this.smoothedY = 0;
    this.lastValidFistAt = 0;
    return events;
  }

  progress(now: number, confirmationDuration: number): number {
    if (this.state !== 'FIST_CANDIDATE') return this.state === 'FIST_CONFIRMED' || this.state === 'SCROLLING' ? 1 : 0;
    return Math.max(0, Math.min(1, (now - this.candidateStartedAt) / Math.max(1, confirmationDuration)));
  }
}

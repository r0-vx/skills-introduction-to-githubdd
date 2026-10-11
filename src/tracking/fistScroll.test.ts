import { describe, expect, it } from 'vitest';
import { classifyHandPose, FistScrollController, type FistScrollSettings } from './fistScroll';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

const base: Record<number, [number, number]> = {
  0: [.50, .80], 1: [.39, .70], 2: [.36, .65], 3: [.34, .61], 4: [.28, .58],
  5: [.42, .62], 6: [.41, .51], 7: [.40, .39], 8: [.38, .25],
  9: [.50, .58], 10: [.50, .45], 11: [.50, .31], 12: [.50, .18],
  13: [.58, .62], 14: [.59, .49], 15: [.61, .35], 16: [.62, .22],
  17: [.64, .68], 18: [.67, .55], 19: [.70, .42], 20: [.72, .32]
};

function landmarks(overrides: Record<number, [number, number]> = {}): NormalizedLandmark[] {
  return Array.from({ length: 21 }, (_, index) => {
    const [x, y] = overrides[index] ?? base[index];
    return { x, y, z: 0 } as NormalizedLandmark;
  });
}

const fistLandmarks = landmarks({
  4: [.47, .65], 8: [.46, .61], 12: [.50, .60], 16: [.55, .62], 20: [.59, .65],
  6: [.43, .54], 10: [.49, .52], 14: [.57, .54], 18: [.63, .58]
});

const settings: FistScrollSettings = {
  enabled: true,
  sensitivity: 1,
  confirmationDuration: 300,
  deadZone: .04,
  maxScrollSpeed: 40,
  invertDirection: false,
  cooldownDuration: 300
};

function input(y: number, now: number, pose: 'fist' | 'open-palm' | 'pinch' = 'fist') {
  return { pose, confidence: .9, x: .5, y, now };
}

describe('fist classification', () => {
  it('recognizes a folded fist and rejects an open palm', () => {
    expect(classifyHandPose(fistLandmarks, .9).pose).toBe('fist');
    expect(classifyHandPose(landmarks(), .9).pose).toBe('open-palm');
  });

  it('accepts an angled fist when one curled fingertip is not perfectly folded', () => {
    const angledFist = landmarks({
      4: [.50, .62], 8: [.43, .57], 12: [.51, .57], 16: [.59, .61], 20: [.66, .66],
      6: [.42, .54], 10: [.50, .52], 14: [.58, .54], 18: [.64, .59]
    });
    expect(classifyHandPose(angledFist, .9).isFist).toBe(true);
  });

  it('rejects low confidence and does not confuse pinch with a fist', () => {
    expect(classifyHandPose(fistLandmarks, .4).isFist).toBe(false);
    expect(classifyHandPose(landmarks({ 4: [.39, .39], 8: [.40, .40] }), .9).pose).toBe('pinch');
  });
});

describe('fist scroll state machine', () => {
  it('requires a stable confirmation window before starting', () => {
    const machine = new FistScrollController();
    expect(machine.update(input(.5, 0), settings)).toEqual([]);
    expect(machine.state).toBe('FIST_CANDIDATE');
    expect(machine.update(input(.5, 299), settings)).toEqual([]);
    const started = machine.update(input(.5, 300), settings);
    expect(started[0]?.type).toBe('start');
    expect(machine.state).toBe('FIST_CONFIRMED');
  });

  it('ignores the dead zone and reports down/up movement with a cap', () => {
    const machine = new FistScrollController();
    machine.update(input(.5, 0), settings);
    machine.update(input(.5, 300), settings);
    expect(machine.update(input(.52, 350), settings)).toEqual([]);
    const down = machine.update(input(.7, 400), settings).find(event => event.type === 'update');
    expect(down && down.type === 'update' ? down.direction : 'none').toBe('down');
    expect(down && down.type === 'update' ? Math.abs(down.deltaY) : 0).toBeLessThanOrEqual(settings.maxScrollSpeed);
    const up = machine.update(input(.1, 600), settings).find(event => event.type === 'update');
    expect(up && up.type === 'update' ? up.direction : 'none').toBe('up');
  });

  it('stops on open hand and enters cooldown before another fist', () => {
    const machine = new FistScrollController();
    machine.update(input(.5, 0), settings);
    machine.update(input(.5, 300), settings);
    machine.update(input(.7, 400), settings);
    expect(machine.update(input(.7, 500, 'open-palm'), settings)[0]?.type).toBe('stop');
    expect(machine.state).toBe('RELEASE_WAIT');
    machine.update(input(.7, 801, 'open-palm'), settings);
    expect(machine.state).toBe('COOLDOWN');
    expect(machine.update(input(.7, 802), settings)).toEqual([]);
  });

  it('keeps a confirmed scroll session through one transient unknown frame', () => {
    const machine = new FistScrollController();
    machine.update(input(.5, 0), settings);
    machine.update(input(.5, 300), settings);
    expect(machine.update({ ...input(.5, 350), pose: 'unknown' }, settings)).toEqual([]);
    expect(machine.state).toBe('FIST_CONFIRMED');
    expect(machine.update({ ...input(.5, 500), pose: 'unknown' }, settings)[0]?.type).toBe('stop');
  });

  it('resets without emitting stale updates', () => {
    const machine = new FistScrollController();
    machine.update(input(.5, 0), settings);
    machine.update(input(.5, 300), settings);
    expect(machine.reset()[0]?.type).toBe('stop');
    expect(machine.state).toBe('IDLE');
    expect(machine.update(input(.8, 301), settings)).toEqual([]);
  });
});

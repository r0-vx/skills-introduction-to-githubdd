import { describe, expect, it } from 'vitest';
import { parseRailwayCommand, parseRailwayGuidedAnswer } from './railwayVoice';

describe('railway voice commands', () => {
  it('parses route and booking controls', () => {
    expect(parseRailwayCommand('from Mumbai')).toEqual({ type: 'set-from', value: 'Mumbai Central' });
    expect(parseRailwayCommand('to Delhi')).toEqual({ type: 'set-to', value: 'Delhi Junction' });
    expect(parseRailwayCommand('tomorrow')).toEqual({ type: 'set-date', value: expect.any(String) });
    expect(parseRailwayCommand('two passengers')).toEqual({ type: 'set-passengers', value: 2 });
    expect(parseRailwayCommand('sleeper')).toEqual({ type: 'set-class', value: 'sleeper' });
    expect(parseRailwayCommand('confirm booking')).toEqual({ type: 'confirm' });
  });

  it('parses results, reading and recovery commands', () => {
    expect(parseRailwayCommand('search trains')).toEqual({ type: 'search' });
    expect(parseRailwayCommand('choose cheapest')).toEqual({ type: 'choose', value: 'cheapest' });
    expect(parseRailwayCommand('read required fields')).toEqual({ type: 'read', value: 'required' });
    expect(parseRailwayCommand('start over')).toEqual({ type: 'start-over' });
    expect(parseRailwayCommand('stop reading')).toEqual({ type: 'stop-reading' });
  });

  it('rejects ordinary sentences so dictation is not treated as a command', () => {
    expect(parseRailwayCommand('My name is Asha Rao and I need an accessible seat')).toBeNull();
  });

  it('understands natural answers in the guided conversation context', () => {
    expect(parseRailwayGuidedAnswer('station is Pune Junction', 'to')).toEqual({ field: 'to', value: 'Pune Junction' });
    expect(parseRailwayGuidedAnswer('18 November 2026', 'date')).toEqual({ field: 'date', value: '2026-11-18' });
    expect(parseRailwayGuidedAnswer('I would like two passengers', 'passengers')).toEqual({ field: 'passengers', value: 2 });
    expect(parseRailwayGuidedAnswer('nine eight seven six five four three two one zero', 'contact')).toEqual({ field: 'contact', value: '9876543210' });
  });
});

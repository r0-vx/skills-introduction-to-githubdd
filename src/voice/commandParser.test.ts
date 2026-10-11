import { describe, expect, it } from 'vitest';
import { parseVoiceCommand } from './commandParser';

describe('parseVoiceCommand', () => {
  it('parses deterministic navigation and interaction commands', () => {
    expect(parseVoiceCommand('scroll down')).toEqual({ type: 'scroll', direction: 'down' });
    expect(parseVoiceCommand('click the Activate Test Button')).toEqual({ type: 'click', query: 'activate test button' });
    expect(parseVoiceCommand('focus the name field')).toEqual({ type: 'focus', query: 'name' });
  });
  it('rejects unsupported speech without executing anything', () => { expect(parseVoiceCommand('do something clever')).toBeNull(); });
  it('normalizes filler words and exposes guarded assistant commands', () => {
    expect(parseVoiceCommand('Could you please open the Railway Booking Demo?')).toEqual({ type: 'open-railway' });
    expect(parseVoiceCommand('Hey HandFree')).toEqual({ type: 'wake' });
    expect(parseVoiceCommand('set dwell to two seconds')).toEqual({ type: 'touchview', action: 'set-dwell', value: 2 });
    expect(parseVoiceCommand('send message')).toEqual({ type: 'submit' });
    expect(parseVoiceCommand('read form fields')).toEqual({ type: 'read-form-fields' });
  });
  it('keeps arbitrary speech out of the command registry', () => {
    expect(parseVoiceCommand('please tell my friend about the project')).toBeNull();
  });
});

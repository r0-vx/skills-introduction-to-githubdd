import type { HandFreeSettings } from '../shared/types';
import './accessibility-preferences.css';

type AccessibilitySettings = Pick<HandFreeSettings, 'dyslexiaFontEnabled' | 'colorBlindModeEnabled'>;

export function accessibilityClassNames(settings: AccessibilitySettings): string {
  return [
    settings.dyslexiaFontEnabled ? 'hf-dyslexia-font' : '',
    settings.colorBlindModeEnabled ? 'hf-colorblind-mode' : ''
  ].filter(Boolean).join(' ');
}

export function AccessibilityControls({
  settings,
  onSettings,
  compact = false
}: {
  settings: HandFreeSettings;
  onSettings: (patch: Partial<HandFreeSettings>) => void | Promise<void>;
  compact?: boolean;
}) {
  return <div className={`accessibility-controls${compact ? ' accessibility-controls--compact' : ''}`} aria-label="Accessibility preferences">
    <button
      type="button"
      role="switch"
      aria-checked={settings.dyslexiaFontEnabled}
      aria-label={`${settings.dyslexiaFontEnabled ? 'Disable' : 'Enable'} dyslexia-friendly Comic Sans font`}
      title="Dyslexia-friendly Comic Sans font"
      className={`accessibility-toggle${settings.dyslexiaFontEnabled ? ' is-on' : ''}`}
      onClick={() => void onSettings({ dyslexiaFontEnabled: !settings.dyslexiaFontEnabled })}
    >
      <span className="accessibility-toggle__mark" aria-hidden="true">Aa</span>
      <span className="accessibility-toggle__label">{settings.dyslexiaFontEnabled ? 'Comic Sans' : 'Dyslexia font'}</span>
      <span className="accessibility-toggle__state">{settings.dyslexiaFontEnabled ? 'On' : 'Off'}</span>
    </button>
    <button
      type="button"
      role="switch"
      aria-checked={settings.colorBlindModeEnabled}
      aria-label={`${settings.colorBlindModeEnabled ? 'Disable' : 'Enable'} colour-safe UI colours`}
      title="Colour-safe UI colours"
      className={`accessibility-toggle${settings.colorBlindModeEnabled ? ' is-on' : ''}`}
      onClick={() => void onSettings({ colorBlindModeEnabled: !settings.colorBlindModeEnabled })}
    >
      <span className="accessibility-toggle__mark" aria-hidden="true">C</span>
      <span className="accessibility-toggle__label">{settings.colorBlindModeEnabled ? 'Colour-safe UI' : 'Colour-safe colours'}</span>
      <span className="accessibility-toggle__state">{settings.colorBlindModeEnabled ? 'On' : 'Off'}</span>
    </button>
  </div>;
}

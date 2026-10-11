export type VoiceIntent =
  | { type: 'wake' | 'start-listening' | 'stop-listening' | 'pause-listening' | 'resume-listening' | 'sleep' | 'help' | 'repeat' | 'read-screen' | 'cancel' | 'exit' | 'close' }
  | { type: 'scroll'; direction: 'up' | 'down' | 'top' | 'bottom' | 'page-up' | 'page-down' }
  | { type: 'history'; direction: 'back' | 'forward' }
  | { type: 'reload' }
  | { type: 'open-dashboard' | 'open-demo' | 'open-touchview' | 'open-railway' | 'open-settings' | 'close-settings' | 'next-tab' | 'previous-tab' }
  | { type: 'click'; query?: string }
  | { type: 'focus'; query: string }
  | { type: 'check'; checked: boolean; query?: string }
  | { type: 'select'; query: string }
  | { type: 'move'; query: string }
  | { type: 'read-query'; query: string }
  | { type: 'read-headings' | 'read-links' | 'read-buttons' | 'read-form-fields' | 'read-important' | 'read-dates' | 'read-contact' | 'read-about' | 'read-section' | 'list-buttons' | 'stop-reading' }
  | { type: 'start-dictation' | 'stop-dictation' | 'dictate'; text?: string }
  | { type: 'clear-field' | 'delete-last-word' | 'delete-last-sentence' | 'punctuation'; value?: 'full stop' | 'comma' | 'new line' }
  | { type: 'submit' }
  | { type: 'review-form' | 'next-field' | 'previous-field' | 'confirm' | 'pause' | 'resume' | 'recenter' | 'main-content' | 'new-tab' }
  | { type: 'touchview'; action: 'enable' | 'disable' | 'pause' | 'resume' | 'settings' | 'hide-settings' | 'recenter' | 'dwell-on' | 'dwell-off' | 'set-dwell' | 'sensitivity-up' | 'sensitivity-down' | 'calibrate' | 'cancel-calibration' | 'reset-calibration'; value?: number }
  | { type: 'camera'; action: 'start' | 'stop' | 'pause' | 'resume' | 'hand-on' | 'hand-off' | 'head-on' | 'head-off' | 'fist-scroll-on' | 'fist-scroll-off' | 'mirror-on' | 'mirror-off' | 'opacity-up' | 'opacity-down' }
  | { type: 'unknown'; raw: string };

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10
};

const FILLER_PREFIX = /^(?:(?:please|kindly|can you|could you|would you|will you|i want to|i would like to|help me)\s+)+/;

export function normalizeVoicePhrase(input: string): string {
  return input
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(FILLER_PREFIX, '')
    .trim();
}

export function stripWakePhrase(input: string): { phrase: string; woke: boolean } {
  const normalized = normalizeVoicePhrase(input);
  const match = normalized.match(/^(?:hey )?handfree(?:\s+|$)(.*)$/);
  if (!match) return { phrase: normalized, woke: false };
  return { phrase: match[1].trim(), woke: true };
}

function numberFrom(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  return NUMBER_WORDS[value] ?? null;
}

function queryAfter(value: string, pattern: RegExp): string | undefined {
  const match = value.match(pattern);
  return match?.[1]?.trim() || undefined;
}

export function parseVoiceCommand(input: string): VoiceIntent | null {
  const { phrase: text } = stripWakePhrase(input);
  if (!text) return stripWakePhrase(input).woke ? { type: 'wake' } : null;

  if (/^(?:hey )?handfree$/.test(text) || text === 'wake up') return { type: 'wake' };
  if (/^(?:start|begin|turn) listening$/.test(text)) return { type: 'start-listening' };
  if (/^(?:stop|end) listening$/.test(text)) return { type: 'stop-listening' };
  if (/^(?:pause|suspend) listening$/.test(text)) return { type: 'pause-listening' };
  if (/^(?:resume|continue) listening$/.test(text)) return { type: 'resume-listening' };
  if (/^(?:go to sleep|sleep|deactivate voice)$/.test(text)) return { type: 'sleep' };
  if (/^(?:help|what can i say|commands)$/.test(text)) return { type: 'help' };
  if (/^(?:repeat|say that again|repeat that)$/.test(text)) return { type: 'repeat' };
  if (/^(?:read current screen|read this page|read the page|read screen|summarize this page)$/.test(text)) return { type: 'read-screen' };
  if (/^(?:what is this page about|read about this page)$/.test(text)) return { type: 'read-about' };
  if (/^(?:cancel|stop)(?: booking| action)?$/.test(text)) return { type: 'cancel' };
  if (/^exit$/.test(text)) return { type: 'exit' };
  if (/^close$/.test(text)) return { type: 'close' };

  if (/^(?:scroll|go) (?:down|lower)$/.test(text)) return { type: 'scroll', direction: 'down' };
  if (/^(?:scroll|go) up$/.test(text)) return { type: 'scroll', direction: 'up' };
  if (/^(?:scroll|go) to top$/.test(text)) return { type: 'scroll', direction: 'top' };
  if (/^(?:scroll|go) to bottom$/.test(text)) return { type: 'scroll', direction: 'bottom' };
  if (/^(?:page|scroll) up$/.test(text)) return { type: 'scroll', direction: 'page-up' };
  if (/^(?:page|scroll) down$/.test(text)) return { type: 'scroll', direction: 'page-down' };
  if (/^(?:go )?back$/.test(text)) return { type: 'history', direction: 'back' };
  if (/^(?:go )?forward$/.test(text)) return { type: 'history', direction: 'forward' };
  if (/^(?:reload|refresh)(?: the page)?$/.test(text)) return { type: 'reload' };
  if (/^(?:open|go to) (?:the )?dashboard$/.test(text)) return { type: 'open-dashboard' };
  if (/^(?:open|go to) (?:the )?demo(?: lab)?$/.test(text)) return { type: 'open-demo' };
  if (/^(?:open|go to) (?:the )?touchview$/.test(text)) return { type: 'open-touchview' };
  if (/^(?:open|go to) (?:the )?(?:railway|railway booking)(?: demo)?$/.test(text)) return { type: 'open-railway' };
  if (/^(?:open|show) (?:the )?settings$/.test(text)) return { type: 'open-settings' };
  if (/^(?:close|hide) settings$/.test(text)) return { type: 'close-settings' };
  if (/^next tab$/.test(text)) return { type: 'next-tab' };
  if (/^(?:previous|prev) tab$/.test(text)) return { type: 'previous-tab' };

  if (/^(?:click|activate|press)(?: the)?(?: button)?$/.test(text)) return { type: 'click' };
  const clickQuery = queryAfter(text, /^(?:click|activate|press)(?: the)?\s+(.+)$/);
  if (clickQuery) return { type: 'click', query: clickQuery.replace(/^button named\s+/, '').trim() };
  const namedQuery = queryAfter(text, /^(?:select|choose) (?:the )?(?:button )?named\s+(.+)$/);
  if (namedQuery) return { type: 'click', query: namedQuery };
  const focus = text.match(/^(?:focus|select|go to) (?:the )?(.+?)(?: field| input)?$/);
  if (focus && /field|input|search|message|departure|arrival|name|contact/.test(text)) return { type: 'focus', query: focus[1].trim() };
  if (/^open (?:the )?menu$/.test(text)) return { type: 'click', query: 'menu' };
  if (/^(?:check|tick) (?:the )?(?:checkbox|box)(?: named)?(?:\s+(.+))?$/.test(text)) return { type: 'check', checked: true, query: queryAfter(text, /^(?:check|tick) (?:the )?(?:checkbox|box)(?: named)?(?:\s+(.+))?$/) };
  if (/^(?:uncheck|untick) (?:the )?(?:checkbox|box)(?: named)?(?:\s+(.+))?$/.test(text)) return { type: 'check', checked: false, query: queryAfter(text, /^(?:uncheck|untick) (?:the )?(?:checkbox|box)(?: named)?(?:\s+(.+))?$/) };
  if (/^(?:select|choose) (?:the )?(.+)$/.test(text) && !/option (?:one|\d+)/.test(text)) return { type: 'select', query: text.replace(/^(?:select|choose) (?:the )?/, '').trim() };
  if (/^move to (.+)$/.test(text)) return { type: 'move', query: text.replace(/^move to /, '').trim() };

  if (/^start dictation$/.test(text) || text === 'dictate') return { type: 'start-dictation' };
  if (/^stop dictation$/.test(text)) return { type: 'stop-dictation' };
  const dictated = text.match(/^(?:type|enter|dictate)\s+(.+)$/);
  if (dictated) return { type: 'dictate', text: dictated[1] };
  const replace = text.match(/^replace that with\s+(.+)$/);
  if (replace) return { type: 'dictate', text: replace[1] };
  if (/^(?:clear|clear the|clear message|clear field|clear input)$/.test(text)) return { type: 'clear-field' };
  if (text === 'delete last word') return { type: 'delete-last-word' };
  if (text === 'delete last sentence') return { type: 'delete-last-sentence' };
  if (text === 'add a full stop') return { type: 'punctuation', value: 'full stop' };
  if (text === 'add a comma') return { type: 'punctuation', value: 'comma' };
  if (text === 'new line') return { type: 'punctuation', value: 'new line' };
  if (/^(?:send|submit)(?: the)?(?: message| form)?$/.test(text)) return { type: 'submit' };
  if (/^review(?: the)? (?:form|submission|booking)$/.test(text)) return { type: 'review-form' };
  if (/^next field$/.test(text)) return { type: 'next-field' };
  if (/^previous field$/.test(text)) return { type: 'previous-field' };
  if (/^(?:confirm|confirm booking)$/.test(text)) return { type: 'confirm' };
  if (/^pause$/.test(text)) return { type: 'pause' };
  if (/^resume$/.test(text)) return { type: 'resume' };
  if (/^recenter(?: pointer)?$/.test(text)) return { type: 'recenter' };
  if (/^main content$/.test(text)) return { type: 'main-content' };
  if (/^(?:open )?new tab$/.test(text)) return { type: 'new-tab' };

  if (/^(?:turn|enable) touchview on$/.test(text) || text === 'turn touchview on') return { type: 'touchview', action: 'enable' };
  if (/^(?:turn|disable) touchview off$/.test(text) || text === 'turn touchview off') return { type: 'touchview', action: 'disable' };
  if (/^pause touchview$/.test(text)) return { type: 'touchview', action: 'pause' };
  if (/^resume touchview$/.test(text)) return { type: 'touchview', action: 'resume' };
  if (/^(?:show|open) touchview settings$/.test(text)) return { type: 'touchview', action: 'settings' };
  if (/^(?:hide|close) touchview settings$/.test(text)) return { type: 'touchview', action: 'hide-settings' };
  if (/^recenter pointer$/.test(text)) return { type: 'touchview', action: 'recenter' };
  if (/^enable dwell$/.test(text)) return { type: 'touchview', action: 'dwell-on' };
  if (/^disable dwell$/.test(text)) return { type: 'touchview', action: 'dwell-off' };
  const dwell = text.match(/^set dwell to\s+([\d.]+|one|two|three|four|five) seconds?$/);
  if (dwell) return { type: 'touchview', action: 'set-dwell', value: numberFrom(dwell[1]) ?? 1 };
  if (/^increase sensitivity$/.test(text)) return { type: 'touchview', action: 'sensitivity-up' };
  if (/^decrease sensitivity$/.test(text)) return { type: 'touchview', action: 'sensitivity-down' };
  if (/^(?:start|begin) calibration$/.test(text)) return { type: 'touchview', action: 'calibrate' };
  if (/^cancel calibration$/.test(text)) return { type: 'touchview', action: 'cancel-calibration' };
  if (/^reset calibration$/.test(text)) return { type: 'touchview', action: 'reset-calibration' };

  if (/^start camera$/.test(text)) return { type: 'camera', action: 'start' };
  if (/^stop camera$/.test(text)) return { type: 'camera', action: 'stop' };
  if (/^pause tracking$/.test(text)) return { type: 'camera', action: 'pause' };
  if (/^resume tracking$/.test(text)) return { type: 'camera', action: 'resume' };
  if (/^enable hand control$/.test(text)) return { type: 'camera', action: 'hand-on' };
  if (/^disable hand control$/.test(text)) return { type: 'camera', action: 'hand-off' };
  if (/^enable head control$/.test(text)) return { type: 'camera', action: 'head-on' };
  if (/^disable head control$/.test(text)) return { type: 'camera', action: 'head-off' };
  if (/^enable fist scrolling$/.test(text)) return { type: 'camera', action: 'fist-scroll-on' };
  if (/^disable fist scrolling$/.test(text)) return { type: 'camera', action: 'fist-scroll-off' };
  if (/^(?:mirror camera|turn mirror on)$/.test(text)) return { type: 'camera', action: 'mirror-on' };
  if (/^turn mirror off$/.test(text)) return { type: 'camera', action: 'mirror-off' };
  if (/^increase camera opacity$/.test(text)) return { type: 'camera', action: 'opacity-up' };
  if (/^decrease camera opacity$/.test(text)) return { type: 'camera', action: 'opacity-down' };

  if (/^read headings$/.test(text)) return { type: 'read-headings' };
  if (/^read links$/.test(text)) return { type: 'read-links' };
  if (/^read buttons$/.test(text)) return { type: 'read-buttons' };
  if (/^read form fields$/.test(text)) return { type: 'read-form-fields' };
  if (/^read important information$/.test(text)) return { type: 'read-important' };
  if (/^find dates$/.test(text)) return { type: 'read-dates' };
  if (/^find contact information$/.test(text)) return { type: 'read-contact' };
  if (/^(?:list|what are) (?:the )?(?:available )?buttons$/.test(text)) return { type: 'list-buttons' };
  if (/^(?:stop reading|quiet)$/.test(text)) return { type: 'stop-reading' };
  if (/^(?:what is|read)(?: the)? deadline$/.test(text)) return { type: 'read-query', query: 'deadline' };
  if (/^(?:what are|read)(?: the)? (?:eligibility requirements|eligibility)$/.test(text)) return { type: 'read-query', query: 'eligibility requirements' };
  if (/^(?:what|which) documents (?:are required|do i need)$/.test(text) || /^read (?:the )?required documents$/.test(text)) return { type: 'read-query', query: 'required documents' };
  if (/^(?:where can i|where do i) apply$/.test(text) || /^read (?:the )?application link$/.test(text)) return { type: 'read-query', query: 'where can i apply' };
  if (/^read (?:this )?section$/.test(text)) return { type: 'read-section' };

  return null;
}

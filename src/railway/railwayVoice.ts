import { normalizeStation, type RailwayClass, type RailwayJourney } from './railwayData';

export type RailwayVoiceIntent =
  | { type: 'open' }
  | { type: 'set-from'; value: string }
  | { type: 'set-to'; value: string }
  | { type: 'request-date' }
  | { type: 'set-date'; value: string }
  | { type: 'set-journey'; value: RailwayJourney }
  | { type: 'set-passengers'; value: number }
  | { type: 'set-class'; value: RailwayClass }
  | { type: 'search' }
  | { type: 'choose'; value: number | 'first' | 'cheapest' | 'fastest' }
  | { type: 'next-option' }
  | { type: 'previous-option' }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'review' }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'clear' }
  | { type: 'read'; value: 'page' | 'results' | 'form' | 'fare' | 'required' | 'confirmation' }
  | { type: 'stop-reading' }
  | { type: 'help' }
  | { type: 'repeat' }
  | { type: 'start-over' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'close-settings' }
  | { type: 'exit-blind-mode' };

function clean(value: string): string {
  return value.toLowerCase().replace(/[.!?,]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseDate(value: string): string | null {
  const today = new Date();
  if (/\btomorrow\b/.test(value)) {
    today.setDate(today.getDate() + 1);
    return today.toISOString().slice(0, 10);
  }
  if (/\btoday\b/.test(value)) return today.toISOString().slice(0, 10);
  const iso = value.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const numeric = value.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](20\d{2}))?\b/);
  if (numeric) {
    const year = numeric[3] ?? String(today.getFullYear());
    return `${year}-${numeric[2].padStart(2, '0')}-${numeric[1].padStart(2, '0')}`;
  }
  return null;
}

export function parseRailwayCommand(input: string): RailwayVoiceIntent | null {
  const value = clean(input);
  if (!value) return null;
  if (/^(open|start)( the)? railway( booking)?( demo)?$/.test(value) || value === 'railway booking') return { type: 'open' };
  if (/^(stop|cancel) reading$/.test(value) || value === 'stop sense') return { type: 'stop-reading' };
  if (/^(exit|leave|stop) blind mode$/.test(value)) return { type: 'exit-blind-mode' };
  if (/^(close|hide) settings$/.test(value)) return { type: 'close-settings' };
  if (/^(start over|restart|reset booking)$/.test(value)) return { type: 'start-over' };
  if (/^(help|what can i say|commands)$/.test(value)) return { type: 'help' };
  if (/^(repeat|say that again)$/.test(value)) return { type: 'repeat' };
  if (/^(pause|pause touchview)$/.test(value)) return { type: 'pause' };
  if (/^(resume|resume touchview)$/.test(value)) return { type: 'resume' };
  if (/^(back|go back|previous step)$/.test(value)) return { type: 'back' };
  if (/^(next|continue|next step)$/.test(value)) return { type: 'next' };
  if (/^(review|review booking|review form)$/.test(value)) return { type: 'review' };
  if (/^(confirm|confirm booking|book ticket|approve)$/.test(value)) return { type: 'confirm' };
  if (/^(cancel|cancel booking|stop booking)$/.test(value)) return { type: 'cancel' };
  if (/^(clear|clear form|start again)$/.test(value)) return { type: 'clear' };
  if (/^(search|search trains|find trains|show trains)$/.test(value)) return { type: 'search' };
  if (/^(read|read page|read the page|read important information)$/.test(value)) return { type: 'read', value: 'page' };
  if (/^(read results|read trains|read available trains)$/.test(value)) return { type: 'read', value: 'results' };
  if (/^(read form|read booking form)$/.test(value)) return { type: 'read', value: 'form' };
  if (/^(read fare|what is the fare)$/.test(value)) return { type: 'read', value: 'fare' };
  if (/^(read required fields|what is required)$/.test(value)) return { type: 'read', value: 'required' };
  if (/^(read confirmation|read booking confirmation)$/.test(value)) return { type: 'read', value: 'confirmation' };
  if (/^(next|show) option$/.test(value) || value === 'next train') return { type: 'next-option' };
  if (/^(previous|prev|prior) option$/.test(value) || value === 'previous train') return { type: 'previous-option' };
  if (/^(choose|select) (?:option )?(first|one)$/.test(value)) return { type: 'choose', value: 'first' };
  if (/^(choose|select) (?:option )?(?:the )?cheapest$/.test(value)) return { type: 'choose', value: 'cheapest' };
  if (/^(choose|select) (?:option )?(?:the )?fastest$/.test(value)) return { type: 'choose', value: 'fastest' };
  const numbered = value.match(/^(?:choose|select) (?:option )?(\d+)$/);
  if (numbered) return { type: 'choose', value: Math.max(1, Number(numbered[1])) };
  const from = value.match(/^(?:from|departure(?: station)?|departing from)\s+(.+)$/);
  if (from) {
    const station = normalizeStation(from[1]);
    if (station) return { type: 'set-from', value: station };
  }
  const to = value.match(/^(?:to|arrival(?: station)?|going to)\s+(.+)$/);
  if (to) {
    const station = normalizeStation(to[1]);
    if (station) return { type: 'set-to', value: station };
  }
  if (/^(?:set )?(?:departure )?date$/.test(value) || /^change date$/.test(value)) return { type: 'request-date' };
  const date = parseDate(value);
  if (date) return { type: 'set-date', value: date };
  if (/^(one way|one-way|single)$/.test(value)) return { type: 'set-journey', value: 'one-way' };
  if (/^(return|round trip|round-trip)$/.test(value)) return { type: 'set-journey', value: 'return' };
  const passenger = value.match(/^(?:set )?(\d+|one|two|three|four|five|six|seven|eight|nine) passengers?$/);
  if (passenger) {
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
    return { type: 'set-passengers', value: Math.max(1, Math.min(9, words[passenger[1]] ?? Number(passenger[1]))) };
  }
  if (/^(general|open seating)$/.test(value)) return { type: 'set-class', value: 'general' };
  if (/^(sleeper|sleeping berth)$/.test(value)) return { type: 'set-class', value: 'sleeper' };
  if (/^(ac|ac chair|chair car|air conditioned)$/.test(value)) return { type: 'set-class', value: 'ac-chair' };
  if (/^(first ac|first class|premium cabin)$/.test(value)) return { type: 'set-class', value: 'first-ac' };
  return null;
}

export function railwayVoiceHelp(): string {
  return 'You can say: from Mumbai Central, to Delhi Junction, tomorrow, one way, two passengers, sleeper, search trains, choose first, review, confirm booking, read results, go back, or cancel.';
}

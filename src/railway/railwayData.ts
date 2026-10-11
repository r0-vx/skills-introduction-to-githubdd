export type RailwayStep =
  | 'WELCOME'
  | 'DEPARTURE'
  | 'ARRIVAL'
  | 'DATE'
  | 'JOURNEY_TYPE'
  | 'PASSENGERS'
  | 'CLASS'
  | 'SEARCHING'
  | 'RESULTS'
  | 'TRAIN_SELECTION'
  | 'PASSENGER_DETAILS'
  | 'REVIEW'
  | 'APPROVAL'
  | 'CONFIRMED';

export type RailwayJourney = 'one-way' | 'return';
export type RailwayClass = 'general' | 'sleeper' | 'ac-chair' | 'first-ac';

export interface RailwayForm {
  from: string;
  to: string;
  date: string;
  returnDate: string;
  journey: RailwayJourney;
  passengers: number;
  className: RailwayClass;
  passengerName: string;
  passengerDetails: string;
  contact: string;
}

export interface RailwayTrain {
  id: string;
  name: string;
  number: string;
  from: string;
  to: string;
  departure: string;
  arrival: string;
  duration: string;
  fares: Record<RailwayClass, number>;
  availability: Record<RailwayClass, number>;
}

export const RAILWAY_STATIONS = [
  'Mumbai Central',
  'Delhi Junction',
  'Pune Junction',
  'Bengaluru City',
  'Chennai Central',
  'Hyderabad Deccan',
  'Kolkata Terminal'
] as const;

export const RAILWAY_CLASSES: Array<{ value: RailwayClass; label: string; description: string }> = [
  { value: 'general', label: 'General', description: 'Open seating' },
  { value: 'sleeper', label: 'Sleeper', description: 'Reserved berth' },
  { value: 'ac-chair', label: 'AC Chair', description: 'Air-conditioned chair car' },
  { value: 'first-ac', label: 'First AC', description: 'Private premium cabin' }
];

export const RAILWAY_TRAINS: RailwayTrain[] = [
  {
    id: 'sunrise-express',
    name: 'Sunrise Express',
    number: 'HF 1024',
    from: 'Mumbai Central',
    to: 'Delhi Junction',
    departure: '08:30',
    arrival: '16:15',
    duration: '7h 45m',
    fares: { general: 520, sleeper: 850, 'ac-chair': 1350, 'first-ac': 2450 },
    availability: { general: 82, sleeper: 34, 'ac-chair': 18, 'first-ac': 6 }
  },
  {
    id: 'blue-line-intercity',
    name: 'Blue Line Intercity',
    number: 'HF 2088',
    from: 'Mumbai Central',
    to: 'Delhi Junction',
    departure: '09:45',
    arrival: '17:40',
    duration: '7h 55m',
    fares: { general: 460, sleeper: 790, 'ac-chair': 1290, 'first-ac': 2320 },
    availability: { general: 120, sleeper: 21, 'ac-chair': 9, 'first-ac': 3 }
  },
  {
    id: 'night-sky-limited',
    name: 'Night Sky Limited',
    number: 'HF 4410',
    from: 'Mumbai Central',
    to: 'Delhi Junction',
    departure: '21:10',
    arrival: '05:30',
    duration: '8h 20m',
    fares: { general: 430, sleeper: 760, 'ac-chair': 1240, 'first-ac': 2190 },
    availability: { general: 64, sleeper: 12, 'ac-chair': 4, 'first-ac': 0 }
  },
  {
    id: 'western-star',
    name: 'Western Star',
    number: 'HF 5732',
    from: 'Pune Junction',
    to: 'Bengaluru City',
    departure: '07:20',
    arrival: '18:05',
    duration: '10h 45m',
    fares: { general: 390, sleeper: 680, 'ac-chair': 1120, 'first-ac': 1980 },
    availability: { general: 95, sleeper: 26, 'ac-chair': 11, 'first-ac': 4 }
  },
  {
    id: 'coastal-dayliner',
    name: 'Coastal Dayliner',
    number: 'HF 6616',
    from: 'Chennai Central',
    to: 'Hyderabad Deccan',
    departure: '06:50',
    arrival: '15:25',
    duration: '8h 35m',
    fares: { general: 350, sleeper: 620, 'ac-chair': 980, 'first-ac': 1740 },
    availability: { general: 72, sleeper: 19, 'ac-chair': 8, 'first-ac': 2 }
  }
];

export const RAILWAY_FLOW: Array<{ step: RailwayStep; label: string }> = [
  { step: 'WELCOME', label: 'Welcome' },
  { step: 'DEPARTURE', label: 'From' },
  { step: 'ARRIVAL', label: 'To' },
  { step: 'DATE', label: 'Date' },
  { step: 'JOURNEY_TYPE', label: 'Journey' },
  { step: 'PASSENGERS', label: 'Passengers' },
  { step: 'CLASS', label: 'Class' },
  { step: 'RESULTS', label: 'Results' },
  { step: 'PASSENGER_DETAILS', label: 'Passenger details' },
  { step: 'REVIEW', label: 'Review' },
  { step: 'APPROVAL', label: 'Approval' },
  { step: 'CONFIRMED', label: 'Confirmed' }
];

export function tomorrowIso(now = new Date()): string {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function defaultRailwayForm(now = new Date()): RailwayForm {
  return {
    from: 'Mumbai Central',
    to: 'Delhi Junction',
    date: tomorrowIso(now),
    returnDate: '',
    journey: 'one-way',
    passengers: 1,
    className: 'sleeper',
    passengerName: '',
    passengerDetails: '',
    contact: ''
  };
}

export function findRailwayTrain(id: string | null | undefined): RailwayTrain | null {
  return RAILWAY_TRAINS.find((train) => train.id === id) ?? null;
}

export function availableRailwayTrains(form: Pick<RailwayForm, 'from' | 'to'>): RailwayTrain[] {
  const exact = RAILWAY_TRAINS.filter((train) => train.from === form.from && train.to === form.to);
  if (exact.length) return exact;
  return RAILWAY_TRAINS.slice(0, 3).map((train) => ({ ...train, from: form.from, to: form.to }));
}

export function fareFor(train: RailwayTrain, className: RailwayClass, passengers: number): number {
  return train.fares[className] * Math.max(1, passengers);
}

export function formatRailwayDate(value: string): string {
  if (!value) return 'Choose a date';
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export function buildBookingReference(seed = Date.now()): string {
  return `HF-DEMO-${String(Math.abs(Math.floor(seed)) % 1000000).padStart(6, '0')}`;
}

export function normalizeStation(value: string): string | null {
  const normalized = value.toLowerCase().replace(/station|railway|junction|central|terminal|city|deccan/g, '').replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  return RAILWAY_STATIONS.find((station) => {
    const stationNormalized = station.toLowerCase().replace(/junction|central|terminal|city|deccan/g, '').replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    return stationNormalized === normalized || station.toLowerCase() === value.toLowerCase().trim() || station.toLowerCase().includes(value.toLowerCase().trim());
  }) ?? null;
}

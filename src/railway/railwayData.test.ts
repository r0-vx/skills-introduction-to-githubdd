import { describe, expect, it } from 'vitest';
import { availableRailwayTrains, buildBookingReference, defaultRailwayForm, fareFor, formatRailwayDate, findRailwayTrain } from './railwayData';

describe('railway demo data', () => {
  it('creates a stable local booking form with a future date', () => {
    const form = defaultRailwayForm(new Date('2026-10-11T12:00:00Z'));
    expect(form.from).toBe('Mumbai Central');
    expect(form.to).toBe('Delhi Junction');
    expect(form.date).toBe('2026-10-12');
  });

  it('returns exact route results and calculates a passenger fare', () => {
    const form = defaultRailwayForm();
    const trains = availableRailwayTrains(form);
    expect(trains).toHaveLength(3);
    expect(fareFor(trains[0], 'sleeper', 2)).toBe(1700);
    expect(findRailwayTrain(trains[1].id)?.name).toBe('Blue Line Intercity');
  });

  it('formats dates and keeps references local', () => {
    expect(formatRailwayDate('2026-12-24')).toContain('Dec');
    expect(buildBookingReference(42)).toBe('HF-DEMO-000042');
  });
});

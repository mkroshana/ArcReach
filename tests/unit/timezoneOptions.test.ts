import { describe, it, expect } from 'vitest';
import { buildTimezoneOptions } from '../../hooks/use-timezones';

describe('buildTimezoneOptions', () => {
  it('adds UTC, the campaign default, when the runtime list leaves it out', () => {
    const tzs = Intl.supportedValuesOf('timeZone');
    const options = buildTimezoneOptions(tzs);

    const utc = options.filter(o => o.value === 'UTC');
    expect(utc).toEqual([{ value: 'UTC', label: '(UTC+00:00) UTC Offset' }]);
    expect(options).toHaveLength(tzs.includes('UTC') ? tzs.length : tzs.length + 1);
  });

  it('lists UTC once when the given names already include it', () => {
    const options = buildTimezoneOptions(['America/New_York', 'UTC', 'Europe/Berlin'], new Date('2026-01-15T12:00:00Z'));

    expect(options.map(o => o.value).filter(v => v === 'UTC')).toHaveLength(1);
    expect(options).toHaveLength(3);
  });

  it('keeps every given zone with its offset label, sorted by label', () => {
    const options = buildTimezoneOptions(['Asia/Tokyo', 'America/New_York'], new Date('2026-01-15T12:00:00Z'));

    expect(options).toEqual([
      { value: 'America/New_York', label: '(UTC-05:00) Eastern Time (US & Canada)' },
      { value: 'UTC', label: '(UTC+00:00) UTC Offset' },
      { value: 'Asia/Tokyo', label: '(UTC+09:00) Asia/Tokyo' },
    ]);
  });
});

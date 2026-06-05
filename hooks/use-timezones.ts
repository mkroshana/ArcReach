/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect } from 'react';

export interface TimezoneOption {
  value: string;
  label: string;
}

export function useTimezones() {
  const [timezoneOptions, setTimezoneOptions] = useState<TimezoneOption[]>([
    { value: 'America/New_York', label: '(UTC-05:00) Eastern Time (US & Canada)' },
    { value: 'America/Los_Angeles', label: '(UTC-08:00) Pacific Time (US & Canada)' },
    { value: 'UTC', label: '(UTC+00:00) UTC Offset' }
  ]);

  useEffect(() => {
    try {
      const tzs = Intl.supportedValuesOf('timeZone');
      const date = new Date();
      const options = tzs.map(tz => {
        try {
          const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            timeZoneName: 'longOffset'
          });
          const parts = formatter.formatToParts(date);
          const tzNamePart = parts.find(p => p.type === 'timeZoneName');
          const offset = tzNamePart ? tzNamePart.value : '';
          const utcOffset = offset.replace('GMT', 'UTC');
          
          let cleanLabel = tz;
          if (tz === 'America/New_York') cleanLabel = 'Eastern Time (US & Canada)';
          else if (tz === 'America/Los_Angeles') cleanLabel = 'Pacific Time (US & Canada)';
          else if (tz === 'UTC') cleanLabel = 'UTC Offset';
          
          return {
            value: tz,
            label: `${utcOffset ? `(${utcOffset}) ` : ''}${cleanLabel}`
          };
        } catch (e) {
          return { value: tz, label: tz };
        }
      }).sort((a, b) => a.label.localeCompare(b.label));

      setTimezoneOptions(options);
    } catch (e) {
      // Keep defaults on failure
    }
  }, []);

  return timezoneOptions;
}

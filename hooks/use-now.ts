import { useState, useEffect } from 'react';

/**
 * The current time, read again on every whole `intervalMs` of the clock, so a
 * seconds display changes with the second and never skips one. Null on the
 * server and while hydrating, then the real time, so a clock never renders a
 * time the client would not match.
 */
export function useNow(intervalMs = 1000): Date | null {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(new Date());
      timer = setTimeout(tick, intervalMs - (Date.now() % intervalMs));
    };
    tick();
    return () => clearTimeout(timer);
  }, [intervalMs]);

  return now;
}

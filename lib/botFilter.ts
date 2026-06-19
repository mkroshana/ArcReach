// Patterns that match known email-security scanners. Conservative by design —
// excludes Gmail Image Proxy and Apple Mail Privacy Protection because those
// prefetch every legitimate recipient's pixel; filtering them would discard
// real human opens.
const SCANNER_UA_PATTERNS: RegExp[] = [
  /barracuda/i,
  /proofpoint/i,
  /mimecast/i,
  /messagelabs/i,
  /symantec/i,
  /sophos/i,
  /forcepoint/i,
  /ironport/i,
  /mailscanner/i,
  /\bmxtoolbox\b/i,
  /microsoft.+(atp|defender|safelinks)/i,
  /ms-office-protocol-discovery/i,
];

// Threshold constants
export const PREFETCH_WINDOW_OPEN_SECONDS = 10;
export const PREFETCH_WINDOW_CLICK_SECONDS = 5;

export function isLikelyScannerUA(userAgent: string | null): boolean {
  if (!userAgent) return false;
  return SCANNER_UA_PATTERNS.some((pattern) => pattern.test(userAgent));
}

// kind: 'open' uses 10s window; 'click' uses 5s window.
// Returns true if the event arrived suspiciously fast after the dispatch
// row was created (i.e. likely a gateway pre-scan, not a human).
export function isWithinPrefetchWindow(
  sentAt: Date,
  kind: 'open' | 'click',
  now: Date = new Date(),
): boolean {
  const sentTime = new Date(sentAt).getTime();
  const nowTime = now.getTime();
  const elapsedSeconds = (nowTime - sentTime) / 1000;
  
  if (elapsedSeconds < 0) {
    // If the system clocks are out of sync or the sentAt is in the future,
    // default to false (don't drop it).
    return false;
  }
  
  const threshold = kind === 'open' ? PREFETCH_WINDOW_OPEN_SECONDS : PREFETCH_WINDOW_CLICK_SECONDS;
  return elapsedSeconds < threshold;
}

// Single decision function used by the track endpoints.
export function shouldDropEvent(
  sentAt: Date,
  userAgent: string | null,
  kind: 'open' | 'click',
): { drop: boolean; reason?: string } {
  if (isLikelyScannerUA(userAgent)) {
    return { drop: true, reason: 'scanner-ua' };
  }
  
  if (isWithinPrefetchWindow(sentAt, kind)) {
    return { drop: true, reason: 'prefetch-window' };
  }
  
  return { drop: false };
}

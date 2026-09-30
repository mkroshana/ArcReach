/** How long a toast stays on screen before it hides itself. */
export const TOAST_DURATION_MS = 4000;

/** Error messages longer than this cannot be read in a few seconds, so they stay until dismissed. */
export const LONG_TOAST_LENGTH = 80;

/**
 * Milliseconds a toast stays, or null when it stays until dismissed: an error
 * longer than LONG_TOAST_LENGTH, such as a server's explanation of a refused
 * save, would otherwise disappear before it is read.
 */
export function toastDuration(message: string, type: string, durationMs: number = TOAST_DURATION_MS): number | null {
  return type === 'error' && message.length > LONG_TOAST_LENGTH ? null : durationMs;
}

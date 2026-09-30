/**
 * The Content-Security-Policy middleware.ts sends with every page, built on a fresh per-request
 * nonce. Next reads the nonce from the policy on the forwarded request and puts it on its own
 * scripts; app/layout.tsx puts it on the inline theme script. 'strict-dynamic' lets those nonced
 * scripts load the app's chunks, so no other script can run.
 *
 * Styles stay 'unsafe-inline' without a nonce: MUI/Emotion and React style props write inline
 * styles, and a nonce in style-src would make browsers ignore 'unsafe-inline'. Google Fonts is
 * allowed for the Google Sans Flex stylesheet app/globals.css imports and its font files. The
 * email preview iframes (srcdoc) inherit this policy, so their templates may use inline styles,
 * https or data: images and Google Fonts, but no other remote stylesheet or font.
 *
 * Development adds 'unsafe-eval' (React Refresh and eval source maps) and ws:/wss: (hot reload).
 * API routes are left alone: the unsubscribe and click pages send their own stricter policy.
 */
export function buildContentSecurityPolicy(nonce: string, isDev: boolean): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ];
  return directives.join('; ');
}

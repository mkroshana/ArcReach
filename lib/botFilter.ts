// Bot filtering for the open and click tracking routes. A hit judged automated
// is still recorded, as a machine open or machine click with its reason, and
// engagement metrics count only a person's 'open' and 'click'.

// Patterns that match known email-security scanners, which fetch every pixel
// and link of an email when it is delivered.
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

// Other automated clients: crawlers, link unfurlers (a recipient pasting a
// tracked link into Slack, Teams or WhatsApp), headless browsers and HTTP
// libraries. Mail providers' image proxies (Gmail's GoogleImageProxy,
// YahooMailProxy) fetch the pixel only when a person opens the email, so they
// are not matched. Neither are Android HTTP stacks (okhttp, Dalvik), which
// some mail apps load images with.
const BOT_UA_PATTERNS: RegExp[] = [
  // Self-named bots: Googlebot, bingbot, Slackbot-LinkExpanding, Twitterbot,
  // LinkedInBot, Discordbot, TelegramBot, Applebot... but not Cubot phones.
  /(?<!cu)bot\b/i,
  /crawl|spider|slurp|scrapy|ia_archiver/i,
  /facebookexternalhit|whatsapp\/|skypeuripreview|microsoftpreview|slack-imgproxy|embedly|iframely|vkshare|googleother|google-pagerenderer|existence discovery/i,
  /headlesschrome|phantomjs/i,
  // http.rb is also Mastodon's link preview fetcher, once per federated server.
  /^curl\/|\bwget\/|python-requests|python-urllib|python-httpx|aiohttp|go-http-client|^java\/|apache-httpclient|axios\/|node-fetch|undici|^node$|libwww-perl|^ruby\b|faraday|guzzlehttp|http\.rb|postmanruntime|httpie/i,
];

// Apple Mail Privacy Protection fetches every pixel through Apple's proxy when
// the email arrives, whether or not it is ever opened, under this bare user
// agent. Browsers and mail clients always send platform details after it.
const APPLE_PRIVACY_PROXY_UA = /^Mozilla\/5\.0$/;

// Threshold constants
export const PREFETCH_WINDOW_OPEN_SECONDS = 10;
export const PREFETCH_WINDOW_CLICK_SECONDS = 5;
/** Clicks on different links of one email this close together are a scanner following every link. */
export const LINK_BURST_SECONDS = 2;

export type EngagementKind = 'open' | 'click';

/** Why a tracked open or click was judged automated. */
export type BotReason =
  | 'missing-ua'
  | 'scanner-ua'
  | 'bot-ua'
  | 'apple-mpp'
  | 'prefetch-window'
  | 'link-burst';

/** The event types automated opens and clicks are recorded under; metrics never count them. */
export const MACHINE_EVENT_TYPE = { open: 'machine_open', click: 'machine_click' } as const;

export function isLikelyScannerUA(userAgent: string | null): boolean {
  if (!userAgent) return false;
  return SCANNER_UA_PATTERNS.some((pattern) => pattern.test(userAgent));
}

export function isLikelyBotUA(userAgent: string | null): boolean {
  if (!userAgent) return false;
  return BOT_UA_PATTERNS.some((pattern) => pattern.test(userAgent));
}

export function isApplePrivacyProxyUA(userAgent: string | null): boolean {
  return APPLE_PRIVACY_PROXY_UA.test(userAgent?.trim() ?? '');
}

/**
 * Why this user agent is not a person's, or null when it may be one. Browsers
 * and mail clients always send a user agent, so a missing one is automated.
 * The bare Apple Mail Privacy Protection agent is Apple's proxy on an open;
 * MPP never fetches links, so on a click it is just an unnamed client.
 */
export function userAgentBotReason(userAgent: string | null, kind: EngagementKind): BotReason | null {
  const ua = userAgent?.trim();
  if (!ua) return 'missing-ua';
  if (isLikelyScannerUA(ua)) return 'scanner-ua';
  if (isLikelyBotUA(ua)) return 'bot-ua';
  if (isApplePrivacyProxyUA(ua)) return kind === 'open' ? 'apple-mpp' : 'bot-ua';
  return null;
}

/** The dispatch fields the filter reads. */
export interface TrackedDispatch {
  status: string;
  sentAt: Date;
  acceptedAt: Date | null;
}

/**
 * When the prefetch window starts: when the dispatch became Sent, ACS having
 * accepted it (acceptedAt). sentAt is set before the send, so it stands in
 * only for rows accepted before acceptedAt existed and rows recorded after
 * their send (Unibox replies, mailbox tests). Null for a dispatch ACS has not
 * accepted, still Sending or Failed.
 */
export function prefetchWindowStart(dispatch: TrackedDispatch): Date | null {
  if (dispatch.acceptedAt) return new Date(dispatch.acceptedAt);
  if (dispatch.status === 'Sending' || dispatch.status === 'Failed') return null;
  return new Date(dispatch.sentAt);
}

// kind: 'open' uses 10s window; 'click' uses 5s window.
// Returns true if the event arrived suspiciously fast after the send was
// accepted (i.e. likely a gateway pre-scan on delivery, not a human), or
// before the acceptance was recorded at all (windowStart null or later than now).
export function isWithinPrefetchWindow(
  windowStart: Date | null,
  kind: EngagementKind,
  now: Date = new Date(),
): boolean {
  if (!windowStart) return true;
  const elapsedSeconds = (now.getTime() - new Date(windowStart).getTime()) / 1000;
  const threshold = kind === 'open' ? PREFETCH_WINDOW_OPEN_SECONDS : PREFETCH_WINDOW_CLICK_SECONDS;
  return elapsedSeconds < threshold;
}

/**
 * Single decision function used by the track endpoints: why an open or click
 * on this dispatch is judged automated, or null when it counts as a person's.
 * The click endpoint also applies LINK_BURST_SECONDS, which needs the
 * dispatch's other clicks.
 */
export function engagementBotReason(
  dispatch: TrackedDispatch,
  userAgent: string | null,
  kind: EngagementKind,
  now: Date = new Date(),
): BotReason | null {
  const uaReason = userAgentBotReason(userAgent, kind);
  if (uaReason) return uaReason;
  return isWithinPrefetchWindow(prefetchWindowStart(dispatch), kind, now) ? 'prefetch-window' : null;
}

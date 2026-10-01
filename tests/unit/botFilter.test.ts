import { describe, it, expect } from 'vitest';
import {
  engagementBotReason,
  isLikelyScannerUA,
  isWithinPrefetchWindow,
  prefetchWindowStart,
  userAgentBotReason,
} from '../../lib/botFilter';

// Real user agents, as they arrive at the tracking endpoints.
const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  // Apple Mail without Mail Privacy Protection, on a Mac and an iPhone.
  appleMailMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  appleMailIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  outlookDesktop: 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17029; Pro)',
  thunderbird: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Thunderbird/115.4.1',
  gmailProxy: 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)',
  yahooProxy: 'YahooMailProxy; https://help.yahoo.com/kb/yahoo-mail-proxy-SLN28749.html',
  cubotPhone: 'Mozilla/5.0 (Linux; Android 11; CUBOT NOTE 20 PRO) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.104 Mobile Safari/537.36',
  // Apple Mail Privacy Protection's proxy.
  applePrivacyProxy: 'Mozilla/5.0',
};

const BOTS: Array<[string, string]> = [
  ['Slack link unfurling', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'],
  ['Slack image proxy', 'Slack-ImgProxy (+https://api.slack.com/robots)'],
  ['Teams / Skype link preview', 'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com'],
  ['Microsoft link preview', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36 Edg/112.0.1722.48 MicrosoftPreview/2.0 +https://aka.ms/MicrosoftPreview'],
  ['Facebook', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'],
  ['Twitter', 'Twitterbot/1.0'],
  ['LinkedIn', 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)'],
  ['Discord', 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'],
  ['Telegram', 'TelegramBot (like TwitterBot)'],
  ['WhatsApp', 'WhatsApp/2.23.20.0 A'],
  ['Mastodon link preview', 'Mastodon/4.2.1 (http.rb/5.1.1; +https://mastodon.social/)'],
  ['Google page renderer', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko; Google-PageRenderer Google (+https://developers.google.com/+/web/snippet/)) Chrome/56.0.2924.87 Safari/537.36'],
  ['Office link check', 'Microsoft Office Existence Discovery'],
  ['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
  ['bingbot', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36'],
  ['Baidu', 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)'],
  ['Yahoo Slurp', 'Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)'],
  ['Headless Chrome', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36'],
  ['curl', 'curl/8.4.0'],
  ['Wget', 'Wget/1.21.4'],
  ['python-requests', 'python-requests/2.31.0'],
  ['Python urllib', 'Python-urllib/3.11'],
  ['aiohttp', 'Python/3.11 aiohttp/3.9.1'],
  ['Go', 'Go-http-client/1.1'],
  ['Java', 'Java/17.0.8'],
  ['Apache HttpClient', 'Apache-HttpClient/4.5.14 (Java/17.0.8)'],
  ['axios', 'axios/1.6.2'],
  ['node-fetch', 'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)'],
  ['Node fetch', 'node'],
  ['undici', 'undici'],
  ['Perl', 'libwww-perl/6.72'],
  ['Postman', 'PostmanRuntime/7.36.0'],
];

describe('isLikelyScannerUA', () => {
  it('should return true for known email-security scanners UAs', () => {
    expect(isLikelyScannerUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Barracuda Sentinel/1.0')).toBe(true);
    expect(isLikelyScannerUA('Mimecast Scanner UA')).toBe(true);
    expect(isLikelyScannerUA('Proofpoint Protection Server')).toBe(true);
    expect(isLikelyScannerUA('Mozilla/5.0 (Windows NT; Microsoft ATP; Microsoft SafeLinks)')).toBe(true);
    expect(isLikelyScannerUA('Mozilla/5.0 ms-office-protocol-discovery')).toBe(true);
  });

  it('should return false for regular browsers, mail clients and proxy servers UAs', () => {
    expect(isLikelyScannerUA(UA.chrome)).toBe(false);
    expect(isLikelyScannerUA(UA.gmailProxy)).toBe(false);
    expect(isLikelyScannerUA(UA.appleMailMac)).toBe(false);
    expect(isLikelyScannerUA(UA.outlookDesktop)).toBe(false);
  });
});

describe('userAgentBotReason (M35, M36)', () => {
  it.each([
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
  ])('treats a %s user agent as automated: browsers and mail clients always send one', (_label, ua) => {
    expect(userAgentBotReason(ua, 'open')).toBe('missing-ua');
    expect(userAgentBotReason(ua, 'click')).toBe('missing-ua');
  });

  it('names email-security gateways as scanners', () => {
    expect(userAgentBotReason('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Barracuda Sentinel/1.0', 'click')).toBe('scanner-ua');
  });

  it.each(BOTS)('treats %s as a bot', (_label, ua) => {
    expect(userAgentBotReason(ua, 'open')).toBe('bot-ua');
    expect(userAgentBotReason(ua, 'click')).toBe('bot-ua');
  });

  it('treats the Apple Mail Privacy Protection proxy as a machine open', () => {
    expect(userAgentBotReason(UA.applePrivacyProxy, 'open')).toBe('apple-mpp');
  });

  it('treats the bare MPP user agent on a click as a bot, since MPP never fetches links', () => {
    expect(userAgentBotReason(UA.applePrivacyProxy, 'click')).toBe('bot-ua');
  });

  it.each(Object.entries(UA).filter(([name]) => name !== 'applePrivacyProxy'))(
    'counts %s as a person',
    (_name, ua) => {
      expect(userAgentBotReason(ua, 'open')).toBeNull();
      expect(userAgentBotReason(ua, 'click')).toBeNull();
    },
  );
});

describe('prefetchWindowStart (M34)', () => {
  const sentAt = new Date('2026-06-19T09:59:00Z');
  const acceptedAt = new Date('2026-06-19T09:59:40Z');

  it('starts when ACS accepted the send, not when the dispatch row was created', () => {
    expect(prefetchWindowStart({ status: 'Sent', sentAt, acceptedAt })).toEqual(acceptedAt);
  });

  it('falls back to sentAt for sends recorded before acceptedAt existed or after the send', () => {
    expect(prefetchWindowStart({ status: 'Sent', sentAt, acceptedAt: null })).toEqual(sentAt);
    expect(prefetchWindowStart({ status: 'Unknown', sentAt, acceptedAt: null })).toEqual(sentAt);
  });

  it('has no start for a dispatch ACS has not accepted', () => {
    expect(prefetchWindowStart({ status: 'Sending', sentAt, acceptedAt: null })).toBeNull();
    expect(prefetchWindowStart({ status: 'Failed', sentAt, acceptedAt: null })).toBeNull();
  });
});

describe('isWithinPrefetchWindow', () => {
  const now = new Date('2026-06-19T10:00:00Z');

  it('counts opens and clicks up to 2 minutes after the send was accepted as the gateway on delivery', () => {
    for (const kind of ['open', 'click'] as const) {
      expect(isWithinPrefetchWindow(new Date('2026-06-19T09:59:58Z'), kind, now)).toBe(true); // 2 seconds ago
      expect(isWithinPrefetchWindow(new Date('2026-06-19T09:58:30Z'), kind, now)).toBe(true); // 90 seconds ago
      expect(isWithinPrefetchWindow(new Date('2026-06-19T09:58:01Z'), kind, now)).toBe(true); // 119 seconds ago
    }
  });

  it('lets opens and clicks from 2 minutes after the send was accepted count', () => {
    for (const kind of ['open', 'click'] as const) {
      expect(isWithinPrefetchWindow(new Date('2026-06-19T09:58:00Z'), kind, now)).toBe(false); // exactly 2 minutes ago
      expect(isWithinPrefetchWindow(new Date('2026-06-19T09:57:00Z'), kind, now)).toBe(false); // 3 minutes ago
    }
  });

  it('counts a hit before the acceptance was recorded, or with no acceptance yet, as a prefetch', () => {
    expect(isWithinPrefetchWindow(new Date('2026-06-19T10:00:01Z'), 'open', now)).toBe(true);
    expect(isWithinPrefetchWindow(null, 'click', now)).toBe(true);
  });
});

describe('engagementBotReason', () => {
  const now = new Date('2026-06-19T10:00:00Z');
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

  it('flags scanner user-agents whenever they arrive', () => {
    const dispatch = { status: 'Sent', sentAt: ago(3600), acceptedAt: ago(3590) };
    expect(engagementBotReason(dispatch, 'Barracuda Sentinel', 'open', now)).toBe('scanner-ua');
  });

  it('flags a browser click 2s after ACS accepted a send whose row was created 42s earlier (the gateway scan on delivery)', () => {
    const dispatch = { status: 'Sent', sentAt: ago(42), acceptedAt: ago(2) };
    expect(engagementBotReason(dispatch, UA.chrome, 'click', now)).toBe('prefetch-window');
  });

  it('flags a browser hit on a dispatch still Sending', () => {
    const dispatch = { status: 'Sending', sentAt: ago(30), acceptedAt: null };
    expect(engagementBotReason(dispatch, UA.chrome, 'open', now)).toBe('prefetch-window');
  });

  it('flags a Slackbot unfurl hours after the send', () => {
    const dispatch = { status: 'Sent', sentAt: ago(4 * 3600), acceptedAt: ago(4 * 3600 - 5) };
    expect(engagementBotReason(dispatch, 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'click', now)).toBe('bot-ua');
  });

  it('flags an Apple MPP pixel fetch however late it arrives', () => {
    const dispatch = { status: 'Sent', sentAt: ago(600), acceptedAt: ago(590) };
    expect(engagementBotReason(dispatch, UA.applePrivacyProxy, 'open', now)).toBe('apple-mpp');
  });

  it('flags a browser click a minute after the send was accepted: a link scanner on delivery', () => {
    const dispatch = { status: 'Sent', sentAt: ago(70), acceptedAt: ago(60) };
    expect(engagementBotReason(dispatch, UA.chrome, 'click', now)).toBe('prefetch-window');
    expect(engagementBotReason(dispatch, UA.appleMailIphone, 'open', now)).toBe('prefetch-window');
  });

  it('counts a person after the prefetch window', () => {
    const dispatch = { status: 'Sent', sentAt: ago(190), acceptedAt: ago(180) };
    expect(engagementBotReason(dispatch, UA.appleMailIphone, 'open', now)).toBeNull();
    expect(engagementBotReason(dispatch, UA.chrome, 'click', now)).toBeNull();
  });
});

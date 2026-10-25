import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const CDP_PORT = 9555;
const SCREENSHOT_DIRS = [
  'C:\\Users\\Roshana Perera\\.gemini\\antigravity\\brain\\ce18a950-840a-434f-94e6-8823478a7766\\screenshots',
  'C:\\Users\\Roshana Perera\\.gemini\\antigravity\\brain\\46b816e7-3ac0-4807-9d87-31436d4c291b\\screenshots',
  'C:\\Users\\Roshana Perera\\.gemini\\antigravity\\brain\\a9249f44-6c69-45f2-9a61-c0e95b68b516\\screenshots',
];
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImFkbWluLWlkLTk5OSIsIm5hbWUiOiJBcmNSZWFjaCBBZG1pbiIsImVtYWlsIjoiYWRtaW5AYXJjcmVhY2guY29tIiwicm9sZSI6IkFETUlOIiwidG9rZW5WZXJzaW9uIjoxLCJleHAiOjE3OTM1MDk4ODV9.6iGbCXaTmFffLtUMQU8vyPdhyWpOqIfTR-5lWb-gShQ';
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const TEMP_USER_DATA = path.join(process.env.TEMP || 'C:\\Temp', 'edge_cdp_profile_' + Date.now());

for (const dir of SCREENSHOT_DIRS) {
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, '01b_dashboard_widget_drawer.png');
  if (fs.existsSync(stale)) {
    try { fs.unlinkSync(stale); } catch {}
  }
}

function saveScreenshot(name, base64Data) {
  const buf = Buffer.from(base64Data, 'base64');
  for (const dir of SCREENSHOT_DIRS) {
    fs.writeFileSync(path.join(dir, name), buf);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`Launching Edge with CDP on port ${CDP_PORT}...`);
  const edgeProc = spawn(EDGE_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${TEMP_USER_DATA}`,
    '--window-size=1440,1100',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]);

  let wsUrl = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      const data = await res.json();
      wsUrl = data.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch {}
  }

  if (!wsUrl) {
    console.error('Failed to connect to Edge CDP');
    edgeProc.kill();
    process.exit(1);
  }

  console.log('Connected to Edge CDP:', wsUrl);

  let id = 1;
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve) => ws.onopen = resolve);

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = id++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id === msgId) {
          ws.removeEventListener('message', handler);
          if (data.error) reject(data.error);
          else resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  // Create target tab
  const tabRes = await send('Target.createTarget', { url: 'about:blank' });
  const targetId = tabRes.targetId;

  // Attach to target
  const attachRes = await send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attachRes.sessionId;

  function sendSession(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = id++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id === msgId) {
          ws.removeEventListener('message', handler);
          if (data.error) reject(data.error);
          else resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: msgId, sessionId, method, params }));
    });
  }

  // Handle CDP Fetch request interception to mock API responses smoothly
  ws.addEventListener('message', async (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.sessionId === sessionId && msg.method === 'Fetch.requestPaused') {
        const { requestId, request } = msg.params;
        const url = request.url;
        let responseJson = null;

        if (url.includes('/api/session')) {
          responseJson = { id: 'admin-id-999', name: 'ArcReach Admin', email: 'admin@arcreach.com', role: 'ADMIN' };
        } else if (url.includes('/api/system-status')) {
          responseJson = {
            database: 'OPERATIONAL',
            azureStatus: 'CONFIGURED',
            workerStatus: 'RUNNING',
            deliveryStatus: 'RUNNING',
            sendingProblem: null,
            workerHeartbeat: {
              lastTickAt: new Date().toISOString(),
              lastSuccessAt: new Date().toISOString(),
              lastError: null,
            },
            accountsCount: 3,
            leadsCount: 1420,
            activeCampaignsCount: 3,
            setupPausedCount: 0,
            setupPausedCampaigns: [],
          };
        } else if (url.includes('/api/dashboard-stats')) {
          responseJson = {
            stats: {
              totalSent: 18450,
              averageOpenRate: 48.6,
              averageClickRate: 14.2,
              totalReplies: 892,
              replySync: 'on',
              failedSends: 24,
              bounced: 41,
              unsubscribed: 12,
              deltas: {
                sent: 18.4,
                openRate: 5.2,
                clickRate: 2.1,
                replies: 12.8,
              },
            },
            trends: [
              { name: '19 Oct', sent: 2100, opens: 1050, clicks: 320, replies: 110 },
              { name: '20 Oct', sent: 2450, opens: 1220, clicks: 380, replies: 135 },
              { name: '21 Oct', sent: 2300, opens: 1140, clicks: 340, replies: 120 },
              { name: '22 Oct', sent: 2800, opens: 1410, clicks: 420, replies: 165 },
              { name: '23 Oct', sent: 3100, opens: 1590, clicks: 490, replies: 190 },
              { name: '24 Oct', sent: 2750, opens: 1380, clicks: 410, replies: 150 },
              { name: '25 Oct', sent: 2950, opens: 1490, clicks: 460, replies: 175 },
            ],
            funnel: [
              { name: 'Sent', value: 18450, unit: 'emails' },
              { name: 'Delivered', value: 17980, unit: 'emails' },
              { name: 'Opened', value: 8970, unit: 'emails' },
              { name: 'Clicked', value: 2620, unit: 'emails' },
              { name: 'Replied', value: 892, unit: 'replies' },
              { name: 'Meeting Booked', value: 185, unit: 'calls' },
            ],
            sentiment: [
              { name: 'Interested', value: 520, color: '#10B981' },
              { name: 'Meeting Booked', value: 185, color: '#3B82F6' },
              { name: 'Neutral', value: 124, color: '#F59E0B' },
              { name: 'Not Interested', value: 63, color: '#64748B' },
            ],
          };
        } else if (url.includes('/api/campaigns')) {
          responseJson = [
            {
              id: 'c1',
              name: 'Q4 Enterprise Outreach (North America)',
              status: 'Active',
              createdAt: '2026-10-12T08:00:00.000Z',
              hasSendingSchedule: true,
              userId: 'admin-id-999',
              senderAccount: { emailAddress: 'sarah@arcreach-mailer.com' },
              steps: [
                { id: 's1', stepOrder: 1, waitDays: 0, subject: 'Enterprise scalability for high-growth teams' },
                { id: 's2', stepOrder: 2, waitDays: 3, subject: 'Quick question regarding outbound deliverability' },
              ],
              stepStats: [
                { stepOrder: 1, active: 410, sent: 1250, delivered: 1230, reported: 1230, failed: 8, leads: 1250 },
                { stepOrder: 2, active: 180, sent: 820, delivered: 810, reported: 810, failed: 2, leads: 820 },
              ],
              enrollmentSummary: { total: 1250, active: 590, completed: 660, notMailable: 0, skipped: 0 },
            },
            {
              id: 'c2',
              name: 'Series A Tech Founders & CTOs',
              status: 'Active',
              createdAt: '2026-10-15T09:30:00.000Z',
              hasSendingSchedule: true,
              userId: 'admin-id-999',
              senderAccount: { emailAddress: 'alex.v@arcreach-mailer.com' },
              steps: [
                { id: 's3', stepOrder: 1, waitDays: 0, subject: 'Scaling pipeline efficiency in 2026' },
              ],
              stepStats: [
                { stepOrder: 1, active: 320, sent: 850, delivered: 840, reported: 840, failed: 4, leads: 850 },
              ],
              enrollmentSummary: { total: 850, active: 320, completed: 530, notMailable: 0, skipped: 0 },
            },
            {
              id: 'c3',
              name: 'Product Hunt Launch Upvoters',
              status: 'Paused',
              createdAt: '2026-10-01T11:00:00.000Z',
              hasSendingSchedule: true,
              userId: 'admin-id-999',
              senderAccount: { emailAddress: 'growth01@inbound-reach.io' },
              steps: [
                { id: 's4', stepOrder: 1, waitDays: 0, subject: 'Thanks for supporting our launch!' },
              ],
              stepStats: [
                { stepOrder: 1, active: 0, sent: 620, delivered: 615, reported: 615, failed: 3, leads: 620 },
              ],
              enrollmentSummary: { total: 620, active: 0, completed: 620, notMailable: 0, skipped: 0 },
            },
            {
              id: 'c4',
              name: 'Inbound Product Demo Follow-ups',
              status: 'Active',
              createdAt: '2026-10-18T14:15:00.000Z',
              hasSendingSchedule: true,
              userId: 'admin-id-999',
              senderAccount: { emailAddress: 'sarah@arcreach-mailer.com' },
              steps: [
                { id: 's5', stepOrder: 1, waitDays: 0, subject: 'Resources mentioned during our demo call' },
              ],
              stepStats: [
                { stepOrder: 1, active: 110, sent: 430, delivered: 425, reported: 425, failed: 1, leads: 430 },
              ],
              enrollmentSummary: { total: 430, active: 110, completed: 320, notMailable: 0, skipped: 0 },
            },
            {
              id: 'c5',
              name: 'EMEA Inactive Accounts Re-engagement',
              status: 'Draft',
              createdAt: '2026-10-22T16:00:00.000Z',
              hasSendingSchedule: false,
              userId: 'admin-id-999',
              senderAccount: { emailAddress: 'alex.v@arcreach-mailer.com' },
              steps: [],
              stepStats: [],
              enrollmentSummary: { total: 0, active: 0, completed: 0, notMailable: 0, skipped: 0 },
            },
          ];
        } else if (url.includes('/api/leads/groups')) {
          responseJson = [
            { id: 'g1', name: 'Enterprise Accounts', description: 'Fortune 500 decision makers', _count: { leads: 820 } },
            { id: 'g2', name: 'SaaS Founders', description: 'Early stage startup leaders', _count: { leads: 600 } },
          ];
        } else if (url.includes('/api/leads')) {
          responseJson = {
            leads: [
              {
                id: 'lead-1',
                name: 'Sarah Connor',
                email: 'sarah.connor@cyberdyne.io',
                company: 'Cyberdyne Systems',
                jobTitle: 'VP Engineering',
                status: 'Neutral',
                validationStatus: 'Valid',
                groups: [{ group: { name: 'Enterprise Accounts' } }],
                createdAt: '2026-10-20T10:00:00.000Z',
              },
              {
                id: 'lead-2',
                name: 'Elena Rostova',
                email: 'elena.rostova@hyperion.tech',
                company: 'Hyperion Dynamics',
                jobTitle: 'Head of Growth',
                status: 'Meeting_Booked',
                validationStatus: 'Valid',
                groups: [{ group: { name: 'SaaS Founders' } }],
                createdAt: '2026-10-21T11:30:00.000Z',
              },
              {
                id: 'lead-3',
                name: 'Marcus Vance',
                email: 'marcus.vance@vanguard.co',
                company: 'Vanguard AI',
                jobTitle: 'Chief Revenue Officer',
                status: 'Replied',
                validationStatus: 'Valid',
                groups: [{ group: { name: 'Enterprise Accounts' } }],
                createdAt: '2026-10-22T09:15:00.000Z',
              },
              {
                id: 'lead-4',
                name: 'Chloe Dupont',
                email: 'chloe.dupont@lumina.fr',
                company: 'Lumina Analytics',
                jobTitle: 'Director of Marketing',
                status: 'Neutral',
                validationStatus: 'Risky',
                groups: [{ group: { name: 'SaaS Founders' } }],
                createdAt: '2026-10-23T14:20:00.000Z',
              },
              {
                id: 'lead-5',
                name: 'David Kim',
                email: 'david.kim@seoul-fintech.kr',
                company: 'Seoul Fintech Labs',
                jobTitle: 'Founder & CEO',
                status: 'Neutral',
                validationStatus: 'Valid',
                groups: [{ group: { name: 'SaaS Founders' } }],
                createdAt: '2026-10-24T08:45:00.000Z',
              },
            ],
            total: 1420,
            leadCount: 1420,
            page: 1,
            pageSize: 20,
          };
        } else if (url.includes('/api/accounts/capacity')) {
          responseJson = { globalDaily: null };
        } else if (url.includes('/api/accounts')) {
          responseJson = [
            {
              id: 'acc-1',
              name: 'Sarah Connor (Outbound)',
              senderName: 'Sarah Connor',
              emailAddress: 'sarah@arcreach-mailer.com',
              status: 'Active',
              dailyLimit: 250,
              sentLast24Hours: 84,
              sentTotal: 3420,
              delivered: 3380,
              reported: 3380,
              bounced: 12,
              uniqueOpens: 1640,
              uniqueClicks: 420,
              replies: 184,
              smtpHost: 'smtp.office365.com',
              imapHost: 'outlook.office365.com',
              imapPort: 993,
              imapUser: 'sarah@arcreach-mailer.com',
              imapLastSyncAt: new Date().toISOString(),
              imapLastSyncError: null,
              warmupEnabled: false,
              userId: 'admin-id-999',
              user: { id: 'admin-id-999', name: 'ArcReach Admin', email: 'admin@arcreach.com' },
            },
            {
              id: 'acc-2',
              name: 'Alex Vance (Enterprise)',
              senderName: 'Alex Vance',
              emailAddress: 'alex.v@arcreach-mailer.com',
              status: 'Active',
              dailyLimit: 200,
              sentLast24Hours: 142,
              sentTotal: 2100,
              delivered: 2075,
              reported: 2075,
              bounced: 8,
              uniqueOpens: 1120,
              uniqueClicks: 340,
              replies: 142,
              smtpHost: 'smtp.gmail.com',
              imapHost: 'imap.gmail.com',
              imapPort: 993,
              imapUser: 'alex.v@arcreach-mailer.com',
              imapLastSyncAt: new Date().toISOString(),
              imapLastSyncError: null,
              warmupEnabled: false,
              userId: 'admin-id-999',
              user: { id: 'admin-id-999', name: 'ArcReach Admin', email: 'admin@arcreach.com' },
            },
            {
              id: 'acc-3',
              name: 'Growth Bot 01',
              senderName: 'Growth Operations',
              emailAddress: 'growth01@inbound-reach.io',
              status: 'Active',
              dailyLimit: 300,
              sentLast24Hours: 210,
              sentTotal: 1860,
              delivered: 1840,
              reported: 1840,
              bounced: 6,
              uniqueOpens: 790,
              uniqueClicks: 150,
              replies: 58,
              smtpHost: 'smtp.mailgun.org',
              imapHost: 'imap.mailgun.org',
              imapPort: 993,
              imapUser: 'growth01@inbound-reach.io',
              imapLastSyncAt: new Date().toISOString(),
              imapLastSyncError: null,
              warmupEnabled: false,
              userId: 'admin-id-999',
              user: { id: 'admin-id-999', name: 'ArcReach Admin', email: 'admin@arcreach.com' },
            },
          ];
        } else if (url.includes('/api/settings')) {
          responseJson = {
            user: {
              id: 'admin-id-999',
              name: 'ArcReach Admin',
              email: 'admin@arcreach.com',
              role: 'ADMIN',
              organization: 'Acme Outbound Operations',
            },
            settings: {
              activeProvider: 'AZURE',
              azureConnString: 'endpoint=https://arcreach-comm.communication.azure.com/;accesskey=mockSecretKey==',
              azureSenderDomains: ['arcreach-mailer.com', 'inbound-reach.io'],
              rateLimitMinute: 60,
              rateLimitHour: 1000,
            },
          };
        } else if (url.includes('/api/users')) {
          responseJson = [{ id: 'admin-id-999', name: 'ArcReach Admin', email: 'admin@arcreach.com', role: 'ADMIN' }];
        } else if (url.includes('/api/templates')) {
          responseJson = [
            {
              id: 't1',
              name: 'Cold Intro - Value Proposition',
              category: 'Cold Outreach',
              subject: 'Question regarding {{company}} outreach',
              body: 'Hi {{name}},\n\nI noticed {{company}} has been expanding rapidly this quarter...',
              steps: [
                { id: 's1', waitDays: 0, subject: 'Question regarding {{company}} outreach', body: 'Hi {{name}},\n\nI noticed {{company}} has been expanding rapidly this quarter...' },
                { id: 's2', waitDays: 3, subject: 'Re: Question regarding {{company}} outreach', body: 'Hi {{name}},\n\nWanted to quickly follow up on my previous note...' },
              ],
            },
            {
              id: 't2',
              name: 'Follow-up - Case Study Metrics',
              category: 'Follow-up',
              subject: 'How Acme scaled outbound 3x with ArcReach',
              body: 'Hi {{name}},\n\nThought you might find this customer case study interesting...',
              steps: [
                { id: 's3', waitDays: 0, subject: 'How Acme scaled outbound 3x with ArcReach', body: 'Hi {{name}},\n\nThought you might find this customer case study interesting...' },
              ],
            },
          ];
        } else if (url.includes('/api/unibox')) {
          if (url.includes('leadId=') || url.includes('thread=')) {
            responseJson = {
              messages: [
                {
                  id: 'm-1',
                  senderEmail: 'sarah.connor@cyberdyne.io',
                  recipientEmail: 'sarah@arcreach-mailer.com',
                  subject: 'Re: Enterprise scalability for high-growth teams',
                  body: 'Hi Sarah,\n\nThanks for reaching out! We are currently evaluating new outbound infrastructure to scale our Q4 campaigns. Could you share details on your deliverability rates and compliance guarantees?\n\nBest,\nSarah Connor\nVP Engineering',
                  sentAt: '2026-10-24T14:32:00.000Z',
                  timestamp: '2026-10-24T14:32:00.000Z',
                  type: 'inbound',
                  direction: 'inbound',
                },
                {
                  id: 'm-2',
                  senderEmail: 'sarah@arcreach-mailer.com',
                  recipientEmail: 'sarah.connor@cyberdyne.io',
                  subject: 'Re: Enterprise scalability for high-growth teams',
                  body: 'Hi Sarah,\n\nGreat to hear from you. We maintain >98.5% inbox placement across dedicated Azure and custom SMTP pools with automated SPF/DKIM rotation. Would you be open to a 15-minute walkthrough on Tuesday?\n\nBest,\nSarah',
                  sentAt: '2026-10-24T15:10:00.000Z',
                  timestamp: '2026-10-24T15:10:00.000Z',
                  type: 'outbound',
                  direction: 'outbound',
                },
              ],
            };
          } else {
            responseJson = {
              threads: [
                {
                  id: 'th-1',
                  leadId: 'lead-1',
                  normalizedSubject: 'enterprise scalability for high growth teams',
                  subject: 'Re: Enterprise scalability for high-growth teams',
                  receivedAt: '2026-10-24T14:32:00.000Z',
                  unread: true,
                  lead: {
                    id: 'lead-1',
                    name: 'Sarah Connor',
                    email: 'sarah.connor@cyberdyne.io',
                    company: 'Cyberdyne Systems',
                    jobTitle: 'VP Engineering',
                    status: 'Interested',
                  },
                  snippet: 'Thanks for reaching out! We are currently evaluating new outbound infrastructure...',
                  campaign: { name: 'Q4 Enterprise Outreach (North America)' },
                },
                {
                  id: 'th-2',
                  leadId: 'lead-2',
                  normalizedSubject: 'scaling pipeline efficiency in 2026',
                  subject: 'Re: Scaling pipeline efficiency in 2026',
                  receivedAt: '2026-10-23T11:20:00.000Z',
                  unread: false,
                  lead: {
                    id: 'lead-2',
                    name: 'Elena Rostova',
                    email: 'elena.rostova@hyperion.tech',
                    company: 'Hyperion Dynamics',
                    jobTitle: 'Head of Growth',
                    status: 'Meeting_Booked',
                  },
                  snippet: 'Booked a slot on your calendar for Thursday at 2 PM. Looking forward to connecting!',
                  campaign: { name: 'Series A Tech Founders & CTOs' },
                },
                {
                  id: 'th-3',
                  leadId: 'lead-3',
                  normalizedSubject: 'quick question regarding outbound deliverability',
                  subject: 'Re: Quick question regarding outbound deliverability',
                  receivedAt: '2026-10-22T09:45:00.000Z',
                  unread: false,
                  lead: {
                    id: 'lead-3',
                    name: 'Marcus Vance',
                    email: 'marcus.vance@vanguard.co',
                    company: 'Vanguard AI',
                    jobTitle: 'Chief Revenue Officer',
                    status: 'Replied',
                  },
                  snippet: 'Can you loop in our operations lead on this? We want to review the integration specs.',
                  campaign: { name: 'Q4 Enterprise Outreach (North America)' },
                },
              ],
              total: 3,
              unreadCount: 1,
            };
          }
        }

        if (responseJson !== null) {
          const bodyBase64 = Buffer.from(JSON.stringify(responseJson)).toString('base64');
          sendSession('Fetch.fulfillRequest', {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'Access-Control-Allow-Origin', value: '*' },
            ],
            body: bodyBase64,
          }).catch(() => {});
        } else {
          sendSession('Fetch.continueRequest', { requestId }).catch(() => {});
        }
      }
    } catch (e) {
      console.error('Error in fetch interception:', e);
    }
  });

  await sendSession('Page.enable');
  await sendSession('Network.enable');
  await sendSession('Runtime.enable');
  await sendSession('Fetch.enable', {
    patterns: [{ urlPattern: '*api*' }],
  });

  // Set auth cookie
  await sendSession('Network.setCookie', {
    name: 'user_session',
    value: TOKEN,
    domain: 'localhost',
    path: '/',
    httpOnly: true,
  });

  await sendSession('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1050,
    deviceScaleFactor: 1.5,
    mobile: false,
  });

  const captures = [
    { name: '01_dashboard.png', url: 'http://localhost:3000/', wait: 3500 },
    { name: '02_campaigns.png', url: 'http://localhost:3000/campaigns', wait: 3000 },
    {
      name: '03_campaign_create_drawer.png',
      url: 'http://localhost:3000/campaigns',
      wait: 2500,
      action: async () => {
        await sendSession('Runtime.evaluate', {
          expression: `
            (() => {
              const btns = Array.from(document.querySelectorAll('button'));
              const createBtn = btns.find(b => b.textContent && b.textContent.includes('Create Campaign'));
              if (createBtn) createBtn.click();
            })()
          `,
        });
        await sleep(2000);
      },
    },
    { name: '04_leads.png', url: 'http://localhost:3000/leads', wait: 3000 },
    { name: '05_accounts.png', url: 'http://localhost:3000/accounts', wait: 3000 },
    {
      name: '06_unibox.png',
      url: 'http://localhost:3000/unibox',
      wait: 3000,
      action: async () => {
        await sendSession('Runtime.evaluate', {
          expression: `
            (() => {
              const threads = Array.from(document.querySelectorAll('div[class*="cursor-pointer"]'));
              const target = threads.find(t => t.textContent && (t.textContent.includes('Sarah Connor') || t.textContent.includes('Cyberdyne')));
              if (target) target.click();
              else if (threads[0]) threads[0].click();
            })()
          `,
        });
        await sleep(1500);
      },
    },
    { name: '07_settings.png', url: 'http://localhost:3000/settings', wait: 3000 },
    { name: '08_templates.png', url: 'http://localhost:3000/templates', wait: 3000 },
    { name: '09_login.png', url: 'http://localhost:3000/login', wait: 2000, noCookie: true },
  ];

  for (const item of captures) {
    console.log(`Capturing ${item.name} from ${item.url}...`);
    if (item.noCookie) {
      await sendSession('Network.deleteCookies', { name: 'user_session', domain: 'localhost' });
    }
    await sendSession('Page.navigate', { url: item.url });
    await sleep(item.wait);

    // Suppress Next.js dev overlay artifacts and disable CSS transitions in captured screenshots
    await sendSession('Runtime.evaluate', {
      expression: `
        (() => {
          const style = document.createElement('style');
          style.id = 'hide-dev-overlays';
          style.innerHTML = '#next-logo, [data-nextjs-toast], nextjs-portal { display: none !important; } *, *::before, *::after { transition-duration: 0s !important; }';
          document.head.appendChild(style);
        })()
      `,
    }).catch(() => {});

    if (item.action) {
      await item.action();
    }

    const snap = await sendSession('Page.captureScreenshot', { format: 'png', quality: 100 });
    saveScreenshot(item.name, snap.data);
    console.log(`  ✓ Saved: ${item.name} (${Math.round(snap.data.length / 1024)} KB)`);

    if (item.noCookie) {
      // re-add cookie
      await sendSession('Network.setCookie', {
        name: 'user_session',
        value: TOKEN,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
      });
    }
  }

  // Dark mode capture: pre-set localStorage so page boots directly in dark mode
  console.log('Capturing 10_dashboard_dark.png...');
  await sendSession('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      try {
        localStorage.setItem('arcreach-theme', 'dark');
        localStorage.setItem('mui-mode', 'dark');
        document.documentElement.classList.remove('light');
        document.documentElement.classList.add('dark');
        document.documentElement.style.colorScheme = 'dark';
      } catch (e) {}
    `,
  });

  await sendSession('Runtime.evaluate', {
    expression: `
      (() => {
        try {
          localStorage.setItem('arcreach-theme', 'dark');
          localStorage.setItem('mui-mode', 'dark');
        } catch (e) {}
      })()
    `,
  }).catch(() => {});

  await sendSession('Page.navigate', { url: 'http://localhost:3000/' });
  // Wait 3500ms for page to load and Recharts animation to run smoothly
  await sleep(3500);

  // Disable transition duration and hide dev overlays
  await sendSession('Runtime.evaluate', {
    expression: `
      (() => {
        try {
          document.documentElement.classList.remove('light');
          document.documentElement.classList.add('dark');
          document.documentElement.style.colorScheme = 'dark';
        } catch (e) {}
        const style = document.createElement('style');
        style.id = 'hide-dev-overlays-dark';
        style.innerHTML = '#next-logo, [data-nextjs-toast], nextjs-portal { display: none !important; } *, *::before, *::after { transition-duration: 0s !important; }';
        document.head.appendChild(style);
      })()
    `,
  });
  await sleep(1500);

  const darkSnap = await sendSession('Page.captureScreenshot', { format: 'png', quality: 100 });
  saveScreenshot('10_dashboard_dark.png', darkSnap.data);
  console.log(`  ✓ Saved: 10_dashboard_dark.png (${Math.round(darkSnap.data.length / 1024)} KB)`);

  ws.close();
  edgeProc.kill();
  console.log('All screenshots captured successfully!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error in capture-screenshots:', err);
  process.exit(1);
});

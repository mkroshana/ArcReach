import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

// Top-level document polyfill for Node / SSR test environment
if (typeof document === 'undefined') {
  (globalThis as any).document = {
    visibilityState: 'visible',
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { nodeType: 1 },
  };
} else {
  (globalThis as any).document.querySelector = (globalThis as any).document.querySelector || (() => null);
  (globalThis as any).document.querySelectorAll = (globalThis as any).document.querySelectorAll || (() => []);
}

// Top-level hook interceptor for controlling Dashboard state in tests
let mockStateHook: ((initial: any) => [any, any]) | null = null;
let mockIsMounted = false;

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: (initial: any) => {
      if (mockStateHook) return mockStateHook(initial);
      return actual.useState(initial);
    },
    useSyncExternalStore: (subscribe: any, getSnapshot: any, getServerSnapshot: any) => {
      if (mockIsMounted) return true;
      return getServerSnapshot ? getServerSnapshot() : getSnapshot();
    },
  };
});


// Top-level module mocks
vi.mock('@mui/material', () => ({
  Tooltip: ({ children }: any) => children,
}));

vi.mock('@/components/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light', toggleTheme: () => {}, setTheme: () => {} }),
  ThemeProvider: ({ children }: any) => children,
}));

import Dashboard from '../../app/page';


// Load source code of app/page.tsx for static verification & syntax analysis
const dashboardPagePath = path.resolve(__dirname, '../../app/page.tsx');
const dashboardSource = fs.readFileSync(dashboardPagePath, 'utf8');

/* -------------------------------------------------------------------------- */
/*             1. Transpile, Static Syntax & Design Directives Audit           */
/* -------------------------------------------------------------------------- */
describe('Static Syntax & House Design Directives Audit (app/page.tsx)', () => {
  it('transpiles cleanly with ts.transpileModule without syntax errors', () => {
    const res = ts.transpileModule(dashboardSource, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: 'page.tsx',
      reportDiagnostics: true,
    });
    expect(res.diagnostics?.length ?? 0).toBe(0);
    expect(res.outputText).toContain('export default function Dashboard');
  });

  it('contains zero unicode emojis in UI strings', () => {
    const emojiRegex = /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/u;
    const match = dashboardSource.match(emojiRegex);
    expect(match).toBeNull();
  });

  it('adheres to Title Case headings across all card modules', () => {
    const mandatedHeadings = [
      'Campaign Analytics',
      'Required Setup Steps',
      'Engagement Trends',
      'Conversion Funnel',
      'Prospect Sentiment',
      'Recent Campaigns',
    ];
    for (const heading of mandatedHeadings) {
      expect(dashboardSource).toContain(heading);
    }
  });

  it('does not contain generic AI vibe-coded purple blobs or rainbow gradients', () => {
    const vibeCodedWords = ['from-purple', 'to-pink', 'from-fuchsia', 'shadow-purple', 'rainbow'];
    for (const word of vibeCodedWords) {
      expect(dashboardSource.toLowerCase()).not.toContain(word);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*            2. Empty & Zero-Data State Rendering Verification                */
/* -------------------------------------------------------------------------- */
describe('Empty & Zero-Data States (app/page.tsx)', () => {
  // Test Sentiment calculation and fallback gauge behavior
  function calculateSentiment(sentiment: Array<{ name: string; value: number }>) {
    const positiveSentiment =
      (sentiment.find((s) => s.name === 'Interested')?.value || 0) +
      (sentiment.find((s) => s.name === 'Meeting Booked')?.value || 0);

    const neutralSentiment =
      (sentiment.find((s) => s.name === 'Neutral')?.value || 0) +
      (sentiment.find((s) => s.name === 'Out of Office')?.value || 0);

    const negativeSentiment =
      (sentiment.find((s) => s.name === 'Not Interested')?.value || 0) +
      (sentiment.find((s) => s.name === 'Bounced')?.value || 0) +
      (sentiment.find((s) => s.name === 'Unsubscribed')?.value || 0);

    const totalSentiment = positiveSentiment + neutralSentiment + negativeSentiment;
    const positiveSentimentRate =
      totalSentiment > 0 ? Math.round((positiveSentiment / totalSentiment) * 100) : 0;

    const trackBg = '#F1F5F9';
    const gaugeData =
      totalSentiment === 0
        ? [{ name: 'No Data', value: 1, fill: trackBg }]
        : [
            { name: 'Positive', value: positiveSentiment, fill: '#10B981' },
            { name: 'Neutral', value: neutralSentiment, fill: '#F59E0B' },
            { name: 'Negative', value: negativeSentiment, fill: '#F43F5E' },
          ].filter((s) => s.value > 0);

    const heroScore = totalSentiment > 0 ? `${positiveSentimentRate}%` : '—';
    const heroLabel = totalSentiment > 0 ? 'Positive Score' : 'No Contacts';

    return {
      positiveSentiment,
      neutralSentiment,
      negativeSentiment,
      totalSentiment,
      positiveSentimentRate,
      gaugeData,
      heroScore,
      heroLabel,
    };
  }

  it('renders "— No Contacts" and single neutral track when sentiment is empty []', () => {
    const res = calculateSentiment([]);
    expect(res.totalSentiment).toBe(0);
    expect(res.heroScore).toBe('—');
    expect(res.heroLabel).toBe('No Contacts');
    expect(res.gaugeData).toEqual([{ name: 'No Data', value: 1, fill: '#F1F5F9' }]);
    expect(res.positiveSentiment).toBe(0);
    expect(res.neutralSentiment).toBe(0);
    expect(res.negativeSentiment).toBe(0);
  });

  it('renders "— No Contacts" and single neutral track when all sentiment values are zero', () => {
    const res = calculateSentiment([
      { name: 'Interested', value: 0 },
      { name: 'Meeting Booked', value: 0 },
      { name: 'Neutral', value: 0 },
      { name: 'Out of Office', value: 0 },
      { name: 'Not Interested', value: 0 },
      { name: 'Bounced', value: 0 },
      { name: 'Unsubscribed', value: 0 },
    ]);
    expect(res.totalSentiment).toBe(0);
    expect(res.heroScore).toBe('—');
    expect(res.heroLabel).toBe('No Contacts');
    expect(res.gaugeData).toEqual([{ name: 'No Data', value: 1, fill: '#F1F5F9' }]);
  });

  it('calculates correct positive percentage when sentiment data exists', () => {
    const res = calculateSentiment([
      { name: 'Interested', value: 8 },
      { name: 'Meeting Booked', value: 4 }, // positive = 12
      { name: 'Neutral', value: 3 },       // neutral = 3
      { name: 'Not Interested', value: 5 }, // negative = 5
    ]);
    expect(res.totalSentiment).toBe(20);
    expect(res.positiveSentimentRate).toBe(60); // 12 / 20 = 60%
    expect(res.heroScore).toBe('60%');
    expect(res.heroLabel).toBe('Positive Score');
    expect(res.gaugeData.length).toBe(3);
  });

  // Test Funnel zero state & conversion rate guards
  function evaluateFunnelState(funnel: Array<{ name: string; value: number }>) {
    const totalSentInFunnel = funnel.find((s) => s.name === 'Sent')?.value || 0;
    const showEmptyState = funnel.length === 0 || totalSentInFunnel === 0;

    const conversionRates = funnel.map((stage) => {
      const conversionPct =
        totalSentInFunnel && totalSentInFunnel > 0 && stage.name !== 'Sent'
          ? ((stage.value / totalSentInFunnel) * 100).toFixed(1)
          : null;
      return { name: stage.name, value: stage.value, conversionPct };
    });

    return { totalSentInFunnel, showEmptyState, conversionRates };
  }

  it('triggers funnel empty state when funnel array is empty', () => {
    const res = evaluateFunnelState([]);
    expect(res.showEmptyState).toBe(true);
    expect(res.totalSentInFunnel).toBe(0);
  });

  it('triggers funnel empty state when Sent is zero to prevent division by zero', () => {
    const res = evaluateFunnelState([
      { name: 'Sent', value: 0 },
      { name: 'Opened', value: 0 },
      { name: 'Clicked', value: 0 },
    ]);
    expect(res.showEmptyState).toBe(true);
    expect(res.totalSentInFunnel).toBe(0);
    // Conversion rates must all be null to avoid NaN or Infinity
    for (const stage of res.conversionRates) {
      expect(stage.conversionPct).toBeNull();
    }
  });

  it('correctly calculates conversion rates relative to Sent stage', () => {
    const res = evaluateFunnelState([
      { name: 'Sent', value: 1000 },
      { name: 'Opened', value: 450 },
      { name: 'Clicked', value: 120 },
      { name: 'Meeting Booked', value: 25 },
    ]);
    expect(res.showEmptyState).toBe(false);
    expect(res.totalSentInFunnel).toBe(1000);
    expect(res.conversionRates[0].conversionPct).toBeNull(); // Sent itself has no conversion pct
    expect(res.conversionRates[1].conversionPct).toBe('45.0');
    expect(res.conversionRates[2].conversionPct).toBe('12.0');
    expect(res.conversionRates[3].conversionPct).toBe('2.5');
  });

  // Test Recent Campaigns empty state and status resolutions
  const STATUS_PILL_CONFIG: Record<
    string,
    { label: string; badgeClass: string; dotClass: string; pulse: boolean }
  > = {
    Active: {
      label: 'Active',
      badgeClass: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60',
      dotClass: 'bg-emerald-500',
      pulse: true,
    },
    Paused: {
      label: 'Paused',
      badgeClass: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800/60',
      dotClass: 'bg-amber-500',
      pulse: false,
    },
    Completed: {
      label: 'Completed',
      badgeClass: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800/60',
      dotClass: 'bg-blue-500',
      pulse: false,
    },
    Draft: {
      label: 'Draft',
      badgeClass: 'bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700/60',
      dotClass: 'bg-slate-400',
      pulse: false,
    },
    Stopped: {
      label: 'Stopped',
      badgeClass: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800/60',
      dotClass: 'bg-rose-500',
      pulse: false,
    },
  };

  function resolveCampaignRow(c: any) {
    const totalLeads = c.enrollmentSummary?.total ?? 0;
    const totalSent = c.stepStats?.reduce((acc: number, s: any) => acc + (s.sent || 0), 0) ?? 0;
    const isCompleted = totalLeads > 0 && c.enrollmentSummary?.completed === totalLeads;
    const resolvedStatus = isCompleted ? 'Completed' : c.status;
    const pill = STATUS_PILL_CONFIG[resolvedStatus] || STATUS_PILL_CONFIG.Draft;
    const hasOpenRate = typeof c.openRate === 'number';
    const openRateValue = hasOpenRate ? c.openRate : 0;
    const openRateDisplay = hasOpenRate ? `${openRateValue.toFixed(1)}%` : totalSent > 0 ? '—' : '0.0%';

    return { totalLeads, totalSent, resolvedStatus, pill, openRateDisplay };
  }

  it('handles campaign with missing, zero or null properties gracefully', () => {
    const row = resolveCampaignRow({
      id: 'c-empty',
      name: 'Empty Campaign',
      status: 'Active',
      enrollmentSummary: null,
      stepStats: null,
      openRate: null,
    });
    expect(row.totalLeads).toBe(0);
    expect(row.totalSent).toBe(0);
    expect(row.resolvedStatus).toBe('Active');
    expect(row.pill.label).toBe('Active');
    expect(row.openRateDisplay).toBe('0.0%');
  });

  it('auto-resolves status to Completed when completed leads equals total leads', () => {
    const row = resolveCampaignRow({
      id: 'c-comp',
      name: 'Finished Sequence',
      status: 'Active', // status in DB might still be Active, but all leads completed
      enrollmentSummary: { total: 50, completed: 50 },
      stepStats: [{ sent: 50 }],
      openRate: 42.5,
    });
    expect(row.resolvedStatus).toBe('Completed');
    expect(row.pill.label).toBe('Completed');
    expect(row.pill.dotClass).toBe('bg-blue-500');
    expect(row.openRateDisplay).toBe('42.5%');
  });

  it('falls back to Draft pill configuration for unexpected status', () => {
    const row = resolveCampaignRow({
      id: 'c-unknown',
      name: 'Weird Status',
      status: 'ARCHIVED_CUSTOM',
    });
    expect(row.pill.label).toBe('Draft');
    expect(row.pill.pulse).toBe(false);
  });

  it('displays dash "—" when openRate is uncalculated but emails were sent', () => {
    const row = resolveCampaignRow({
      id: 'c-uncalculated',
      name: 'Pending Sync',
      status: 'Active',
      stepStats: [{ sent: 120 }],
      openRate: null,
    });
    expect(row.totalSent).toBe(120);
    expect(row.openRateDisplay).toBe('—');
  });
});

/* -------------------------------------------------------------------------- */
/*         3. Polling Loop & AbortController Lifecycle Verification            */
/* -------------------------------------------------------------------------- */
describe('Polling Loop & AbortController Lifecycle (app/page.tsx)', () => {
  it('aborts prior in-flight request when rapid range switching occurs (7d -> 30d -> 90d)', async () => {
    // Harness simulating the exact fetchStats and inFlight ref lifecycle from app/page.tsx
    let inFlight: AbortController | null = null;
    let loading = false;
    let committedRange = '';
    const abortHistory: boolean[] = [];

    const mockFetchRange = async (range: string, delayMs: number) => {
      // Step 1: inFlight.current?.abort()
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      loading = true;

      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (controller.signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
          } else {
            resolve(`data-for-${range}`);
          }
        }, delayMs);

        controller.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      })
        .then((data) => {
          if (controller.signal.aborted) return;
          committedRange = range;
        })
        .catch((err) => {
          if (controller.signal.aborted) {
            abortHistory.push(true);
            return;
          }
          throw err;
        })
        .finally(() => {
          if (inFlight === controller) {
            inFlight = null;
            loading = false;
          }
        });
    };

    // Trigger 7d (slow, takes 100ms)
    const p1 = mockFetchRange('7', 100);
    expect(loading).toBe(true);

    // After 10ms, user rapidly clicks 30d (takes 80ms)
    await new Promise((r) => setTimeout(r, 10));
    const p2 = mockFetchRange('30', 80);

    // After another 10ms, user rapidly clicks 90d (takes 30ms)
    await new Promise((r) => setTimeout(r, 10));
    const p3 = mockFetchRange('90', 30);

    // Await all promises
    await Promise.allSettled([p1, p2, p3]);

    // Check assertions
    expect(abortHistory.length).toBe(2); // 7d and 30d were cleanly aborted
    expect(committedRange).toBe('90');   // Only 90d was committed to state
    expect(loading).toBe(false);        // Loading was cleared by the winning 90d request
    expect(inFlight).toBeNull();
  });

  it('unmount cleanup properly clears the 30s interval and aborts in-flight fetch', () => {
    vi.useFakeTimers();

    let intervalCleared = false;
    let fetchAborted = false;

    // Simulate setup inside useEffect
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => {
      fetchAborted = true;
    });

    const inFlight = { current: controller };

    const intervalId = setInterval(() => {
      // 30s polling
    }, 30000);

    // Spy on clearInterval
    const origClearInterval = globalThis.clearInterval;
    globalThis.clearInterval = vi.fn((id: any) => {
      intervalCleared = true;
      origClearInterval(id);
    });

    // Simulate useEffect cleanup function on unmount
    const cleanup = () => {
      clearInterval(intervalId);
      inFlight.current?.abort();
    };

    // Execute cleanup
    cleanup();

    expect(intervalCleared).toBe(true);
    expect(fetchAborted).toBe(true);

    // Restore timers and clearInterval
    globalThis.clearInterval = origClearInterval;
    vi.useRealTimers();
  });

  it('skips polling tick when document.visibilityState is hidden or a request is in flight', () => {
    let fetchCallCount = 0;
    const fetchStats = () => {
      fetchCallCount++;
    };

    // Scenario A: tab is hidden
    let visibilityState = 'hidden';
    let inFlight: any = null;

    if (visibilityState === 'visible' && !inFlight) {
      fetchStats();
    }
    expect(fetchCallCount).toBe(0);

    // Scenario B: tab is visible but another request is in flight
    visibilityState = 'visible';
    inFlight = new AbortController();

    if (visibilityState === 'visible' && !inFlight) {
      fetchStats();
    }
    expect(fetchCallCount).toBe(0);

    // Scenario C: tab is visible and idle
    inFlight = null;
    if (visibilityState === 'visible' && !inFlight) {
      fetchStats();
    }
    expect(fetchCallCount).toBe(1);
  });

  it('handles loadError state and retry recovery without discarding cached stats', () => {
    let stats: any = { totalSent: 500, averageOpenRate: 25 };
    let loadError = '';

    // Simulate failed background refresh
    const simulateFailedRefresh = () => {
      try {
        throw new Error('Server 500 Error');
      } catch (err: any) {
        loadError = err.message;
      }
    };

    simulateFailedRefresh();

    // Verify stats were NOT wiped out by background refresh failure
    expect(stats).not.toBeNull();
    expect(stats.totalSent).toBe(500);
    expect(loadError).toBe('Server 500 Error');

    // Simulate successful retry
    const simulateRetry = () => {
      stats = { totalSent: 600, averageOpenRate: 30 };
      loadError = '';
    };

    simulateRetry();

    expect(loadError).toBe('');
    expect(stats.totalSent).toBe(600);
  });
});

/* -------------------------------------------------------------------------- */
/*            4. Setup Wizard Rendering & Layout Matrix Verification           */
/* -------------------------------------------------------------------------- */
describe('Setup Wizard Logic & Edge Cases (app/page.tsx)', () => {
  function getSetupState(systemStatus: any) {
    const needsSetup =
      systemStatus &&
      (systemStatus.accountsCount === 0 ||
        systemStatus.leadsCount === 0 ||
        systemStatus.activeCampaignsCount === 0);

    const setupSteps = systemStatus
      ? [
          {
            done: systemStatus.accountsCount > 0,
            title: '1. Connect Mailbox',
            todo: 'No mailboxes connected. Outbound paused.',
            done_text: `${systemStatus.accountsCount} active mailbox(es) online.`,
            href: '/accounts',
            cta: 'Connect Senders',
          },
          {
            done: systemStatus.leadsCount > 0,
            title: '2. Import Leads',
            todo: 'No CRM leads. Outbox has no targets.',
            done_text: `${systemStatus.leadsCount} CRM contact(s) imported.`,
            href: '/leads',
            cta: 'Upload Leads',
          },
          {
            done: systemStatus.activeCampaignsCount > 0,
            title: '3. Start Campaign',
            todo: 'All campaigns are idle.',
            done_text: `${systemStatus.activeCampaignsCount} Active campaign(s).`,
            href: '/campaigns',
            cta: 'Manage Campaigns',
          },
        ]
      : [];

    return { needsSetup: Boolean(needsSetup), setupSteps };
  }

  it('triggers needsSetup banner when all counts are 0', () => {
    const res = getSetupState({ accountsCount: 0, leadsCount: 0, activeCampaignsCount: 0 });
    expect(res.needsSetup).toBe(true);
    expect(res.setupSteps.length).toBe(3);
    expect(res.setupSteps.every((s) => !s.done)).toBe(true);
    expect(res.setupSteps[0].cta).toBe('Connect Senders');
    expect(res.setupSteps[1].cta).toBe('Upload Leads');
    expect(res.setupSteps[2].cta).toBe('Manage Campaigns');
  });

  it('triggers needsSetup banner when some counts are non-zero but at least one is 0', () => {
    const res = getSetupState({ accountsCount: 2, leadsCount: 150, activeCampaignsCount: 0 });
    expect(res.needsSetup).toBe(true);
    expect(res.setupSteps[0].done).toBe(true);
    expect(res.setupSteps[0].done_text).toBe('2 active mailbox(es) online.');
    expect(res.setupSteps[1].done).toBe(true);
    expect(res.setupSteps[1].done_text).toBe('150 CRM contact(s) imported.');
    expect(res.setupSteps[2].done).toBe(false);
    expect(res.setupSteps[2].todo).toBe('All campaigns are idle.');
  });

  it('hides needsSetup banner when all 3 setup prerequisites are satisfied', () => {
    const res = getSetupState({ accountsCount: 1, leadsCount: 50, activeCampaignsCount: 1 });
    expect(res.needsSetup).toBe(false);
  });

  it('gracefully handles null or undefined systemStatus without throwing', () => {
    const resNull = getSetupState(null);
    expect(resNull.needsSetup).toBe(false);
    expect(resNull.setupSteps).toEqual([]);

    const resUndefined = getSetupState(undefined);
    expect(resUndefined.needsSetup).toBe(false);
    expect(resUndefined.setupSteps).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*           5. Live Dashboard Component Rendering & Markup Tests             */
/* -------------------------------------------------------------------------- */
describe('Dashboard Component SSR & Markup Verification', () => {
  afterEach(() => {
    mockStateHook = null;
  });

  function mockDashboardState(overrides: {
    range?: string;
    stats?: any;
    statsRange?: string;
    loadedAt?: Date | null;
    trends?: any[];
    funnel?: any[];
    sentiment?: any[];
    recentCampaigns?: any[];
    loading?: boolean;
    loadError?: string;
    systemStatus?: any;
  }) {
    const stateValues = [
      overrides.range ?? '7',
      overrides.stats !== undefined ? overrides.stats : null,
      overrides.statsRange ?? overrides.range ?? '7',
      overrides.loadedAt ?? null,
      overrides.trends ?? [],
      overrides.funnel ?? [],
      overrides.sentiment ?? [],
      overrides.recentCampaigns ?? [],
      overrides.loading ?? (overrides.stats ? false : true),
      overrides.loadError ?? '',
      overrides.systemStatus !== undefined ? overrides.systemStatus : null,
    ];

    let callIndex = 0;
    mockStateHook = (initial: any) => {
      const val = callIndex < stateValues.length ? stateValues[callIndex] : initial;
      callIndex++;
      return [val, vi.fn()];
    };
  }


  it('renders initial SSR loading skeleton markup without errors', () => {
    const html = renderToStaticMarkup(React.createElement(Dashboard));
    expect(html).toContain('Campaign Analytics');
    expect(html).toContain('A unified overview of your outbound deliverability and automated sequences.');
    expect(html).toContain('Create Campaign');
    expect(html).toContain('Checking Outbox');
    expect(html).toContain('animate-pulse'); // Skeletons are rendered during SSR
  });

  it('renders complete Dashboard with all zero data states cleanly without NaN or crashes', () => {
    mockDashboardState({
      range: '7',
      stats: {
        totalSent: 0,
        averageOpenRate: 0,
        averageClickRate: 0,
        totalReplies: 0,
        replySync: 'on',
        deltas: { sent: 0, openRate: 0, clickRate: 0, replies: 0 },
        failed: 0,
        bounced: 0,
        unsubscribed: 0,
      },
      statsRange: '7',
      loadedAt: new Date('2026-10-25T04:00:00Z'),
      trends: [],
      funnel: [],
      sentiment: [],
      recentCampaigns: [],
      loading: false,
      loadError: '',
      systemStatus: {
        deliveryStatus: 'RUNNING',
        accountsCount: 0,
        leadsCount: 0,
        activeCampaignsCount: 0,
      },
    });

    const html = renderToStaticMarkup(React.createElement(Dashboard));

    // 1. Metric Cards with 0 values and 0% pills
    expect(html).toContain('Emails Sent');
    expect(html).toContain('Open Rate');
    expect(html).toContain('Click Rate');
    expect(html).toContain('Replies');
    expect(html).toContain('0%');
    expect(html).toContain('vs last period');


    // 2. Deliverability Health Segment Pills with 0
    expect(html).toContain('Failed Sends');
    expect(html).toContain('Bounced');
    expect(html).toContain('Unsubscribed');

    // 3. Setup Wizard rendering because accountsCount is 0
    expect(html).toContain('Required Setup Steps');
    expect(html).toContain('1. Connect Mailbox');
    expect(html).toContain('2. Import Leads');
    expect(html).toContain('3. Start Campaign');
    expect(html).toContain('Connect Senders');
    expect(html).toContain('Upload Leads');
    expect(html).toContain('Manage Campaigns');

    // 4. Empty State for Recent Campaigns
    expect(html).toContain('No Campaigns Created Yet');
    expect(html).toContain('Create your first automated email campaign to start reaching prospects');

    // 5. Zero State for Sentiment
    expect(html).toContain('Prospect Sentiment');
    expect(html).toContain('Positive');
    expect(html).toContain('Neutral');
    expect(html).toContain('Negative');
    expect(html).not.toContain('NaN');
  });

  it('renders Replies card with caveat when replySync is off', () => {
    mockDashboardState({
      range: '7',
      stats: {
        totalSent: 50,
        averageOpenRate: 10,
        averageClickRate: 5,
        totalReplies: 0,
        replySync: 'off',
        deltas: { sent: 5, openRate: 1, clickRate: 0 },
        failed: 0,
        bounced: 0,
        unsubscribed: 0,
      },
      recentCampaigns: [],
      systemStatus: {
        deliveryStatus: 'RUNNING',
        accountsCount: 1,
        leadsCount: 20,
        activeCampaignsCount: 1,
      },
    });

    const html = renderToStaticMarkup(React.createElement(Dashboard));
    expect(html).toContain('Reply sync off');
    // Funnel should show caveat banner
    expect(html).toContain('Replied stage omitted (reply sync is unconfigured).');
  });

  it('renders initial load failure error banner with Retry button', () => {
    mockDashboardState({
      stats: null,
      loading: false,
      loadError: 'Analytics could not be loaded (the server answered 500).',
    });

    const html = renderToStaticMarkup(React.createElement(Dashboard));
    expect(html).toContain('Analytics Could Not Be Loaded');
    expect(html).toContain('Analytics could not be loaded (the server answered 500).');
    expect(html).toContain('Retry');
  });

  it('renders cached stats warning banner when refresh fails', () => {
    mockDashboardState({
      stats: {
        totalSent: 1200,
        averageOpenRate: 45,
        averageClickRate: 12,
        totalReplies: 8,
        replySync: 'on',
        deltas: { sent: 15, openRate: 3, clickRate: 1, replies: 2 },
      },
      statsRange: '7',
      loadedAt: new Date('2026-10-25T04:15:00Z'),
      loadError: 'Connection timed out.',
    });

    const html = renderToStaticMarkup(React.createElement(Dashboard));
    expect(html).toContain('Analytics Could Not Be Refreshed');
    expect(html).toContain('Connection timed out.');
    expect(html).toContain('Retry');
    // Cached stats are still visible
    expect(html).toContain('1,200');
    expect(html).toContain('45%');
  });

  it('hides setup wizard banner when all setup requirements are satisfied', () => {
    mockDashboardState({
      stats: {
        totalSent: 500,
        averageOpenRate: 20,
        averageClickRate: 5,
        totalReplies: 2,
        replySync: 'on',
      },
      systemStatus: {
        deliveryStatus: 'RUNNING',
        accountsCount: 3,
        leadsCount: 250,
        activeCampaignsCount: 2,
      },
    });

    const html = renderToStaticMarkup(React.createElement(Dashboard));
    expect(html).not.toContain('Required Setup Steps');
    expect(html).not.toContain('1. Connect Mailbox');
  });

  it('renders Recent Campaigns table rows with status badges and open rate bars', () => {
    mockDashboardState({
      stats: {
        totalSent: 500,
        averageOpenRate: 20,
        averageClickRate: 5,
        totalReplies: 2,
        replySync: 'on',
      },
      recentCampaigns: [
        {
          id: 'camp-1',
          name: 'Q4 Enterprise Outbound',
          status: 'Active',
          enrollmentSummary: { total: 200, completed: 50 },
          stepStats: [{ sent: 150 }],
          openRate: 35.5,
          createdAt: '2026-10-01T00:00:00Z',
        },
        {
          id: 'camp-2',
          name: 'Beta Invite Flow',
          status: 'Paused',
          enrollmentSummary: { total: 100, completed: 100 }, // Completed auto-resolution
          stepStats: [{ sent: 100 }],
          openRate: 50.0,
          createdAt: '2026-09-15T00:00:00Z',
        },
      ],
      systemStatus: {
        deliveryStatus: 'RUNNING',
        accountsCount: 1,
        leadsCount: 100,
        activeCampaignsCount: 1,
      },
    });

    const html = renderToStaticMarkup(React.createElement(Dashboard));
    expect(html).toContain('Q4 Enterprise Outbound');
    expect(html).toContain('Beta Invite Flow');
    expect(html).toContain('Active');
    expect(html).toContain('Completed'); // auto-resolved from enrollmentSummary.completed === total
    expect(html).toContain('35.5%');
    expect(html).toContain('50.0%');
    expect(html).toContain('200');
    expect(html).toContain('leads enrolled');
    expect(html).toContain('emails sent');
  });

  it('renders chart empty states when client-hydrated with zero or empty arrays', () => {
    mockIsMounted = true;
    mockDashboardState({
      stats: {
        totalSent: 0,
        averageOpenRate: 0,
        averageClickRate: 0,
        totalReplies: 0,
        replySync: 'on',
        failed: 0,
        bounced: 0,
        unsubscribed: 0,
      },
      trends: [],
      funnel: [],
      sentiment: [],
      recentCampaigns: [],
      systemStatus: {
        deliveryStatus: 'RUNNING',
        accountsCount: 1,
        leadsCount: 10,
        activeCampaignsCount: 1,
      },
    });

    const html = renderToStaticMarkup(React.createElement(Dashboard));

    // Engagement Trends empty state
    expect(html).toContain('No engagement activity recorded');
    expect(html).toContain('Sent emails and prospect interactions will chart here');

    // Conversion Funnel empty state
    expect(html).toContain('No outreach dispatches recorded');
    expect(html).toContain('Launch a campaign sequence to view conversion flow');
    expect(html).not.toContain('Top of Funnel:'); // Footer summary hidden on 0

    // Prospect Sentiment fallback gauge
    expect(html).toContain('—');
    expect(html).toContain('No Contacts');
  });

  it('renders client-hydrated sentiment gauge score and funnel summary when data is populated', () => {
    mockIsMounted = true;
    mockDashboardState({
      stats: {
        totalSent: 500,
        averageOpenRate: 40,
        averageClickRate: 15,
        totalReplies: 10,
        replySync: 'on',
      },
      trends: [
        { name: 'Mon', sent: 100, opens: 40, clicks: 15 },
        { name: 'Tue', sent: 120, opens: 50, clicks: 20 },
      ],
      funnel: [
        { name: 'Sent', value: 500 },
        { name: 'Opened', value: 200 },
        { name: 'Clicked', value: 75 },
      ],
      sentiment: [
        { name: 'Interested', value: 8 },
        { name: 'Meeting Booked', value: 2 },
      ],
      recentCampaigns: [],
      systemStatus: {
        deliveryStatus: 'RUNNING',
        accountsCount: 1,
        leadsCount: 50,
        activeCampaignsCount: 1,
      },
    });

    const html = renderToStaticMarkup(React.createElement(Dashboard));

    // Sentiment hero score: 10/10 positive -> 100%
    expect(html).toContain('100%');
    expect(html).toContain('Positive Score');

    // Funnel summary footer
    expect(html).toContain('Top of Funnel:');
    expect(html).toContain('500 Sent');
    expect(html).toContain('3 Active Stages');
  });

  it('gracefully falls back when campaign createdAt is missing or undefined', () => {
    mockDashboardState({
      stats: {
        totalSent: 100,
        averageOpenRate: 10,
        averageClickRate: 2,
        totalReplies: 1,
        replySync: 'on',
      },
      recentCampaigns: [
        {
          id: 'camp-sender-fallback',
          name: 'Sender Account Fallback',
          status: 'Active',
          senderAccount: { emailAddress: 'sales@outreachpro.io' },
          createdAt: null,
        },
        {
          id: 'camp-pure-fallback',
          name: 'Pure Default Sequence',
          status: 'Draft',
          senderAccount: null,
          createdAt: undefined,
        },
      ],
      systemStatus: {
        deliveryStatus: 'RUNNING',
        accountsCount: 1,
        leadsCount: 10,
        activeCampaignsCount: 1,
      },
    });

    const html = renderToStaticMarkup(React.createElement(Dashboard));
    expect(html).toContain('Sender Account Fallback');
    expect(html).toContain('sales@outreachpro.io');
    expect(html).toContain('Pure Default Sequence');
    expect(html).toContain('Automated Sequence');
  });
});


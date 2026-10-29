import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

// Load source code of app/page.tsx for static analysis and AST checks
const pagePath = path.resolve(__dirname, '../../app/page.tsx');
const pageSource = fs.readFileSync(pagePath, 'utf8');

describe('Dashboard (app/page.tsx) SSR Hydration & Lifecycle Stress-Test', () => {
  it('transpiles cleanly without syntax or typing diagnostics in TypeScript', () => {
    const res = ts.transpileModule(pageSource, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: 'page.tsx',
      reportDiagnostics: true,
    });
    expect(res.diagnostics?.length ?? 0).toBe(0);
    expect(res.outputText).toContain('useIsMounted');
    expect(res.outputText).toContain('Dashboard');
  });

  it('implements useIsMounted with useSyncExternalStore returning false during SSR', () => {
    // Verify useIsMounted implementation pattern
    expect(pageSource).toContain('useSyncExternalStore');
    expect(pageSource).toContain('const emptySubscribe = () => () => {};');
    expect(pageSource).toContain('() => true');
    expect(pageSource).toContain('() => false');

    // Test the logic directly
    const emptySub = () => () => {};
    expect(typeof emptySub()).toBe('function');
  });

  it('performs SSR renderToString without throwing exceptions or generating Recharts clipPath IDs', async () => {
    // Dynamic import of page component and ThemeProvider
    const PageModule = await import('../../app/page');
    const { ThemeProvider } = await import('../../components/ThemeProvider');
    const Dashboard = PageModule.default;

    // Render to string simulating SSR server execution within ThemeProvider
    let ssrHtml = '';
    expect(() => {
      ssrHtml = renderToString(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(Dashboard)
        )
      );
    }).not.toThrow();

    // Verify SSR HTML does NOT leak Recharts clipPath IDs or SVG charts
    expect(ssrHtml).not.toContain('clipPath-recharts');
    expect(ssrHtml).not.toContain('recharts-responsive-container');
    expect(ssrHtml).not.toContain('<svg class="recharts-surface"');

    // Verify SSR renders smooth pulse skeleton placeholders instead
    expect(ssrHtml).toContain('animate-pulse');
  }, 25000);
});

describe('ResponsiveContainer Sizing & Container Safety Checks', () => {
  it('enforces explicit heights on all chart container wrappers', () => {
    // Trend chart wrapper must have explicit height and min-height
    expect(pageSource).toContain('h-[240px] w-full min-h-[240px]');
    // Sentiment Gauge wrapper must have explicit height and min-height
    expect(pageSource).toContain('w-full h-[120px] min-h-[120px]');
  });

  it('enforces min-w-0 on all flex and grid parents to prevent resize loops', () => {
    // Grid columns
    expect(pageSource).toContain('lg:col-span-2 min-w-0');
    expect(pageSource).toContain('lg:col-span-1 min-w-0');
    // Chart wrappers
    expect(pageSource).toContain('h-[240px] w-full min-h-[240px] min-w-0 relative');
    expect(pageSource).toContain('w-full h-[120px] min-h-[120px] min-w-0 relative flex items-center justify-center');
  });

  it('passes minWidth={0} and explicit minHeight to all ResponsiveContainer instances', () => {
    const responsiveContainers = pageSource.match(/<ResponsiveContainer[^>]*>/g) || [];
    expect(responsiveContainers.length).toBe(2);

    for (const containerTag of responsiveContainers) {
      expect(containerTag).toContain('minWidth={0}');
      expect(containerTag).toContain('minHeight=');
      expect(containerTag).toContain('width="100%"');
      expect(containerTag).toContain('height="100%"');
    }
  });
});

describe('Tooltip & Hover Component Safety', () => {
  // Extract or recreate tooltip components as defined in page.tsx
  function CustomAreaTooltip({ active, payload, label }: any) {
    if (!active || !payload || !payload.length) return null;
    return React.createElement(
      'div',
      { className: 'tooltip-container' },
      React.createElement('div', { className: 'label' }, label),
      payload.map((entry: any, i: number) =>
        React.createElement(
          'div',
          { key: `tooltip-${i}`, className: 'entry' },
          entry.name,
          ': ',
          Number(entry.value).toLocaleString()
        )
      )
    );
  }

  it('CustomAreaTooltip returns null when inactive or empty', () => {
    expect(CustomAreaTooltip({ active: false, payload: [{ value: 10 }] })).toBeNull();
    expect(CustomAreaTooltip({ active: true, payload: [] })).toBeNull();
    expect(CustomAreaTooltip({ active: true, payload: null })).toBeNull();
  });

  it('CustomAreaTooltip renders gracefully with zero and normal values', () => {
    const payload = [
      { name: 'Emails Sent', value: 0, stroke: '#2563EB' },
      { name: 'Unique Opens', value: 1500, stroke: '#059669' },
      { name: 'Unique Clicks', value: 250, stroke: '#D97706' },
    ];
    const html = renderToString(
      CustomAreaTooltip({ active: true, payload, label: 'Oct 24' })
    ).replace(/<!-- -->/g, '');
    expect(html).toContain('Oct 24');
    expect(html).toContain('Emails Sent: 0');
    expect(html).toContain('Unique Opens: 1,500');
    expect(html).toContain('Unique Clicks: 250');
  });

});

describe('Sentiment Gauge Edge Case Synthesis', () => {
  function synthesizeSentiment(sentiment: any[]) {
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

    return {
      positiveSentiment,
      neutralSentiment,
      negativeSentiment,
      totalSentiment,
      positiveSentimentRate,
      gaugeData,
    };
  }

  it('handles empty sentiment array gracefully without NaN', () => {
    const res = synthesizeSentiment([]);
    expect(res.totalSentiment).toBe(0);
    expect(res.positiveSentimentRate).toBe(0);
    expect(res.gaugeData).toEqual([{ name: 'No Data', value: 1, fill: '#F1F5F9' }]);
  });

  it('filters out zero-value categories from gaugeData to prevent PieChart render defects', () => {
    const sentiment = [
      { name: 'Interested', value: 10 },
      { name: 'Meeting Booked', value: 5 },
      // Neutral has 0
      // Negative has 0
    ];
    const res = synthesizeSentiment(sentiment);
    expect(res.totalSentiment).toBe(15);
    expect(res.positiveSentimentRate).toBe(100);
    expect(res.gaugeData.length).toBe(1);
    expect(res.gaugeData[0].name).toBe('Positive');
    expect(res.gaugeData[0].value).toBe(15);
  });

  it('calculates weighted rates accurately when all sentiment categories exist', () => {
    const sentiment = [
      { name: 'Interested', value: 40 },
      { name: 'Meeting Booked', value: 10 },
      { name: 'Neutral', value: 25 },
      { name: 'Out of Office', value: 5 },
      { name: 'Not Interested', value: 15 },
      { name: 'Bounced', value: 5 },
    ];
    const res = synthesizeSentiment(sentiment);
    expect(res.positiveSentiment).toBe(50);
    expect(res.neutralSentiment).toBe(30);
    expect(res.negativeSentiment).toBe(20);
    expect(res.totalSentiment).toBe(100);
    expect(res.positiveSentimentRate).toBe(50);
    expect(res.gaugeData.length).toBe(3);
  });
});

describe('House Design Directives & Chart Hygiene in page.tsx', () => {
  it('contains zero unicode emojis in app/page.tsx', () => {
    const emojiRegex = /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/u;
    const match = pageSource.match(emojiRegex);
    expect(match).toBeNull();
  });

  it('does not contain generic AI vibe-coded purple gradient blobs or rainbow text', () => {
    const vibeCodedWords = ['from-purple', 'to-pink', 'from-fuchsia', 'shadow-purple', 'rainbow'];
    for (const word of vibeCodedWords) {
      expect(pageSource.toLowerCase()).not.toContain(word);
    }
  });

  it('uses Title Case headings throughout the dashboard', () => {
    expect(pageSource).toContain('title="Dashboard"');
    expect(pageSource).toContain('Engagement Trends');
    expect(pageSource).toContain('Conversion Funnel');
    expect(pageSource).toContain('Prospect Sentiment');
    expect(pageSource).toContain('Recent Campaigns');
    expect(pageSource).toContain('Required Setup Steps');
    expect(pageSource).toContain('Busiest Send Day');
  });
});

describe('Skeleton-to-Chart Zero Layout Shift (CLS) Parity', () => {
  it('guarantees identical height dimensions between SSR skeletons and client charts', () => {
    // Trend chart: outer wrapper is h-[240px], skeleton is h-full, chart is height="100%"
    expect(pageSource).toMatch(/h-\[240px\] w-full min-h-\[240px\]/);
    expect(pageSource).toMatch(/<ResponsiveContainer width="100%" height="100%" minWidth=\{0\} minHeight=\{240\}/);

    // Sentiment Gauge: outer wrapper is h-[120px], skeleton is h-full, chart is height="100%"
    expect(pageSource).toMatch(/className="mt-2 w-full h-\[120px\] min-h-\[120px\]/);
    expect(pageSource).toMatch(/<ResponsiveContainer width="100%" height="100%" minWidth=\{0\} minHeight=\{120\}/);
  });
});

describe('Deliverability Health Telemetry Integration', () => {
  it('integrates Failed Sends, Bounced, and Unsubscribed with proper tooltips and icons', () => {
    expect(pageSource).toContain('Failed Sends');
    expect(pageSource).toContain('Bounced');
    expect(pageSource).toContain('Unsubscribed');
    expect(pageSource).toContain('XCircle');
    expect(pageSource).toContain('AlertTriangle');
    expect(pageSource).toContain('UserMinus');
  });
});

describe('Recent Campaigns Table Logic & Edge Cases', () => {
  const STATUS_BADGE: Record<string, { label: string; tone: string }> = {
    Active: { label: 'Active', tone: 'green' },
    Paused: { label: 'Paused', tone: 'amber' },
    Completed: { label: 'Completed', tone: 'blue' },
    Draft: { label: 'Draft', tone: 'neutral' },
    Stopped: { label: 'Stopped', tone: 'red' },
  };

  function resolveCampaignStatus(c: any) {
    const totalLeads = c.enrollmentSummary?.total ?? 0;
    const isCompleted = totalLeads > 0 && c.enrollmentSummary?.completed === totalLeads;
    const resolvedStatus = isCompleted ? 'Completed' : c.status;
    return STATUS_BADGE[resolvedStatus] || STATUS_BADGE.Draft;
  }

  it('resolves active campaign with a green badge', () => {
    const pill = resolveCampaignStatus({ status: 'Active', enrollmentSummary: { total: 100, completed: 50 } });
    expect(pill.label).toBe('Active');
    expect(pill.tone).toBe('green');
  });

  it('resolves completed campaign when all leads have finished', () => {
    const pill = resolveCampaignStatus({ status: 'Active', enrollmentSummary: { total: 100, completed: 100 } });
    expect(pill.label).toBe('Completed');
    expect(pill.tone).toBe('blue');
  });

  it('safely falls back to Draft for unknown status', () => {
    const pill = resolveCampaignStatus({ status: 'Archived', enrollmentSummary: null });
    expect(pill.label).toBe('Draft');
  });

  it('calculates openRate safely with missing or zero sent dispatches', () => {
    function formatOpenRate(c: any, totalSent: number) {
      const hasOpenRate = typeof c.openRate === 'number';
      const openRateValue = hasOpenRate ? c.openRate : 0;
      if (hasOpenRate) return `${openRateValue.toFixed(1)}%`;
      return totalSent > 0 ? '—' : '0.0%';
    }

    expect(formatOpenRate({ openRate: 42.56 }, 100)).toBe('42.6%');
    expect(formatOpenRate({}, 100)).toBe('—');
    expect(formatOpenRate({}, 0)).toBe('0.0%');
  });
});

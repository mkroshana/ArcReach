/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import React, { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import Link from 'next/link';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import {
  MailOpen,
  MousePointerClick,
  Reply,
  SendHorizontal,
  RefreshCw,
  XCircle,
  AlertTriangle,
  UserMinus,
  Plus,
  Inbox,
  ArrowRight,
  Check,
} from 'lucide-react';
import { Tooltip as MuiTooltip } from '@mui/material';
import { useTheme as useAppTheme } from '@/components/ThemeProvider';
import { replyCountUnknown } from '@/lib/imapSyncStatus';
import { LoadError, loadErrorMessage, readJsonObject } from '@/lib/apiResponse';
import { sendsByWeekday } from '@/lib/busiestSendDay';
import { Card, CardHeader } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { StatCard } from '@/components/ui/StatCard';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';

/* -------------------------------------------------------------------------- */
/*                               HYDRATION GUARD                              */
/* -------------------------------------------------------------------------- */

const emptySubscribe = () => () => {};

/**
 * SSR hydration guard using React 19 useSyncExternalStore.
 * Ensures zero hydration mismatches and eliminates Next.js 15 SSR ResponsiveContainer warnings.
 */
function useIsMounted() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

/* -------------------------------------------------------------------------- */
/*                                 CONSTANTS                                  */
/* -------------------------------------------------------------------------- */

/**
 * The Replies card's note while no mailbox that receives replies has reply sync on.
 */
const REPLY_SYNC_OFF_NOTE =
  "No mailbox that receives replies has reply sync on, so replies are not read and are missing from these counts. Replies to a mailbox's emails go to its Reply-To address when it has one, which is read only if it is a mailbox with reply sync on. On the Accounts page, set up reply sync on a mailbox, or check each mailbox's Reply-To.";

/** Status badge for each campaign status in Recent Campaigns. */
const STATUS_BADGE: Record<string, { label: string; tone: BadgeTone }> = {
  Active: { label: 'Active', tone: 'green' },
  Paused: { label: 'Paused', tone: 'amber' },
  Completed: { label: 'Completed', tone: 'blue' },
  Draft: { label: 'Draft', tone: 'neutral' },
  Stopped: { label: 'Stopped', tone: 'red' },
};

const RANGE_OPTIONS = [
  { label: '7d', value: '7' },
  { label: '30d', value: '30' },
  { label: '90d', value: '90' },
] as const;

/**
 * Trend series colours, checked with the dataviz palette validator against each
 * mode's card surface. Dark mode takes its own steps; Clicks is also dashed,
 * since its dark step sits close to Opens for protan readers.
 */
const SERIES_COLORS = {
  light: { sent: '#2563EB', opens: '#10B981', clicks: '#F59E0B' },
  dark: { sent: '#3B82F6', opens: '#059669', clicks: '#D97706' },
};

const WEEKDAY_NAMES: Record<string, string> = {
  Mon: 'Monday',
  Tue: 'Tuesday',
  Wed: 'Wednesday',
  Thu: 'Thursday',
  Fri: 'Friday',
  Sat: 'Saturday',
  Sun: 'Sunday',
};

/** Y-axis ticks: 3,200 reads as 3.2k so the axis stays narrow. */
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

const campaignDateFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/* -------------------------------------------------------------------------- */
/*                                SUBCOMPONENTS                               */
/* -------------------------------------------------------------------------- */

function CaveatMark({ note }: { note: string }) {
  return (
    <MuiTooltip title={note} arrow>
      <span
        tabIndex={0}
        aria-label={note}
        className="inline-flex text-amber-500 hover:text-amber-600 dark:text-amber-400 align-middle cursor-help transition-colors"
      >
        <AlertTriangle size={13} strokeWidth={2.2} />
      </span>
    </MuiTooltip>
  );
}

function TrendTooltip({ active, payload, label }: any) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="min-w-[160px] rounded-control border border-card-border bg-card p-3 text-xs shadow-[var(--float-shadow)]">
      <div className="mb-2 font-medium text-text-main">{label}</div>
      <div className="space-y-1.5">
        {payload.map((entry: any, i: number) => (
          <div key={`tooltip-${i}`} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-text-sub">
              <span className="size-2 rounded-full" style={{ backgroundColor: entry.stroke || entry.color }} />
              {entry.name}
            </span>
            <span className="font-medium text-text-main">{Number(entry.value).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A trend series' legend entry: its colour, name and total over the range. */
function SeriesTotal({ color, label, total, dashed }: { color: string; label: string; total: number; dashed?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="h-0.5 w-3 rounded-full"
        style={dashed ? { backgroundImage: `linear-gradient(90deg, ${color} 60%, transparent 60%)`, backgroundSize: '4px 2px' } : { backgroundColor: color }}
      />
      <span className="text-xs text-text-sub">{label}</span>
      <span className="text-[13px] font-semibold text-text-main">{total.toLocaleString()}</span>
    </div>
  );
}

/** A delivery-problem count under the trend chart, with a coloured underline naming its kind. */
function HealthTile({
  label,
  value,
  note,
  icon: Icon,
  accentClass,
}: {
  label: string;
  value: number;
  note: string;
  icon: React.ElementType;
  accentClass: string;
}) {
  return (
    <MuiTooltip title={note} arrow>
      <div className="rounded-control bg-canvas px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-1.5 text-xs text-text-sub">
          <Icon size={13} strokeWidth={2} className="shrink-0 text-text-muted" />
          {label}
        </div>
        <div className="mt-1 text-base font-semibold text-text-main">{value.toLocaleString()}</div>
        <div aria-hidden className={`mt-2 h-0.5 w-8 rounded-full ${accentClass}`} />
      </div>
    </MuiTooltip>
  );
}

/* -------------------------------------------------------------------------- */
/*                                MAIN COMPONENT                              */
/* -------------------------------------------------------------------------- */

export default function Dashboard() {
  const isMounted = useIsMounted();
  const { theme: appMode } = useAppTheme();
  const isDark = appMode === 'dark';

  const gridStroke = isDark ? '#1E222D' : '#EEF1F5';
  const axisTickColor = isDark ? '#94A3B8' : '#64748B';
  const trackBg = isDark ? '#1E222D' : '#F1F5F9';
  const series = isDark ? SERIES_COLORS.dark : SERIES_COLORS.light;

  const [range, setRange] = useState('7');
  const [stats, setStats] = useState<any>(null);
  const [statsRange, setStatsRange] = useState(range);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [trends, setTrends] = useState<any[]>([]);
  const [funnel, setFunnel] = useState<any[]>([]);
  const [sentiment, setSentiment] = useState<any[]>([]);
  const [recentCampaigns, setRecentCampaigns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [systemStatus, setSystemStatus] = useState<any>(null);
  const inFlight = useRef<AbortController | null>(null);

  const fetchStats = async (selectedRange: string) => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setLoading(true);
    try {
      const [statsRes, statusRes, campaignsRes] = await Promise.all([
        fetch(`/api/dashboard-stats?range=${selectedRange}`, { signal: controller.signal }),
        fetch('/api/system-status', { signal: controller.signal }),
        fetch(`/api/campaigns?t=${Date.now()}`, { signal: controller.signal }),
      ]);

      const status = statusRes.ok ? await statusRes.json().catch(() => null) : null;
      if (controller.signal.aborted) return;
      setSystemStatus(status);

      const data = await readJsonObject(statsRes, 'Analytics');
      if (controller.signal.aborted) return;
      if (!data.stats || typeof data.stats !== 'object') {
        throw new LoadError('Analytics could not be loaded: the server sent no totals.');
      }
      setStats(data.stats);
      setTrends(Array.isArray(data.trends) ? data.trends : []);
      setFunnel(Array.isArray(data.funnel) ? data.funnel : []);
      setSentiment(Array.isArray(data.sentiment) ? data.sentiment : []);
      setStatsRange(selectedRange);
      setLoadedAt(new Date());
      setLoadError('');

      if (campaignsRes.ok) {
        const campData = await campaignsRes.json().catch(() => []);
        if (Array.isArray(campData)) {
          setRecentCampaigns(campData.slice(0, 5));
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error('Failed to load stats:', error);
      setLoadError(loadErrorMessage(error, 'Analytics'));
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    fetchStats(range);
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible' && !inFlight.current) fetchStats(range);
    }, 30000);
    return () => {
      clearInterval(interval);
      inFlight.current?.abort();
    };
  }, [range]);

  const replySyncOff = stats?.replySync === 'off';
  const repliesUnknown = replyCountUnknown(stats?.replySync, stats?.totalReplies);
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

  // Sentiment synthesis
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

  const gaugeData =
    totalSentiment === 0
      ? [{ name: 'No Data', value: 1, fill: trackBg }]
      : [
          { name: 'Positive', value: positiveSentiment, fill: '#10B981' },
          { name: 'Neutral', value: neutralSentiment, fill: '#94A3B8' },
          { name: 'Negative', value: negativeSentiment, fill: '#F43F5E' },
        ].filter((s) => s.value > 0);

  const totalSentInFunnel = funnel.find((s) => s.name === 'Sent')?.value || 0;

  // Totals over the range for the trend legend, and sends per weekday.
  const trendTotals = trends.reduce(
    (acc, t) => ({
      sent: acc.sent + (Number(t.sent) || 0),
      opens: acc.opens + (Number(t.opens) || 0),
      clicks: acc.clicks + (Number(t.clicks) || 0),
    }),
    { sent: 0, opens: 0, clicks: 0 }
  );
  const weekdays = sendsByWeekday(trends);
  const weekdayMax = Math.max(1, ...weekdays.days.map((d) => d.sent));
  const comparison = `vs. prior ${statsRange} days`;

  return (
    <div className="space-y-4 pb-10">
      <PageHeader
        title="Dashboard"
        actions={
          <>
            {loadedAt && (
              <span className="mr-1 hidden text-xs text-text-muted sm:inline">
                {loading ? 'Refreshing…' : `Updated ${loadedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
              </span>
            )}
            <Segmented label="Date range" options={RANGE_OPTIONS} value={range as '7' | '30' | '90'} onChange={setRange} />
            <MuiTooltip title="Refresh">
              <Button iconOnly aria-label="Refresh analytics" onClick={() => fetchStats(range)}>
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              </Button>
            </MuiTooltip>
            <Link href="/campaigns" className={buttonClasses({ variant: 'primary' })}>
              <Plus size={15} />
              Create Campaign
            </Link>
          </>
        }
      />

      {/* Setup Wizard */}
      {needsSetup && (
        <Card className="p-5">
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} className="text-amber-500" />
            <h2 className="text-sm font-semibold text-text-main">Required Setup Steps</h2>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
            {setupSteps.map((s) => (
              <div key={s.title} className="rounded-control bg-canvas p-4">
                <div className="flex items-center gap-2">
                  {s.done ? (
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
                      <Check size={12} strokeWidth={2.5} />
                    </span>
                  ) : (
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-amber-50 dark:bg-amber-500/10">
                      <span className="size-1.5 rounded-full bg-amber-500" />
                    </span>
                  )}
                  <span className="text-[13px] font-medium text-text-main">{s.title}</span>
                </div>
                <p className="mt-2 text-xs text-text-sub">{s.done ? s.done_text : s.todo}</p>
                <Link
                  href={s.href}
                  className={`mt-3 inline-flex items-center gap-1 text-xs font-medium transition-colors ${
                    s.done ? 'text-text-sub hover:text-text-main' : 'text-primary hover:text-primary-hover'
                  }`}
                >
                  {s.done ? 'Manage' : s.cta}
                  <ArrowRight size={12} />
                </Link>
              </div>
            ))}
          </div>
        </Card>
      )}

      {!stats && loading && !loadError ? (
        /* Initial load skeletons, the same heights as the cards they stand in for */
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-[118px] rounded-card bg-slate-100 dark:bg-white/5 animate-pulse" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2 h-[430px] rounded-card bg-slate-100 dark:bg-white/5 animate-pulse" />
            <div className="h-[430px] rounded-card bg-slate-100 dark:bg-white/5 animate-pulse" />
          </div>
          <div className="h-[320px] rounded-card bg-slate-100 dark:bg-white/5 animate-pulse" />
        </div>
      ) : !stats ? (
        /* Failed initial load */
        <Card className="flex items-start justify-between gap-4 border-rose-200 p-4 dark:border-rose-900/50">
          <div>
            <div className="text-sm font-semibold text-rose-700 dark:text-rose-300">Analytics Could Not Be Loaded</div>
            <div className="mt-1 text-xs text-text-sub">
              {loadError || 'Analytics could not be loaded.'}
              {loading ? ' Trying again…' : ''}
            </div>
          </div>
          <Button onClick={() => fetchStats(range)}>
            <RefreshCw size={13} />
            Retry
          </Button>
        </Card>
      ) : (
        <>
          {/* Refresh failed while showing the last loaded figures */}
          {loadError && (
            <Card className="flex items-start justify-between gap-4 border-amber-200 p-4 dark:border-amber-900/50">
              <div>
                <div className="text-[13px] font-semibold text-amber-700 dark:text-amber-300">
                  Analytics Could Not Be Refreshed
                </div>
                <div className="mt-0.5 text-xs text-text-sub">
                  Showing the last {statsRange} days as loaded at {loadedAt?.toLocaleTimeString()}. {loadError}
                </div>
              </div>
              <Button size="sm" onClick={() => fetchStats(range)}>
                <RefreshCw size={12} />
                Retry
              </Button>
            </Card>
          )}

          {/* 1. KPI row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Emails Sent"
              icon={SendHorizontal}
              value={stats.totalSent.toLocaleString()}
              delta={stats.deltas?.sent}
              comparison={comparison}
            />
            <StatCard
              label="Open Rate"
              icon={MailOpen}
              value={`${stats.averageOpenRate}%`}
              delta={stats.deltas?.openRate}
              comparison={comparison}
            />
            <StatCard
              label="Click Rate"
              icon={MousePointerClick}
              value={`${stats.averageClickRate}%`}
              delta={stats.deltas?.clickRate}
              comparison={comparison}
            />
            <StatCard
              label="Replies"
              icon={Reply}
              value={repliesUnknown ? '—' : stats.totalReplies.toLocaleString()}
              delta={replySyncOff ? undefined : stats.deltas?.replies}
              comparison={replySyncOff ? undefined : comparison}
              footer={
                replySyncOff ? (
                  <span className="inline-flex items-center gap-1.5">
                    Reply sync off
                    <CaveatMark note={REPLY_SYNC_OFF_NOTE} />
                  </span>
                ) : undefined
              }
            />
          </div>

          {/* 2. Engagement trend (2/3) beside the funnel (1/3) */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2 min-w-0 p-5">
              <CardHeader title="Engagement Trends" />
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
                <SeriesTotal color={series.sent} label="Emails Sent" total={trendTotals.sent} />
                <SeriesTotal color={series.opens} label="Unique Opens" total={trendTotals.opens} />
                <SeriesTotal color={series.clicks} label="Unique Clicks" total={trendTotals.clicks} dashed />
              </div>

              <div className="mt-4 h-[240px] w-full min-h-[240px] min-w-0 relative">
                {!isMounted ? (
                  <div className="w-full h-full animate-pulse rounded-control bg-slate-100 dark:bg-white/5" />
                ) : trends.length === 0 ? (
                  <div className="w-full h-full flex flex-col items-center justify-center text-center">
                    <Inbox size={24} className="mb-2 text-text-muted" />
                    <span className="text-[13px] font-medium text-text-sub">No engagement activity recorded</span>
                    <span className="mt-0.5 text-xs text-text-muted">Sent emails and prospect interactions will chart here</span>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={240}>
                    <ComposedChart data={trends} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="trendSentFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={series.sent} stopOpacity={0.16} />
                          <stop offset="100%" stopColor={series.sent} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} stroke={gridStroke} />
                      <XAxis
                        dataKey="name"
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: axisTickColor, fontSize: 11 }}
                        dy={8}
                        minTickGap={16}
                      />
                      <YAxis
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: axisTickColor, fontSize: 11 }}
                        allowDecimals={false}
                        tickFormatter={(v: number) => compactNumber.format(v)}
                        width={36}
                      />
                      <RechartsTooltip content={<TrendTooltip />} cursor={{ stroke: gridStroke, strokeWidth: 1 }} />
                      <Area
                        type="monotone"
                        dataKey="sent"
                        stroke={series.sent}
                        strokeWidth={2}
                        fill="url(#trendSentFill)"
                        name="Emails Sent"
                        isAnimationActive={false}
                        activeDot={{ r: 4, strokeWidth: 2, stroke: isDark ? '#11131A' : '#FFFFFF' }}
                      />
                      <Line
                        type="monotone"
                        dataKey="opens"
                        stroke={series.opens}
                        strokeWidth={2}
                        dot={false}
                        name="Unique Opens"
                        isAnimationActive={false}
                        activeDot={{ r: 4, strokeWidth: 2, stroke: isDark ? '#11131A' : '#FFFFFF' }}
                      />
                      <Line
                        type="monotone"
                        dataKey="clicks"
                        stroke={series.clicks}
                        strokeWidth={2}
                        strokeDasharray="4 3"
                        dot={false}
                        name="Unique Clicks"
                        isAnimationActive={false}
                        activeDot={{ r: 4, strokeWidth: 2, stroke: isDark ? '#11131A' : '#FFFFFF' }}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <HealthTile
                  label="Failed Sends"
                  value={stats.failed ?? 0}
                  note="Send attempts recorded as failed"
                  icon={XCircle}
                  accentClass="bg-rose-500"
                />
                <HealthTile
                  label="Bounced"
                  value={stats.bounced ?? 0}
                  note="Hard bounces at send time or reported on delivery"
                  icon={AlertTriangle}
                  accentClass="bg-amber-500"
                />
                <HealthTile
                  label="Unsubscribed"
                  value={stats.unsubscribed ?? 0}
                  note="Opted out of mailings"
                  icon={UserMinus}
                  accentClass="bg-slate-400"
                />
              </div>
            </Card>

            <Card className="lg:col-span-1 min-w-0 flex flex-col p-5">
              <CardHeader title="Conversion Funnel" />
              {repliesUnknown && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle size={12} className="shrink-0" />
                  Replied stage omitted (reply sync is unconfigured).
                </p>
              )}
              {funnel.length === 0 || totalSentInFunnel === 0 ? (
                <div className="flex h-[240px] flex-col items-center justify-center text-center">
                  <Inbox size={24} className="mb-2 text-text-muted" />
                  <span className="text-[13px] font-medium text-text-sub">No outreach dispatches recorded</span>
                  <span className="mt-0.5 text-xs text-text-muted">Launch a campaign sequence to view conversion flow</span>
                </div>
              ) : (
                <ul className="mt-4 flex flex-1 flex-col justify-between gap-4">
                  {funnel.map((stage) => {
                    const share = (stage.value / totalSentInFunnel) * 100;
                    return (
                      <li key={stage.name}>
                        <div className="flex items-baseline justify-between gap-3 text-[13px]">
                          <span className="text-text-sub">{stage.name}</span>
                          <span className="flex items-baseline gap-2">
                            <span className="font-semibold text-text-main">{Number(stage.value).toLocaleString()}</span>
                            {stage.name !== 'Sent' && (
                              <span className="w-12 text-right text-xs text-text-muted">{share.toFixed(1)}%</span>
                            )}
                          </span>
                        </div>
                        <div className="mt-1.5 h-1.5 rounded-full bg-slate-100 dark:bg-white/5">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${Math.min(100, Math.max(stage.value > 0 ? 1 : 0, share))}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>

          {/* 3. Recent campaigns (2/3) beside the busiest send day and sentiment (1/3) */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:items-start">
            <Card className="lg:col-span-2 min-w-0 overflow-hidden">
              <CardHeader
                className="px-5 pt-4 pb-3"
                title="Recent Campaigns"
                action={
                  <Link href="/campaigns" className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
                    View All
                    <ArrowRight size={13} />
                  </Link>
                }
              />
              <div className="w-full overflow-x-auto">
                <Table>
                  <THead>
                    <tr>
                      <TH className="pl-5">Campaign</TH>
                      <TH>Status</TH>
                      <TH className="text-right">Leads</TH>
                      <TH className="text-right">Sent</TH>
                      <TH className="pr-5">Open Rate</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {loading && recentCampaigns.length === 0 ? (
                      [0, 1, 2, 3].map((idx) => (
                        <TR key={idx} className="animate-pulse">
                          <TD className="pl-5">
                            <div className="h-4 w-36 rounded bg-slate-100 dark:bg-white/5" />
                          </TD>
                          <TD>
                            <div className="h-4 w-14 rounded bg-slate-100 dark:bg-white/5" />
                          </TD>
                          <TD>
                            <div className="ml-auto h-4 w-10 rounded bg-slate-100 dark:bg-white/5" />
                          </TD>
                          <TD>
                            <div className="ml-auto h-4 w-10 rounded bg-slate-100 dark:bg-white/5" />
                          </TD>
                          <TD className="pr-5">
                            <div className="h-4 w-20 rounded bg-slate-100 dark:bg-white/5" />
                          </TD>
                        </TR>
                      ))
                    ) : recentCampaigns.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-5 py-10 text-center">
                          <h3 className="text-sm font-semibold text-text-main">No Campaigns Created Yet</h3>
                          <p className="mx-auto mt-1 max-w-sm text-xs text-text-sub">
                            Create your first automated email campaign to start reaching prospects and tracking engagement metrics.
                          </p>
                          <Link href="/campaigns" className={buttonClasses({ variant: 'primary', className: 'mt-4' })}>
                            <Plus size={15} />
                            Create Campaign
                          </Link>
                        </td>
                      </tr>
                    ) : (
                      recentCampaigns.map((c) => {
                        const totalLeads = c.enrollmentSummary?.total ?? 0;
                        const totalSent = c.stepStats?.reduce((acc: number, s: any) => acc + (s.sent || 0), 0) ?? 0;
                        const isCompleted = totalLeads > 0 && c.enrollmentSummary?.completed === totalLeads;
                        const resolvedStatus = isCompleted ? 'Completed' : c.status;
                        const badge = STATUS_BADGE[resolvedStatus] || STATUS_BADGE.Draft;
                        const hasOpenRate = typeof c.openRate === 'number';
                        const openRateValue = hasOpenRate ? c.openRate : 0;

                        return (
                          <TR key={c.id}>
                            <TD className="max-w-[280px] pl-5">
                              <Link
                                href={`/campaigns/${c.id}`}
                                className="block truncate font-medium text-text-main transition-colors hover:text-primary"
                              >
                                {c.name}
                              </Link>
                              <span className="block truncate text-xs text-text-muted">
                                {c.createdAt
                                  ? `Created ${campaignDateFormat.format(new Date(c.createdAt))}`
                                  : c.senderAccount?.emailAddress || 'Automated Sequence'}
                              </span>
                            </TD>
                            <TD>
                              <Badge tone={badge.tone} dot>
                                {badge.label}
                              </Badge>
                            </TD>
                            <TD className="text-right">{totalLeads.toLocaleString()}</TD>
                            <TD className="text-right">{totalSent.toLocaleString()}</TD>
                            <TD className="pr-5">
                              {hasOpenRate ? (
                                <div className="flex items-center gap-2.5">
                                  <span className="w-11 text-text-main">{openRateValue.toFixed(1)}%</span>
                                  <div className="h-1.5 w-16 rounded-full bg-slate-100 dark:bg-white/5">
                                    <div
                                      className="h-full rounded-full bg-primary"
                                      style={{ width: `${Math.min(100, Math.max(0, openRateValue))}%` }}
                                    />
                                  </div>
                                </div>
                              ) : (
                                <span className="text-text-muted">{totalSent > 0 ? '—' : '0.0%'}</span>
                              )}
                            </TD>
                          </TR>
                        );
                      })
                    )}
                  </tbody>
                </Table>
              </div>
            </Card>

            <div className="lg:col-span-1 min-w-0 space-y-4">
              {/* Busiest send day, from the trend's daily sends */}
              <Card className="p-5">
                <CardHeader title="Busiest Send Day" />
                {weekdays.busiest ? (
                  <>
                    <div className="mt-2 text-2xl font-semibold tracking-tight text-text-main">
                      {WEEKDAY_NAMES[weekdays.busiest.day]}
                    </div>
                    <p className="mt-0.5 text-xs text-text-muted">
                      {weekdays.busiest.sent.toLocaleString()} emails sent on {WEEKDAY_NAMES[weekdays.busiest.day]}s in the last {statsRange} days
                    </p>
                    <div className="mt-4 flex h-[96px] items-end gap-1.5" role="list" aria-label="Emails sent by weekday">
                      {weekdays.days.map((d) => (
                        <MuiTooltip key={d.day} title={`${WEEKDAY_NAMES[d.day]}: ${d.sent.toLocaleString()} sent`} arrow>
                          <div role="listitem" className="flex h-full flex-1 cursor-default flex-col justify-end">
                            <div
                              className={`rounded-t-[4px] ${d === weekdays.busiest ? 'bg-primary' : 'bg-blue-100 dark:bg-primary-subtle'}`}
                              style={{ height: `${Math.max(d.sent > 0 ? 4 : 2, (d.sent / weekdayMax) * 100)}%` }}
                            />
                          </div>
                        </MuiTooltip>
                      ))}
                    </div>
                    <div className="mt-1.5 flex gap-1.5">
                      {weekdays.days.map((d) => (
                        <span key={d.day} className="flex-1 text-center text-[11px] text-text-muted">
                          {d.day}
                        </span>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="mt-2 text-xs text-text-muted">No emails sent in the last {statsRange} days.</p>
                )}
              </Card>

              {/* Prospect sentiment gauge */}
              <Card className="p-5">
                <CardHeader title="Prospect Sentiment" />
                <div className="mt-2 w-full h-[120px] min-h-[120px] min-w-0 relative flex items-center justify-center">
                  {!isMounted ? (
                    <div className="w-full h-full animate-pulse rounded-control bg-slate-100 dark:bg-white/5" />
                  ) : (
                    <>
                      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={120}>
                        <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                          <Pie
                            data={gaugeData}
                            cx="50%"
                            cy="88%"
                            startAngle={180}
                            endAngle={0}
                            innerRadius={68}
                            outerRadius={84}
                            paddingAngle={totalSentiment > 0 && gaugeData.length > 1 ? 2 : 0}
                            dataKey="value"
                            isAnimationActive={false}
                          >
                            {gaugeData.map((entry, index) => (
                              <Cell key={`gauge-cell-${index}`} fill={entry.fill} stroke="none" />
                            ))}
                          </Pie>
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 text-center">
                        <span className="block text-2xl font-semibold tracking-tight text-text-main">
                          {totalSentiment > 0 ? `${positiveSentimentRate}%` : '—'}
                        </span>
                        <span className="block text-xs text-text-muted">
                          {totalSentiment > 0 ? 'Positive' : 'No Contacts'}
                        </span>
                      </div>
                    </>
                  )}
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 border-t border-card-border pt-3">
                  {[
                    { label: 'Positive', value: positiveSentiment, dot: 'bg-emerald-500' },
                    { label: 'Neutral', value: neutralSentiment, dot: 'bg-slate-400' },
                    { label: 'Negative', value: negativeSentiment, dot: 'bg-rose-500' },
                  ].map((s) => (
                    <div key={s.label}>
                      <div className="flex items-center gap-1.5 text-xs text-text-sub">
                        <span className={`size-2 rounded-full ${s.dot}`} />
                        {s.label}
                      </div>
                      <div className="mt-0.5 text-[13px] font-semibold text-text-main">{s.value.toLocaleString()}</div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import React, { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import Link from 'next/link';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import {
  Mail,
  MailOpen,
  MousePointerClick,
  Reply,
  SendHorizontal,
  RefreshCw,
  XCircle,
  AlertTriangle,
  UserMinus,
  Plus,
  Workflow,
  CheckCircle2,
  Inbox,
  ArrowRight,
  ChevronRight,
  Check,
  Calendar,
  ChevronDown,
} from 'lucide-react';
import { Tooltip as MuiTooltip } from '@mui/material';
import { useTheme as useAppTheme } from '@/components/ThemeProvider';
import { deliveryStatusText } from '@/lib/systemStatus';
import { replyCountUnknown } from '@/lib/imapSyncStatus';
import { LoadError, loadErrorMessage, readJsonObject } from '@/lib/apiResponse';

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

/** The outbox chip for each /api/system-status deliveryStatus. */
const DELIVERY_CHIP: Record<string, { label: string; dotClass: string }> = {
  RUNNING: { label: 'Outbox Running', dotClass: 'bg-emerald-500' },
  STALLED: { label: 'Outbox Stalled', dotClass: 'bg-amber-500' },
  FAILING: { label: 'Outbox Failing', dotClass: 'bg-rose-500' },
  NOT_RUNNING: { label: 'Outbox Not Running', dotClass: 'bg-rose-500' },
  DISABLED: { label: 'Sending Disabled', dotClass: 'bg-amber-500' },
};

/**
 * The Replies card's note while no mailbox that receives replies has reply sync on.
 */
const REPLY_SYNC_OFF_NOTE =
  "No mailbox that receives replies has reply sync on, so replies are not read and are missing from these counts. Replies to a mailbox's emails go to its Reply-To address when it has one, which is read only if it is a mailbox with reply sync on. On the Accounts page, set up reply sync on a mailbox, or check each mailbox's Reply-To.";

/**
 * Status pill styling and indicators for Recent Campaigns table.
 */
const STATUS_PILL_CONFIG: Record<
  string,
  { label: string; badgeClass: string; dotClass: string; pulse: boolean }
> = {
  Active: {
    label: 'Active',
    badgeClass:
      'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60',
    dotClass: 'bg-emerald-500',
    pulse: true,
  },
  Paused: {
    label: 'Paused',
    badgeClass:
      'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800/60',
    dotClass: 'bg-amber-500',
    pulse: false,
  },
  Completed: {
    label: 'Completed',
    badgeClass:
      'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800/60',
    dotClass: 'bg-blue-500',
    pulse: false,
  },
  Draft: {
    label: 'Draft',
    badgeClass:
      'bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700/60',
    dotClass: 'bg-slate-400',
    pulse: false,
  },
  Stopped: {
    label: 'Stopped',
    badgeClass:
      'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800/60',
    dotClass: 'bg-rose-500',
    pulse: false,
  },
};

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
        className="inline-flex text-amber-500 hover:text-amber-600 dark:text-amber-400 align-middle ml-1 cursor-help transition-colors"
      >
        <AlertTriangle size={13} strokeWidth={2.2} />
      </span>
    </MuiTooltip>
  );
}

interface ShopeersMetricCardProps {
  title: string;
  value: string | number;
  change?: number | null;
  sub?: string;
  caveat?: string;
  icon: React.ElementType;
  colorScheme: 'blue' | 'emerald' | 'amber' | 'indigo';
}

const METRIC_THEMES = {
  blue: {
    iconBg: 'bg-blue-50 dark:bg-blue-950/40',
    iconText: 'text-[#2563EB] dark:text-[#60A5FA]',
    iconBorder: 'border-blue-100/80 dark:border-blue-900/40',
  },
  emerald: {
    iconBg: 'bg-emerald-50 dark:bg-emerald-950/40',
    iconText: 'text-[#059669] dark:text-[#34D399]',
    iconBorder: 'border-emerald-100/80 dark:border-emerald-900/40',
  },
  amber: {
    iconBg: 'bg-amber-50 dark:bg-amber-950/40',
    iconText: 'text-[#D97706] dark:text-[#FBBF24]',
    iconBorder: 'border-amber-100/80 dark:border-amber-900/40',
  },
  indigo: {
    iconBg: 'bg-indigo-50 dark:bg-indigo-950/40',
    iconText: 'text-[#7C3AED] dark:text-[#A78BFA]',
    iconBorder: 'border-indigo-100/80 dark:border-indigo-900/40',
  },
};

function ShopeersMetricCard({
  title,
  value,
  change,
  sub,
  caveat,
  icon: Icon,
  colorScheme,
}: ShopeersMetricCardProps) {
  const theme = METRIC_THEMES[colorScheme];
  const hasDelta = change !== undefined && change !== null;
  const numChange = Number(change) || 0;
  const isPositive = numChange > 0;
  const isNegative = numChange < 0;

  return (
    <div className="p-5 rounded-2xl bg-white dark:bg-[#11131A] border border-[#EBF0F5] dark:border-[#1E222D] shadow-xs hover:shadow-md transition-all duration-200 flex flex-col justify-between">
      {/* Top Header: Title & Icon */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          {title}
        </span>
        <div
          className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${theme.iconBg} ${theme.iconText} ${theme.iconBorder}`}
        >
          <Icon size={16} strokeWidth={2} />
        </div>
      </div>

      {/* Value: Standard Clean Typography */}
      <div className="mt-2.5">
        <div className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white font-sans">
          {value}
        </div>
      </div>

      {/* Footer: Delta Percentage Pill or Subtitle */}
      <div className="mt-2.5 flex items-center gap-2">
        {hasDelta ? (
          <>
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold font-mono border ${
                isPositive
                  ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-200/80 dark:border-emerald-800/60'
                  : isNegative
                  ? 'bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border-rose-200/80 dark:border-rose-800/60'
                  : 'bg-slate-100 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'
              }`}
            >
              {isPositive ? `+${numChange}%` : `${numChange}%`}
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              vs last period
            </span>
            {caveat && <CaveatMark note={caveat} />}
          </>
        ) : sub ? (
          <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <span>{sub}</span>
            {caveat && <CaveatMark note={caveat} />}
          </div>
        ) : (
          <span className="text-xs text-slate-400 dark:text-slate-500">
            Steady vs last period
          </span>
        )}
      </div>
    </div>
  );
}

function CustomAreaTooltip({ active, payload, label }: any) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white/95 dark:bg-[#11131A]/95 p-3.5 shadow-xl backdrop-blur-md min-w-[170px] text-xs">
      <div className="font-bold text-slate-800 dark:text-slate-100 pb-2 border-b border-slate-100 dark:border-slate-800/80 mb-2">
        {label}
      </div>
      <div className="space-y-1.5">
        {payload.map((entry: any, i: number) => (
          <div key={`tooltip-${i}`} className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.stroke || entry.color }} />
              <span className="text-slate-500 dark:text-slate-400 text-[11px] font-medium">{entry.name}</span>
            </div>
            <span className="font-bold font-mono text-slate-800 dark:text-slate-100 text-xs">
              {Number(entry.value).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShopeersChartTooltip({ active, payload, label, totalSent }: any) {
  if (!active || !payload || !payload.length) return null;

  const item = payload[0];
  const value = item.value ?? 0;
  const unit = item.payload?.unit || '';
  const color = item.color || item.payload?.fill || '#2563EB';
  const stageName = label || item.name;

  const conversionPct =
    totalSent && totalSent > 0 && stageName !== 'Sent'
      ? ((value / totalSent) * 100).toFixed(1)
      : null;

  return (
    <div className="z-50 min-w-[150px] rounded-xl border border-slate-700/80 bg-slate-900/95 px-3 py-2 text-white shadow-xl shadow-black/30 backdrop-blur-md pointer-events-none transition-all duration-150">
      <div className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase pb-1 mb-1.5 border-b border-slate-800">
        {stageName}
      </div>
      <div className="flex items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: color }}
          />
          <span className="text-slate-300 font-normal">Count:</span>
        </div>
        <div className="flex items-baseline gap-1">
          <span className="font-semibold text-white">{value.toLocaleString()}</span>
          {unit && <span className="text-[10px] text-slate-400">{unit}</span>}
        </div>
      </div>
      {conversionPct && (
        <div className="mt-1 pt-1 border-t border-slate-800/60 flex items-center justify-between text-[11px]">
          <span className="text-slate-400">Conv. Rate:</span>
          <span className="font-medium text-emerald-400">{conversionPct}% of Sent</span>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                MAIN COMPONENT                              */
/* -------------------------------------------------------------------------- */

export default function Dashboard() {
  const isMounted = useIsMounted();
  const { theme: appMode } = useAppTheme();
  const isDark = appMode === 'dark';

  const gridStroke = isDark ? '#1E222D' : '#EBF0F5';
  const axisTickColor = isDark ? '#94A3B8' : '#64748B';
  const trackBg = isDark ? '#1E222D' : '#F1F5F9';

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

  const delivery = DELIVERY_CHIP[systemStatus?.deliveryStatus] ?? {
    label: !systemStatus && loading ? 'Checking Outbox' : 'Outbox Status Unknown',
    dotClass: 'bg-slate-400',
  };
  const deliveryDetail = DELIVERY_CHIP[systemStatus?.deliveryStatus]
    ? deliveryStatusText(systemStatus.deliveryStatus, systemStatus.sendingProblem, systemStatus.workerHeartbeat)
    : !systemStatus && loading
    ? ''
    : 'The system status could not be read.';

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

  // Range options for Engagement Trends
  const RANGE_OPTIONS = [
    { label: '7d', value: '7' },
    { label: '30d', value: '30' },
    { label: '90d', value: '90' },
  ];

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

  return (
    <div className="space-y-6 pb-12">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#EBF0F5] dark:border-[#1E222D]">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            Campaign Analytics
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            A unified overview of your outbound deliverability and automated sequences.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Date Range Pill */}
          <div className="hidden sm:inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#11131A] text-xs font-medium text-slate-700 dark:text-slate-300 shadow-2xs">
            <Calendar size={13} className="text-slate-400 dark:text-slate-500" />
            <span>Oct 19, 2026 - Oct 25, 2026</span>
          </div>

          {/* Range Dropdown Pill */}
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#11131A] text-xs font-semibold text-slate-700 dark:text-slate-300 shadow-2xs">
            <span>Last {statsRange} days</span>
            <ChevronDown size={13} className="text-slate-400" />
          </div>

          {/* Create Campaign Button */}
          <Link
            href="/campaigns"
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-xs transition-all active:scale-[0.98]"
          >
            <Plus size={14} />
            <span>Create Campaign</span>
          </Link>

          {/* Refresh Action */}
          <MuiTooltip title="Refresh">
            <button
              type="button"
              aria-label="Refresh analytics"
              onClick={() => fetchStats(range)}
              className="inline-flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#11131A] text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </MuiTooltip>
        </div>
      </div>

      {/* Setup Wizard */}
      {needsSetup && (
        <div className="rounded-2xl border border-amber-200/80 dark:border-amber-900/50 bg-amber-50/40 dark:bg-amber-950/20 p-5 md:p-6 shadow-xs">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400" />
            <span className="text-xs font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">
              Required Setup Steps
            </span>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 mb-4 font-normal">
            To start sending, connect a mailbox, import contacts, and activate a campaign.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {setupSteps.map((s) => (
              <div
                key={s.title}
                className={`p-4 rounded-2xl border transition-all ${
                  s.done
                    ? 'bg-white/80 dark:bg-[#11131A]/80 border-emerald-200 dark:border-emerald-800/60'
                    : 'bg-white dark:bg-[#11131A] border-amber-200/80 dark:border-amber-900/60 shadow-xs'
                }`}
              >
                <div className="flex items-center gap-2">
                  {s.done ? (
                    <div className="w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-950/60 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
                      <Check size={12} strokeWidth={2.5} />
                    </div>
                  ) : (
                    <div className="w-5 h-5 rounded-full bg-amber-100 dark:bg-amber-950/60 flex items-center justify-center text-amber-600 dark:text-amber-400 shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    </div>
                  )}
                  <span
                    className={`text-xs font-bold ${
                      s.done ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-800 dark:text-slate-200'
                    }`}
                  >
                    {s.title}
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                  {s.done ? s.done_text : s.todo}
                </p>
                <Link
                  href={s.href}
                  className={`inline-flex items-center gap-1 mt-3 text-xs font-bold transition-colors ${
                    s.done
                      ? 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                      : 'text-blue-600 dark:text-blue-400 hover:text-blue-700'
                  }`}
                >
                  <span>{s.done ? 'Manage' : s.cta}</span>
                  <ArrowRight size={12} />
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Subheader info line */}
      <div className="text-xs text-slate-500 dark:text-slate-400 font-medium flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span>
            {stats
              ? `Showing the last ${statsRange} days · deltas compare against the prior ${statsRange}-day window.${loading ? ' Refreshing…' : ''}`
              : `Showing the last ${statsRange} days`}
          </span>
          <MuiTooltip title={deliveryDetail}>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#11131A] text-[11px] font-semibold text-slate-700 dark:text-slate-300 shadow-2xs cursor-help">
              <span className={`w-1.5 h-1.5 rounded-full ${delivery.dotClass}`} />
              <span>{delivery.label}</span>
            </span>
          </MuiTooltip>
        </div>
        {loadedAt && (
          <span className="font-mono text-[11px] text-slate-400">
            Updated {loadedAt.toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Loading Skeletons for Initial Load */}
      {!stats && loading && !loadError ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-32 rounded-2xl bg-slate-100 dark:bg-slate-800/40 animate-pulse" />
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 h-[420px] rounded-2xl bg-slate-100 dark:bg-slate-800/40 animate-pulse" />
            <div className="lg:col-span-1 space-y-6">
              <div className="h-[240px] rounded-2xl bg-slate-100 dark:bg-slate-800/40 animate-pulse" />
              <div className="h-[240px] rounded-2xl bg-slate-100 dark:bg-slate-800/40 animate-pulse" />
            </div>
          </div>
          <div className="h-[300px] rounded-2xl bg-slate-100 dark:bg-slate-800/40 animate-pulse" />
        </div>
      ) : !stats ? (
        /* Failed Initial Load Error Alert */
        <div className="rounded-2xl border border-rose-200 dark:border-rose-900/50 bg-rose-50/50 dark:bg-rose-950/30 p-5 flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-bold text-rose-800 dark:text-rose-200">
              Analytics Could Not Be Loaded
            </div>
            <div className="text-xs text-rose-700 dark:text-rose-300 mt-1">
              {loadError || 'Analytics could not be loaded.'}
              {loading ? ' Trying again…' : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={() => fetchStats(range)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white transition-colors shrink-0 cursor-pointer"
          >
            <RefreshCw size={13} />
            <span>Retry</span>
          </button>
        </div>
      ) : (
        <>
          {/* Refresh Warning Alert if error while showing cached stats */}
          {loadError && (
            <div className="rounded-2xl border border-amber-200 dark:border-amber-900/50 bg-amber-50/50 dark:bg-amber-950/30 p-4 flex items-start justify-between gap-4">
              <div>
                <div className="text-xs font-bold text-amber-800 dark:text-amber-200">
                  Analytics Could Not Be Refreshed
                </div>
                <div className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
                  Showing the last {statsRange} days as loaded at {loadedAt?.toLocaleTimeString()}. {loadError}
                </div>
              </div>
              <button
                type="button"
                onClick={() => fetchStats(range)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white transition-colors shrink-0 cursor-pointer"
              >
                <RefreshCw size={12} />
                <span>Retry</span>
              </button>
            </div>
          )}


          {/* 1. 4-Card Metric Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            <ShopeersMetricCard
              title="Emails Sent"
              value={stats.totalSent.toLocaleString()}
              change={stats.deltas?.sent}
              colorScheme="blue"
              icon={SendHorizontal}
            />
            <ShopeersMetricCard
              title="Open Rate"
              value={`${stats.averageOpenRate}%`}
              change={stats.deltas?.openRate}
              colorScheme="emerald"
              icon={MailOpen}
            />
            <ShopeersMetricCard
              title="Click Rate"
              value={`${stats.averageClickRate}%`}
              change={stats.deltas?.clickRate}
              colorScheme="amber"
              icon={MousePointerClick}
            />
            <ShopeersMetricCard
              title="Replies"
              value={repliesUnknown ? '—' : stats.totalReplies.toLocaleString()}
              change={replySyncOff ? undefined : stats.deltas?.replies}
              sub={replySyncOff ? 'Reply sync off' : undefined}
              caveat={replySyncOff ? REPLY_SYNC_OFF_NOTE : undefined}
              colorScheme="indigo"
              icon={Reply}
            />
          </div>

          {/* 2. Asymmetric Grid: 2/3 Left (Engagement Trends) + 1/3 Right (Funnel & Sentiment) */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
            {/* Left 2/3 Column: Engagement Trends Card */}
            <div className="lg:col-span-2 min-w-0 flex flex-col">
              <div className="h-full p-5 sm:p-6 rounded-2xl bg-white dark:bg-[#11131A] border border-[#EBF0F5] dark:border-[#1E222D] shadow-xs flex flex-col justify-between">
                {/* Header: Title, Subtitle & Range Selection Pills */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5">
                  <div>
                    <h2 className="text-base font-semibold tracking-tight text-slate-900 dark:text-white">
                      Engagement Trends
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Campaign emails sent each day, and how many of them were opened and clicked.
                    </p>
                  </div>

                  {/* Range Selection Pills */}
                  <div className="inline-flex items-center p-1 rounded-full bg-slate-100 dark:bg-[#161822] border border-[#EBF0F5] dark:border-[#1E222D] self-start sm:self-auto">
                    {RANGE_OPTIONS.map((opt) => {
                      const isActive = range === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setRange(opt.value)}
                          className={`px-3.5 py-1 text-xs font-bold rounded-full transition-all duration-150 cursor-pointer ${
                            isActive
                              ? 'bg-white dark:bg-[#2563EB] text-slate-900 dark:text-white shadow-xs'
                              : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Smooth Area Chart (Recharts) */}
                <div className="h-[260px] w-full min-h-[250px] min-w-0 relative">
                  {!isMounted ? (
                    <div className="w-full h-full animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/40" />
                  ) : trends.length === 0 ? (
                    <div className="w-full h-full flex flex-col items-center justify-center text-center p-4">
                      <Inbox size={28} className="text-slate-300 dark:text-slate-600 mb-2" />
                      <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                        No engagement activity recorded
                      </span>
                      <span className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">
                        Sent emails and prospect interactions will chart here
                      </span>
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={250}>
                      <AreaChart data={trends} margin={{ top: 8, right: 12, left: -20, bottom: 0 }}>
                        <defs>
                          <linearGradient id="shopeersSent" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#2563EB" stopOpacity={0.22} />
                            <stop offset="95%" stopColor="#2563EB" stopOpacity={0.0} />
                          </linearGradient>
                          <linearGradient id="shopeersOpens" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#059669" stopOpacity={0.2} />
                            <stop offset="95%" stopColor="#059669" stopOpacity={0.0} />
                          </linearGradient>
                          <linearGradient id="shopeersClicks" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#D97706" stopOpacity={0.18} />
                            <stop offset="95%" stopColor="#D97706" stopOpacity={0.0} />
                          </linearGradient>
                        </defs>

                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridStroke} />
                        <XAxis
                          dataKey="name"
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: axisTickColor, fontSize: 11, fontWeight: 500 }}
                          dy={8}
                        />
                        <YAxis
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: axisTickColor, fontSize: 11, fontWeight: 500 }}
                          allowDecimals={false}
                        />
                        <RechartsTooltip content={<CustomAreaTooltip />} />
                        <Legend
                          verticalAlign="top"
                          height={28}
                          iconType="circle"
                          iconSize={8}
                          wrapperStyle={{ fontSize: 11, fontWeight: 600, paddingBottom: 8 }}
                        />
                        <Area
                          type="monotone"
                          dataKey="sent"
                          stroke="#2563EB"
                          strokeWidth={2.5}
                          fillOpacity={1}
                          fill="url(#shopeersSent)"
                          name="Emails Sent"
                          isAnimationActive={false}
                          activeDot={{ r: 5, strokeWidth: 2, stroke: '#FFFFFF' }}
                        />
                        <Area
                          type="monotone"
                          dataKey="opens"
                          stroke="#059669"
                          strokeWidth={2.5}
                          fillOpacity={1}
                          fill="url(#shopeersOpens)"
                          name="Unique Opens"
                          isAnimationActive={false}
                          activeDot={{ r: 5, strokeWidth: 2, stroke: '#FFFFFF' }}
                        />
                        <Area
                          type="monotone"
                          dataKey="clicks"
                          stroke="#D97706"
                          strokeWidth={2.5}
                          fillOpacity={1}
                          fill="url(#shopeersClicks)"
                          name="Unique Clicks"
                          isAnimationActive={false}
                          activeDot={{ r: 5, strokeWidth: 2, stroke: '#FFFFFF' }}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </div>

                {/* Deliverability Health Segment Pills (Integrated Bottom Row) */}
                <div className="border-t border-[#EBF0F5] dark:border-[#1E222D] pt-3.5 mt-3.5">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {/* Failed Sends */}
                    <MuiTooltip title="Send attempts recorded as failed" arrow>
                      <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50/70 dark:bg-[#161822]/70 border border-[#EBF0F5] dark:border-[#1E222D] hover:border-rose-200 dark:hover:border-rose-900/40 transition-colors">
                        <div>
                          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                            Failed Sends
                          </div>
                          <div className="text-sm font-semibold text-slate-900 dark:text-white font-mono mt-0.5">
                            {(stats.failed ?? 0).toLocaleString()}
                          </div>
                        </div>
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 border border-rose-200/60 dark:border-rose-900/40 shrink-0">
                          <XCircle size={14} strokeWidth={2} />
                        </div>
                      </div>
                    </MuiTooltip>

                    {/* Bounced */}
                    <MuiTooltip title="Hard bounces at send time or reported on delivery" arrow>
                      <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50/70 dark:bg-[#161822]/70 border border-[#EBF0F5] dark:border-[#1E222D] hover:border-amber-200 dark:hover:border-amber-900/40 transition-colors">
                        <div>
                          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                            Bounced
                          </div>
                          <div className="text-sm font-semibold text-slate-900 dark:text-white font-mono mt-0.5">
                            {(stats.bounced ?? 0).toLocaleString()}
                          </div>
                        </div>
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 border border-amber-200/60 dark:border-amber-900/40 shrink-0">
                          <AlertTriangle size={14} strokeWidth={2} />
                        </div>
                      </div>
                    </MuiTooltip>

                    {/* Unsubscribed */}
                    <MuiTooltip title="Opted out of mailings" arrow>
                      <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50/70 dark:bg-[#161822]/70 border border-[#EBF0F5] dark:border-[#1E222D] hover:border-slate-300 dark:hover:border-slate-700 transition-colors">
                        <div>
                          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                            Unsubscribed
                          </div>
                          <div className="text-sm font-semibold text-slate-900 dark:text-white font-mono mt-0.5">
                            {(stats.unsubscribed ?? 0).toLocaleString()}
                          </div>
                        </div>
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 shrink-0">
                          <UserMinus size={14} strokeWidth={2} />
                        </div>
                      </div>
                    </MuiTooltip>
                  </div>
                </div>
              </div>
            </div>

            {/* Right 1/3 Column: Funnel & Sentiment Cards Stacked */}
            <div className="lg:col-span-1 min-w-0 flex flex-col justify-between gap-5">
              {/* Conversion Funnel Card */}
              <div className="flex-1 w-full rounded-2xl border border-[#EBF0F5] dark:border-[#1E222D] bg-white dark:bg-[#11131A] p-5 shadow-xs transition-shadow duration-200 hover:shadow-md flex flex-col justify-between">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-base font-semibold text-slate-900 dark:text-white tracking-tight">
                      Conversion Funnel
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Outreach progression from dispatch to booked call
                    </p>
                  </div>
                </div>

                {repliesUnknown && (
                  <div className="mb-2.5 flex items-center gap-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 px-2.5 py-1 text-[11px] text-amber-700 dark:text-amber-400 border border-amber-200/50 dark:border-amber-800/30">
                    <AlertTriangle size={12} className="flex-shrink-0" />
                    <span>Replied stage omitted (reply sync is unconfigured).</span>
                  </div>
                )}

                <div className="w-full h-[145px] min-h-[145px] min-w-0 relative">
                  {!isMounted ? (
                    <div className="w-full h-full animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/40" />
                  ) : funnel.length === 0 || totalSentInFunnel === 0 ? (
                    <div className="w-full h-full flex flex-col items-center justify-center text-center p-3">
                      <Inbox size={24} className="text-slate-300 dark:text-slate-600 mb-1" />
                      <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                        No outreach dispatches recorded
                      </span>
                      <span className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">
                        Launch a campaign sequence to view conversion flow
                      </span>
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={145}>
                      <BarChart
                        layout="vertical"
                        data={funnel}
                        margin={{ top: 4, right: 28, left: 0, bottom: 0 }}
                        barCategoryGap="12%"
                      >
                        <XAxis type="number" hide domain={[0, 'dataMax']} />
                        <YAxis
                          type="category"
                          dataKey="name"
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: axisTickColor, fontSize: 11, fontWeight: 500 }}
                          width={86}
                        />
                        <RechartsTooltip
                          cursor={{ fill: isDark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.03)', radius: 6 }}
                          content={<ShopeersChartTooltip totalSent={totalSentInFunnel} />}
                        />
                        <Bar
                          dataKey="value"
                          radius={[5, 5, 5, 5]}
                          barSize={11}
                          background={{ fill: trackBg, radius: 5 }}
                          isAnimationActive={false}
                        >
                          {funnel.map((entry, index) => {
                            const fill =
                              entry.name === 'Meeting Booked'
                                ? '#10B981'
                                : entry.name === 'Replied'
                                ? '#8B5CF6'
                                : entry.name === 'Clicked'
                                ? '#38BDF8'
                                : entry.name === 'Opened'
                                ? '#3B82F6'
                                : '#2563EB';
                            return <Cell key={`funnel-cell-${index}`} fill={fill} />;
                          })}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>

                {totalSentInFunnel > 0 && (
                  <div className="mt-2.5 pt-2.5 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 text-[11px]">
                      <CheckCircle2 size={13} className="text-emerald-500" />
                      <span>Top of Funnel:</span>
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        {totalSentInFunnel.toLocaleString()} Sent
                      </span>
                    </div>
                    <div className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
                      {funnel.length} Active Stages
                    </div>
                  </div>
                )}
              </div>

              {/* Prospect Sentiment Gauge Card */}
              <div className="flex-1 w-full rounded-2xl border border-[#EBF0F5] dark:border-[#1E222D] bg-white dark:bg-[#11131A] p-5 shadow-xs transition-shadow duration-200 hover:shadow-md flex flex-col justify-between">
                <div className="flex items-start justify-between mb-1.5">
                  <div>
                    <h3 className="text-base font-semibold text-slate-900 dark:text-white tracking-tight">
                      Prospect Sentiment
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Lead outcome and sentiment distribution
                    </p>
                  </div>
                </div>

                <div className="w-full h-[135px] min-h-[135px] min-w-0 relative flex items-center justify-center">
                  {!isMounted ? (
                    <div className="w-full h-full animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/40" />
                  ) : (
                    <>
                      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={135}>
                        <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                          <Pie
                            data={gaugeData}
                            cx="50%"
                            cy="80%"
                            startAngle={180}
                            endAngle={0}
                            innerRadius={54}
                            outerRadius={74}
                            paddingAngle={totalSentiment > 0 ? 3 : 0}
                            dataKey="value"
                            isAnimationActive={false}
                          >
                            {gaugeData.map((entry, index) => (
                              <Cell key={`gauge-cell-${index}`} fill={entry.fill} stroke="none" />
                            ))}
                          </Pie>
                          {totalSentiment > 0 && (
                            <RechartsTooltip content={<ShopeersChartTooltip totalSent={totalSentiment} />} />
                          )}
                        </PieChart>
                      </ResponsiveContainer>

                      {/* Central Score Typography */}
                      <div className="absolute top-[56%] left-1/2 -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none">
                        <span className="block text-2xl font-bold font-sans text-slate-900 dark:text-white tracking-tight">
                          {totalSentiment > 0 ? `${positiveSentimentRate}%` : '—'}
                        </span>
                        <span className="block text-xs font-medium text-slate-500 dark:text-slate-400 mt-0.5">
                          {totalSentiment > 0 ? 'Positive Score' : 'No Contacts'}
                        </span>
                      </div>
                    </>
                  )}
                </div>

                {/* 3-Category Breakdown Footer Pills */}
                <div className="mt-1 pt-2.5 border-t border-slate-100 dark:border-slate-800/80 grid grid-cols-3 gap-2 text-center">
                  {/* Positive */}
                  <div className="rounded-xl bg-slate-50/70 dark:bg-slate-900/40 p-2 border border-slate-100 dark:border-slate-800/60">
                    <div className="flex items-center justify-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                      <span>Positive</span>
                    </div>
                    <span className="block text-sm font-semibold text-slate-900 dark:text-white font-mono mt-0.5">
                      {positiveSentiment.toLocaleString()}
                    </span>
                  </div>

                  {/* Neutral */}
                  <div className="rounded-xl bg-slate-50/70 dark:bg-slate-900/40 p-2 border border-slate-100 dark:border-slate-800/60">
                    <div className="flex items-center justify-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                      <span className="w-2 h-2 rounded-full bg-slate-400 dark:bg-slate-500" />
                      <span>Neutral</span>
                    </div>
                    <span className="block text-sm font-semibold text-slate-900 dark:text-white font-mono mt-0.5">
                      {neutralSentiment.toLocaleString()}
                    </span>
                  </div>

                  {/* Negative */}
                  <div className="rounded-xl bg-slate-50/70 dark:bg-slate-900/40 p-2 border border-slate-100 dark:border-slate-800/60">
                    <div className="flex items-center justify-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                      <span className="w-2 h-2 rounded-full bg-rose-500" />
                      <span>Negative</span>
                    </div>
                    <span className="block text-sm font-semibold text-slate-900 dark:text-white font-mono mt-0.5">
                      {negativeSentiment.toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>

            </div>
          </div>

          {/* 3. Full-width Recent Campaigns Summary Table Card */}
          <div className="rounded-2xl border border-[#EBF0F5] dark:border-[#1E222D] bg-white dark:bg-[#11131A] shadow-xs overflow-hidden transition-all duration-200">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-6 pb-4 border-b border-[#EBF0F5] dark:border-[#1E222D]">
              <div>
                <h2 className="text-base font-semibold text-slate-900 dark:text-white tracking-tight">
                  Recent Campaigns
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-normal">
                  Summary of recent outbound sequences and delivery performance
                </p>
              </div>
              <Link
                href="/campaigns"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors border border-blue-100 dark:border-blue-900/40 self-start sm:self-auto"
              >
                <span>View All</span>
                <ArrowRight size={13} className="shrink-0" />
              </Link>
            </div>

            <div className="w-full overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#EBF0F5] dark:border-[#1E222D] bg-slate-50/50 dark:bg-slate-900/20">
                    <th className="py-3 px-6 text-xs font-semibold text-slate-500 dark:text-slate-400 min-w-[240px]">
                      Campaign Name
                    </th>
                    <th className="py-3 px-6 text-xs font-semibold text-slate-500 dark:text-slate-400 min-w-[130px]">
                      Status
                    </th>
                    <th className="py-3 px-6 text-xs font-semibold text-slate-500 dark:text-slate-400 min-w-[120px]">
                      Total Leads
                    </th>
                    <th className="py-3 px-6 text-xs font-semibold text-slate-500 dark:text-slate-400 min-w-[120px]">
                      Dispatches
                    </th>
                    <th className="py-3 px-6 text-xs font-semibold text-slate-500 dark:text-slate-400 min-w-[160px]">
                      Open Rate
                    </th>
                    <th className="py-3 px-6 text-xs font-semibold text-slate-500 dark:text-slate-400 w-[70px] text-right">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-[#1E222D]/60">
                  {loading && recentCampaigns.length === 0 ? (
                    [0, 1, 2, 3].map((idx) => (
                      <tr key={idx} className="animate-pulse">
                        <td className="py-4 px-6">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-slate-200 dark:bg-slate-800" />
                            <div className="space-y-1.5">
                              <div className="w-32 h-4 rounded-md bg-slate-200 dark:bg-slate-800" />
                              <div className="w-20 h-3 rounded-md bg-slate-200 dark:bg-slate-800" />
                            </div>
                          </div>
                        </td>
                        <td className="py-4 px-6">
                          <div className="w-16 h-6 rounded-full bg-slate-200 dark:bg-slate-800" />
                        </td>
                        <td className="py-4 px-6">
                          <div className="w-12 h-4 rounded-md bg-slate-200 dark:bg-slate-800" />
                        </td>
                        <td className="py-4 px-6">
                          <div className="w-12 h-4 rounded-md bg-slate-200 dark:bg-slate-800" />
                        </td>
                        <td className="py-4 px-6">
                          <div className="w-24 h-4 rounded-md bg-slate-200 dark:bg-slate-800" />
                        </td>
                        <td className="py-4 px-6 text-right">
                          <div className="w-7 h-7 rounded-full bg-slate-200 dark:bg-slate-800 ml-auto" />
                        </td>
                      </tr>
                    ))
                  ) : recentCampaigns.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12 px-6 text-center">
                        <div className="w-12 h-12 rounded-2xl bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 flex items-center justify-center mx-auto mb-3">
                          <SendHorizontal size={20} />
                        </div>
                        <h3 className="text-sm font-bold text-slate-800 dark:text-slate-200">
                          No Campaigns Created Yet
                        </h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
                          Create your first automated email campaign to start reaching prospects and tracking engagement metrics.
                        </p>
                        <Link
                          href="/campaigns"
                          className="inline-flex items-center gap-1.5 mt-4 px-4 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-colors shadow-xs"
                        >
                          <Plus size={14} />
                          <span>Create Campaign</span>
                        </Link>
                      </td>
                    </tr>
                  ) : (
                    recentCampaigns.map((c) => {
                      const totalLeads = c.enrollmentSummary?.total ?? 0;
                      const totalSent = c.stepStats?.reduce((acc: number, s: any) => acc + (s.sent || 0), 0) ?? 0;
                      const isCompleted = totalLeads > 0 && c.enrollmentSummary?.completed === totalLeads;
                      const resolvedStatus = isCompleted ? 'Completed' : c.status;
                      const pill = STATUS_PILL_CONFIG[resolvedStatus] || STATUS_PILL_CONFIG.Draft;
                      const hasOpenRate = typeof c.openRate === 'number';
                      const openRateValue = hasOpenRate ? c.openRate : 0;

                      return (
                        <tr
                          key={c.id}
                          className="group transition-colors duration-150 ease-in-out hover:bg-slate-50/70 dark:hover:bg-[#161822]/80"
                        >
                          {/* Campaign Name */}
                          <td className="py-3.5 px-6">
                            <div className="flex items-center gap-3">
                              <div className="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                                <SendHorizontal size={16} />
                              </div>
                              <div className="min-w-0">
                                <Link
                                  href={`/campaigns/${c.id}`}
                                  className="text-sm font-semibold text-slate-900 dark:text-slate-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors truncate block"
                                >
                                  {c.name}
                                </Link>
                                <span className="text-[11px] text-slate-400 dark:text-slate-500 block truncate">
                                  {c.createdAt
                                    ? `Created ${campaignDateFormat.format(new Date(c.createdAt))}`
                                    : c.senderAccount?.emailAddress || 'Automated Sequence'}
                                </span>
                              </div>
                            </div>
                          </td>

                          {/* Status Pill */}
                          <td className="py-3.5 px-6">
                            <span
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${pill.badgeClass}`}
                            >
                              <span
                                className={`w-1.5 h-1.5 rounded-full ${pill.dotClass} ${
                                  pill.pulse ? 'animate-pulse' : ''
                                }`}
                              />
                              <span>{pill.label}</span>
                            </span>
                          </td>

                          {/* Total Leads */}
                          <td className="py-3.5 px-6">
                            <div className="text-sm font-semibold text-slate-800 dark:text-slate-200 font-mono">
                              {totalLeads.toLocaleString()}
                            </div>
                            <span className="text-[11px] text-slate-400">leads enrolled</span>
                          </td>

                          {/* Dispatches / Sent */}
                          <td className="py-3.5 px-6">
                            <div className="text-sm font-semibold text-slate-800 dark:text-slate-200 font-mono">
                              {totalSent.toLocaleString()}
                            </div>
                            <span className="text-[11px] text-slate-400">emails sent</span>
                          </td>

                          {/* Open Rate */}
                          <td className="py-3.5 px-6">
                            {hasOpenRate ? (
                              <div className="space-y-1.5">
                                <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-300 font-mono">
                                  <span>{openRateValue.toFixed(1)}%</span>
                                </div>
                                <div className="w-24 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                                  <div
                                    className="h-full rounded-full bg-blue-600 dark:bg-blue-500 transition-all duration-500"
                                    style={{ width: `${Math.min(100, Math.max(0, openRateValue))}%` }}
                                  />
                                </div>
                              </div>
                            ) : (
                              <span className="text-xs font-mono text-slate-400 dark:text-slate-500">
                                {totalSent > 0 ? '—' : '0.0%'}
                              </span>
                            )}
                          </td>

                          {/* Quick Action / Arrow */}
                          <td className="py-3.5 px-6 text-right">
                            <Link
                              href={`/campaigns/${c.id}`}
                              aria-label={`Configure ${c.name}`}
                              className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-slate-100/80 dark:bg-slate-800/80 text-slate-400 dark:text-slate-500 group-hover:bg-blue-600 group-hover:text-white transition-all shadow-xs"
                            >
                              <ChevronRight size={15} />
                            </Link>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

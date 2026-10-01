/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell, Legend, LabelList,
} from 'recharts';
import { Mail, MousePointerClick, Reply, SendHorizontal, RefreshCw, XCircle, AlertTriangle, UserMinus, Plus } from 'lucide-react';
import {
  Box, Card, CardContent, Typography, Button, IconButton, Chip, Stack,
  Skeleton, Select, MenuItem, FormControl, Tooltip as MuiTooltip, Alert, AlertTitle,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { useTheme as useAppTheme } from '@/components/ThemeProvider';
import { deliveryStatusText } from '@/lib/systemStatus';
import { replyCountUnknown } from '@/lib/imapSyncStatus';
import { LoadError, loadErrorMessage, readJsonObject } from '@/lib/apiResponse';

/** The outbox chip for each /api/system-status deliveryStatus. */
const DELIVERY_CHIP: Record<string, { label: string; color: string }> = {
  RUNNING: { label: 'Outbox Running', color: 'success.main' },
  STALLED: { label: 'Outbox Stalled', color: 'warning.main' },
  FAILING: { label: 'Outbox Failing', color: 'error.main' },
  NOT_RUNNING: { label: 'Outbox Not Running', color: 'error.main' },
  DISABLED: { label: 'Sending Disabled', color: 'warning.main' },
};

/** The Replies card's note while no mailbox has reply sync on, so no reply is read. */
const REPLY_SYNC_OFF_NOTE = 'No active mailbox has IMAP set up, so replies are not read and are missing from these counts. Add IMAP details to a mailbox on the Accounts page.';

const gridSx = (cols: number) => ({
  display: 'grid',
  gap: 2,
  gridTemplateColumns: {
    xs: '1fr',
    sm: cols >= 3 ? 'repeat(2, 1fr)' : '1fr',
    md: cols === 4 ? 'repeat(2, 1fr)' : `repeat(${Math.min(cols, 3)}, 1fr)`,
    lg: `repeat(${cols}, 1fr)`,
  },
});

function DeltaChip({ change }: { change: number }) {
  const positive = change > 0;
  const negative = change < 0;
  const tone = positive ? 'success' : negative ? 'error' : 'text';
  return (
    <Chip
      size="small"
      label={`${positive ? '+' : ''}${change}%`}
      sx={{
        height: 20,
        bgcolor: (t) =>
          alpha(tone === 'success' ? t.palette.success.main : tone === 'error' ? t.palette.error.main : t.palette.text.secondary, 0.14),
        color: tone === 'text' ? 'text.secondary' : `${tone}.main`,
        '& .MuiChip-label': { px: 1, fontSize: 11, fontWeight: 700 },
      }}
    />
  );
}

function MetricCard({ title, value, change, sub, caveat, color, icon: Icon }: any) {
  const hasDelta = change !== undefined && change !== null;
  return (
    <Card sx={{ transition: 'border-color .2s, box-shadow .2s', '&:hover': { boxShadow: 3 } }}>
      <CardContent>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Typography variant="overline" sx={{ color: 'text.secondary', lineHeight: 1.4 }}>{title}</Typography>
          <Box sx={{ width: 44, height: 44, borderRadius: '14px', display: 'grid', placeItems: 'center', flexShrink: 0, bgcolor: alpha(color, 0.14), color }}>
            <Icon size={20} strokeWidth={2.2} />
          </Box>
        </Stack>
        <Typography variant="h4" sx={{ fontWeight: 700, mt: 0.5 }}>{value}</Typography>
        {hasDelta ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 1.25 }}>
            <DeltaChip change={Number(change) || 0} />
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>vs last period</Typography>
          </Stack>
        ) : sub ? (
          <Typography variant="caption" sx={{ color: 'text.secondary', mt: 1.25, display: 'flex', alignItems: 'center' }}>
            {sub}
            {caveat && (
              <MuiTooltip title={caveat} arrow>
                <Box component="span" tabIndex={0} aria-label={caveat} sx={{ display: 'inline-flex', color: 'warning.main', ml: 0.5 }}>
                  <AlertTriangle size={12} />
                </Box>
              </MuiTooltip>
            )}
          </Typography>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ChartCard({ title, subtitle, action, height = 300, children }: any) {
  return (
    <Card>
      <CardContent>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{title}</Typography>
            {subtitle && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{subtitle}</Typography>}
          </Box>
          {action}
        </Stack>
        <Box sx={{ height, width: '100%' }}>{children}</Box>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const muiTheme = useTheme();
  const { theme: appMode } = useAppTheme();
  // Charts read colors in JS (SVG attrs can't use CSS vars), and MUI's runtime
  // theme always exposes the default (light) scheme — resolve from the scheme
  // matching the app's actual mode instead.
  const schemePalette = (muiTheme as any).colorSchemes?.[appMode]?.palette ?? muiTheme.palette;
  const axisTickColor = schemePalette.text.secondary;
  const gridStroke = schemePalette.divider;
  const chartTooltipStyle = {
    borderRadius: 12,
    border: `1px solid ${schemePalette.divider}`,
    background: schemePalette.background.paper,
    color: schemePalette.text.primary,
  };
  const [range, setRange] = useState('7');
  // Null until a load succeeds, so a failed first load shows an error, never zeros.
  const [stats, setStats] = useState<any>(null);
  // The range and time of the numbers on screen, which stay while a refresh or another range loads.
  const [statsRange, setStatsRange] = useState(range);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [trends, setTrends] = useState<any[]>([]);
  const [funnel, setFunnel] = useState<any[]>([]);
  const [sentiment, setSentiment] = useState<any[]>([]);
  // A load is in flight. Skeletons show only until the first numbers arrive.
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [systemStatus, setSystemStatus] = useState<any>(null);
  // The load in flight. A newer load aborts it, so a late answer for another range is never shown.
  const inFlight = useRef<AbortController | null>(null);

  const fetchStats = async (selectedRange: string) => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setLoading(true);
    try {
      const [statsRes, statusRes] = await Promise.all([
        fetch(`/api/dashboard-stats?range=${selectedRange}`, { signal: controller.signal }),
        fetch('/api/system-status', { signal: controller.signal }),
      ]);
      // A status that cannot be read shows as unknown, not as the last one read.
      const status = statusRes.ok ? await statusRes.json().catch(() => null) : null;
      if (controller.signal.aborted) return;
      setSystemStatus(status);
      const data = await readJsonObject(statsRes, 'Analytics');
      if (controller.signal.aborted) return;
      if (!data.stats || typeof data.stats !== 'object') throw new LoadError('Analytics could not be loaded: the server sent no totals.');
      setStats(data.stats);
      setTrends(Array.isArray(data.trends) ? data.trends : []);
      setFunnel(Array.isArray(data.funnel) ? data.funnel : []);
      setSentiment(Array.isArray(data.sentiment) ? data.sentiment : []);
      setStatsRange(selectedRange);
      setLoadedAt(new Date());
      setLoadError('');
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

  // Loads on open and on a range change, then every 30s while the tab is visible,
  // skipping a poll while a load is still in flight.
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

  const retryButton = (
    <Button color="inherit" size="small" startIcon={<RefreshCw size={14} />} onClick={() => fetchStats(range)}>Retry</Button>
  );

  // Whether campaign email goes out, from the Azure settings and the send worker's heartbeat.
  const delivery = DELIVERY_CHIP[systemStatus?.deliveryStatus]
    ?? { label: !systemStatus && loading ? 'Checking Outbox' : 'Outbox Status Unknown', color: 'text.disabled' };
  const deliveryDetail = DELIVERY_CHIP[systemStatus?.deliveryStatus]
    ? deliveryStatusText(systemStatus.deliveryStatus, systemStatus.sendingProblem, systemStatus.workerHeartbeat)
    : !systemStatus && loading ? '' : 'The system status could not be read.';
  // With reply sync off on every mailbox no reply is read, so a 0 means replies are not read, not that nobody replied.
  const replySyncOff = stats?.replySync === 'off';
  const repliesUnknown = replyCountUnknown(stats?.replySync, stats?.totalReplies);
  const needsSetup = systemStatus && (systemStatus.accountsCount === 0 || systemStatus.leadsCount === 0 || systemStatus.activeCampaignsCount === 0);

  const setupSteps = systemStatus ? [
    { done: systemStatus.accountsCount > 0, title: '1. Connect Mailbox', todo: 'No mailboxes connected. Outbound paused.', done_text: `${systemStatus.accountsCount} active mailbox(es) online.`, href: '/accounts', cta: 'Connect Senders' },
    { done: systemStatus.leadsCount > 0, title: '2. Import Leads', todo: 'No CRM leads. Outbox has no targets.', done_text: `${systemStatus.leadsCount} CRM contact(s) imported.`, href: '/leads', cta: 'Upload Leads' },
    { done: systemStatus.activeCampaignsCount > 0, title: '3. Start Campaign', todo: 'All campaigns are idle.', done_text: `${systemStatus.activeCampaignsCount} Active campaign(s).`, href: '/campaigns', cta: 'Manage Campaigns' },
  ] : [];

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {/* Header */}
      <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', sm: 'center' }, gap: 2, pb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>Campaign Analytics</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>A unified overview of your outbound deliverability and automated sequences.</Typography>
        </Box>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          <Button component={Link as any} href="/campaigns" variant="contained" startIcon={<Plus size={16} />}>Create Campaign</Button>
          <MuiTooltip title="Refresh">
            <IconButton aria-label="Refresh analytics" onClick={() => fetchStats(range)} sx={{ border: 1, borderColor: 'divider' }}>
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </IconButton>
          </MuiTooltip>
          <MuiTooltip title={deliveryDetail}>
            <Chip
              size="small"
              label={delivery.label}
              sx={{ fontFamily: 'monospace', fontWeight: 700 }}
              icon={<Box component="span" sx={{ width: 8, height: 8, borderRadius: '50%', ml: 1, bgcolor: delivery.color }} />}
            />
          </MuiTooltip>
        </Stack>
      </Stack>

      {/* Setup wizard */}
      {needsSetup && (
        <Card sx={{ bgcolor: (t) => alpha(t.palette.warning.main, 0.06), borderColor: (t) => alpha(t.palette.warning.main, 0.3) }}>
          <CardContent>
            <Typography variant="overline" sx={{ color: 'warning.main' }}>Required Setup Steps</Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2, fontWeight: 500 }}>
              To start sending, connect a mailbox, import contacts, and activate a campaign.
            </Typography>
            <Box sx={gridSx(3)}>
              {setupSteps.map((s) => (
                <Card key={s.title} sx={{ bgcolor: s.done ? (t) => alpha(t.palette.success.main, 0.06) : 'background.paper', borderColor: s.done ? (t) => alpha(t.palette.success.main, 0.3) : (t) => alpha(t.palette.warning.main, 0.4) }}>
                  <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 700, color: s.done ? 'success.main' : 'text.primary' }}>
                      {s.done ? `✓ ${s.title}` : s.title}
                    </Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{s.done ? s.done_text : s.todo}</Typography>
                    <Button component={Link as any} href={s.href} size="small" variant="text" sx={{ alignSelf: 'flex-start', mt: 0.5 }}>
                      {s.done ? 'Manage' : `${s.cta} →`}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </Box>
          </CardContent>
        </Card>
      )}

      {/* After a failed first load the error stays up while a poll or Retry tries again */}
      {!stats && loading && !loadError ? (
        <Stack sx={{ gap: 3 }}>
          <Box sx={gridSx(4)}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="rounded" height={140} sx={{ borderRadius: '24px' }} />)}</Box>
          <Box sx={gridSx(3)}>{[0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={120} sx={{ borderRadius: '24px' }} />)}</Box>
          <Skeleton variant="rounded" height={420} sx={{ borderRadius: '24px' }} />
        </Stack>
      ) : !stats ? (
        <Alert severity="error" action={retryButton}>
          <AlertTitle>Analytics Could Not Be Loaded</AlertTitle>
          {loadError || 'Analytics could not be loaded.'}{loading ? ' Trying again…' : ''}
        </Alert>
      ) : (
        <>
          {loadError && (
            <Alert severity="warning" action={retryButton}>
              <AlertTitle>Analytics Could Not Be Refreshed</AlertTitle>
              Showing the last {statsRange} days as loaded at {loadedAt?.toLocaleTimeString()}. {loadError}
            </Alert>
          )}
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Showing the last {statsRange} days · deltas compare against the prior {statsRange}-day window.{loading ? ' Refreshing…' : ''}
          </Typography>

          {/* Engagement metrics */}
          <Box sx={gridSx(4)}>
            <MetricCard title="Emails Sent" value={stats.totalSent.toLocaleString()} change={stats.deltas?.sent} color="#2563EB" icon={SendHorizontal} />
            <MetricCard title="Open Rate" value={`${stats.averageOpenRate}%`} change={stats.deltas?.openRate} color="#0D9488" icon={Mail} />
            <MetricCard title="Click Rate" value={`${stats.averageClickRate}%`} change={stats.deltas?.clickRate} color="#D97706" icon={MousePointerClick} />
            <MetricCard
              title="Replies"
              value={repliesUnknown ? '—' : stats.totalReplies.toLocaleString()}
              change={replySyncOff ? undefined : stats.deltas?.replies}
              sub={replySyncOff ? 'Reply sync off' : undefined}
              caveat={replySyncOff ? REPLY_SYNC_OFF_NOTE : undefined}
              color="#7C3AED"
              icon={Reply}
            />
          </Box>

          {/* Deliverability health */}
          <Box sx={gridSx(3)}>
            <MetricCard title="Failed Sends" value={(stats.failed ?? 0).toLocaleString()} sub="Delivery errors at send time" color="#DC2626" icon={XCircle} />
            <MetricCard title="Bounced" value={(stats.bounced ?? 0).toLocaleString()} sub="Hard bounces at send time or reported on delivery" color="#D97706" icon={AlertTriangle} />
            <MetricCard title="Unsubscribed" value={(stats.unsubscribed ?? 0).toLocaleString()} sub="Opted out of mailings" color="#64748B" icon={UserMinus} />
          </Box>

          {/* Engagement trend */}
          <ChartCard
            title="Engagement Trends"
            subtitle="Campaign emails sent each day, and how many of them were opened and clicked."
            height={350}
            action={
              <FormControl size="small">
                <Select value={range} onChange={(e) => setRange(e.target.value)} sx={{ minWidth: 140 }}>
                  <MenuItem value="7">Last 7 Days</MenuItem>
                  <MenuItem value="30">Last 30 Days</MenuItem>
                  <MenuItem value="90">Last 90 Days</MenuItem>
                </Select>
              </FormControl>
            }
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trends} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorSent" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} /><stop offset="95%" stopColor="#3b82f6" stopOpacity={0} /></linearGradient>
                  <linearGradient id="colorOpens" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#2dd4bf" stopOpacity={0.15} /><stop offset="95%" stopColor="#2dd4bf" stopOpacity={0} /></linearGradient>
                  <linearGradient id="colorClicks" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#f43f5e" stopOpacity={0.15} /><stop offset="95%" stopColor="#f43f5e" stopOpacity={0} /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridStroke} />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: axisTickColor, fontSize: 11 }} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: axisTickColor, fontSize: 11 }} allowDecimals={false} />
                <Tooltip contentStyle={chartTooltipStyle} labelStyle={{ color: schemePalette.text.primary }} itemStyle={{ fontSize: 11 }} />
                <Legend verticalAlign="top" height={28} iconType="plainline" wrapperStyle={{ fontSize: 11 }} />
                <Area type="linear" dataKey="sent" stroke="#3b82f6" strokeWidth={2.5} fillOpacity={1} fill="url(#colorSent)" name="Emails Sent" dot={{ r: 2 }} />
                <Area type="linear" dataKey="opens" stroke="#2dd4bf" strokeWidth={2.5} fillOpacity={1} fill="url(#colorOpens)" name="Unique Opens" dot={{ r: 2 }} />
                <Area type="linear" dataKey="clicks" stroke="#f43f5e" strokeWidth={2.5} fillOpacity={1} fill="url(#colorClicks)" name="Unique Clicks" dot={{ r: 2 }} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' } }}>
            <ChartCard
              title="Conversion Funnel"
              subtitle={`Pipeline from outbound dispatch to booked meeting.${repliesUnknown ? ' Replied is left out while reply sync is off.' : ''}`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart layout="vertical" data={funnel} margin={{ top: 10, right: 24, left: 20, bottom: 10 }}>
                  <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: axisTickColor, fontSize: 10 }} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" axisLine={false} tickLine={false} tick={{ fill: axisTickColor, fontSize: 10 }} width={90} />
                  {/* Each stage names what it counts: emails, replies or leads. */}
                  <Tooltip cursor={{ fill: alpha(schemePalette.text.secondary, 0.08) }} contentStyle={chartTooltipStyle} labelStyle={{ color: schemePalette.text.primary }} itemStyle={{ fontSize: 11 }} formatter={(value, name, item) => [value, item?.payload?.unit ?? name]} />
                  <Bar dataKey="value" fill={schemePalette.primary.main} radius={[0, 8, 8, 0]} barSize={24} name="Count">
                    <LabelList dataKey="value" position="right" style={{ fontSize: 10, fontWeight: 700, fill: axisTickColor }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Prospect Sentiment" subtitle="Distribution of lead outcomes and responses.">
              <Box sx={{ position: 'relative', height: '100%' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={sentiment.filter((s) => s.value > 0)} cx="50%" cy="50%" innerRadius={65} outerRadius={95} paddingAngle={3} dataKey="value" nameKey="name">
                      {sentiment.filter((s) => s.value > 0).map((entry, index) => {
                        const colors: Record<string, string> = { 'Neutral': '#94a3b8', 'Interested': '#10b981', 'Not Interested': '#f43f5e', 'Meeting Booked': '#6366f1', 'Out of Office': '#f59e0b', 'Bounced': '#8b5cf6', 'Unsubscribed': '#475569' };
                        return <Cell key={`cell-${index}`} fill={colors[entry.name] || '#3b82f6'} />;
                      })}
                    </Pie>
                    <Tooltip contentStyle={chartTooltipStyle} labelStyle={{ color: schemePalette.text.primary }} itemStyle={{ fontSize: 11 }} />
                    <Legend verticalAlign="bottom" height={36} iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 10 }} />
                  </PieChart>
                </ResponsiveContainer>
                {sentiment.every((s) => s.value === 0) && (
                  <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>No leads enrolled in active campaigns.</Typography>
                  </Box>
                )}
              </Box>
            </ChartCard>
          </Box>
        </>
      )}
    </Box>
  );
}

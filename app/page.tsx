/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell, Legend, LabelList,
} from 'recharts';
import { Mail, MousePointerClick, Reply, SendHorizontal, RefreshCw, XCircle, AlertTriangle, UserMinus, Plus } from 'lucide-react';
import {
  Box, Card, CardContent, Typography, Button, IconButton, Chip, Stack,
  Skeleton, Select, MenuItem, FormControl, Tooltip as MuiTooltip,
} from '@mui/material';
import { alpha } from '@mui/material/styles';

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

function MetricCard({ title, value, change, sub, color, icon: Icon }: any) {
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
          <Typography variant="caption" sx={{ color: 'text.secondary', mt: 1.25, display: 'block' }}>{sub}</Typography>
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
  const [range, setRange] = useState('7');
  const [stats, setStats] = useState<any>({
    totalSent: 0, totalReplies: 0, averageOpenRate: 0, averageClickRate: 0,
    failed: 0, bounced: 0, unsubscribed: 0,
    deltas: { sent: 0, openRate: 0, clickRate: 0, replies: 0 },
  });
  const [trends, setTrends] = useState<any[]>([]);
  const [funnel, setFunnel] = useState<any[]>([]);
  const [sentiment, setSentiment] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [systemStatus, setSystemStatus] = useState<any>(null);

  const fetchStats = async (selectedRange = range) => {
    try {
      setLoading(true);
      const [statsRes, statusRes] = await Promise.all([
        fetch(`/api/dashboard-stats?range=${selectedRange}`),
        fetch('/api/system-status'),
      ]);
      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data.stats);
        setTrends(data.trends);
        setFunnel(data.funnel || []);
        setSentiment(data.sentiment || []);
      }
      if (statusRes.ok) setSystemStatus(await statusRes.json());
    } catch (error) {
      console.error('Failed to load stats:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleRangeChange = (newRange: string) => {
    setRange(newRange);
    fetchStats(newRange);
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') fetchStats();
    }, 30000);
    return () => clearInterval(interval);
  }, [range]);

  const deliveryOperational = systemStatus?.deliveryStatus === 'OPERATIONAL';
  const needsSetup = systemStatus && (systemStatus.accountsCount === 0 || systemStatus.leadsCount === 0 || systemStatus.activeCampaignsCount === 0);

  const setupSteps = systemStatus ? [
    { done: systemStatus.accountsCount > 0, title: '1. Connect Mailbox', todo: 'No mailboxes connected. Outbound paused.', done_text: `${systemStatus.accountsCount} active mailbox(es) online.`, href: '/accounts', cta: 'Connect Senders' },
    { done: systemStatus.leadsCount > 0, title: '2. Import Leads', todo: 'No CRM leads. Outbox has no targets.', done_text: `${systemStatus.leadsCount} CRM contact(s) imported.`, href: '/leads', cta: 'Upload Leads' },
    { done: systemStatus.activeCampaignsCount > 0, title: '3. Start Campaign', todo: 'All campaigns are idle.', done_text: `${systemStatus.activeCampaignsCount} campaign(s) actively sending.`, href: '/campaigns', cta: 'Manage Campaigns' },
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
            <IconButton aria-label="Refresh analytics" onClick={() => fetchStats()} sx={{ border: 1, borderColor: 'divider' }}>
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </IconButton>
          </MuiTooltip>
          <Chip
            size="small"
            label={deliveryOperational ? 'Live Outbox' : 'Outbox Inactive'}
            sx={{ fontFamily: 'monospace', fontWeight: 700 }}
            icon={<Box component="span" sx={{ width: 8, height: 8, borderRadius: '50%', ml: 1, bgcolor: deliveryOperational ? 'success.main' : systemStatus?.deliveryStatus === 'STANDBY' ? 'warning.main' : 'text.disabled' }} />}
          />
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

      {loading ? (
        <Stack sx={{ gap: 3 }}>
          <Box sx={gridSx(4)}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="rounded" height={140} sx={{ borderRadius: '24px' }} />)}</Box>
          <Box sx={gridSx(3)}>{[0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={120} sx={{ borderRadius: '24px' }} />)}</Box>
          <Skeleton variant="rounded" height={420} sx={{ borderRadius: '24px' }} />
        </Stack>
      ) : (
        <>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Showing the last {range} days · deltas compare against the prior {range}-day window.
          </Typography>

          {/* Engagement metrics */}
          <Box sx={gridSx(4)}>
            <MetricCard title="Emails Sent" value={stats.totalSent.toLocaleString()} change={stats.deltas?.sent} color="#2563EB" icon={SendHorizontal} />
            <MetricCard title="Open Rate" value={`${stats.averageOpenRate}%`} change={stats.deltas?.openRate} color="#0D9488" icon={Mail} />
            <MetricCard title="Click Rate" value={`${stats.averageClickRate}%`} change={stats.deltas?.clickRate} color="#D97706" icon={MousePointerClick} />
            <MetricCard title="Replies" value={stats.totalReplies.toLocaleString()} change={stats.deltas?.replies} color="#7C3AED" icon={Reply} />
          </Box>

          {/* Deliverability health */}
          <Box sx={gridSx(3)}>
            <MetricCard title="Failed Sends" value={(stats.failed ?? 0).toLocaleString()} sub="Delivery errors at send time" color="#DC2626" icon={XCircle} />
            <MetricCard title="Bounced" value={(stats.bounced ?? 0).toLocaleString()} sub="Hard bounces (delivery webhook)" color="#D97706" icon={AlertTriangle} />
            <MetricCard title="Unsubscribed" value={(stats.unsubscribed ?? 0).toLocaleString()} sub="Opted out of mailings" color="#64748B" icon={UserMinus} />
          </Box>

          {/* Engagement trend */}
          <ChartCard
            title="Engagement Trends"
            subtitle="Daily emails sent, unique opens, and clicks over the selected period."
            height={350}
            action={
              <FormControl size="small">
                <Select value={range} onChange={(e) => handleRangeChange(e.target.value)} sx={{ minWidth: 140 }}>
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
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" className="text-slate-200 dark:text-slate-800/80" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 11 }} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 11 }} allowDecimals={false} />
                <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid rgba(100,116,139,0.2)' }} itemStyle={{ fontSize: 11 }} />
                <Legend verticalAlign="top" height={28} iconType="plainline" wrapperStyle={{ fontSize: 11 }} />
                <Area type="linear" dataKey="sent" stroke="#3b82f6" strokeWidth={2.5} fillOpacity={1} fill="url(#colorSent)" name="Emails Sent" dot={{ r: 2 }} />
                <Area type="linear" dataKey="opens" stroke="#2dd4bf" strokeWidth={2.5} fillOpacity={1} fill="url(#colorOpens)" name="Unique Opens" dot={{ r: 2 }} />
                <Area type="linear" dataKey="clicks" stroke="#f43f5e" strokeWidth={2.5} fillOpacity={1} fill="url(#colorClicks)" name="Total Clicks" dot={{ r: 2 }} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' } }}>
            <ChartCard title="Conversion Funnel" subtitle="Pipeline from outbound dispatch to booked meeting.">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart layout="vertical" data={funnel} margin={{ top: 10, right: 24, left: 20, bottom: 10 }}>
                  <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10 }} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10 }} width={90} />
                  <Tooltip cursor={{ fill: 'rgba(148,163,184,0.08)' }} contentStyle={{ borderRadius: 12, border: '1px solid rgba(100,116,139,0.2)' }} itemStyle={{ fontSize: 11 }} />
                  <Bar dataKey="value" fill="#2563EB" radius={[0, 8, 8, 0]} barSize={24} name="Leads">
                    <LabelList dataKey="value" position="right" style={{ fontSize: 10, fontWeight: 700, fill: '#64748b' }} />
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
                    <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid rgba(100,116,139,0.2)' }} itemStyle={{ fontSize: 11 }} />
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

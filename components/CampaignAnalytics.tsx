'use client';

import type { ReactNode } from 'react';
import {
  Mail, CheckCircle2, MousePointerClick, Reply, SendHorizontal, Send, XCircle, AlertTriangle, UserMinus,
} from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell,
} from 'recharts';
import {
  Box, Card, CardContent, Stack, Typography, Chip, Table, TableHead, TableBody, TableRow, TableCell, Tooltip as MuiTooltip,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { isHtmlTemplate } from '@/lib/personalize';
import { replyCountUnknown, replySyncState, type ImapSyncState } from '@/lib/imapSyncStatus';
import { ENROLLMENT_STATES, STOPPED_ACTIVE_STATE, nextSendText } from '@/lib/campaignProgress';
import { timeAgo } from '@/lib/systemStatus';
import { useTheme as useAppTheme } from '@/components/ThemeProvider';

/**
 * The campaign page's Analytics tab: what GET /api/campaigns/[id] reports in
 * its telemetry, defined in lib/engagementMetrics as on the dashboard. A
 * number that depends on something not set up says so instead of showing a
 * misleading zero: deliveries need Azure delivery reports, replies need reply
 * sync on the mailboxes that receive them, and opens and clicks need tracking
 * on and an HTML step.
 */

/** A count as the page shows it: 1,284. */
const count = (value: number | null | undefined) => (value ?? 0).toLocaleString();

/** `part` as a percentage of `whole` to one decimal, as lib/engagementMetrics percent() works it out; 0 with no whole. */
const share = (part: number, whole: number) => (whole > 0 ? Number(((part / whole) * 100).toFixed(1)) : 0);

/** A next send date: "Tue, 1 Oct, 09:00", in local 24-hour time. */
const dateTime = (at: Date) =>
  at.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Why a campaign's reply counts may be short, by the reply-sync state of the mailboxes that receive its replies. */
const REPLY_SYNC_NOTES: Record<Exclude<ImapSyncState, 'ok'>, { short: string; long: string }> = {
  off: {
    short: 'Reply sync off',
    long: "No mailbox that receives this campaign's replies has IMAP set up, so replies are not read and are missing from these counts.",
  },
  waiting: {
    short: 'Reply sync pending',
    long: "No mailbox that receives this campaign's replies has finished a reply sync yet, so replies may be missing from these counts.",
  },
  failing: {
    short: 'Reply sync failing',
    long: "Reply sync is failing on the mailboxes that receive this campaign's replies, so replies may be missing from these counts. See the Accounts page.",
  },
};

const NO_REPORTS_NOTE =
  "No delivery reports have arrived for these emails. Deliveries, bounces and spam filtering show here once Azure sends delivery reports to ArcReach (Event Grid).";

/**
 * The reply-sync state of the mailboxes that receive a campaign's replies (its
 * primary and pool mailboxes, and their Reply-To mailboxes), from `mailboxes`
 * as GET /api/accounts lists them; null when that list did not load.
 */
function campaignReplySync(campaign: any, mailboxes: any[] | null): ImapSyncState | null {
  if (!mailboxes) return null;
  const ids = new Set<string>([campaign.senderAccountId, ...(campaign.senders ?? []).map((s: any) => s.senderAccountId)]);
  const pool = mailboxes.filter((m) => ids.has(m.id));
  return pool.length > 0 ? replySyncState(pool, mailboxes) : null;
}

/** What the Analytics tab and the Sequence tab's step lines need to say which numbers can't be trusted. */
export type AnalyticsCaveats = {
  /** Emails were accepted but no delivery report arrived for any of them. */
  noDeliveryReports: boolean;
  /** Why replies may be missing, or null when a receiving mailbox syncs (or the mailboxes did not load). */
  replySync: Exclude<ImapSyncState, 'ok'> | null;
  trackOpens: boolean;
  trackClicks: boolean;
};

export function analyticsCaveats(campaign: any, mailboxes: any[] | null): AnalyticsCaveats {
  const delivery = campaign?.telemetry?.delivery;
  const sync = campaignReplySync(campaign, mailboxes);
  return {
    noDeliveryReports: !!delivery && delivery.accepted > 0 && delivery.reported === 0,
    replySync: sync && sync !== 'ok' ? sync : null,
    trackOpens: campaign?.trackOpens !== false,
    trackClicks: campaign?.trackClicks !== false,
  };
}

/** A small warning mark with its reason on hover and focus. */
function Caveat({ note }: { note: string }) {
  return (
    <MuiTooltip title={note} arrow>
      <Box component="span" tabIndex={0} aria-label={note} sx={{ display: 'inline-flex', color: 'warning.main', verticalAlign: 'middle', ml: 0.5 }}>
        <AlertTriangle size={12} />
      </Box>
    </MuiTooltip>
  );
}

/**
 * Whether a step's or mailbox's delivered count means nothing yet: no report
 * arrived for any of its sent emails (or for any of the campaign's).
 */
function noReportsFor(row: { sent: number; reported: number }, caveats: AnalyticsCaveats): boolean {
  return caveats.noDeliveryReports || (row.sent > 0 && row.reported === 0);
}

/** A table cell's count, with its rate on a line below it. */
function rated(value: number, rate: number): ReactNode {
  return (
    <>
      {count(value)}
      <Typography component="span" variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>{rate}%</Typography>
    </>
  );
}

/** Why opens or clicks show no number for a step, or null when they can be counted. */
function trackingGap(tracked: boolean, htmlStep: boolean, value: number): string | null {
  if (value > 0) return null; // Counted before tracking was turned off, or the body changed since.
  if (!tracked) return 'Off';
  if (!htmlStep) return 'Plain text';
  return null;
}

const TRACKING_GAP_NOTES: Record<string, string> = {
  Off: 'Tracking is turned off for this campaign on the Options tab.',
  'Plain text': 'This step is plain text, which cannot carry the open pixel or tracked links.',
};

function Gap({ label }: { label: string }) {
  return (
    <MuiTooltip title={TRACKING_GAP_NOTES[label] ?? ''} arrow>
      <Box component="span" tabIndex={0} sx={{ color: 'text.secondary' }}>{label}</Box>
    </MuiTooltip>
  );
}

function NoReports() {
  return (
    <MuiTooltip title={NO_REPORTS_NOTE} arrow>
      <Box component="span" tabIndex={0} aria-label="No delivery reports" sx={{ color: 'text.secondary' }}>—</Box>
    </MuiTooltip>
  );
}

function StatTile({ title, value, icon: Icon, color, sub, caveat }: {
  title: string; value: ReactNode; icon: any; color: string; sub: string; caveat?: string | null;
}) {
  return (
    <Card>
      <CardContent>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 700 }}>{title}</Typography>
          <Box sx={{ width: 32, height: 32, borderRadius: '10px', display: 'grid', placeItems: 'center', bgcolor: alpha(color, 0.14), color }}>
            <Icon size={16} />
          </Box>
        </Stack>
        <Typography variant="h6" sx={{ fontWeight: 700, mt: 0.5 }}>{value}</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'flex', alignItems: 'center', mt: 0.5, fontFamily: 'monospace', fontSize: 9 }}>
          {sub}
          {caveat && <Caveat note={caveat} />}
        </Typography>
      </CardContent>
    </Card>
  );
}

function SectionTitle({ children, caption }: { children: ReactNode; caption?: ReactNode }) {
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="overline" sx={{ fontWeight: 700, display: 'block', lineHeight: 1.6 }}>{children}</Typography>
      {caption && <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>{caption}</Typography>}
    </Box>
  );
}

type BarRow = { key: string; label: string; description: string; value: number };

/**
 * Horizontal bars for the parts of one whole, one hue, each with its count and
 * share; the description shows on hover and keyboard focus.
 */
function BarList({ rows, total, noun }: { rows: BarRow[]; total: number; noun: string }) {
  return (
    <Stack spacing={1.5}>
      {rows.map((row) => {
        const percentage = share(row.value, total);
        return (
          <MuiTooltip key={row.key} arrow placement="top" title={`${row.description} ${count(row.value)} of ${count(total)} ${noun} (${percentage}%).`}>
            <Box tabIndex={0} sx={{ borderRadius: '6px', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 } }}>
              <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline', mb: 0.5, gap: 1 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{row.label}</Typography>
                <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  <Box component="strong">{count(row.value)}</Box>{' '}
                  <Box component="span" sx={{ color: 'text.secondary', ml: 0.5 }}>{percentage}%</Box>
                </Typography>
              </Stack>
              <Box sx={{ height: 8, bgcolor: 'rgba(var(--mui-palette-primary-mainChannel) / 0.12)', borderRadius: '0 4px 4px 0' }}>
                <Box sx={{
                  width: `${Math.min(100, (total > 0 ? row.value / total : 0) * 100)}%`, minWidth: row.value > 0 ? 3 : 0,
                  height: '100%', bgcolor: 'primary.main', borderRadius: '0 4px 4px 0',
                }} />
              </Box>
            </Box>
          </MuiTooltip>
        );
      })}
    </Stack>
  );
}

function Fact({ label, value, sub, caveat }: { label: string; value: ReactNode; sub?: string; caveat?: string | null }) {
  return (
    <Box>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block' }}>
        {label}
      </Typography>
      <Typography variant="body1" sx={{ fontWeight: 700, display: 'flex', alignItems: 'center' }}>
        {value}
        {caveat && <Caveat note={caveat} />}
      </Typography>
      {sub && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{sub}</Typography>}
    </Box>
  );
}

const headerSx = { '& th': { fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, color: 'text.secondary', whiteSpace: 'nowrap' } };
/** Narrower side padding than MUI's small table, so ten columns fit the page at desktop widths. */
const tableSx = { '& td, & th': { px: 1.25 } };

/** A table header with its definition on hover and focus. */
function Th({ children, title, caveat }: { children: ReactNode; title: string; caveat?: string | null }) {
  return (
    <TableCell>
      <MuiTooltip title={title} arrow>
        <Box component="span" tabIndex={0} sx={{ cursor: 'help' }}>{children}</Box>
      </MuiTooltip>
      {caveat && <Caveat note={caveat} />}
    </TableCell>
  );
}

/**
 * One line of a step's stats for its card on the Sequence tab, or nothing
 * before the step has been sent (or attempted).
 */
export function StepStatStrip({ stats, htmlStep, caveats }: { stats: any; htmlStep: boolean; caveats: AnalyticsCaveats }) {
  if (!stats || (stats.sent === 0 && stats.failed === 0)) return null;
  const opensGap = trackingGap(caveats.trackOpens, htmlStep, stats.opened);
  const clicksGap = trackingGap(caveats.trackClicks, htmlStep, stats.clicked);
  const items: Array<{ label: string; value: string; caveat?: string | null }> = [
    { label: 'Sent', value: stats.leads && stats.leads !== stats.sent ? `${count(stats.sent)} to ${count(stats.leads)} leads` : count(stats.sent) },
    ...(noReportsFor(stats, caveats) ? [] : [{ label: 'Delivered', value: `${stats.deliveryRate}%` }]),
    { label: 'Opened', value: opensGap ?? `${stats.openRate}%` },
    { label: 'Clicked', value: clicksGap ?? `${stats.clickRate}%` },
    { label: 'Replied', value: `${stats.replyRate}%`, caveat: caveats.replySync ? REPLY_SYNC_NOTES[caveats.replySync].long : null },
    { label: 'Unsubscribed', value: count(stats.unsubscribed) },
    { label: 'Bounced', value: count(stats.bounced) },
    ...(stats.failed > 0 ? [{ label: 'Failed', value: count(stats.failed) }] : []),
  ];
  return (
    <Stack direction="row" sx={{ flexWrap: 'wrap', columnGap: 2, rowGap: 0.5, mb: 2, px: 1.5, py: 1, borderRadius: '10px', bgcolor: 'action.hover' }}>
      {items.map((item) => (
        <Typography key={item.label} variant="caption" sx={{ color: 'text.secondary', display: 'inline-flex', alignItems: 'center' }}>
          {item.label}&nbsp;<Box component="strong" sx={{ color: 'text.primary', fontVariantNumeric: 'tabular-nums' }}>{item.value}</Box>
          {item.caveat && <Caveat note={item.caveat} />}
        </Typography>
      ))}
    </Stack>
  );
}

const SENTIMENT_COLORS: Record<string, string> = {
  'Neutral': '#94a3b8', 'Interested': '#10b981', 'Not Interested': '#f43f5e', 'Meeting Booked': '#6366f1',
  'Out of Office': '#f59e0b', 'Bounced': '#8b5cf6', 'Unsubscribed': '#475569',
};

export default function CampaignAnalytics({ campaign, mailboxes }: { campaign: any; mailboxes: any[] | null }) {
  // The app's own light/dark choice: MUI's palette values read in JS are always the light scheme's.
  const { theme: colorMode } = useAppTheme();
  const t = campaign?.telemetry ?? {};
  const progress = t.progress ?? { enrolled: 0, byStatus: {}, contacted: 0, repliedLeads: 0, emailsLeft: 0, dueNow: 0, nextDueAt: null, lastSentAt: null };
  const delivery = t.delivery ?? { accepted: 0, reported: 0, noReport: 0 };
  const stepStats: any[] = t.stepStats ?? [];
  const mailboxStats: any[] = t.mailboxes ?? [];
  const caveats = analyticsCaveats(campaign, mailboxes);
  const replyNote = caveats.replySync ? REPLY_SYNC_NOTES[caveats.replySync] : null;
  // With reply sync off, a reply count of 0 shows as unknown, and the funnel leaves Replied out.
  const repliesUnknown = replyCountUnknown(caveats.replySync, t.replies);
  const repliedLeadsUnknown = replyCountUnknown(caveats.replySync, progress.repliedLeads);
  const funnel = (t.funnel ?? []).filter((stage: any) => !(repliesUnknown && stage.name === 'Replied'));
  const stopped = campaign?.status === 'Stopped';
  const now = new Date();
  // Opens and clicks in the validated categorical slots 1 and 2 (light and dark steps), each named in the legend.
  const series = colorMode === 'dark' ? { opens: '#3987e5', clicks: '#d95926' } : { opens: '#2a78d6', clicks: '#eb6834' };
  const stepBodies = new Map<number, string>((campaign?.steps ?? []).map((s: any) => [s.stepOrder, s.body ?? '']));

  const emailTiles = [
    { title: 'Total Sent Requests', value: count(t.sentRequests), icon: SendHorizontal, color: '#64748b', sub: 'Includes retries & failures' },
    { title: 'Emails Sent', value: count(t.sent), icon: Send, color: '#2563EB', sub: `Accepted by provider, to ${count(progress.contacted)} leads` },
    caveats.noDeliveryReports
      ? { title: 'Delivered', value: '—', icon: CheckCircle2, color: '#059669', sub: 'No delivery reports yet', caveat: NO_REPORTS_NOTE }
      : { title: 'Delivered', value: count(t.delivered), icon: CheckCircle2, color: '#059669', sub: `${t.deliveryRate ?? 0}% delivery rate` },
    { title: 'Unique Opens', value: count(t.opens), icon: Mail, color: '#2563EB', sub: caveats.trackOpens ? `${t.openRate ?? 0}% open rate` : 'Open tracking is off' },
    { title: 'Unique Clicks', value: count(t.clicks), icon: MousePointerClick, color: '#D97706', sub: caveats.trackClicks ? `${t.clickRate ?? 0}% click rate` : 'Click tracking is off' },
    { title: 'Replies', value: repliesUnknown ? '—' : count(t.replies), icon: Reply, color: '#7C3AED', sub: replyNote ? replyNote.short : `${t.replyRate ?? 0}% reply rate`, caveat: replyNote?.long },
  ];
  const healthTiles = [
    { title: 'Failed Sends', value: count(t.failed), icon: XCircle, color: '#DC2626', sub: 'Delivery errors at send time' },
    { title: 'Bounced', value: count(t.bounced), icon: AlertTriangle, color: '#D97706', sub: `${t.bounceRate ?? 0}% bounce rate` },
    { title: 'Unsubscribed', value: count(t.unsubscribed), icon: UserMinus, color: '#64748b', sub: 'Opted out of mailings' },
  ];

  // Every enrollment status, in a fixed order, zeros included; a stopped campaign's Active leads show as Stopped.
  const knownStatuses = new Set(ENROLLMENT_STATES.map((s) => s.status));
  const progressRows: BarRow[] = [
    ...ENROLLMENT_STATES.map((state) => (stopped && state.status === 'Active' ? STOPPED_ACTIVE_STATE : state)),
    ...Object.keys(progress.byStatus ?? {}).filter((status) => !knownStatuses.has(status))
      .map((status) => ({ status, label: status, description: 'An enrollment status this page does not describe.' })),
  ].map((state) => ({ key: state.status, label: state.label, description: state.description, value: progress.byStatus?.[state.status] ?? 0 }));

  const deliveryRows: BarRow[] = [
    { key: 'delivered', label: 'Delivered', description: "The recipient's mail server accepted it.", value: delivery.delivered },
    { key: 'soft', label: 'Soft Bounce', description: 'Refused this time (a full mailbox, spam or reputation filtering, a temporary error). The address stays mailable.', value: delivery.softBounced },
    { key: 'hard', label: 'Hard Bounce', description: 'The address cannot receive mail, so it went on the suppression list.', value: delivery.hardBounced },
    { key: 'spam', label: 'Filtered As Spam', description: "The recipient's filtering rejected it as spam.", value: delivery.spam },
    { key: 'quarantined', label: 'Quarantined', description: "The recipient's filtering held it.", value: delivery.quarantined },
    ...(delivery.expanded > 0 ? [{ key: 'expanded', label: 'Expanded List', description: "A distribution list was expanded; its members' reports are counted on their own.", value: delivery.expanded }] : []),
    ...(delivery.otherReported > 0 ? [{ key: 'other', label: 'Other', description: 'Another delivery report status.', value: delivery.otherReported }] : []),
    { key: 'none', label: 'No Report Yet', description: 'Azure has not reported on it yet.', value: delivery.noReport },
  ];

  const waitingTitle = stopped ? 'Stopped Here' : 'Waiting';
  const waitingDefinition = stopped
    ? 'Leads whose next email is this step, held while the campaign is stopped. A restart continues them from it.'
    : 'Leads in the sequence whose next email is this step.';

  return (
    <Stack spacing={3}>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' }, gap: 2 }}>
        {emailTiles.map((tile) => <StatTile key={tile.title} {...tile} />)}
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' }, gap: 2 }}>
        {healthTiles.map((tile) => <StatTile key={tile.title} {...tile} />)}
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' }, gap: 2 }}>
        <Card>
          <CardContent>
            <SectionTitle caption="Where every enrolled lead is in the sequence.">Lead Progress</SectionTitle>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)' }, gap: 2, mb: 3 }}>
              <Fact label="Enrolled" value={count(progress.enrolled)} />
              <Fact label="Contacted" value={count(progress.contacted)} sub={`${share(progress.contacted, progress.enrolled)}% of enrolled`} />
              <Fact label="Replied" value={repliedLeadsUnknown ? '—' : count(progress.repliedLeads)} sub={repliedLeadsUnknown ? replyNote?.short : `${share(progress.repliedLeads, progress.contacted)}% of contacted`} caveat={replyNote?.long} />
              <Fact label="Emails Left" value={`Up to ${count(progress.emailsLeft)}`} sub={stopped ? 'Sent after a restart' : undefined} />
              <Fact label="Next Send" value={nextSendText(campaign ?? {}, progress.nextDueAt, now, dateTime)} sub={campaign?.status === 'Active' && progress.dueNow > 0 ? `${count(progress.dueNow)} leads due` : undefined} />
              <Fact label="Last Send" value={progress.lastSentAt ? timeAgo(progress.lastSentAt, now) : 'Never'} />
            </Box>
            <BarList rows={progressRows} total={progress.enrolled} noun="enrolled leads" />
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <SectionTitle caption={delivery.accepted > 0 ? `What Azure reported for the ${count(delivery.accepted)} emails it accepted.` : undefined}>Delivery Reports</SectionTitle>
            {delivery.accepted === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>No emails have been accepted for sending yet.</Typography>
            ) : delivery.reported === 0 ? (
              <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', color: 'warning.main' }}>
                <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                <Typography variant="caption" sx={{ fontWeight: 600 }}>{NO_REPORTS_NOTE}</Typography>
              </Stack>
            ) : (
              <BarList rows={deliveryRows} total={delivery.accepted} noun="accepted emails" />
            )}
          </CardContent>
        </Card>
      </Box>

      <Card>
        <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="overline" sx={{ fontWeight: 700, display: 'block', lineHeight: 1.6 }}>Step Performance</Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Each email in the sequence. Rates are of the emails that step sent; Replied is of the leads it reached.
          </Typography>
        </Box>
        {stepStats.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary', p: 2 }}>This campaign has no steps yet.</Typography>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={tableSx}>
              <TableHead>
                <TableRow sx={headerSx}>
                  <TableCell>Step</TableCell>
                  <Th title={waitingDefinition}>{waitingTitle}</Th>
                  <Th title="Emails the provider accepted for this step. Where a lead got the step more than once, the leads it reached are shown too.">Sent</Th>
                  <Th title="Emails a delivery report said were delivered.">Delivered</Th>
                  <Th title="Emails a person opened or clicked in (automated opens are left out), of those not reported undelivered.">Opened</Th>
                  <Th title="Emails a person clicked a link in, of those not reported undelivered.">Clicked</Th>
                  <Th title="Leads who replied after this step was their latest email, of the leads it reached. Bounces and auto-replies are left out." caveat={replyNote?.long}>Replied</Th>
                  <Th title="Emails whose unsubscribe link was used.">Unsubscribed</Th>
                  <Th title="Hard bounces: reported by Azure or found when sending.">Bounced</Th>
                  <Th title="Send attempts the provider refused or that errored, retries included.">Failed</Th>
                </TableRow>
              </TableHead>
              <TableBody>
                {stepStats.map((s: any) => {
                  const htmlStep = isHtmlTemplate(stepBodies.get(s.stepOrder) ?? '');
                  const opensGap = trackingGap(caveats.trackOpens, htmlStep, s.opened);
                  const clicksGap = trackingGap(caveats.trackClicks, htmlStep, s.clicked);
                  const nextDue = s.nextDueAt ? new Date(s.nextDueAt) : null;
                  const waitingNote = campaign?.status !== 'Active' || s.active === 0 ? null
                    : s.due > 0 ? `${count(s.due)} due now`
                      : nextDue ? `next ${dateTime(nextDue)}` : null;
                  return (
                    <TableRow key={s.stepOrder} hover sx={{ '& td': { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }}>
                      <TableCell>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <Chip size="small" label={s.stepOrder} sx={{ height: 20, fontWeight: 700, fontFamily: 'monospace', bgcolor: (th) => alpha(th.palette.primary.main, 0.14), color: 'primary.main' }} />
                          <Box sx={{ minWidth: 0 }}>
                            <Typography variant="body2" sx={{ fontWeight: 600, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={s.subject}>{s.subject || '(No subject)'}</Typography>
                            <Typography variant="caption" sx={{ color: 'text.secondary' }}>{s.stepOrder === 1 ? 'On enrollment' : `${s.waitDays} days after step ${s.stepOrder - 1}`}</Typography>
                          </Box>
                        </Stack>
                      </TableCell>
                      <TableCell>
                        {count(s.active)}
                        {waitingNote && <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>{waitingNote}</Typography>}
                      </TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>
                        {count(s.sent)}
                        {s.leads > 0 && s.leads !== s.sent && (
                          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontWeight: 400 }}>to {count(s.leads)} leads</Typography>
                        )}
                      </TableCell>
                      <TableCell>{noReportsFor(s, caveats) ? <NoReports /> : rated(s.delivered, s.deliveryRate)}</TableCell>
                      <TableCell>{opensGap ? <Gap label={opensGap} /> : rated(s.opened, s.openRate)}</TableCell>
                      <TableCell>{clicksGap ? <Gap label={clicksGap} /> : rated(s.clicked, s.clickRate)}</TableCell>
                      <TableCell>{rated(s.replied, s.replyRate)}</TableCell>
                      <TableCell>{rated(s.unsubscribed, s.unsubscribeRate)}</TableCell>
                      <TableCell>{rated(s.bounced, s.bounceRate)}</TableCell>
                      <TableCell sx={{ color: s.failed > 0 ? 'error.main' : undefined, fontWeight: s.failed > 0 ? 700 : 400 }}>{count(s.failed)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        )}
      </Card>

      <Card>
        <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="overline" sx={{ fontWeight: 700, display: 'block', lineHeight: 1.6 }}>Mailboxes</Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>The sends of this campaign by the mailbox that sent them.</Typography>
        </Box>
        {mailboxStats.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary', p: 2 }}>Nothing has been sent yet.</Typography>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={tableSx}>
              <TableHead>
                <TableRow sx={headerSx}>
                  <TableCell>Mailbox</TableCell>
                  <Th title="Emails the provider accepted from this mailbox, and the leads they went to.">Sent</Th>
                  <Th title="Emails a delivery report said were delivered.">Delivered</Th>
                  <Th title="Emails a person opened or clicked in, of those not reported undelivered.">Opened</Th>
                  <Th title="Leads who replied after an email from this mailbox was their latest, of the leads it reached." caveat={replyNote?.long}>Replied</Th>
                  <Th title="Hard bounces: reported by Azure or found when sending.">Bounced</Th>
                  <Th title="Send attempts the provider refused or that errored, retries included.">Failed</Th>
                </TableRow>
              </TableHead>
              <TableBody>
                {mailboxStats.map((m: any) => (
                  <TableRow key={m.senderAccountId ?? 'none'} hover sx={{ '& td': { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }}>
                    <TableCell>
                      {m.senderAccountId ? (
                        <>
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>{m.name || m.emailAddress || 'Deleted mailbox'}</Typography>
                          {m.name && m.emailAddress && <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>{m.emailAddress}</Typography>}
                        </>
                      ) : (
                        <MuiTooltip arrow title="Sent before ArcReach recorded which mailbox sent each email, or from a mailbox since deleted.">
                          <Typography variant="body2" tabIndex={0} sx={{ fontWeight: 600, color: 'text.secondary', width: 'fit-content' }}>Not Recorded</Typography>
                        </MuiTooltip>
                      )}
                    </TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>
                      {count(m.sent)}
                      {m.leads > 0 && <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontWeight: 400 }}>to {count(m.leads)} leads</Typography>}
                    </TableCell>
                    <TableCell>{noReportsFor(m, caveats) ? <NoReports /> : rated(m.delivered, m.deliveryRate)}</TableCell>
                    <TableCell>{!caveats.trackOpens && m.opened === 0 ? <Gap label="Off" /> : rated(m.opened, m.openRate)}</TableCell>
                    <TableCell>{rated(m.replied, m.replyRate)}</TableCell>
                    <TableCell>{rated(m.bounced, m.bounceRate)}</TableCell>
                    <TableCell sx={{ color: m.failed > 0 ? 'error.main' : undefined, fontWeight: m.failed > 0 ? 700 : 400 }}>{count(m.failed)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
      </Card>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(3, 1fr)' }, gap: 2 }}>
        <Card>
          <CardContent>
            <SectionTitle caption="Of the emails sent each day, the last 7 days.">Engagement Over Time</SectionTitle>
            <Box sx={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={t.trend || []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="currentColor" className="text-slate-200 dark:text-slate-800/80" />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10 }} dy={10} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10 }} allowDecimals={false} />
                  <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid rgba(100,116,139,0.2)', fontSize: 11 }} />
                  <Legend
                    iconType="plainline" verticalAlign="top" height={24} wrapperStyle={{ fontSize: 11 }}
                    formatter={(value) => <span style={{ color: '#64748b' }}>{value}</span>}
                  />
                  <Area type="monotone" dataKey="opens" stroke={series.opens} strokeWidth={2} fill={series.opens} fillOpacity={0.1} name="Unique Opens" />
                  <Area type="monotone" dataKey="clicks" stroke={series.clicks} strokeWidth={2} fill={series.clicks} fillOpacity={0.1} name="Unique Clicks" />
                </AreaChart>
              </ResponsiveContainer>
            </Box>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <SectionTitle caption={repliesUnknown ? 'Replied is left out while reply sync is off.' : undefined}>Conversion Funnel</SectionTitle>
            <Box sx={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart layout="vertical" data={funnel} margin={{ top: 5, right: 5, left: 10, bottom: 5 }}>
                  <XAxis type="number" hide allowDecimals={false} />
                  <YAxis type="category" dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 9 }} width={75} />
                  {/* Each stage names what it counts: emails, replies or leads. */}
                  <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid rgba(100,116,139,0.2)', fontSize: 11 }} formatter={(value, name, item) => [value, item?.payload?.unit ?? name]} />
                  <Bar dataKey="value" fill="#2563EB" radius={[0, 8, 8, 0]} barSize={14} name="Count" />
                </BarChart>
              </ResponsiveContainer>
            </Box>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <SectionTitle>Sentiment Distribution</SectionTitle>
            <Box sx={{ height: 200, position: 'relative' }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={(t.sentiment || []).filter((s: any) => s.value > 0)} cx="50%" cy="50%" innerRadius={45} outerRadius={65} paddingAngle={3} dataKey="value" nameKey="name">
                    {(t.sentiment || []).filter((s: any) => s.value > 0).map((entry: any, index: number) => (
                      <Cell key={`cell-${index}`} fill={SENTIMENT_COLORS[entry.name] || '#3b82f6'} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid rgba(100,116,139,0.2)', fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
              {(!t.sentiment || t.sentiment.every((s: any) => s.value === 0)) && (
                <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>No leads enrolled.</Typography>
                </Box>
              )}
            </Box>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 0.75, mt: 1, fontSize: 9 }}>
              {t.sentiment?.filter((s: any) => s.value > 0).map((s: any) => (
                <Stack key={s.name} direction="row" spacing={0.5} sx={{ alignItems: 'center', color: 'text.secondary' }}>
                  <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: SENTIMENT_COLORS[s.name] || '#3b82f6' }} />
                  <Typography variant="caption" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}: {s.value}</Typography>
                </Stack>
              ))}
            </Box>
          </CardContent>
        </Card>
      </Box>
    </Stack>
  );
}

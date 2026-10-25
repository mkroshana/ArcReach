'use client';

import { useState, useEffect, Fragment } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Plus, PlayCircle, Search, Layers, RefreshCw, Loader2,
  Mail, User, ChevronRight, ChevronDown, Gauge, Inbox, Trash2, Play, Pause, Send, Check, Clock, TimerOff, UserX,
  CircleStop, RotateCcw, SendHorizontal,
} from 'lucide-react';
import {
  Box, Card, CardContent, Stack, Typography, Button, IconButton, Chip, TextField,
  Dialog, DialogTitle, DialogContent, DialogActions, Table, TableHead, TableBody, TableRow, TableCell,
  Snackbar, Alert, AlertTitle, InputAdornment, CircularProgress, Tooltip as MuiTooltip, Select, MenuItem,
  Checkbox, FormControlLabel,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ActionDrawer } from '@/components/ActionDrawer';
import { queuedLeadsMessage } from '@/lib/campaignSteps';
import { sendStepConfirmMessage, sequenceCounts, sequenceHeadline, stepRowState, stepWaitText } from '@/lib/campaignListPanel';
import { type NextSend, nextSendTimes, viewerTimeZone } from '@/lib/campaignTiming';
import { autoResumeNote, ownerDisabledNote } from '@/lib/campaignPause';
import { STOPPABLE_STATUSES, STOPPED_STATUS, restartConfirmMessage, stopConfirmMessage, stoppedNote } from '@/lib/campaignStop';
import { LoadError, loadErrorMessage, readJsonList, readJsonObject } from '@/lib/apiResponse';
import { toastDuration } from '@/lib/toastDuration';

interface DbCampaign {
  id: string;
  name: string;
  status: 'Active' | 'Draft' | 'Paused' | 'Stopped';
  pausedUntil?: string | null;
  pauseReason?: string | null;
  // When a user stopped it; null unless Stopped.
  stoppedAt?: string | null;
  // Whether its saved sending window is complete; without one the auto-resume sets it to Draft.
  hasSendingSchedule: boolean;
  senderAccount?: { emailAddress: string };
  userId: string | null;
  user?: { id: string; name: string | null; email: string } | null;
  createdAt: string;
  // Step metadata only: bodies load with a single campaign on its page.
  steps?: { id: string; stepOrder: number; waitDays: number; subject: string }[];
  // Server-side aggregates — raw enrollment/dispatch rows are never shipped
  // (payloads at scale OOM'd the server).
  // `leads`: the leads the step's sent emails reached, each once however often it got the step.
  // `reported`: its sent emails a delivery report arrived for; with none, `delivered` is unknown, not 0.
  // `active`: the leads waiting for the step that can still be emailed; `nextSend`: when they next go out.
  stepStats?: { stepOrder: number; active: number; sent: number; delivered: number; reported: number; failed: number; leads: number; nextSend?: NextSend | null }[];
  // `notMailable`: Active enrollments whose lead may no longer be emailed, so no step counts them.
  // `skipped`: leads it skips because a campaign of `skipLeadsEmailedBy` has emailed them (lib/campaignSkip).
  enrollmentSummary?: { total: number; active: number; completed: number; notMailable?: number; skipped?: number };
  // IDs of the campaigns whose emailed leads it skips.
  skipLeadsEmailedBy?: string[];
}

const statusColorMap = { Active: 'success', Draft: 'default', Paused: 'warning', Stopped: 'error' } as const;

/** Shopeers status pill badge with emerald pulse dot, pause indicator, stop indicator, or neutral dot. */
function CampaignStatusPill({ status }: { status: 'Active' | 'Draft' | 'Paused' | 'Stopped' }) {
  if (status === 'Active') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800/50">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
        </span>
        <span>Active</span>
      </span>
    );
  }
  if (status === 'Paused') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-200/60 dark:border-amber-800/50">
        <Pause size={12} className="text-amber-500" />
        <span>Paused</span>
      </span>
    );
  }
  if (status === 'Stopped') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 border border-rose-200/60 dark:border-rose-800/50">
        <CircleStop size={12} className="text-rose-500" />
        <span>Stopped</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
      <span className="w-2 h-2 rounded-full bg-slate-400" />
      <span>Draft</span>
    </span>
  );
}

/** A campaign's creation date with the month as a word, "8 Oct 2026" or "Oct 8, 2026" by locale, so day and month cannot be mixed up. */
const createdDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Why a step row shows Delivered as unknown. */
const NO_DELIVERY_REPORTS_NOTE = 'No delivery reports have arrived for these emails, so how many were delivered is not known.';

/** Why a step row's Delivered names the emails a delivery report arrived for. */
const PARTLY_REPORTED_NOTE = 'Delivered counts only the emails a delivery report arrived for. No delivery report has arrived for the others yet.';

export default function CampaignsPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<DbCampaign[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  // Set when a load or refresh fails. The list shows only once loaded, so a failure is never shown as no campaigns.
  const [loadError, setLoadError] = useState('');
  const [campaignsLoaded, setCampaignsLoaded] = useState(false);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  // Why the mailboxes could not be loaded. Only Create Campaign needs them.
  const [accountsError, setAccountsError] = useState('');
  const [search, setSearch] = useState('');
  const [expandedCampaignId, setExpandedCampaignId] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [campaignName, setCampaignName] = useState('');
  const [selectedMailboxId, setSelectedMailboxId] = useState('');
  const [selectedPoolIds, setSelectedPoolIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error'; duration: number | null } | null>(null);
  // `destructive` defaults to true: Delete and Stop confirm in red, Restart does not.
  const [confirmState, setConfirmState] = useState<{ title: string; message: string; confirmLabel: string; destructive?: boolean; onConfirm: () => void } | null>(null);
  // The step Send Step is asking about. It sends to every lead on the step now, whatever is left of their wait, so it asks first.
  const [sendStepPrompt, setSendStepPrompt] = useState<{ campaignId: string; stepOrder: number; message: string } | null>(null);
  // A long error, such as the server's reason a campaign was not created, stays until dismissed.
  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    const next = { message, type, duration: toastDuration(message, type, 3000) };
    setToast(next);
    if (next.duration !== null) setTimeout(() => setToast(current => (current === next ? null : current)), next.duration + 50);
  };

  const handleToggleStatus = async (id: string, currentStatus: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newStatus = currentStatus === 'Active' ? 'Paused' : 'Active';
    try {
      const res = await fetch('/api/campaigns', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: newStatus }),
      });
      if (res.ok) { showToast(`Campaign status updated to ${newStatus}`); loadData(); }
      else {
        const data = await res.json().catch(() => null);
        showToast(data?.error || 'Failed to update status.', 'error');
      }
    } catch { showToast('Error updating status.', 'error'); }
  };

  // Setting Paused again cancels the auto-resume the send engine scheduled.
  const handleKeepPaused = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await fetch('/api/campaigns', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: 'Paused' }),
      });
      if (res.ok) { showToast('Auto-resume cancelled. The campaign stays paused until you activate it.'); loadData(); }
      else {
        const data = await res.json().catch(() => null);
        showToast(data?.error || 'Failed to keep the campaign paused.', 'error');
      }
    } catch { showToast('Error keeping the campaign paused.', 'error'); }
  };

  // Stop and Restart ask first. Stop ends sending until a restart, which makes the campaign Active again.
  const confirmStopOrRestart = (campaign: DbCampaign, e: React.MouseEvent) => {
    e.stopPropagation();
    const restart = campaign.status === STOPPED_STATUS;
    const action = restart ? 'restart' : 'stop';
    setConfirmState({
      title: restart ? 'Restart Campaign?' : 'Stop Campaign?',
      message: restart ? restartConfirmMessage(campaign.name) : stopConfirmMessage(campaign.name, campaign.enrollmentSummary?.active || 0),
      confirmLabel: restart ? 'Restart' : 'Stop Campaign',
      destructive: !restart,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch('/api/campaigns', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: campaign.id, status: restart ? 'Active' : STOPPED_STATUS }),
          });
          if (res.ok) {
            showToast(restart ? 'Campaign restarted. Sending resumes inside its sending window.' : 'Campaign stopped. It sends nothing until you restart it.');
            loadData();
          } else {
            const data = await res.json().catch(() => null);
            showToast(data?.error || `Failed to ${action} the campaign.`, 'error');
          }
        } catch { showToast(`Error trying to ${action} the campaign.`, 'error'); }
      },
    });
  };

  const handleRunCampaign = async (id: string, stepOrder?: number) => {
    const key = id + (stepOrder ? `-${stepOrder}` : '');
    try {
      setExecutingId(key);
      const url = `/api/campaigns/${id}/run` + (stepOrder ? `?stepOrder=${stepOrder}` : '');
      const res = await fetch(url, { method: 'POST' });
      const data = await res.json().catch(() => null);
      // The route only queues leads; the background worker sends them.
      if (res.ok && typeof data?.queued === 'number') { showToast(queuedLeadsMessage(data.queued, stepOrder)); loadData(); }
      else showToast(data?.error || 'Failed to queue leads.', 'error');
    } catch { showToast('Failed to queue leads.', 'error'); }
    finally { setExecutingId(null); }
  };

  const loadData = async () => {
    try {
      setLoading(true);
      setLoadError('');
      const sessData = await readJsonObject(await fetch('/api/session'), 'Your session');
      if (!sessData.id) throw new LoadError('Your session could not be loaded. Sign in again.');
      setSession(sessData);
      // The mailboxes load on their own: a failure there blocks only Create Campaign,
      // never the list, where running campaigns are paused and resumed.
      try {
        // A new campaign belongs to the signed-in user and only sends from its
        // owner's mailboxes, so an admin picks among their own, not every user's.
        const accData = (await readJsonList(await fetch('/api/accounts'), 'Your mailboxes')).filter((acc: any) => acc.userId === sessData.id);
        setAccounts(accData);
        setAccountsLoaded(true);
        setAccountsError('');
        if (accData.length > 0) setSelectedMailboxId(accData[0].id);
      } catch (err) { console.error(err); setAccountsError(loadErrorMessage(err, 'Your mailboxes')); }
      setCampaigns(await readJsonList(await fetch(`/api/campaigns?t=${Date.now()}`), 'Campaigns'));
      setCampaignsLoaded(true);
    } catch (err) { console.error(err); setLoadError(loadErrorMessage(err, 'Campaigns')); }
    finally { setLoading(false); }
  };

  // A failed refresh keeps the last list on screen and says it may be out of date.
  const refreshCampaigns = async () => {
    try {
      setCampaigns(await readJsonList(await fetch(`/api/campaigns?t=${Date.now()}`), 'Campaigns'));
      setCampaignsLoaded(true);
      setLoadError('');
    } catch (err) {
      console.error('Failed to auto-refresh campaigns:', err);
      setLoadError(loadErrorMessage(err, 'Campaigns'));
    }
  };

  const retryButton = (
    <Button color="inherit" size="small" startIcon={<RefreshCw size={14} />} onClick={() => loadData()}>Retry</Button>
  );

  useEffect(() => { loadData(); }, []);

  const anyCampaignActive = campaigns.some(c => c.status === 'Active');
  const isRunning = executingId !== null;

  // Refreshes every 30s while a campaign is Active or queuing, and only while the tab is visible.
  useEffect(() => {
    if (!anyCampaignActive && !isRunning) return;
    const interval = setInterval(() => { if (document.visibilityState === 'visible') refreshCampaigns(); }, 30000);
    return () => clearInterval(interval);
  }, [anyCampaignActive, isRunning]);

  const handleCreateCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!campaignName || !selectedMailboxId) {
      showToast('Name and physical Sender Mailbox are required.', 'error');
      return;
    }
    try {
      setSubmitting(true);
      const res = await fetch('/api/campaigns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: campaignName,
          senderAccountId: selectedMailboxId,
          senderAccountIds: Array.from(new Set([selectedMailboxId, ...selectedPoolIds])),
          status: 'Draft',
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || 'Failed to establish campaign.');
      }
      const created = await res.json();
      showToast('Campaign created.');
      setCampaignName(''); setSelectedPoolIds([]); setIsAddOpen(false);
      router.push(`/campaigns/${created.id}`);
    } catch (err: any) {
      showToast(err.message || 'Error occurred', 'error');
    } finally { setSubmitting(false); }
  };

  const handleDeleteCampaign = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmState({
      title: 'Delete Campaign?',
      message: 'Permanently delete this campaign, its steps and its lead enrollments? This cannot be undone. Emails it already sent and the replies they received are kept but unlinked from it, so they stay in lead timelines and Unibox and the links in those emails keep working.',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/campaigns?id=${id}`, { method: 'DELETE' });
          if (res.ok) { setCampaigns(campaigns.filter(c => c.id !== id)); showToast('Campaign deleted.'); }
          // The server says why it refused, e.g. another campaign skips the leads this one emailed.
          else showToast((await res.json().catch(() => null))?.error || 'Failed to delete the campaign.', 'error');
        } catch (err) { showToast('Error occurred deleting campaign.', 'error'); }
      },
    });
  };

  const filteredCampaigns = campaigns.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
  // Send times are given in the campaign's time zone and, where it reads differently, in the viewer's.
  const viewerZone = viewerTimeZone();

  return (
    <div className="space-y-6 pb-12 w-full">
      <Snackbar open={!!toast} anchorOrigin={{ vertical: 'top', horizontal: 'right' }} autoHideDuration={toast?.duration ?? null} onClose={(_, reason) => { if (reason !== 'clickaway') setToast(null); }}>
        {toast ? <Alert severity={toast.type} variant="filled" onClose={() => setToast(null)} sx={{ borderRadius: '12px', maxWidth: 520 }}>{toast.message}</Alert> : undefined}
      </Snackbar>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#EBF0F5] dark:border-[#1E222D]">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white">
            Campaign Sequences
          </h1>
          <p className="text-xs md:text-sm text-slate-500 dark:text-slate-400 mt-1">
            Each campaign, where its leads are in the sequence and when the next step goes out.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (!accountsLoaded) { showToast('Your mailboxes could not be loaded, so a campaign cannot be created yet. Use Retry to load them.', 'error'); return; }
            if (accounts.length === 0) { showToast('Please first connect at least one Mailbox of your own in the Senders view before starting a campaign.', 'error'); return; }
            setIsAddOpen(true);
          }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs md:text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-xs transition-colors cursor-pointer self-start sm:self-auto"
        >
          <Plus size={16} />
          <span>Create Campaign</span>
        </button>
      </div>

      {loadError && campaignsLoaded && !loading && (
        <Alert severity="warning" action={retryButton}>
          <AlertTitle>Campaigns Could Not Be Refreshed</AlertTitle>
          This list may be out of date. {loadError}
        </Alert>
      )}

      {accountsError && !accountsLoaded && !loading && (
        <Alert severity="warning" action={retryButton}>
          <AlertTitle>Mailboxes Could Not Be Loaded</AlertTitle>
          A campaign cannot be created until your mailboxes load. {accountsError}
        </Alert>
      )}

      <div className="rounded-[24px] border border-[#EBF0F5] dark:border-[#1E222D] bg-white dark:bg-[#11131A] shadow-xs overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 sm:px-6 border-b border-[#EBF0F5] dark:border-[#1E222D]">
          <div className="relative w-full sm:w-72">
            <Search size={14} className="text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search campaigns..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3.5 py-2 rounded-xl text-xs border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
            />
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 font-medium">
            Showing {filteredCampaigns.length} {filteredCampaigns.length === 1 ? 'campaign' : 'campaigns'}
          </div>
        </div>

        {loading ? (
          <Stack sx={{ alignItems: 'center', py: 8, gap: 2 }}>
            <CircularProgress size={24} />
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>Loading campaigns…</Typography>
          </Stack>
        ) : !campaignsLoaded ? (
          <Box sx={{ p: 2 }}>
            <Alert severity="error" action={retryButton}>
              <AlertTitle>Campaigns Could Not Be Loaded</AlertTitle>
              {loadError || 'Campaigns could not be loaded.'}
            </Alert>
          </Box>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ '& th': { fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, color: 'text.secondary' } }}>
                  <TableCell>Campaign</TableCell>
                  <TableCell>Sender Mailbox</TableCell>
                  <TableCell>Owner</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell align="right">Configure</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredCampaigns.map(campaign => {
                  const isExpanded = expandedCampaignId === campaign.id;
                  const resumeNote = autoResumeNote(campaign);
                  const ownerNote = ownerDisabledNote(campaign);
                  const stopNote = stoppedNote(campaign);
                  const stopped = campaign.status === STOPPED_STATUS;
                  const steps = campaign.steps ?? [];
                  const stepStats = campaign.stepStats ?? [];
                  // The campaigns whose emailed leads it skips, by name; null for one this list does not have.
                  const skippedBy = (campaign.skipLeadsEmailedBy ?? []).map(id => campaigns.find(c => c.id === id)?.name ?? null);
                  return (
                    <Fragment key={campaign.id}>
                      <TableRow hover onClick={() => setExpandedCampaignId(isExpanded ? null : campaign.id)} sx={{ cursor: 'pointer', bgcolor: isExpanded ? 'action.hover' : undefined }}>
                        <TableCell>
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <SendHorizontal size={16} className="text-slate-400 dark:text-slate-500 shrink-0" />
                            <Typography variant="body2" sx={{ fontWeight: 700 }}>{campaign.name}</Typography>
                          </Stack>
                          <Typography variant="caption" sx={{ color: 'text.secondary', ml: '46px', display: 'block' }}>
                            Created {createdDate.format(new Date(campaign.createdAt))}
                          </Typography>
                        </TableCell>
                        <TableCell sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                            <Mail size={14} /> {campaign.senderAccount?.emailAddress || 'N/A'}
                          </Stack>
                        </TableCell>
                        <TableCell sx={{ color: 'text.secondary' }}>
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                            <User size={14} /> {campaign.userId === session?.id ? `Me (${session?.name})` : (campaign.user?.name || campaign.user?.email || 'Company Admin')}
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <CampaignStatusPill status={campaign.status} />
                          {resumeNote && (
                            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                              <Clock size={11} style={{ flexShrink: 0 }} /> {resumeNote}
                            </Typography>
                          )}
                          {ownerNote && (
                            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                              <UserX size={11} style={{ flexShrink: 0 }} /> {ownerNote}
                            </Typography>
                          )}
                          {stopNote && (
                            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
                              {stopNote}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                          <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end', alignItems: 'center' }}>
                            <MuiTooltip title="Delete">
                              <IconButton aria-label="Delete campaign" size="small" onClick={(e) => handleDeleteCampaign(campaign.id, e)} sx={{ color: 'error.main' }}>
                                <Trash2 size={14} />
                              </IconButton>
                            </MuiTooltip>
                            <Link
                              href={`/campaigns/${campaign.id}`}
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-700 dark:text-slate-200 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                            >
                              <span>Configure</span>
                              <ChevronRight size={14} />
                            </Link>
                          </Stack>
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow sx={{ bgcolor: 'action.hover' }}>
                          <TableCell colSpan={5} sx={{ p: 3 }}>
                            <Stack spacing={2}>
                              <Stack direction={{ xs: 'column', md: 'row' }} sx={{ justifyContent: 'space-between', alignItems: { md: 'center' }, gap: 1.5 }}>
                                <Box sx={{ minWidth: 0 }}>
                                  <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.4 }}>
                                    {sequenceHeadline(campaign, new Date(), (send) => nextSendTimes(send, viewerZone).campaign)}
                                  </Typography>
                                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>{sequenceCounts(stepStats, campaign.enrollmentSummary, skippedBy)}</Typography>
                                </Box>
                                <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
                                  {resumeNote && (
                                    <Button
                                      size="small" variant="outlined" color="inherit"
                                      startIcon={<TimerOff size={12} />}
                                      onClick={(e) => handleKeepPaused(campaign.id, e)}
                                      sx={{ borderColor: 'divider' }}
                                    >
                                      Keep Paused
                                    </Button>
                                  )}
                                  {stopped ? (
                                    <Button
                                      size="small" variant="outlined" color="inherit"
                                      startIcon={<RotateCcw size={12} />}
                                      onClick={(e) => confirmStopOrRestart(campaign, e)}
                                      sx={{ borderColor: 'divider' }}
                                    >
                                      Restart
                                    </Button>
                                  ) : (
                                    <>
                                      <Button
                                        size="small" variant="outlined" color="inherit"
                                        startIcon={campaign.status === 'Active' ? <Pause size={12} color="#d97706" /> : <Play size={12} color="#10b981" />}
                                        onClick={(e) => handleToggleStatus(campaign.id, campaign.status, e)}
                                        sx={{ borderColor: 'divider' }}
                                      >
                                        {campaign.status === 'Active' ? 'Pause' : 'Activate'}
                                      </Button>
                                      {STOPPABLE_STATUSES.includes(campaign.status) && (
                                        <Button
                                          size="small" variant="outlined" color="error"
                                          startIcon={<CircleStop size={12} />}
                                          onClick={(e) => confirmStopOrRestart(campaign, e)}
                                        >
                                          Stop
                                        </Button>
                                      )}
                                    </>
                                  )}
                                  {campaign.status === 'Active' && (
                                    <MuiTooltip title="Queue the leads that are due now. A lead still waiting out a step's wait days stays put.">
                                      <Box component="span">
                                        <Button
                                          size="small" variant="outlined" color="inherit"
                                          startIcon={executingId === campaign.id ? <Loader2 size={12} className="animate-spin" /> : <PlayCircle size={12} />}
                                          onClick={() => handleRunCampaign(campaign.id)}
                                          disabled={executingId !== null}
                                          sx={{ borderColor: 'divider' }}
                                        >
                                          {executingId === campaign.id ? 'Running…' : 'Run Now'}
                                        </Button>
                                      </Box>
                                    </MuiTooltip>
                                  )}
                                </Stack>
                              </Stack>

                              {steps.length === 0 ? (
                                <Typography variant="body2" sx={{ color: 'text.secondary', py: 2 }}>
                                  This campaign has no steps yet. Add them on its Sequence tab.
                                </Typography>
                              ) : (
                                <>
                                  {/* One segment per step: gone out, waiting to go, not reached yet. */}
                                  <div aria-hidden className="grid gap-1 mb-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
                                    {steps.map((step) => {
                                      const state = stepRowState(stepStats.find(s => s.stepOrder === step.stepOrder));
                                      return (
                                        <div
                                          key={step.id}
                                          className={`h-1.5 rounded-full transition-colors ${
                                            state === 'waiting'
                                              ? 'bg-blue-600 dark:bg-blue-500'
                                              : state === 'sent'
                                              ? 'bg-slate-400 dark:bg-slate-500'
                                              : 'bg-slate-200 dark:bg-slate-800'
                                          }`}
                                        />
                                      );
                                    })}
                                  </div>
                                  <Box sx={{ overflowX: 'auto' }}>
                                    <Table size="small" sx={{ '& td, & th': { borderColor: 'divider' }, '& td': { fontVariantNumeric: 'tabular-nums' } }}>
                                      <TableHead>
                                        <TableRow sx={{ '& th': { fontSize: 12, fontWeight: 600, color: 'text.secondary', whiteSpace: 'nowrap' } }}>
                                          <TableCell>Step</TableCell>
                                          <TableCell>State</TableCell>
                                          <TableCell align="right">{stopped ? 'Stopped Here' : 'Waiting'}</TableCell>
                                          <TableCell align="right">Sent</TableCell>
                                          <TableCell align="right">Delivered</TableCell>
                                          <TableCell />
                                        </TableRow>
                                      </TableHead>
                                      <TableBody>
                                        {steps.map((step) => {
                                          const stats = stepStats.find(s => s.stepOrder === step.stepOrder);
                                          const state = stepRowState(stats);
                                          const waitingCount = stats?.active || 0;
                                          const sentCount = stats?.sent || 0;
                                          // The leads the step's sent emails went to, each once: fewer than the
                                          // emails where a lead got the step more than once.
                                          const sentLeads = stats?.leads || 0;
                                          // With no delivery report for any of its emails, Delivered is unknown rather than 0.
                                          // Else it counts only the emails a report arrived for, so the row names them.
                                          const reportedCount = stats?.reported || 0;
                                          const failedCount = stats?.failed || 0;
                                          const send = stats?.nextSend ?? null;
                                          const sendTimes = send ? nextSendTimes(send, viewerZone) : null;
                                          const dueNow = !!send && new Date(send.at).getTime() <= Date.now();
                                          const sendingStep = executingId === `${campaign.id}-${step.stepOrder}`;
                                          const stateIcon = { display: 'flex', alignItems: 'center', gap: 0.75 };
                                          return (
                                            <TableRow
                                              key={step.id}
                                              sx={{
                                                bgcolor: state === 'waiting' ? (t) => alpha(t.palette.primary.main, 0.07) : undefined,
                                                '& td': { color: state === 'upcoming' ? 'text.secondary' : undefined },
                                                '&:last-child td': { borderBottom: 0 },
                                              }}
                                            >
                                              <TableCell sx={{ maxWidth: 340 }}>
                                                <Stack direction="row" spacing={1.5} sx={{ alignItems: 'baseline', minWidth: 0 }}>
                                                  <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 700, flexShrink: 0, minWidth: 16, color: state === 'waiting' ? 'primary.main' : 'text.secondary' }}>{step.stepOrder}</Box>
                                                  <Typography variant="body2" noWrap title={step.subject} sx={{ fontWeight: state === 'waiting' ? 700 : 500 }}>{step.subject || '(No Subject)'}</Typography>
                                                </Stack>
                                              </TableCell>
                                              <TableCell sx={{ whiteSpace: 'nowrap' }}>
                                                {state === 'sent' ? (
                                                  <Box sx={{ ...stateIcon, color: 'text.secondary' }}><Check size={14} /> Sent</Box>
                                                ) : state === 'upcoming' ? (
                                                  stepWaitText(steps, step.stepOrder)
                                                ) : stopped ? (
                                                  <Box sx={stateIcon}><CircleStop size={14} /> Held while stopped</Box>
                                                ) : campaign.status === 'Paused' ? (
                                                  <Box sx={stateIcon}><Pause size={14} /> Held while paused</Box>
                                                ) : campaign.status !== 'Active' ? (
                                                  'Not published'
                                                ) : !sendTimes ? (
                                                  campaign.hasSendingSchedule ? 'Waiting' : 'No sending schedule'
                                                ) : dueNow ? (
                                                  <Box sx={{ ...stateIcon, color: 'primary.main', fontWeight: 700 }}><Send size={14} /> Due now</Box>
                                                ) : (
                                                  <>
                                                    <Box sx={{ ...stateIcon, color: 'primary.main', fontWeight: 700 }}><Clock size={14} /> {sendTimes.campaign}</Box>
                                                    {sendTimes.viewer && <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', pl: '22px' }}>{sendTimes.viewer} your time</Typography>}
                                                  </>
                                                )}
                                              </TableCell>
                                              <TableCell align="right" sx={{ fontWeight: waitingCount > 0 ? 700 : 400, color: waitingCount > 0 ? undefined : 'text.disabled' }}>
                                                {waitingCount.toLocaleString()}
                                              </TableCell>
                                              <TableCell align="right">
                                                <Box component="span" sx={{ color: sentCount > 0 ? undefined : 'text.disabled' }}>{sentCount.toLocaleString()}</Box>
                                                {sentLeads > 0 && sentLeads !== sentCount && (
                                                  <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }} title="Some leads got this step more than once.">to {sentLeads.toLocaleString()} {sentLeads === 1 ? 'lead' : 'leads'}</Typography>
                                                )}
                                                {failedCount > 0 && <Typography variant="caption" sx={{ color: 'error.main', display: 'block' }}>{failedCount.toLocaleString()} failed</Typography>}
                                              </TableCell>
                                              <TableCell align="right">
                                                {sentCount === 0 ? (
                                                  <Box component="span" sx={{ color: 'text.disabled' }}>–</Box>
                                                ) : reportedCount === 0 ? (
                                                  <MuiTooltip title={NO_DELIVERY_REPORTS_NOTE}>
                                                    <Box component="span" tabIndex={0} aria-label="No delivery reports" sx={{ color: 'text.secondary' }}>—</Box>
                                                  </MuiTooltip>
                                                ) : (
                                                  <>
                                                    {(stats?.delivered || 0).toLocaleString()}
                                                    {reportedCount < sentCount && <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }} title={PARTLY_REPORTED_NOTE}>of {reportedCount.toLocaleString()} reported</Typography>}
                                                  </>
                                                )}
                                              </TableCell>
                                              <TableCell align="right" sx={{ width: 120 }}>
                                                {campaign.status === 'Active' && waitingCount > 0 && (
                                                  <MuiTooltip title={`Queue the ${waitingCount.toLocaleString()} ${waitingCount === 1 ? 'lead' : 'leads'} at this step now${dueNow ? '' : ', skipping the rest of the wait'}.`}>
                                                    <Box component="span">
                                                      <Button size="small" variant="outlined" startIcon={sendingStep ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} onClick={(e) => { e.stopPropagation(); setSendStepPrompt({ campaignId: campaign.id, stepOrder: step.stepOrder, message: sendStepConfirmMessage(campaign.name, step.stepOrder, waitingCount, sendTimes && !dueNow ? sendTimes.campaign : null) }); }} disabled={executingId !== null} sx={{ whiteSpace: 'nowrap' }}>
                                                        Send Step
                                                      </Button>
                                                    </Box>
                                                  </MuiTooltip>
                                                )}
                                              </TableCell>
                                            </TableRow>
                                          );
                                        })}
                                      </TableBody>
                                    </Table>
                                  </Box>
                                </>
                              )}
                            </Stack>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
                {filteredCampaigns.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} sx={{ textAlign: 'center', py: 8, color: 'text.secondary' }}>
                      <Inbox size={24} style={{ margin: '0 auto', opacity: 0.5 }} />
                      <Typography variant="caption" sx={{ display: 'block', mt: 1 }}>{search ? 'No campaigns match your search.' : 'No campaigns yet.'}</Typography>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
        )}
      </div>

      {/* Create Campaign Action Drawer */}
      <ActionDrawer
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        title="Create Campaign"
        subtitle="Configure a new cold outbound email sequence"
        icon={Plus}
        width="md"
        onSubmit={handleCreateCampaign}
        primaryLabel={submitting ? 'Creating…' : 'Create Campaign'}
        primaryLoading={submitting}
        primaryDisabled={submitting || !campaignName.trim() || !selectedMailboxId}
        cancelLabel="Cancel"
        onCancel={() => setIsAddOpen(false)}
      >
        <div className="space-y-5">
          {/* Campaign Name */}
          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2">
              Campaign Name <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              placeholder="e.g., Enterprise SaaS Seed Funding Round"
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
            />
          </div>

          {/* Primary Sender Mailbox */}
          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Mail className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
              <span>Connect Sender Mailbox <span className="text-rose-500">*</span></span>
            </label>
            <select
              value={selectedMailboxId}
              onChange={(e) => setSelectedMailboxId(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
            >
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.emailAddress} ({acc.provider})
                </option>
              ))}
            </select>
          </div>

          {/* Rotation Across Additional Mailboxes */}
          {accounts.filter((acc) => acc.id !== selectedMailboxId).length > 0 && (
            <div>
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                <Mail className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                <span>Rotate Across Additional Mailboxes</span>
                <span className="text-[11px] font-normal text-slate-400 capitalize">(optional)</span>
              </label>
              <div className="max-h-40 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 bg-slate-50/50 dark:bg-slate-900/40 space-y-2">
                {accounts
                  .filter((acc) => acc.id !== selectedMailboxId)
                  .map((acc) => {
                    const isChecked = selectedPoolIds.includes(acc.id);
                    return (
                      <label
                        key={acc.id}
                        className={`flex items-center gap-3 p-2 rounded-lg border transition-all cursor-pointer ${
                          isChecked
                            ? 'bg-blue-50/60 dark:bg-blue-950/40 border-blue-200 dark:border-blue-900/50 text-blue-950 dark:text-blue-200'
                            : 'bg-white dark:bg-slate-900 border-slate-200/80 dark:border-slate-800/80 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) =>
                            setSelectedPoolIds((prev) =>
                              e.target.checked
                                ? [...prev, acc.id]
                                : prev.filter((id) => id !== acc.id)
                            )
                          }
                          className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500/20 border-slate-300 dark:border-slate-700"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium truncate">{acc.emailAddress}</p>
                          <p className="text-[10px] text-slate-400 dark:text-slate-500">{acc.provider}</p>
                        </div>
                      </label>
                    );
                  })}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                Sending volume spreads across the primary plus any selected mailboxes (least-loaded first).
              </p>
            </div>
          )}

          {/* Sending Limits Notice */}
          <div className="rounded-2xl bg-blue-50/70 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900/40 p-4 flex items-start gap-3">
            <Gauge className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
            <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed font-medium">
              This campaign follows the sending limits set on its mailboxes.
            </p>
          </div>
        </div>
      </ActionDrawer>

      <ConfirmDialog
        isOpen={!!confirmState}
        title={confirmState?.title || ''}
        message={confirmState?.message || ''}
        confirmLabel={confirmState?.confirmLabel}
        isDestructive={confirmState?.destructive ?? true}
        onConfirm={() => confirmState?.onConfirm()}
        onCancel={() => setConfirmState(null)}
      />

      <ConfirmDialog
        isOpen={!!sendStepPrompt}
        title={sendStepPrompt ? `Send Step ${sendStepPrompt.stepOrder} Now?` : ''}
        message={sendStepPrompt?.message || ''}
        confirmLabel="Send Step"
        onConfirm={() => {
          const prompt = sendStepPrompt;
          setSendStepPrompt(null);
          if (prompt) handleRunCampaign(prompt.campaignId, prompt.stepOrder);
        }}
        onCancel={() => setSendStepPrompt(null)}
      />
    </div>
  );
}

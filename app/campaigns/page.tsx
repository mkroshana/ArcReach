/* eslint-disable react-hooks/set-state-in-effect, react/no-unescaped-entities, react-hooks/exhaustive-deps */
'use client';

import { useState, useEffect, Fragment } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Plus, PlayCircle, Search, Layers, RefreshCw, Loader2,
  Mail, User, ChevronRight, ChevronDown, Gauge, Inbox, Trash2, Play, Pause, Send, Check, Clock, TimerOff, UserX,
  CircleStop, RotateCcw,
} from 'lucide-react';
import {
  Box, Card, CardContent, Stack, Typography, Button, IconButton, Chip, TextField,
  Dialog, DialogTitle, DialogContent, DialogActions, Table, TableHead, TableBody, TableRow, TableCell,
  Snackbar, Alert, AlertTitle, InputAdornment, CircularProgress, Tooltip as MuiTooltip, Select, MenuItem,
  Checkbox, FormControlLabel,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { queuedLeadsMessage } from '@/lib/campaignSteps';
import { sequenceCounts, sequenceHeadline, stepRowState, stepWaitText } from '@/lib/campaignListPanel';
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
  enrollmentSummary?: { total: number; active: number; completed: number; notMailable?: number };
}

const statusColorMap = { Active: 'success', Draft: 'default', Paused: 'warning', Stopped: 'error' } as const;

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
          else showToast('Failed to delete the campaign.', 'error');
        } catch (err) { showToast('Error occurred deleting campaign.', 'error'); }
      },
    });
  };

  const filteredCampaigns = campaigns.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
  // Send times are given in the campaign's time zone and, where it reads differently, in the viewer's.
  const viewerZone = viewerTimeZone();

  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto', pb: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Snackbar open={!!toast} anchorOrigin={{ vertical: 'top', horizontal: 'right' }} autoHideDuration={toast?.duration ?? null} onClose={(_, reason) => { if (reason !== 'clickaway') setToast(null); }}>
        {toast ? <Alert severity={toast.type} variant="filled" onClose={() => setToast(null)} sx={{ borderRadius: '12px' }}>{toast.message}</Alert> : undefined}
      </Snackbar>

      {/* Header */}
      <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', sm: 'center' }, gap: 2, pb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>Campaigns</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>Each campaign, where its leads are in the sequence and when the next step goes out.</Typography>
        </Box>
        <Button
          variant="contained" startIcon={<Plus size={16} />}
          onClick={() => {
            if (!accountsLoaded) { showToast('Your mailboxes could not be loaded, so a campaign cannot be created yet. Use Retry to load them.', 'error'); return; }
            if (accounts.length === 0) { showToast('Please first connect at least one Mailbox of your own in the Senders view before starting a campaign.', 'error'); return; }
            setIsAddOpen(true);
          }}
        >Create Campaign</Button>
      </Stack>

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

      <Card>
        {/* Toolbar */}
        <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', sm: 'center' }, gap: 1.5, p: 2, borderBottom: 1, borderColor: 'divider' }}>
          <TextField
            size="small" sx={{ width: { xs: '100%', sm: 280 } }} placeholder="Search campaigns..."
            value={search} onChange={e => setSearch(e.target.value)}
            slotProps={{ input: { startAdornment: <InputAdornment position="start"><Search size={14} /></InputAdornment> } }}
          />
        </Stack>

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
                  return (
                    <Fragment key={campaign.id}>
                      <TableRow hover onClick={() => setExpandedCampaignId(isExpanded ? null : campaign.id)} sx={{ cursor: 'pointer', bgcolor: isExpanded ? 'action.hover' : undefined }}>
                        <TableCell>
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <Layers size={16} color="#94a3b8" />
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
                          <Chip
                            size="small"
                            icon={campaign.status === 'Active' ? <PlayCircle size={10} /> : stopped ? <CircleStop size={10} /> : undefined}
                            label={campaign.status}
                            color={statusColorMap[campaign.status] as any === 'default' ? undefined : statusColorMap[campaign.status] as any}
                            variant="outlined"
                            sx={{ fontWeight: 700, fontSize: 10 }}
                          />
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
                          <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                            <MuiTooltip title="Delete">
                              <IconButton aria-label="Delete campaign" size="small" onClick={(e) => handleDeleteCampaign(campaign.id, e)} sx={{ color: 'error.main' }}>
                                <Trash2 size={14} />
                              </IconButton>
                            </MuiTooltip>
                            <Button component={Link as any} href={`/campaigns/${campaign.id}`} size="small" variant="text" endIcon={<ChevronRight size={14} />} color="inherit" sx={{ color: 'text.secondary' }}>
                              Configure
                            </Button>
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
                                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>{sequenceCounts(stepStats, campaign.enrollmentSummary)}</Typography>
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
                                  {/* One segment per step: gone out, waiting to go, not reached yet. The rows below say the same in words. */}
                                  <Box aria-hidden sx={{ display: 'grid', gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`, gap: 0.5 }}>
                                    {steps.map((step) => {
                                      const state = stepRowState(stepStats.find(s => s.stepOrder === step.stepOrder));
                                      return <Box key={step.id} sx={{ height: 6, borderRadius: '3px', bgcolor: state === 'waiting' ? 'primary.main' : state === 'sent' ? 'text.secondary' : 'divider' }} />;
                                    })}
                                  </Box>
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
                                                      <Button size="small" variant="outlined" startIcon={sendingStep ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} onClick={(e) => { e.stopPropagation(); handleRunCampaign(campaign.id, step.stepOrder); }} disabled={executingId !== null} sx={{ whiteSpace: 'nowrap' }}>
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
      </Card>

      {/* Create modal */}
      <Dialog open={isAddOpen} onClose={() => setIsAddOpen(false)} maxWidth="sm" fullWidth slotProps={{ paper: { sx: { borderRadius: '20px' } } }}>
        <form onSubmit={handleCreateCampaign}>
          <DialogTitle>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <Plus size={20} color="#2563EB" />
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Create Campaign</Typography>
            </Stack>
          </DialogTitle>
          <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <TextField label="Campaign Name" required value={campaignName} onChange={(e) => setCampaignName(e.target.value)} size="small" placeholder="e.g., Enterprise SaaS Seed Funding Round" />
            <Box>
              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
                <Mail size={14} /> Connect Sender Mailbox
              </Typography>
              <Select size="small" fullWidth value={selectedMailboxId} onChange={(e) => setSelectedMailboxId(e.target.value)}>
                {accounts.map((acc) => (
                  <MenuItem key={acc.id} value={acc.id}>{acc.emailAddress} ({acc.provider})</MenuItem>
                ))}
              </Select>
            </Box>
            {accounts.filter((acc) => acc.id !== selectedMailboxId).length > 0 && (
              <Box>
                <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
                  <Mail size={14} /> Rotate Across Additional Mailboxes (optional)
                </Typography>
                <Box sx={{ maxHeight: 130, overflowY: 'auto', border: 1, borderColor: 'divider', borderRadius: '12px', p: 1, bgcolor: 'action.hover' }}>
                  {accounts.filter((acc) => acc.id !== selectedMailboxId).map((acc) => (
                    <FormControlLabel
                      key={acc.id}
                      sx={{ display: 'flex', m: 0 }}
                      control={
                        <Checkbox size="small" checked={selectedPoolIds.includes(acc.id)} onChange={(e) =>
                          setSelectedPoolIds(prev => e.target.checked ? [...prev, acc.id] : prev.filter(id => id !== acc.id))
                        } />
                      }
                      label={<Typography variant="caption">{acc.emailAddress} ({acc.provider})</Typography>}
                    />
                  ))}
                </Box>
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
                  Sending volume spreads across the primary plus any selected mailboxes (least-loaded first).
                </Typography>
              </Box>
            )}
            <Card sx={{ bgcolor: (t) => alpha(t.palette.primary.main, 0.06), borderColor: (t) => alpha(t.palette.primary.main, 0.2) }}>
              <CardContent sx={{ p: 2, '&:last-child': { pb: 2 }, display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
                <Gauge size={16} color="#2563EB" style={{ marginTop: 2, flexShrink: 0 }} />
                <Typography variant="caption" sx={{ color: 'primary.main', lineHeight: 1.6 }}>
                  This campaign follows the sending limits set on its mailboxes.
                </Typography>
              </CardContent>
            </Card>
          </DialogContent>
          <DialogActions sx={{ p: 2 }}>
            <Button color="inherit" onClick={() => setIsAddOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create Campaign'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      <ConfirmDialog
        isOpen={!!confirmState}
        title={confirmState?.title || ''}
        message={confirmState?.message || ''}
        confirmLabel={confirmState?.confirmLabel}
        isDestructive={confirmState?.destructive ?? true}
        onConfirm={() => confirmState?.onConfirm()}
        onCancel={() => setConfirmState(null)}
      />
    </Box>
  );
}

'use client';

import { useState, useEffect, Fragment } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Plus, PlayCircle, RefreshCw, Loader2, ChevronRight, Gauge, Trash2, Play, Pause, Send, Check, Clock, TimerOff, UserX,
  CircleStop, RotateCcw,
} from 'lucide-react';
import { Snackbar, Alert, Tooltip as MuiTooltip } from '@mui/material';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { inputClasses, SearchInput } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Table, TD, TH, THead, TR } from '@/components/ui/Table';
import { cn } from '@/lib/utils';
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

/** Status tag colours, matching the dashboard's Recent Campaigns. */
const STATUS_TONE: Record<DbCampaign['status'], BadgeTone> = { Active: 'green', Draft: 'neutral', Paused: 'amber', Stopped: 'red' };

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
    <Button size="sm" onClick={() => loadData()}>
      <RefreshCw size={12} />
      Retry
    </Button>
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
    <div className="w-full space-y-4 pb-12">
      <Snackbar open={!!toast} anchorOrigin={{ vertical: 'top', horizontal: 'right' }} autoHideDuration={toast?.duration ?? null} onClose={(_, reason) => { if (reason !== 'clickaway') setToast(null); }}>
        {toast ? <Alert severity={toast.type} variant="filled" onClose={() => setToast(null)} sx={{ borderRadius: '12px', maxWidth: 520 }}>{toast.message}</Alert> : undefined}
      </Snackbar>

      <PageHeader
        title="Campaigns"
        actions={
          <Button
            variant="primary"
            onClick={() => {
              if (!accountsLoaded) { showToast('Your mailboxes could not be loaded, so a campaign cannot be created yet. Use Retry to load them.', 'error'); return; }
              if (accounts.length === 0) { showToast('Please first connect at least one Mailbox of your own in the Senders view before starting a campaign.', 'error'); return; }
              setIsAddOpen(true);
            }}
          >
            <Plus size={14} />
            Create Campaign
          </Button>
        }
      />

      {loadError && campaignsLoaded && !loading && (
        <Notice tone="warning" title="Campaigns Could Not Be Refreshed" action={retryButton}>
          This list may be out of date. {loadError}
        </Notice>
      )}

      {accountsError && !accountsLoaded && !loading && (
        <Notice tone="warning" title="Mailboxes Could Not Be Loaded" action={retryButton}>
          A campaign cannot be created until your mailboxes load. {accountsError}
        </Notice>
      )}

      <Card className="overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-card-border px-4 py-3">
          <SearchInput
            aria-label="Search campaigns"
            placeholder="Search campaigns"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full sm:w-64"
          />
          <span className="text-xs text-text-muted tabular-nums">
            {filteredCampaigns.length} {filteredCampaigns.length === 1 ? 'campaign' : 'campaigns'}
          </span>
        </div>

        {loading ? (
          <div className="flex flex-col items-center gap-2 py-16 text-xs text-text-muted">
            <Loader2 size={18} className="animate-spin" />
            Loading campaigns…
          </div>
        ) : !campaignsLoaded ? (
          <div className="p-4">
            <Notice tone="error" title="Campaigns Could Not Be Loaded" action={retryButton}>
              {loadError || 'Campaigns could not be loaded.'}
            </Notice>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <tr>
                  <TH>Campaign</TH>
                  <TH>Sender Mailbox</TH>
                  <TH>Owner</TH>
                  <TH>Status</TH>
                  <TH className="text-right"><span className="sr-only">Actions</span></TH>
                </tr>
              </THead>
              <tbody>
                {filteredCampaigns.map(campaign => {
                  const isExpanded = expandedCampaignId === campaign.id;
                  const toggleExpanded = () => setExpandedCampaignId(isExpanded ? null : campaign.id);
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
                      <TR onClick={toggleExpanded} className={cn('cursor-pointer', isExpanded && 'border-b-0 bg-slate-50/70 dark:bg-white/[0.02]')}>
                        <TD>
                          <button
                            type="button"
                            aria-expanded={isExpanded}
                            onClick={(e) => { e.stopPropagation(); toggleExpanded(); }}
                            className="flex cursor-pointer items-center gap-1.5 text-left font-medium text-text-main"
                          >
                            <ChevronRight size={14} className={cn('shrink-0 text-text-muted transition-transform', isExpanded && 'rotate-90')} />
                            {campaign.name}
                          </button>
                          <div className="mt-0.5 pl-5 text-xs text-text-muted">
                            Created {createdDate.format(new Date(campaign.createdAt))}
                          </div>
                        </TD>
                        <TD className="text-text-sub">{campaign.senderAccount?.emailAddress || 'N/A'}</TD>
                        <TD className="text-text-sub">
                          {campaign.userId === session?.id ? `Me (${session?.name})` : (campaign.user?.name || campaign.user?.email || 'Company Admin')}
                        </TD>
                        <TD>
                          <Badge tone={STATUS_TONE[campaign.status]} dot>{campaign.status}</Badge>
                          {resumeNote && (
                            <div className="mt-1 flex items-center gap-1 text-xs text-text-muted">
                              <Clock size={11} className="shrink-0" /> {resumeNote}
                            </div>
                          )}
                          {ownerNote && (
                            <div className="mt-1 flex items-center gap-1 text-xs text-text-muted">
                              <UserX size={11} className="shrink-0" /> {ownerNote}
                            </div>
                          )}
                          {stopNote && <div className="mt-1 text-xs text-text-muted">{stopNote}</div>}
                        </TD>
                        <TD className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <MuiTooltip title="Delete">
                              <Button
                                variant="ghost" size="sm" iconOnly aria-label="Delete campaign"
                                onClick={(e) => handleDeleteCampaign(campaign.id, e)}
                                className="text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:text-rose-400 dark:hover:bg-rose-500/10"
                              >
                                <Trash2 size={14} />
                              </Button>
                            </MuiTooltip>
                            <Link href={`/campaigns/${campaign.id}`} className={buttonClasses({ size: 'sm' })}>
                              Configure
                            </Link>
                          </div>
                        </TD>
                      </TR>
                      {isExpanded && (
                        <tr className="border-b border-card-border bg-slate-50/70 dark:bg-white/[0.02]">
                          <td colSpan={5} className="px-4 pt-1 pb-4">
                            <div className="space-y-3">
                              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                                <div className="min-w-0">
                                  <div className="text-sm font-semibold text-text-main">
                                    {sequenceHeadline(campaign, new Date(), (send) => nextSendTimes(send, viewerZone).campaign)}
                                  </div>
                                  <div className="mt-0.5 text-xs text-text-sub">{sequenceCounts(stepStats, campaign.enrollmentSummary, skippedBy)}</div>
                                </div>
                                <div className="flex shrink-0 flex-wrap gap-2">
                                  {resumeNote && (
                                    <Button size="sm" onClick={(e) => handleKeepPaused(campaign.id, e)}>
                                      <TimerOff size={12} /> Keep Paused
                                    </Button>
                                  )}
                                  {stopped ? (
                                    <Button size="sm" onClick={(e) => confirmStopOrRestart(campaign, e)}>
                                      <RotateCcw size={12} /> Restart
                                    </Button>
                                  ) : (
                                    <>
                                      <Button size="sm" onClick={(e) => handleToggleStatus(campaign.id, campaign.status, e)}>
                                        {campaign.status === 'Active'
                                          ? <Pause size={12} className="text-amber-600 dark:text-amber-400" />
                                          : <Play size={12} className="text-emerald-600 dark:text-emerald-400" />}
                                        {campaign.status === 'Active' ? 'Pause' : 'Activate'}
                                      </Button>
                                      {STOPPABLE_STATUSES.includes(campaign.status) && (
                                        <Button variant="danger" size="sm" onClick={(e) => confirmStopOrRestart(campaign, e)}>
                                          <CircleStop size={12} /> Stop
                                        </Button>
                                      )}
                                    </>
                                  )}
                                  {campaign.status === 'Active' && (
                                    <MuiTooltip title="Queue the leads that are due now. A lead still waiting out a step's wait days stays put.">
                                      <span>
                                        <Button size="sm" onClick={() => handleRunCampaign(campaign.id)} disabled={executingId !== null}>
                                          {executingId === campaign.id ? <Loader2 size={12} className="animate-spin" /> : <PlayCircle size={12} />}
                                          {executingId === campaign.id ? 'Running…' : 'Run Now'}
                                        </Button>
                                      </span>
                                    </MuiTooltip>
                                  )}
                                </div>
                              </div>

                              {steps.length === 0 ? (
                                <p className="py-2 text-[13px] text-text-sub">
                                  This campaign has no steps yet. Add them on its Sequence tab.
                                </p>
                              ) : (
                                <>
                                  {/* One segment per step: gone out, waiting to go, not reached yet. */}
                                  <div aria-hidden className="grid gap-1" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
                                    {steps.map((step) => {
                                      const state = stepRowState(stepStats.find(s => s.stepOrder === step.stepOrder));
                                      return (
                                        <div
                                          key={step.id}
                                          className={cn(
                                            'h-1.5 rounded-full transition-colors',
                                            state === 'waiting' ? 'bg-primary' : state === 'sent' ? 'bg-slate-400 dark:bg-slate-500' : 'bg-slate-200 dark:bg-white/10',
                                          )}
                                        />
                                      );
                                    })}
                                  </div>
                                  <Card className="overflow-x-auto">
                                    <Table className="tabular-nums">
                                      <THead>
                                        <tr>
                                          <TH>Step</TH>
                                          <TH>State</TH>
                                          <TH className="text-right">{stopped ? 'Stopped Here' : 'Waiting'}</TH>
                                          <TH className="text-right">Sent</TH>
                                          <TH className="text-right">Delivered</TH>
                                          <TH><span className="sr-only">Send</span></TH>
                                        </tr>
                                      </THead>
                                      <tbody>
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
                                          const cell = cn('py-2.5', state === 'upcoming' && 'text-text-sub');
                                          return (
                                            <TR key={step.id} className={cn(state === 'waiting' && 'bg-primary-subtle hover:bg-primary-subtle')}>
                                              <TD className={cn(cell, 'max-w-[340px]')}>
                                                <div className="flex min-w-0 items-baseline gap-3">
                                                  <span className={cn('min-w-4 shrink-0 font-semibold', state === 'waiting' ? 'text-primary' : 'text-text-muted')}>{step.stepOrder}</span>
                                                  <span title={step.subject} className={cn('truncate', state === 'waiting' && 'font-semibold')}>{step.subject || '(No Subject)'}</span>
                                                </div>
                                              </TD>
                                              <TD className={cn(cell, 'whitespace-nowrap')}>
                                                {state === 'sent' ? (
                                                  <span className="inline-flex items-center gap-1.5 text-text-sub"><Check size={14} /> Sent</span>
                                                ) : state === 'upcoming' ? (
                                                  stepWaitText(steps, step.stepOrder)
                                                ) : stopped ? (
                                                  <span className="inline-flex items-center gap-1.5"><CircleStop size={14} /> Held while stopped</span>
                                                ) : campaign.status === 'Paused' ? (
                                                  <span className="inline-flex items-center gap-1.5"><Pause size={14} /> Held while paused</span>
                                                ) : campaign.status !== 'Active' ? (
                                                  'Not published'
                                                ) : !sendTimes ? (
                                                  campaign.hasSendingSchedule ? 'Waiting' : 'No sending schedule'
                                                ) : dueNow ? (
                                                  <span className="inline-flex items-center gap-1.5 font-semibold text-primary"><Send size={14} /> Due now</span>
                                                ) : (
                                                  <>
                                                    <span className="inline-flex items-center gap-1.5 font-semibold text-primary"><Clock size={14} /> {sendTimes.campaign}</span>
                                                    {sendTimes.viewer && <span className="block pl-5 text-xs text-text-muted">{sendTimes.viewer} your time</span>}
                                                  </>
                                                )}
                                              </TD>
                                              <TD className={cn(cell, 'text-right', waitingCount > 0 ? 'font-semibold' : 'text-text-muted')}>
                                                {waitingCount.toLocaleString()}
                                              </TD>
                                              <TD className={cn(cell, 'text-right')}>
                                                <span className={sentCount > 0 ? undefined : 'text-text-muted'}>{sentCount.toLocaleString()}</span>
                                                {sentLeads > 0 && sentLeads !== sentCount && (
                                                  <span className="block text-xs text-text-muted" title="Some leads got this step more than once.">to {sentLeads.toLocaleString()} {sentLeads === 1 ? 'lead' : 'leads'}</span>
                                                )}
                                                {failedCount > 0 && <span className="block text-xs text-rose-600 dark:text-rose-400">{failedCount.toLocaleString()} failed</span>}
                                              </TD>
                                              <TD className={cn(cell, 'text-right')}>
                                                {sentCount === 0 ? (
                                                  <span className="text-text-muted">–</span>
                                                ) : reportedCount === 0 ? (
                                                  <MuiTooltip title={NO_DELIVERY_REPORTS_NOTE}>
                                                    <span tabIndex={0} aria-label="No delivery reports" className="text-text-sub">—</span>
                                                  </MuiTooltip>
                                                ) : (
                                                  <>
                                                    {(stats?.delivered || 0).toLocaleString()}
                                                    {reportedCount < sentCount && <span className="block text-xs text-text-muted" title={PARTLY_REPORTED_NOTE}>of {reportedCount.toLocaleString()} reported</span>}
                                                  </>
                                                )}
                                              </TD>
                                              <TD className={cn(cell, 'w-[120px] text-right')}>
                                                {campaign.status === 'Active' && waitingCount > 0 && (
                                                  <MuiTooltip title={`Queue the ${waitingCount.toLocaleString()} ${waitingCount === 1 ? 'lead' : 'leads'} at this step now${dueNow ? '' : ', skipping the rest of the wait'}.`}>
                                                    <span>
                                                      <Button size="sm" onClick={(e) => { e.stopPropagation(); setSendStepPrompt({ campaignId: campaign.id, stepOrder: step.stepOrder, message: sendStepConfirmMessage(campaign.name, step.stepOrder, waitingCount, sendTimes && !dueNow ? sendTimes.campaign : null) }); }} disabled={executingId !== null}>
                                                        {sendingStep ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                                                        Send Step
                                                      </Button>
                                                    </span>
                                                  </MuiTooltip>
                                                )}
                                              </TD>
                                            </TR>
                                          );
                                        })}
                                      </tbody>
                                    </Table>
                                  </Card>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {filteredCampaigns.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-16 text-center text-xs text-text-muted">
                      <Send size={20} className="mx-auto mb-2 opacity-60" />
                      {search ? 'No campaigns match your search.' : 'No campaigns yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </div>
        )}
      </Card>

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
          <div>
            <label htmlFor="campaign-name" className="mb-1.5 block text-[13px] font-medium text-text-main">
              Campaign Name <span className="text-rose-500">*</span>
            </label>
            <input
              id="campaign-name"
              type="text"
              required
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              placeholder="e.g., Enterprise SaaS Seed Funding Round"
              className={inputClasses('h-9')}
            />
          </div>

          <div>
            <label htmlFor="campaign-sender" className="mb-1.5 block text-[13px] font-medium text-text-main">
              Connect Sender Mailbox <span className="text-rose-500">*</span>
            </label>
            <select
              id="campaign-sender"
              value={selectedMailboxId}
              onChange={(e) => setSelectedMailboxId(e.target.value)}
              className={inputClasses('h-9')}
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
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-medium text-text-main">
                Rotate Across Additional Mailboxes <span className="font-normal text-text-muted">(optional)</span>
              </legend>
              <div className="max-h-40 divide-y divide-card-border overflow-y-auto rounded-control border border-card-border">
                {accounts
                  .filter((acc) => acc.id !== selectedMailboxId)
                  .map((acc) => {
                    const isChecked = selectedPoolIds.includes(acc.id);
                    return (
                      <label
                        key={acc.id}
                        className={cn(
                          'flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors',
                          isChecked ? 'bg-primary-subtle' : 'hover:bg-slate-50 dark:hover:bg-white/[0.03]',
                        )}
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
                          className="size-4 shrink-0 accent-blue-600"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] text-text-main">{acc.emailAddress}</p>
                          <p className="text-[11px] text-text-muted">{acc.provider}</p>
                        </div>
                      </label>
                    );
                  })}
              </div>
              <p className="mt-1.5 text-xs text-text-muted">
                Sending volume spreads across the primary plus any selected mailboxes (least-loaded first).
              </p>
            </fieldset>
          )}

          {/* Sending Limits Notice */}
          <div className="flex items-start gap-2.5 rounded-control bg-primary-subtle px-3 py-2.5">
            <Gauge size={14} className="mt-0.5 shrink-0 text-primary" />
            <p className="text-xs text-text-sub">
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

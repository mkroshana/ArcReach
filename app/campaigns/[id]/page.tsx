/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import {
  ArrowLeft, Save, Send, Plus, Trash2, Eye, PenLine, Play, Loader2, AlertTriangle, TimerOff, Lock, RefreshCw, UserX,
  CircleStop, RotateCcw, Split, Clock,
} from 'lucide-react';
import Link from 'next/link';
import { use, useState, useEffect, useRef } from 'react';
import { useTimezones } from '@/hooks/use-timezones';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import VariableToolbar from '@/components/VariableToolbar';
import CampaignAnalytics, { StepStatStrip, analyticsCaveats } from '@/components/CampaignAnalytics';
import CampaignTiming from '@/components/CampaignTiming';
import CampaignLeadExport from '@/components/CampaignLeadExport';
import { RecipientDomainsInput } from '@/components/RecipientDomainsInput';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { inputClasses } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { Segmented } from '@/components/ui/Segmented';
import { Switch } from '@/components/ui/Switch';
import { cn } from '@/lib/utils';
import { activationBlocker, findIncompleteSteps, queuedLeadsMessage, sequenceDurationDays } from '@/lib/campaignSteps';
import { autoResumeNote, noScheduleOutcome, ownerDisabledNote, savedScheduleNote } from '@/lib/campaignPause';
import { STOPPABLE_STATUSES, STOPPED_STATUS, restartConfirmMessage, stopConfirmMessage, stoppedNote } from '@/lib/campaignStop';
import { sameCampaignVersion } from '@/lib/campaignVersion';
import { hasSendingSchedule, sendScheduleError, timezoneError } from '@/lib/sendSchedule';
import { isHtmlTemplate, personalizePreview, previewEmailBody } from '@/lib/personalize';
import { mailboxReplySync, mailboxReplySyncLabel, otherReplyTo, stopOnReplyWarning } from '@/lib/imapSyncStatus';
import { loadErrorMessage, readJsonList, responseErrorMessage } from '@/lib/apiResponse';
import { effectiveRecipientDomains, routingSummary, storedRecipientDomains, unroutedPoolError } from '@/lib/senderRouting';
import { skippedByText, skippedLeadsNote } from '@/lib/campaignProgress';

import { Autocomplete, TextField } from '@mui/material';

const TAB_OPTIONS = ['Analytics', 'Sequence', 'Audience', 'Schedule', 'Options', 'Senders'].map(tab => ({ value: tab, label: tab }));

/** The status menu in the header wears the status tag's colours. */
const STATUS_SELECT: Record<string, string> = {
  Active: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  Paused: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  Draft: 'bg-slate-100 text-slate-600 dark:bg-white/5 dark:text-slate-300',
};

/** A form field's label. */
const LABEL = 'mb-1.5 block text-[13px] font-medium text-text-main';

export default function CampaignDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const campaignId = resolvedParams.id;
  const timezoneOptions = useTimezones();
  const { toast: showToast } = useToast();

  const [campaign, setCampaign] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  // Why the campaign could not be loaded; with no campaign the page shows it instead of an empty form.
  const [loadError, setLoadError] = useState('');
  // Why the templates, lead groups or mailboxes lists could not be loaded, by list ('' once loaded).
  const [listErrors, setListErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('Sequence');
  // Set once the first load has picked the opening tab, so a reload after a save keeps the current one.
  const openingTabChosen = useRef(false);
  const [templates, setTemplates] = useState<any[]>([]);
  const [previewSteps, setPreviewSteps] = useState<Record<string, boolean>>({});
  // A step shows its preview unless its key is false (edit mode), so a toggle flips it to or from false.
  const toggleStepPreview = (id: string | number) => setPreviewSteps(prev => ({ ...prev, [id]: prev[id] === false }));

  const [campaignName, setCampaignName] = useState('');
  const [status, setStatus] = useState('Draft');
  const [audienceCohort, setAudienceCohort] = useState('Valid');
  // IDs of the campaigns whose emailed leads this one skips (lib/campaignSkip).
  const [skipCampaignIds, setSkipCampaignIds] = useState<string[]>([]);
  // The campaigns the viewer may see, for that picker.
  const [allCampaigns, setAllCampaigns] = useState<any[]>([]);
  const [runningCampaign, setRunningCampaign] = useState(false);
  const [keepingPaused, setKeepingPaused] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  // The Stop or Restart confirmation on screen, if any.
  const [confirmAction, setConfirmAction] = useState<'stop' | 'restart' | null>(null);
  // The updatedAt of the campaign the form was loaded from. Saves send it, and the
  // server refuses one once the campaign has changed since (showChangedPrompt).
  const [editorVersion, setEditorVersion] = useState<string | null>(null);
  const [showChangedPrompt, setShowChangedPrompt] = useState(false);
  const [timezone, setTimezone] = useState('America/New_York');
  const [stopOnReply, setStopOnReply] = useState(true);
  const [trackOpens, setTrackOpens] = useState(true);
  const [trackClicks, setTrackClicks] = useState(true);
  const [steps, setSteps] = useState<any[]>([]);
  const [showStepErrors, setShowStepErrors] = useState(false);
  const [groups, setGroups] = useState<any[]>([]);
  const [availableMailboxes, setAvailableMailboxes] = useState<any[]>([]);
  const [primarySenderId, setPrimarySenderId] = useState<string>('');
  const [selectedPoolIds, setSelectedPoolIds] = useState<string[]>([]);
  // The campaign's Recipient Domains for each pool mailbox, by mailbox ID (lib/senderRouting).
  const [poolDomains, setPoolDomains] = useState<Record<string, string[]>>({});
  const [selectedDays, setSelectedDays] = useState<string[]>([]);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');

  // A list that fails to load is named in a warning, so its empty picker is not taken for none.
  // (The error is recorded after the try: a state update in the catch stops the React Compiler lint rules checking this page.)
  const loadList = async (key: string, url: string, what: string, set: (rows: any[]) => void) => {
    let error = '';
    try { set(await readJsonList(await fetch(url), what)); }
    catch (e) { console.error(e); error = loadErrorMessage(e, what); }
    setListErrors(prev => ({ ...prev, [key]: error }));
  };
  const loadTemplates = () => loadList('templates', '/api/templates', 'Templates', setTemplates);
  const loadGroups = () => loadList('groups', '/api/leads/groups', 'Lead groups', setGroups);
  const loadMailboxes = () => loadList('mailboxes', '/api/accounts', 'Mailboxes', setAvailableMailboxes);
  const loadAllCampaigns = () => loadList('campaigns', '/api/campaigns', 'Campaigns', setAllCampaigns);
  const listLoaders: Record<string, () => Promise<void>> = { templates: loadTemplates, groups: loadGroups, mailboxes: loadMailboxes, campaigns: loadAllCampaigns };
  const failedListMessages = Object.values(listErrors).filter(Boolean);

  const applyTemplate = (templateId: string) => {
    if (!templateId) return;
    const selected = templates.find(t => t.id === templateId);
    if (!selected) return;
    let parsedSteps: any[] = [];
    if (selected.steps) {
      try { parsedSteps = typeof selected.steps === 'string' ? JSON.parse(selected.steps) : selected.steps; } catch (e) { console.error(e); }
    }
    if (parsedSteps && parsedSteps.length > 0) {
      setSteps(parsedSteps.map((step, idx) => ({ id: `temp-${Date.now()}-${idx}`, waitDays: idx === 0 ? 0 : (step.waitDays || 3), subject: step.subject || '', body: step.body || '' })));
    } else {
      setSteps([{ id: `temp-${Date.now()}`, waitDays: 0, subject: selected.subject || '', body: selected.body || '' }]);
    }
    showToast(`Applied template: ${selected.name}`);
  };

  const loadCampaign = async () => {
    try {
      setLoading(true);
      setLoadError('');
      const res = await fetch(`/api/campaigns/${campaignId}?t=${Date.now()}`);
      if (res.ok) {
        const data = await res.json();
        setCampaign(data);
        if (!openingTabChosen.current) {
          openingTabChosen.current = true;
          // Analytics once the campaign has tried to send anything, the Sequence editor before.
          setActiveTab((data.telemetry?.sentRequests ?? 0) > 0 ? 'Analytics' : 'Sequence');
        }
        setEditorVersion(data.updatedAt ?? null);
        setCampaignName(data.name || '');
        setStatus(data.status || 'Draft');
        setTimezone(data.timezone || 'UTC');
        setAudienceCohort(data.audienceCohort || 'Valid');
        setSkipCampaignIds(Array.isArray(data.skipLeadsEmailedBy) ? data.skipLeadsEmailedBy : []);
        setStopOnReply(data.stopOnReply !== false);
        setTrackOpens(data.trackOpens !== false);
        setTrackClicks(data.trackClicks !== false);
        setSteps(data.steps || []);
        setPrimarySenderId(data.senderAccountId || '');
        setSelectedPoolIds(data.senders ? data.senders.map((s: any) => s.senderAccountId) : []);
        setPoolDomains(Object.fromEntries((data.senders ?? []).map((s: any) => [s.senderAccountId, storedRecipientDomains(s.recipientDomains)])));
        // The form shows the schedule as saved, even when empty, never unsaved defaults.
        let sched: any = data.sendSchedule;
        if (typeof sched === 'string') {
          try { sched = JSON.parse(sched); } catch (e) { console.error(e); sched = undefined; }
        }
        setSelectedDays(Array.isArray(sched?.days) ? sched.days : []);
        setStartTime(typeof sched?.window?.start === 'string' ? sched.window.start : '');
        setEndTime(typeof sched?.window?.end === 'string' ? sched.window.end : '');
      } else {
        const message = await responseErrorMessage(res, `The campaign could not be loaded (the server answered ${res.status}).`);
        setLoadError(message);
        // Before the first load the page shows the error itself; after it, the form stays and a toast says so.
        if (campaign) showToast(message, 'error');
      }
    } catch (err) {
      console.error(err);
      const message = loadErrorMessage(err, 'The campaign');
      setLoadError(message);
      if (campaign) showToast(message, 'error');
    }
    finally { setLoading(false); }
  };

  const refreshCampaignTelemetry = async () => {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}?t=${Date.now()}`);
      if (res.ok) {
        const data = await res.json();
        setCampaign(data);
        if (data.status !== status) setStatus(data.status);
      }
    } catch (err) { console.error(err); }
  };

  useEffect(() => {
    if (!campaign) return;
    if (status !== 'Active' && !runningCampaign) return;
    const interval = setInterval(() => { if (document.visibilityState === 'visible') refreshCampaignTelemetry(); }, 30000);
    return () => clearInterval(interval);
  }, [campaignId, status, runningCampaign, !!campaign]);

  useEffect(() => { loadCampaign(); loadTemplates(); loadGroups(); loadMailboxes(); loadAllCampaigns(); }, [campaignId]);

  // Step 1 is sent on enrollment, so it has no wait; follow-ups start at 3 days.
  const addStep = () => setSteps([...steps, { id: `temp-${Date.now()}`, waitDays: steps.length === 0 ? 0 : 3, subject: '', body: '' }]);
  const removeStep = (i: number) => { if (steps.length > 1) setSteps(steps.filter((_, idx) => idx !== i)); };
  const updateStepField = (i: number, field: string, value: any) => setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, [field]: value } : s));
  const insertVariable = (variable: string, i: number) => updateStepField(i, 'body', (steps[i]?.body || '') + variable);
  const toggleDaySelection = (day: string) => setSelectedDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]);

  // Pausing on reply needs a reply read from the pool's mailboxes (or their Reply-To mailbox) over IMAP.
  const poolMailboxes = availableMailboxes.filter(m => m.id === primarySenderId || selectedPoolIds.includes(m.id));
  const replySyncWarning = stopOnReplyWarning(stopOnReply, poolMailboxes, availableMailboxes);
  // A campaign only sends from its owner's mailboxes, so the Senders tab lists only
  // those, also for an admin. Pool entries another user owns (saved before senders
  // were checked) are never sent from and not listed, so a save drops them.
  const ownerMailboxes = availableMailboxes.filter(m => m.userId === campaign?.userId);
  const foreignMailboxIds = new Set(availableMailboxes.filter(m => m.userId !== campaign?.userId).map(m => m.id));
  const poolIds = selectedPoolIds.filter(id => !foreignMailboxIds.has(id));
  // The pool a save stores: the primary sender is always one of its mailboxes.
  const savedPoolIds = Array.from(new Set([primarySenderId, ...poolIds])).filter(Boolean);
  // The leads each pool mailbox sends to (lib/senderRouting): a mailbox's own
  // Recipient Domains, set on the Accounts page, go before the campaign's for it.
  const routedMailboxes = ownerMailboxes.filter(m => savedPoolIds.includes(m.id));
  const senderRoutes = new Map<string, string[]>(routedMailboxes.map(m => [m.id, effectiveRecipientDomains(m.recipientDomains, poolDomains[m.id])]));
  const routingError = unroutedPoolError(routedMailboxes, senderRoutes);
  const routingNote = routingSummary(routedMailboxes, senderRoutes);
  // Leads the send engine is holding back because no mailbox may send to them (lib/sendEngine), as last loaded.
  const waitingRefused: number = campaign?.telemetry?.progress?.waitingForSender?.refused ?? 0;
  const waitingUnrouted: number = campaign?.telemetry?.progress?.waitingForSender?.unrouted ?? 0;
  const leadsAre = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'lead is' : 'leads are'}`;

  // Skip Leads Emailed By (lib/campaignSkip): the other campaigns the viewer may
  // see, by ID. One the campaign already names stays pickable by its saved name
  // when the viewer's list does not have it.
  const savedSkipIds: string[] = Array.isArray(campaign?.skipLeadsEmailedBy) ? campaign.skipLeadsEmailedBy : [];
  const savedSkipSources: any[] = campaign?.telemetry?.progress?.skipped?.campaigns ?? [];
  const skipCampaignName = (id: string): string | null =>
    allCampaigns.find(c => c.id === id)?.name ?? savedSkipSources.find(s => s.id === id)?.name ?? null;
  const skipOptionIds = Array.from(new Set([...allCampaigns.filter(c => c.id !== campaignId).map(c => c.id), ...skipCampaignIds]));
  // How many leads are skipped for the saved list, and what a save of a changed one does.
  const skipNote = skippedLeadsNote(campaign?.telemetry?.progress?.skipped, campaign?.telemetry?.progress?.enrolled ?? 0);
  const skipListChanged = savedSkipIds.length !== skipCampaignIds.length || savedSkipIds.some(id => !skipCampaignIds.includes(id));
  const removedSkipIds = savedSkipIds.filter(id => !skipCampaignIds.includes(id));
  const skipChangeNote = !skipListChanged ? null
    : removedSkipIds.length > 0
      ? `Not saved yet. Saving puts the leads skipped only for ${skippedByText(removedSkipIds.map(skipCampaignName), Infinity)} back in the sequence where they were${status === 'Active' ? ', and those already due go out next' : ''}.`
      : 'Not saved yet. Save to mark the leads these campaigns have emailed as Skipped.';

  // Save writes the form only, never the status, so a status this page shows from
  // before a pause elsewhere can't reactivate the campaign. Publish Sequence saves
  // the form and makes the campaign Active. Both name the version the form was
  // loaded from, and the server refuses them once the campaign has changed since.
  const handleSaveCampaign = async (publish = false) => {
    // Drafts may be saved incomplete; an Active campaign mails every step as written.
    if (publish || status === 'Active') {
      const blocker = activationBlocker(steps);
      if (blocker) {
        const incompleteKeys = findIncompleteSteps(steps).map(s => steps[s.stepNumber - 1].id || s.stepNumber - 1);
        setShowStepErrors(true);
        setActiveTab('Sequence');
        setPreviewSteps(prev => ({ ...prev, ...Object.fromEntries(incompleteKeys.map(key => [key, false])) }));
        showToast(blocker, 'error');
        return;
      }
    }
    // The send engine never sends on an incomplete window, so only a complete one is saved.
    // A Save that isn't publishing may leave the schedule entirely empty (no days, no
    // times) unless the campaign is Active: it saves none, and the campaign sends
    // nothing and can't be published until one is set.
    const schedule = { days: selectedDays, window: { start: startTime, end: endTime } };
    const clearSchedule = !publish && status !== 'Active' && selectedDays.length === 0 && !startTime && !endTime;
    const windowError = timezoneError(timezone) ?? (clearSchedule ? null : sendScheduleError(schedule));
    if (windowError) {
      setActiveTab('Schedule');
      showToast(windowError, 'error');
      return;
    }
    // Leads at a domain no mailbox sends to would never go out, so such a pool is not saved.
    if (routingError) {
      setActiveTab('Senders');
      showToast(routingError, 'error');
      return;
    }
    try {
      setSaving(true);
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: campaignName, timezone,
          sendSchedule: clearSchedule ? null : schedule,
          stopOnReply, trackOpens, trackClicks, audienceCohort, steps,
          skipLeadsEmailedBy: skipCampaignIds,
          senderAccountId: primarySenderId, senderAccountIds: savedPoolIds,
          senderRecipientDomains: Object.fromEntries(savedPoolIds.map(id => [id, poolDomains[id] ?? []])),
          updatedAt: editorVersion,
          ...(publish ? { status: 'Active' } : {}),
        }),
      });
      if (res.ok) {
        if (clearSchedule) {
          // The send engine's auto-resume sets a campaign without a window to Draft instead of Active.
          const outcome = noScheduleOutcome({ status, pausedUntil: campaign?.pausedUntil }, 'you set one on the Schedule tab');
          showToast(`Saved without a sending window, so this campaign sends nothing and ${outcome}.`, 'warning');
        } else {
          showToast('Outbound sequence configuration successfully saved!');
        }
        await loadCampaign();
      } else {
        const data = await res.json().catch(() => null);
        if (res.status === 409 && data?.stale) setShowChangedPrompt(true);
        else {
          showToast(data?.error || 'Failed to update campaign configuration.', 'error');
          // Saved, but enrolling its audience did not finish: the form takes the
          // saved version, so the next Save runs the enrollment sync again.
          if (data?.saved) await loadCampaign();
        }
      }
    } catch (err) { console.error(err); showToast('Error occurred saving sequence configuration.', 'error'); }
    finally { setSaving(false); }
  };

  // Status changes go through the status route and never save the form, so
  // unsaved edits stay as they are (and Active sends the saved steps). The form
  // takes on the new version only when this change was the only one since it
  // loaded, so Save still refuses to overwrite a change made elsewhere.
  const changeStatus = async (nextStatus: string): Promise<{ ok: boolean; error?: string }> => {
    const res = await fetch('/api/campaigns', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: campaignId, status: nextStatus }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return { ok: false, error: data?.error };
    setCampaign((prev: any) => ({ ...prev, status: data.status, pausedUntil: data.pausedUntil, pauseReason: data.pauseReason, stoppedAt: data.stoppedAt }));
    setStatus(data.status);
    setEditorVersion(prev => (sameCampaignVersion(prev, data.previousUpdatedAt) ? data.updatedAt : prev));
    return { ok: true };
  };

  const handleStatusChange = async (nextStatus: string) => {
    if (nextStatus === status) return;
    try {
      setChangingStatus(true);
      const result = await changeStatus(nextStatus);
      if (result.ok) showToast(`Campaign status set to ${nextStatus}.`);
      else showToast(result.error || 'Failed to change the campaign status.', 'error');
    } catch (err) { console.error(err); showToast('Error changing the campaign status.', 'error'); }
    finally { setChangingStatus(false); }
  };

  const handleRunCampaign = async () => {
    try {
      setRunningCampaign(true);
      const res = await fetch(`/api/campaigns/${campaignId}/run`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      // The route only queues leads; the background worker sends them.
      if (res.ok && typeof data?.queued === 'number') { showToast(queuedLeadsMessage(data.queued)); await loadCampaign(); }
      else showToast(data?.error || 'Failed to queue leads.', 'error');
    } catch (err) { console.error(err); showToast('Failed to queue leads.', 'error'); }
    finally { setRunningCampaign(false); }
  };

  // Stop and Restart go through the status route like the status menu, so
  // unsaved edits stay in the form (a stopped campaign can't save them).
  const handleStopOrRestart = async (action: 'stop' | 'restart') => {
    setConfirmAction(null);
    try {
      setChangingStatus(true);
      const result = await changeStatus(action === 'stop' ? STOPPED_STATUS : 'Active');
      if (result.ok) {
        showToast(action === 'stop'
          ? 'Campaign stopped. It sends nothing until you restart it.'
          : 'Campaign restarted. Sending resumes inside its sending window.');
      } else {
        showToast(result.error || `Failed to ${action} the campaign.`, 'error');
      }
    } catch (err) { console.error(err); showToast(`Error trying to ${action} the campaign.`, 'error'); }
    finally { setChangingStatus(false); }
  };

  // Setting Paused again cancels the auto-resume the send engine scheduled. Only
  // the status is refreshed, so unsaved edits in the form stay as they are.
  const handleKeepPaused = async () => {
    try {
      setKeepingPaused(true);
      const result = await changeStatus('Paused');
      if (result.ok) showToast('Auto-resume cancelled. The campaign stays paused until you activate it.');
      else showToast(result.error || 'Failed to keep the campaign paused.', 'error');
    } catch (err) { console.error(err); showToast('Error keeping the campaign paused.', 'error'); }
    finally { setKeepingPaused(false); }
  };

  if (loading) {
    return (
      <div className="mx-auto flex max-w-[1100px] flex-col gap-4 pb-12">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="size-8 animate-pulse rounded-control bg-slate-100 dark:bg-white/5" />
            <div className="h-6 w-56 animate-pulse rounded-md bg-slate-100 dark:bg-white/5" />
          </div>
          <div className="h-8 w-56 animate-pulse rounded-control bg-slate-100 dark:bg-white/5" />
        </div>
        <div className="h-[120px] animate-pulse rounded-card bg-slate-100 dark:bg-white/5" />
        <div className="h-[300px] animate-pulse rounded-card bg-slate-100 dark:bg-white/5" />
      </div>
    );
  }

  // Never loaded: an empty form would show defaults as the campaign's settings, and Save could write them.
  if (!campaign) {
    return (
      <div className="mx-auto flex max-w-[1100px] flex-col items-start gap-3 py-8">
        <Notice
          tone="error"
          title="Campaign Could Not Be Loaded"
          className="w-full"
          action={<Button size="sm" onClick={() => loadCampaign()}><RefreshCw size={12} /> Retry</Button>}
        >
          {loadError || 'The campaign could not be loaded.'}
        </Notice>
        <Link href="/campaigns" className={buttonClasses({ variant: 'ghost' })}>
          <ArrowLeft size={14} /> Back to Campaigns
        </Link>
      </div>
    );
  }

  // A stopped campaign is read-only until it is restarted: the form shows its
  // settings, but nothing in it can be changed or saved.
  const stopped = status === STOPPED_STATUS;
  // Which of the campaign's stats depend on something not set up (lib/imapSyncStatus, delivery reports, tracking).
  const statCaveats = analyticsCaveats(campaign, listErrors.mailboxes ? null : availableMailboxes);
  // Without a complete saved window the auto-resume sets the campaign to Draft, so the note says so.
  const resumeNote = campaign ? autoResumeNote({ ...campaign, hasSendingSchedule: hasSendingSchedule(campaign.timezone, campaign.sendSchedule) }) : null;
  const ownerNote = campaign ? ownerDisabledNote(campaign) : null;
  const incompleteSteps = showStepErrors ? findIncompleteSteps(steps) : [];
  // Once the campaign has started sending, saved steps may be edited in place
  // but not removed or replaced by a template; new steps go after them.
  const stepsLocked = !!campaign?.stepsLocked;
  const savedStepIds = new Set<string>((campaign?.steps || []).map((s: any) => s.id));
  // Publish Sequence saves the form's window with it, and a campaign without a
  // complete one never sends, so it can't be published until one is set.
  const scheduleMissing = !!(timezoneError(timezone) ?? sendScheduleError({ days: selectedDays, window: { start: startTime, end: endTime } }));
  // What the send engine does with the saved window, which the form may not show,
  // for the campaign's current status (a status change here does not reload it).
  const savedWindowNote = savedScheduleNote(campaign);

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-4 pb-12">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Link href="/campaigns" aria-label="Back to campaigns" className={buttonClasses({ iconOnly: true })}>
            <ArrowLeft size={16} />
          </Link>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-semibold tracking-tight text-text-main">{campaignName || 'Sequence Setup'}</h1>
              {stopped ? (
                <Badge tone="red" dot>Stopped</Badge>
              ) : (
                <select
                  aria-label="Campaign status"
                  value={status}
                  disabled={changingStatus}
                  onChange={(e) => handleStatusChange(e.target.value)}
                  className={cn(
                    'h-6 cursor-pointer rounded-md border-0 py-0 pr-6 pl-2 text-xs font-medium focus:ring-2 focus:ring-primary/30 focus:outline-none disabled:opacity-60',
                    STATUS_SELECT[status] ?? STATUS_SELECT.Draft,
                  )}
                >
                  <option value="Draft">Draft</option>
                  <option value="Active">Active</option>
                  <option value="Paused">Paused</option>
                </select>
              )}
            </div>
            <div className="mt-1 text-xs text-text-sub">
              Primary Mailbox: {campaign?.senderAccount?.emailAddress || 'N/A'}
              {campaign?.senders && campaign.senders.length > 0 && ` (+${campaign.senders.length} rotated)`}
            </div>
            {resumeNote && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                  <Clock size={12} className="shrink-0" /> {resumeNote}
                </span>
                <Button size="sm" disabled={keepingPaused} onClick={handleKeepPaused}>
                  <TimerOff size={12} /> {keepingPaused ? 'Keeping Paused…' : 'Keep Paused'}
                </Button>
              </div>
            )}
            {ownerNote && (
              <div className="mt-2 flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                <UserX size={12} className="shrink-0" /> {ownerNote}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1.5 md:items-end">
          <div className="flex flex-wrap gap-2">
            {status === 'Active' && (
              <Button disabled={runningCampaign} onClick={handleRunCampaign}>
                {runningCampaign ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {runningCampaign ? 'Running…' : 'Run Campaign'}
              </Button>
            )}
            {stopped ? (
              <Button variant="primary" disabled={changingStatus} onClick={() => setConfirmAction('restart')}>
                <RotateCcw size={14} /> Restart
              </Button>
            ) : (
              <>
                {STOPPABLE_STATUSES.includes(status) && (
                  <Button variant="danger" disabled={changingStatus} onClick={() => setConfirmAction('stop')}>
                    <CircleStop size={14} /> Stop
                  </Button>
                )}
                <Button disabled={saving} onClick={() => handleSaveCampaign()}>
                  <Save size={14} /> {saving ? 'Saving…' : 'Save'}
                </Button>
                <Button variant="primary" disabled={saving || scheduleMissing} onClick={() => handleSaveCampaign(true)}>
                  <Send size={14} /> Publish Sequence
                </Button>
              </>
            )}
          </div>
          {scheduleMissing && !stopped && (
            <span className="flex items-center gap-1 text-xs text-text-muted">
              <Clock size={12} className="shrink-0" /> Publishing needs a sending schedule: set days, times and a timezone on the Schedule tab.
            </span>
          )}
        </div>
      </div>

      {stopped && (
        <Notice tone="info" title="Campaign Stopped">
          {stoppedNote(campaign)}. It sends nothing, and can&apos;t be edited, until you restart it. Its leads keep their place in the sequence, and its stats and sent emails are kept.
        </Notice>
      )}

      {failedListMessages.length > 0 && (
        <Notice
          tone="warning"
          title="Some Choices Could Not Be Loaded"
          action={
            <Button size="sm" onClick={() => Object.keys(listErrors).forEach(key => { if (listErrors[key]) listLoaders[key](); })}>
              <RefreshCw size={12} /> Retry
            </Button>
          }
        >
          {failedListMessages.join(' ')} Use Template, Target CRM List, Skip Leads Emailed By and the Senders tab may be missing entries until they load.
        </Notice>
      )}

      <CampaignTiming campaign={campaign} />

      {/* Tabs */}
      <div className="max-w-full overflow-x-auto">
        <Segmented label="Campaign sections" options={TAB_OPTIONS} value={activeTab} onChange={setActiveTab} />
      </div>

      {activeTab === 'Analytics' ? (
        <div className="flex flex-col gap-4">
          <CampaignAnalytics campaign={campaign} mailboxes={listErrors.mailboxes ? null : availableMailboxes} />
          <CampaignLeadExport campaignId={campaignId} campaignName={campaignName} groups={groups} onGroupsChanged={loadGroups} />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[2fr_1fr] md:items-start">
          <div className="flex min-w-0 flex-col gap-4">
            {activeTab === 'Sequence' && (
              <>
                <Card className="p-5">
                  <label htmlFor="campaign-title" className={LABEL}>Campaign Title</label>
                  <input
                    id="campaign-title"
                    type="text"
                    placeholder="e.g. Q4 Inactive Leads Engagement"
                    value={campaignName}
                    disabled={stopped}
                    onChange={(e) => setCampaignName(e.target.value)}
                    className={inputClasses('h-9 disabled:opacity-60')}
                  />
                </Card>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold text-text-main">Steps Setup</h2>
                  {templates.length > 0 && (
                    <select
                      aria-label="Use template"
                      value=""
                      disabled={stepsLocked || stopped}
                      onChange={(e) => applyTemplate(e.target.value)}
                      className={inputClasses('w-auto min-w-[220px] disabled:opacity-60')}
                    >
                      <option value="" disabled>Use Template</option>
                      {templates.map(t => <option key={t.id} value={t.id}>{t.name} ({t.category})</option>)}
                    </select>
                  )}
                </div>

                {stepsLocked && !stopped && (
                  <p className="flex items-start gap-1.5 text-xs text-text-sub">
                    <Lock size={13} className="mt-px shrink-0" />
                    This campaign has started sending, so saved steps can&apos;t be removed or replaced with a template: leads already in the sequence would get the wrong step. Edit steps in place or add new ones at the end.
                  </p>
                )}

                {steps.map((step, index) => {
                  // A stopped campaign can't be edited, so its steps only show their preview.
                  const showPreview = stopped || previewSteps[step.id || index] !== false;
                  const bodyPreview = showPreview ? previewEmailBody(step.body || '') : null;
                  const stepIssue = incompleteSteps.find(s => s.stepNumber === index + 1);
                  // Stats belong to the saved step this card edits, matched by its id.
                  const savedStep = (campaign?.steps || []).find((s: any) => s.id === step.id);
                  const savedStepStats = savedStep ? (campaign?.telemetry?.stepStats || []).find((s: any) => s.stepOrder === savedStep.stepOrder) : null;
                  return (
                    <Card key={step.id || index} className={cn('p-5', stepIssue && 'border-rose-300 dark:border-rose-800')}>
                      {/* Step Header */}
                      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                        <div className="flex items-center gap-3">
                          <div className="flex size-8 items-center justify-center rounded-control bg-primary-subtle text-sm font-semibold text-primary">
                            {index + 1}
                          </div>
                          {index > 0 ? (
                            <label className="flex items-center gap-2 text-xs text-text-sub">
                              Wait for
                              <input
                                type="number"
                                value={step.waitDays}
                                disabled={stopped}
                                onChange={(e) => updateStepField(index, 'waitDays', parseInt(e.target.value) || 0)}
                                className={inputClasses('h-7 w-16 px-2 text-center font-medium')}
                              />
                              days
                            </label>
                          ) : (
                            <Badge tone="blue">Initial Dispatch</Badge>
                          )}
                        </div>

                        {!stopped && (
                          <div className="flex items-center gap-1.5 self-start sm:self-auto">
                            <Button size="sm" onClick={() => toggleStepPreview(step.id || index)}>
                              {showPreview ? <><PenLine size={12} /> Edit Mode</> : <><Eye size={12} /> Preview Mode</>}
                            </Button>
                            {steps.length > 1 && (
                              <Button
                                variant="ghost" size="sm" iconOnly aria-label="Remove step"
                                disabled={stepsLocked && savedStepIds.has(step.id)}
                                onClick={() => removeStep(index)}
                                className="hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
                              >
                                <Trash2 size={14} />
                              </Button>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="my-4">
                        <StepStatStrip stats={savedStepStats} htmlStep={isHtmlTemplate(savedStep?.body ?? '')} caveats={statCaveats} />
                      </div>

                      {stepIssue && (
                        <div className="mb-4 flex items-center gap-2 rounded-control bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                          <AlertTriangle size={14} className="shrink-0" />
                          This step has no {stepIssue.missing.map(m => m === 'subject' ? 'subject line' : 'message body').join(' or ')}. Complete it before publishing.
                        </div>
                      )}

                      {showPreview ? (
                        <div className="space-y-2">
                          <p className="flex items-center gap-1.5 text-xs text-text-sub">
                            <Eye size={13} className="shrink-0 text-text-muted" />
                            <span>Showing output for contact <strong className="font-medium text-text-main">Emily</strong> at <strong className="font-medium text-text-main">Stark Industries</strong>.</span>
                          </p>
                          <div className="rounded-control border border-card-border">
                            <div className="border-b border-card-border px-4 py-3">
                              <div className="text-[11px] text-text-muted">Subject</div>
                              <p className="mt-0.5 text-[13px] font-medium text-text-main">{personalizePreview(step.subject || '')}</p>
                            </div>
                            <div className="px-4 py-3">
                              <div className="mb-1.5 text-[11px] text-text-muted">Message</div>
                              {bodyPreview?.isHtml ? (
                                <iframe
                                  srcDoc={bodyPreview.body}
                                  title="Email Preview"
                                  sandbox=""
                                  className="h-[480px] w-full rounded-control border border-card-border bg-white"
                                />
                              ) : (
                                <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-text-main">{bodyPreview?.body}</p>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-3.5">
                          <div>
                            <label htmlFor={`step-subject-${index}`} className={LABEL}>Subject Line</label>
                            <input
                              id={`step-subject-${index}`}
                              type="text"
                              value={step.subject}
                              onChange={(e) => updateStepField(index, 'subject', e.target.value)}
                              placeholder="e.g. Quick question regarding cold email infrastructure"
                              className={inputClasses(cn('h-9', stepIssue?.missing.includes('subject') && 'border-rose-400 dark:border-rose-700'))}
                            />
                          </div>
                          <div className={cn('overflow-hidden rounded-control border bg-card', stepIssue?.missing.includes('body') ? 'border-rose-400 dark:border-rose-700' : 'border-input-border')}>
                            <div className="border-b border-card-border bg-slate-50/70 px-3 py-2 dark:bg-white/[0.02]">
                              <VariableToolbar
                                onInsert={(v) => insertVariable(v, index)}
                                onInsertSubject={(v) => updateStepField(index, 'subject', (step.subject || '') + ' ' + v)}
                              />
                            </div>
                            <textarea
                              rows={7}
                              aria-label="Message body"
                              value={step.body}
                              onChange={(e) => updateStepField(index, 'body', e.target.value)}
                              placeholder="Write your custom copy stream here. Use {{firstName}}, {{company}}..."
                              className="w-full resize-y bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-text-main placeholder:text-text-muted focus:outline-none"
                            />
                          </div>
                        </div>
                      )}
                    </Card>
                  );
                })}

                {!stopped && (
                  <button
                    type="button"
                    onClick={addStep}
                    className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-card border border-dashed border-input-border py-3 text-[13px] font-medium text-text-sub transition-colors hover:border-primary/50 hover:bg-primary-subtle hover:text-primary"
                  >
                    <Plus size={14} /> Add Journey Step
                  </button>
                )}
              </>
            )}

            {activeTab === 'Schedule' && (
              <Card className="p-5">
                <CardHeader title="Target Cadence Window" />
                <p className="mt-1 text-xs text-text-sub">
                  Required before publishing: the campaign sends only on these days, between these times in its timezone. Without a schedule it sends nothing and can&apos;t be made Active.
                </p>
                {savedWindowNote && (
                  <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                    <AlertTriangle size={13} className="shrink-0" /> {savedWindowNote}
                  </p>
                )}
                <div className="mt-5 space-y-5">
                  <div>
                    <label htmlFor="campaign-timezone" className={LABEL}>Outbox Timezone</label>
                    <select id="campaign-timezone" value={timezone} disabled={stopped} onChange={(e) => setTimezone(e.target.value)} className={inputClasses('h-9 disabled:opacity-60')}>
                      {timezoneOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <div role="group" aria-labelledby="campaign-days-label">
                    <div id="campaign-days-label" className={LABEL}>Permitted Active Days</div>
                    <div className="grid grid-cols-7 gap-1.5">
                      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => {
                        const on = selectedDays.includes(day);
                        return (
                          <button
                            key={day}
                            type="button"
                            aria-pressed={on}
                            disabled={stopped}
                            onClick={() => toggleDaySelection(day)}
                            className={cn(
                              'h-8 cursor-pointer rounded-control border text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                              on ? 'border-primary bg-primary-subtle text-primary' : 'border-input-border bg-card text-text-sub hover:text-text-main',
                            )}
                          >
                            {day}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div role="group" aria-labelledby="campaign-window-label">
                    <div id="campaign-window-label" className={LABEL}>Cadence Delivery Window (Local Senders Clock)</div>
                    <div className="flex items-center gap-3">
                      <input type="time" aria-label="Window start" value={startTime} disabled={stopped} onChange={(e) => setStartTime(e.target.value)} className={inputClasses('h-9 disabled:opacity-60')} />
                      <span className="text-xs text-text-muted">to</span>
                      <input type="time" aria-label="Window end" value={endTime} disabled={stopped} onChange={(e) => setEndTime(e.target.value)} className={inputClasses('h-9 disabled:opacity-60')} />
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {activeTab === 'Options' && (
              <Card className="p-5">
                <CardHeader title="Delivery Autopilot Flags" />
                <div className="mt-3 divide-y divide-card-border">
                  {[
                    { key: 'stop-on-reply', label: 'Pause Sequence on Reply', desc: 'Stop further emails once a customer expresses interest.', val: stopOnReply, set: setStopOnReply, warning: replySyncWarning },
                    { key: 'track-opens', label: 'Track Opens', desc: 'Embed a tracking pixel in HTML steps. Plain-text steps cannot track opens.', val: trackOpens, set: setTrackOpens, warning: null },
                    { key: 'track-clicks', label: 'Track Link Clicks', desc: 'Route links in HTML steps through the click tracker. Plain-text steps cannot track clicks.', val: trackClicks, set: setTrackClicks, warning: null },
                  ].map((f) => (
                    <div key={f.key} className="flex items-center justify-between gap-4 py-3.5 first:pt-1 last:pb-0">
                      <div className="min-w-0">
                        <div id={`option-${f.key}`} className="text-[13px] font-medium text-text-main">{f.label}</div>
                        <div className="mt-0.5 text-xs text-text-sub">{f.desc}</div>
                        {f.warning && (
                          <p className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                            <AlertTriangle size={13} className="mt-px shrink-0" /> {f.warning}
                          </p>
                        )}
                      </div>
                      <Switch checked={f.val} disabled={stopped} onChange={f.set} aria-labelledby={`option-${f.key}`} />
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {activeTab === 'Audience' && (
              <Card className="p-5">
                <CardHeader title="Audience Selection" />
                <div className="mt-4 space-y-5">
                  <div>
                    <label htmlFor="campaign-audience" className={LABEL}>Target CRM List</label>
                    <select id="campaign-audience" value={audienceCohort} disabled={stopped} onChange={(e) => setAudienceCohort(e.target.value)} className={inputClasses('h-9 disabled:opacity-60')}>
                      <option value="Valid">All Active Valid Leads ({campaign?.telemetry?.validLeadsCount || 0})</option>
                      <option value="Unverified">All Unverified Leads ({campaign?.telemetry?.unverifiedLeadsCount || 0})</option>
                      {groups.map((g: any) => <option key={g.id} value={g.id}>Segment: {g.name} ({g._count?.leads || 0})</option>)}
                    </select>
                  </div>
                  <div>
                    <Autocomplete
                      multiple filterSelectedOptions size="small"
                      options={skipOptionIds}
                      getOptionLabel={(id) => skipCampaignName(id) ?? 'A campaign not in your list'}
                      value={skipCampaignIds}
                      disabled={stopped}
                      onChange={(_, ids) => setSkipCampaignIds(ids)}
                      noOptionsText="No other campaign"
                      renderInput={(params) => (
                        <TextField
                          {...params} label="Skip Leads Emailed By"
                          placeholder={skipCampaignIds.length === 0 ? 'Pick campaigns' : ''}
                          helperText="Optional. A lead one of these campaigns has emailed gets nothing from this campaign and is counted as Skipped. Those campaigns go on emailing the lead."
                        />
                      )}
                    />
                    {skipNote && <p className="mx-3.5 mt-1.5 text-xs font-medium text-text-sub">{skipNote}</p>}
                    {skipChangeNote && <p className="mx-3.5 mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">{skipChangeNote}</p>}
                  </div>
                  <div className="rounded-control bg-primary-subtle px-4 py-3">
                    <div className="text-xs font-medium text-text-sub">Active Enrollments</div>
                    <div className="mt-1 text-2xl font-semibold text-text-main tabular-nums">{(campaign?.telemetry?.activeEnrollments || 0).toLocaleString()}</div>
                    <div className="mt-1 text-xs text-text-sub">Leads still in the sequence. Paused, completed, failed, bounced, removed and skipped leads are not counted.</div>
                  </div>
                </div>
              </Card>
            )}

            {activeTab === 'Senders' && (
              <Card className="p-5">
                <CardHeader
                  title="Campaign Senders Pool & Rotation"
                  action={<Badge tone="blue">{`${poolIds.length || 1} Active ${(poolIds.length || 1) === 1 ? 'Sender' : 'Senders'}`}</Badge>}
                />
                <p className="mt-1 text-xs leading-relaxed text-text-sub">
                  Spreading outbound across multiple mailboxes protects sender reputation and circumvents daily provider caps. The send engine routes each dispatch via the least-loaded mailbox. A mailbox with Recipient Domains sends only to leads at those domains and mail providers, and the mailboxes without any share every other lead.
                </p>
                <div className="mt-3 space-y-2 empty:hidden">
                  {(routingError || routingNote) && (
                    <p className={cn('flex items-start gap-1.5 text-xs font-medium', routingError ? 'text-rose-600 dark:text-rose-400' : 'text-text-sub')}>
                      {routingError ? <AlertTriangle size={13} className="mt-px shrink-0" /> : <Split size={13} className="mt-px shrink-0" />}
                      {routingError ?? routingNote}
                    </p>
                  )}
                  {waitingRefused > 0 && (
                    <p className="flex items-start gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                      <AlertTriangle size={13} className="mt-px shrink-0" />
                      {leadsAre(waitingRefused)} waiting for another mailbox: every mailbox allowed for them has refused their email for a reason on the sender&apos;s side, such as spam or reputation. Nothing more is sent to them until this campaign has another mailbox they may go out from.
                    </p>
                  )}
                  {waitingUnrouted > 0 && (
                    <p className="flex items-start gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                      <AlertTriangle size={13} className="mt-px shrink-0" />
                      {leadsAre(waitingUnrouted)} waiting for a mailbox: no mailbox of this campaign sends to their domain. Leave Recipient Domains empty on one of them.
                    </p>
                  )}
                  {replySyncWarning && (
                    <p className="flex items-start gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                      <AlertTriangle size={13} className="mt-px shrink-0" /> {replySyncWarning}
                    </p>
                  )}
                </div>
                <div className="mt-4 space-y-2">
                  {ownerMailboxes.map((mailbox) => {
                    const isPrimary = primarySenderId === mailbox.id;
                    const isChecked = selectedPoolIds.includes(mailbox.id) || isPrimary;
                    // Its own reply sync never sees replies to its emails when they go to another address.
                    const replyTo = otherReplyTo(mailbox);
                    // Its Reply-To mailbox's sync when its own is off and that mailbox reads its replies.
                    const replySync = mailboxReplySync(mailbox, availableMailboxes);
                    // Its own Recipient Domains hold in every campaign, so the campaign's list for it is not editable.
                    const ownDomains = storedRecipientDomains(mailbox.recipientDomains);
                    const toggleCheckbox = () => {
                      if (isPrimary) { showToast('The primary sender is always included.', 'error'); return; }
                      setSelectedPoolIds(prev => isChecked ? prev.filter(id => id !== mailbox.id) : [...prev, mailbox.id]);
                    };
                    const makePrimary = () => {
                      setPrimarySenderId(mailbox.id);
                      if (!selectedPoolIds.includes(mailbox.id)) setSelectedPoolIds(prev => [...prev, mailbox.id]);
                    };
                    return (
                      <div
                        key={mailbox.id}
                        className={cn(
                          'rounded-control border p-3',
                          isPrimary ? 'border-primary/40 bg-primary-subtle' : 'border-card-border',
                          !isChecked && 'opacity-60',
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              disabled={isPrimary || stopped}
                              onChange={toggleCheckbox}
                              className="size-4 shrink-0 accent-blue-600"
                            />
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-[13px] font-medium text-text-main">{mailbox.name || 'SMTP Account'}</span>
                                <span className="text-xs text-text-sub">({mailbox.emailAddress})</span>
                                {isPrimary && <Badge tone="blue">Primary</Badge>}
                                {mailbox.warmupEnabled && <Badge tone="amber">Warmup</Badge>}
                              </div>
                              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-text-muted">
                                <span>Provider: <strong className="font-medium text-text-sub">{mailbox.provider}</strong></span>
                                <strong className={cn('font-medium', replySync.state === 'failing' ? 'text-rose-600 dark:text-rose-400' : 'text-text-sub')}>{mailboxReplySyncLabel(replySync)}</strong>
                                {replyTo && <span>Replies go to <strong className="font-medium text-text-sub">{replyTo}</strong></span>}
                                {/* No cap of its own while a global rate limit is set, unless it is warming up */}
                                <span>Last 24 Hours: <strong className="font-medium text-text-sub">{mailbox.sentLast24Hours}{mailbox.effectiveDailyCap != null && ` / ${mailbox.effectiveDailyCap}`}</strong></span>
                                <span>Total: <strong className="font-medium text-text-sub">{mailbox.sentTotal}</strong></span>
                              </div>
                            </div>
                          </label>
                          {!isPrimary && !stopped && (
                            <Button size="sm" onClick={makePrimary}>Set as Primary</Button>
                          )}
                        </div>
                        {isChecked && (
                          <div className="mt-3 pl-7">
                            <RecipientDomainsInput
                              value={ownDomains.length > 0 ? ownDomains : poolDomains[mailbox.id] ?? []}
                              disabled={stopped || ownDomains.length > 0}
                              onChange={(domains) => setPoolDomains(prev => ({ ...prev, [mailbox.id]: domains }))}
                              onInvalid={(error) => showToast(error, 'error')}
                              helperText={ownDomains.length > 0
                                ? 'Set on this mailbox on the Accounts page, so it holds in every campaign and is not changed here.'
                                : 'Optional. With domains or mail providers here, this mailbox sends only to leads at them in this campaign. Leave empty to send to every domain no other mailbox lists.'}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {ownerMailboxes.length === 0 && (
                    <p className={cn('py-8 text-center text-xs', listErrors.mailboxes ? 'text-rose-600 dark:text-rose-400' : 'text-text-muted')}>
                      {listErrors.mailboxes
                        ? 'Mailboxes could not be loaded, so the sender pool is not shown. Use Retry above.'
                        : 'No sender accounts owned by the campaign owner. Create mailboxes in the Accounts page first.'}
                    </p>
                  )}
                </div>
              </Card>
            )}
          </div>

          {/* Sidebar */}
          <Card className="p-5">
            <CardHeader title="Campaign Outline" />
            <dl className="mt-3 divide-y divide-card-border text-[13px]">
              <div className="flex justify-between py-2 first:pt-0"><dt className="text-text-sub">Total Emails</dt><dd className="font-medium text-text-main">{steps.length} Steps</dd></div>
              <div className="flex justify-between py-2"><dt className="text-text-sub">Duration</dt><dd className="font-medium text-text-main">{sequenceDurationDays(steps)} Days</dd></div>
              <div className="flex justify-between py-2 last:pb-0"><dt className="text-text-sub">Active Cohort</dt><dd className="font-medium text-primary">{campaign?.telemetry?.activeEnrollments || 0} leads</dd></div>
            </dl>
          </Card>
        </div>
      )}

      <ConfirmDialog
        isOpen={showChangedPrompt}
        title="Campaign Changed Elsewhere"
        message="This campaign was saved elsewhere or its status changed after you opened it, so your changes were not saved. Reload to see the latest version, then make your changes again. Reloading discards your unsaved edits: choose Keep Editing to copy them first."
        confirmLabel="Reload"
        cancelLabel="Keep Editing"
        isDestructive
        onConfirm={() => { setShowChangedPrompt(false); loadCampaign(); }}
        onCancel={() => setShowChangedPrompt(false)}
      />

      <ConfirmDialog
        isOpen={confirmAction === 'stop'}
        title="Stop Campaign?"
        message={stopConfirmMessage(campaignName || 'this campaign', campaign?.telemetry?.activeEnrollments ?? 0)}
        confirmLabel="Stop Campaign"
        isDestructive
        onConfirm={() => handleStopOrRestart('stop')}
        onCancel={() => setConfirmAction(null)}
      />

      <ConfirmDialog
        isOpen={confirmAction === 'restart'}
        title="Restart Campaign?"
        message={restartConfirmMessage(campaignName || 'this campaign')}
        confirmLabel="Restart"
        onConfirm={() => handleStopOrRestart('restart')}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}

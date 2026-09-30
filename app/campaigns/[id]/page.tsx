/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import {
  ArrowLeft, Save, Send, Settings, Users, AlignLeft, Clock, ToggleLeft, Plus, Trash2,
  Mail, CheckCircle2, MousePointerClick, Reply, SendHorizontal,
  Eye, Play, Loader2, XCircle, AlertTriangle, UserMinus, TimerOff, Lock, RefreshCw, UserX,
} from 'lucide-react';
import Link from 'next/link';
import { use, useState, useEffect } from 'react';
import { useTimezones } from '@/hooks/use-timezones';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell,
} from 'recharts';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import VariableToolbar from '@/components/VariableToolbar';
import { activationBlocker, findIncompleteSteps, queuedLeadsMessage, sequenceDurationDays } from '@/lib/campaignSteps';
import { autoResumeNote, ownerDisabledNote } from '@/lib/campaignPause';
import { sameCampaignVersion } from '@/lib/campaignVersion';
import { sendScheduleError, timezoneError } from '@/lib/sendSchedule';
import { personalizePreview, previewEmailBody } from '@/lib/personalize';
import { IMAP_SYNC_LABELS, imapSyncState, stopOnReplyWarning } from '@/lib/imapSyncStatus';
import { loadErrorMessage, readJsonList, responseErrorMessage } from '@/lib/apiResponse';
import {
  Box, Card, CardContent, Stack, Typography, Button, IconButton, Chip, TextField,
  Select, MenuItem, FormControl, InputLabel, Switch, Skeleton, ToggleButtonGroup, ToggleButton,
  Table, TableHead, TableBody, TableRow, TableCell, Checkbox, FormControlLabel, Alert, AlertTitle,
} from '@mui/material';
import { alpha } from '@mui/material/styles';

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
  const [templates, setTemplates] = useState<any[]>([]);
  const [previewSteps, setPreviewSteps] = useState<Record<string, boolean>>({});
  // A step shows its preview unless its key is false (edit mode), so a toggle flips it to or from false.
  const toggleStepPreview = (id: string | number) => setPreviewSteps(prev => ({ ...prev, [id]: prev[id] === false }));

  const [campaignName, setCampaignName] = useState('');
  const [status, setStatus] = useState('Draft');
  const [audienceCohort, setAudienceCohort] = useState('Valid');
  const [runningCampaign, setRunningCampaign] = useState(false);
  const [keepingPaused, setKeepingPaused] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
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
  const [selectedDays, setSelectedDays] = useState<string[]>([]);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [savedWindowNote, setSavedWindowNote] = useState<string | null>(null);

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
  const listLoaders: Record<string, () => Promise<void>> = { templates: loadTemplates, groups: loadGroups, mailboxes: loadMailboxes };
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
        setEditorVersion(data.updatedAt ?? null);
        setCampaignName(data.name || '');
        setStatus(data.status || 'Draft');
        setTimezone(data.timezone || 'UTC');
        setAudienceCohort(data.audienceCohort || 'Valid');
        setStopOnReply(data.stopOnReply !== false);
        setTrackOpens(data.trackOpens !== false);
        setTrackClicks(data.trackClicks !== false);
        setSteps(data.steps || []);
        setPrimarySenderId(data.senderAccountId || '');
        setSelectedPoolIds(data.senders ? data.senders.map((s: any) => s.senderAccountId) : []);
        // The form shows the schedule as saved, even when empty, never unsaved defaults.
        let sched: any = data.sendSchedule;
        if (typeof sched === 'string') {
          try { sched = JSON.parse(sched); } catch (e) { console.error(e); sched = undefined; }
        }
        setSelectedDays(Array.isArray(sched?.days) ? sched.days : []);
        setStartTime(typeof sched?.window?.start === 'string' ? sched.window.start : '');
        setEndTime(typeof sched?.window?.end === 'string' ? sched.window.end : '');
        // What the send engine does with the saved window, which the form may not show.
        if (data.sendSchedule == null) setSavedWindowNote('No sending window is saved, so this campaign sends at any hour. Choose days and times, then save.');
        else if (sendScheduleError(sched) || timezoneError(data.timezone)) setSavedWindowNote('The saved sending window is incomplete or its timezone is unknown, so this campaign sends nothing until you fix it and save.');
        else setSavedWindowNote(null);
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

  useEffect(() => { loadCampaign(); loadTemplates(); loadGroups(); loadMailboxes(); }, [campaignId]);

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
    const windowError = timezoneError(timezone) ?? sendScheduleError({ days: selectedDays, window: { start: startTime, end: endTime } });
    if (windowError) {
      setActiveTab('Schedule');
      showToast(windowError, 'error');
      return;
    }
    try {
      setSaving(true);
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: campaignName, timezone,
          sendSchedule: { days: selectedDays, window: { start: startTime, end: endTime } },
          stopOnReply, trackOpens, trackClicks, audienceCohort, steps,
          senderAccountId: primarySenderId, senderAccountIds: poolIds,
          updatedAt: editorVersion,
          ...(publish ? { status: 'Active' } : {}),
        }),
      });
      if (res.ok) {
        showToast('Outbound sequence configuration successfully saved!');
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
    setCampaign((prev: any) => ({ ...prev, status: data.status, pausedUntil: data.pausedUntil, pauseReason: data.pauseReason }));
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
      <Box sx={{ maxWidth: 1100, mx: 'auto', pb: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', pb: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
            <Skeleton variant="rounded" width={36} height={36} />
            <Box><Skeleton width={200} height={28} /><Skeleton width={140} /></Box>
          </Stack>
          <Stack direction="row" spacing={1}><Skeleton variant="rounded" width={100} height={36} /><Skeleton variant="rounded" width={120} height={36} /></Stack>
        </Stack>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' }, gap: 2 }}>
          {[0,1,2,3].map(i => <Skeleton key={i} variant="rounded" height={120} sx={{ borderRadius: '24px' }} />)}
        </Box>
        <Skeleton variant="rounded" height={300} sx={{ borderRadius: '24px' }} />
      </Box>
    );
  }

  // Never loaded: an empty form would show defaults as the campaign's settings, and Save could write them.
  if (!campaign) {
    return (
      <Box sx={{ maxWidth: 1100, mx: 'auto', py: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Alert
          severity="error"
          action={<Button color="inherit" size="small" startIcon={<RefreshCw size={14} />} onClick={() => loadCampaign()}>Retry</Button>}
        >
          <AlertTitle>Campaign Could Not Be Loaded</AlertTitle>
          {loadError || 'The campaign could not be loaded.'}
        </Alert>
        <Button component={Link as any} href="/campaigns" color="inherit" startIcon={<ArrowLeft size={14} />} sx={{ alignSelf: 'flex-start', color: 'text.secondary' }}>
          Back to Campaigns
        </Button>
      </Box>
    );
  }

  const metrics = [
    { title: 'Total Sent Requests', value: campaign?.telemetry?.sentRequests, icon: SendHorizontal, color: '#64748b', sub: 'Includes retries & failures' },
    { title: 'Emails Sent', value: campaign?.telemetry?.sent, icon: Send, color: '#2563EB', sub: 'Accepted by provider' },
    { title: 'Delivered', value: campaign?.telemetry?.delivered, icon: CheckCircle2, color: '#059669', sub: `${campaign?.telemetry?.deliveryRate ?? 0}% delivery rate` },
    { title: 'Unique Opens', value: campaign?.telemetry?.opens, icon: Mail, color: '#2563EB', sub: `${campaign?.telemetry?.openRate ?? 0}% open rate` },
    { title: 'Unique Clicks', value: campaign?.telemetry?.clicks, icon: MousePointerClick, color: '#D97706', sub: `${campaign?.telemetry?.clickRate ?? 0}% click rate` },
    { title: 'Replies', value: campaign?.telemetry?.replies, icon: Reply, color: '#7C3AED', sub: `${campaign?.telemetry?.replyRate ?? 0}% reply rate` },
  ];

  const healthCards = [
    { title: 'Failed Sends', value: campaign?.telemetry?.failed, icon: XCircle, color: '#DC2626', sub: 'Delivery errors at send time' },
    { title: 'Bounced', value: campaign?.telemetry?.bounced, icon: AlertTriangle, color: '#D97706', sub: `${campaign?.telemetry?.bounceRate ?? 0}% bounce rate` },
    { title: 'Unsubscribed', value: campaign?.telemetry?.unsubscribed, icon: UserMinus, color: '#64748b', sub: 'Opted out of mailings' },
  ];

  const statusColor = status === 'Active' ? 'success' : status === 'Paused' ? 'warning' : 'default';
  const resumeNote = campaign ? autoResumeNote(campaign) : null;
  const ownerNote = campaign ? ownerDisabledNote(campaign) : null;
  const incompleteSteps = showStepErrors ? findIncompleteSteps(steps) : [];
  // Once the campaign has started sending, saved steps may be edited in place
  // but not removed or replaced by a template; new steps go after them.
  const stepsLocked = !!campaign?.stepsLocked;
  const savedStepIds = new Set<string>((campaign?.steps || []).map((s: any) => s.id));

  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto', pb: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
      {/* Header */}
      <Stack direction={{ xs: 'column', md: 'row' }} sx={{ justifyContent: 'space-between', alignItems: { md: 'flex-start' }, gap: 2, pb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
          <IconButton aria-label="Back to campaigns" component={Link as any} href="/campaigns" sx={{ border: 1, borderColor: 'divider' }}>
            <ArrowLeft size={16} />
          </IconButton>
          <Box>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>{campaignName || 'Sequence Setup'}</Typography>
              <FormControl size="small">
                <Select
                  value={status}
                  disabled={changingStatus}
                  onChange={(e) => handleStatusChange(e.target.value)}
                  sx={{
                    height: 26, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                    bgcolor: (t) => statusColor !== 'default' ? alpha(t.palette[statusColor as 'success' | 'warning'].main, 0.14) : 'action.hover',
                    color: statusColor !== 'default' ? `${statusColor}.main` : 'text.secondary',
                    '& .MuiOutlinedInput-notchedOutline': { borderColor: statusColor !== 'default' ? `${statusColor}.main` : 'divider' },
                  }}
                >
                  <MenuItem value="Draft">Draft</MenuItem>
                  <MenuItem value="Active">Active</MenuItem>
                  <MenuItem value="Paused">Paused</MenuItem>
                </Select>
              </FormControl>
            </Stack>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
              Primary Mailbox: {campaign?.senderAccount?.emailAddress || 'N/A'}
              {campaign?.senders && campaign.senders.length > 0 && ` (+${campaign.senders.length} rotated)`}
            </Typography>
            {resumeNote && (
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', mt: 1 }}>
                <Typography variant="caption" sx={{ color: 'warning.main', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Clock size={12} style={{ flexShrink: 0 }} /> {resumeNote}
                </Typography>
                <Button size="small" variant="outlined" color="inherit" disabled={keepingPaused} startIcon={<TimerOff size={12} />} onClick={handleKeepPaused} sx={{ borderColor: 'divider', color: 'text.secondary', py: 0 }}>
                  {keepingPaused ? 'Keeping Paused…' : 'Keep Paused'}
                </Button>
              </Stack>
            )}
            {ownerNote && (
              <Typography variant="caption" sx={{ color: 'warning.main', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 0.5, mt: 1 }}>
                <UserX size={12} style={{ flexShrink: 0 }} /> {ownerNote}
              </Typography>
            )}
          </Box>
        </Stack>
        <Stack direction="row" spacing={1}>
          {status === 'Active' && (
            <Button variant="contained" color="warning" disabled={runningCampaign} startIcon={runningCampaign ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} onClick={handleRunCampaign}>
              {runningCampaign ? 'Running…' : 'Run Campaign'}
            </Button>
          )}
          <Button variant="outlined" color="inherit" disabled={saving} startIcon={<Save size={14} />} onClick={() => handleSaveCampaign()} sx={{ borderColor: 'divider', color: 'text.secondary' }}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="contained" disabled={saving} startIcon={<Send size={14} />} onClick={() => handleSaveCampaign(true)}>Publish Sequence</Button>
        </Stack>
      </Stack>

      {failedListMessages.length > 0 && (
        <Alert
          severity="warning"
          action={<Button color="inherit" size="small" startIcon={<RefreshCw size={14} />} onClick={() => Object.keys(listErrors).forEach(key => { if (listErrors[key]) listLoaders[key](); })}>Retry</Button>}
        >
          <AlertTitle>Some Choices Could Not Be Loaded</AlertTitle>
          {failedListMessages.join(' ')} Use Template, Target CRM List and the Senders tab may be missing entries until they load.
        </Alert>
      )}

      {/* Metrics */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' }, gap: 2 }}>
        {metrics.map((m, i) => (
          <Card key={i}>
            <CardContent>
              <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 700 }}>{m.title}</Typography>
                <Box sx={{ width: 32, height: 32, borderRadius: '10px', display: 'grid', placeItems: 'center', bgcolor: alpha(m.color, 0.14), color: m.color }}>
                  <m.icon size={16} />
                </Box>
              </Stack>
              <Typography variant="h6" sx={{ fontWeight: 700, mt: 0.5 }}>{(m.value ?? 0).toLocaleString()}</Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5, fontFamily: 'monospace', fontSize: 9 }}>{m.sub}</Typography>
            </CardContent>
          </Card>
        ))}
      </Box>

      {/* Deliverability */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' }, gap: 2 }}>
        {healthCards.map((m, i) => (
          <Card key={i}>
            <CardContent>
              <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 700 }}>{m.title}</Typography>
                <Box sx={{ width: 32, height: 32, borderRadius: '10px', display: 'grid', placeItems: 'center', bgcolor: alpha(m.color, 0.14), color: m.color }}>
                  <m.icon size={16} />
                </Box>
              </Stack>
              <Typography variant="h6" sx={{ fontWeight: 700, mt: 0.5 }}>{(m.value ?? 0).toLocaleString()}</Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5, fontFamily: 'monospace', fontSize: 9 }}>{m.sub}</Typography>
            </CardContent>
          </Card>
        ))}
      </Box>

      {/* Per-step table */}
      {campaign?.telemetry?.stepStats && campaign.telemetry.stepStats.length > 0 && (
        <Card>
          <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
            <Typography variant="overline" sx={{ fontWeight: 700 }}>Per-Step Performance</Typography>
          </Box>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ '& th': { fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, color: 'text.secondary' } }}>
                  <TableCell>Step</TableCell>
                  <TableCell>Active</TableCell>
                  <TableCell>Sent</TableCell>
                  <TableCell>Delivered</TableCell>
                  <TableCell>Opened</TableCell>
                  <TableCell>Clicked</TableCell>
                  <TableCell>Failed</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {campaign.telemetry.stepStats.map((s: any) => (
                  <TableRow key={s.stepOrder} hover>
                    <TableCell>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <Chip size="small" label={s.stepOrder} sx={{ height: 20, fontWeight: 700, fontFamily: 'monospace', bgcolor: (t) => alpha(t.palette.primary.main, 0.14), color: 'primary.main' }} />
                        <Typography variant="body2" sx={{ fontWeight: 600, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.subject}>{s.subject || '(No subject)'}</Typography>
                      </Stack>
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{s.active}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{s.sent}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{s.delivered} <Box component="span" sx={{ color: 'text.secondary' }}>({s.deliveryRate}%)</Box></TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{s.opened} <Box component="span" sx={{ color: 'text.secondary' }}>({s.openRate}%)</Box></TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{s.clicked} <Box component="span" sx={{ color: 'text.secondary' }}>({s.clickRate}%)</Box></TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', color: s.failed > 0 ? 'error.main' : undefined, fontWeight: s.failed > 0 ? 700 : 400 }}>{s.failed}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        </Card>
      )}

      {/* Tabs */}
      <ToggleButtonGroup value={activeTab} exclusive onChange={(_, v) => v && setActiveTab(v)} sx={{ width: 'fit-content' }}>
        {['Sequence', 'Audience', 'Schedule', 'Options', 'Senders'].map(tab => (
          <ToggleButton key={tab} value={tab} sx={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{tab}</ToggleButton>
        ))}
      </ToggleButtonGroup>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '2fr 1fr' }, gap: 3 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {activeTab === 'Sequence' && (
            <>
              <Card>
                <CardContent>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1.5 }}>
                    <Settings size={16} color="#2563EB" />
                    <Typography variant="overline" sx={{ fontWeight: 700 }}>Campaign Title</Typography>
                  </Stack>
                  <TextField fullWidth size="small" placeholder="e.g. Q4 Inactive Leads Engagement" value={campaignName} onChange={(e) => setCampaignName(e.target.value)} />
                </CardContent>
              </Card>

              <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', pb: 0.5, borderBottom: 1, borderColor: 'divider' }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <AlignLeft size={16} color="#2563EB" />
                  <Typography variant="overline" sx={{ fontWeight: 700 }}>Steps Setup</Typography>
                </Stack>
                {templates.length > 0 && (
                  <FormControl size="small" sx={{ minWidth: 220 }}>
                    <Select displayEmpty value="" disabled={stepsLocked} onChange={(e) => applyTemplate(e.target.value)}>
                      <MenuItem value="" disabled>— Use Template —</MenuItem>
                      {templates.map(t => <MenuItem key={t.id} value={t.id}>{t.name} ({t.category})</MenuItem>)}
                    </Select>
                  </FormControl>
                )}
              </Stack>

              {stepsLocked && (
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', color: 'text.secondary' }}>
                  <Lock size={14} style={{ flexShrink: 0 }} />
                  <Typography variant="caption" sx={{ fontWeight: 600 }}>
                    This campaign has started sending, so saved steps can&apos;t be removed or replaced with a template: leads already in the sequence would get the wrong step. Edit steps in place or add new ones at the end.
                  </Typography>
                </Stack>
              )}

              {steps.map((step, index) => {
                const showPreview = previewSteps[step.id || index] !== false;
                const bodyPreview = showPreview ? previewEmailBody(step.body || '') : null;
                const stepIssue = incompleteSteps.find(s => s.stepNumber === index + 1);
                return (
                  <Card key={step.id || index} sx={stepIssue ? { borderColor: 'error.main' } : undefined}>
                    <CardContent>
                      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: 1 }}>
                        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                          <Box sx={{ width: 28, height: 28, borderRadius: '8px', display: 'grid', placeItems: 'center', bgcolor: (t) => alpha(t.palette.primary.main, 0.14), color: 'primary.main', fontWeight: 700, fontFamily: 'monospace' }}>{index + 1}</Box>
                          {index > 0 ? (
                            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                              <Typography variant="body2" sx={{ fontWeight: 600 }}>Wait for</Typography>
                              <TextField size="small" type="number" value={step.waitDays} onChange={(e) => updateStepField(index, 'waitDays', parseInt(e.target.value) || 0)} sx={{ width: 72 }} slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 12 } } }} />
                              <Typography variant="body2" sx={{ fontWeight: 600 }}>days</Typography>
                            </Stack>
                          ) : (<Typography variant="overline" sx={{ fontWeight: 700, color: 'text.secondary' }}>Initial Dispatch</Typography>)}
                        </Stack>
                        <Stack direction="row" spacing={1}>
                          <Button size="small" variant={showPreview ? 'contained' : 'outlined'} color={showPreview ? 'primary' : 'inherit'} onClick={() => toggleStepPreview(step.id || index)} sx={{ borderColor: showPreview ? undefined : 'divider', color: showPreview ? undefined : 'text.secondary', fontSize: 10 }}>
                            {showPreview ? 'Edit Mode' : 'Preview Mode'}
                          </Button>
                          {steps.length > 1 && (
                            <IconButton aria-label="Remove step" size="small" disabled={stepsLocked && savedStepIds.has(step.id)} onClick={() => removeStep(index)} sx={{ border: 1, borderColor: 'divider', color: 'text.secondary', '&:hover': { color: 'error.main', borderColor: 'error.main' } }}>
                              <Trash2 size={14} />
                            </IconButton>
                          )}
                        </Stack>
                      </Stack>

                      {stepIssue && (
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 2, color: 'error.main' }}>
                          <AlertTriangle size={14} />
                          <Typography variant="caption" sx={{ fontWeight: 600 }}>
                            This step has no {stepIssue.missing.map(m => m === 'subject' ? 'subject line' : 'message body').join(' or ')}. Complete it before publishing.
                          </Typography>
                        </Stack>
                      )}

                      {showPreview ? (
                        <Stack spacing={2}>
                          <Card sx={{ bgcolor: (t) => alpha(t.palette.primary.main, 0.06), borderColor: (t) => alpha(t.palette.primary.main, 0.2) }}>
                            <CardContent sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
                              <Eye size={16} color="#2563EB" style={{ marginTop: 2, flexShrink: 0 }} />
                              <Box>
                                <Typography variant="overline" sx={{ color: 'primary.main', fontWeight: 700 }}>Dynamic Resolve Preview</Typography>
                                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>Showing output for contact <strong>Emily</strong> at <strong>Stark Industries</strong>.</Typography>
                              </Box>
                            </CardContent>
                          </Card>
                          <Card sx={{ bgcolor: 'action.hover' }}>
                            <CardContent>
                              <Box sx={{ pb: 1, borderBottom: 1, borderColor: 'divider', mb: 1 }}>
                                <Typography variant="overline" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>Subject:</Typography>
                                <Typography variant="body2" sx={{ fontWeight: 600, mt: 0.5 }}>{personalizePreview(step.subject || '')}</Typography>
                              </Box>
                              <Typography variant="overline" sx={{ color: 'text.secondary', fontFamily: 'monospace', display: 'block', mb: 1 }}>Message:</Typography>
                              {bodyPreview?.isHtml ? (
                                <Box component="iframe" srcDoc={bodyPreview.body} title="Email Preview" sandbox="" sx={{ width: '100%', height: 500, border: 1, borderColor: 'divider', borderRadius: '12px', bgcolor: '#fff' }} />
                              ) : (
                                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{bodyPreview?.body}</Typography>
                              )}
                            </CardContent>
                          </Card>
                        </Stack>
                      ) : (
                        <Stack spacing={1.5}>
                          <TextField fullWidth size="small" placeholder="Subject Line" value={step.subject} onChange={(e) => updateStepField(index, 'subject', e.target.value)} error={!!stepIssue?.missing.includes('subject')} />
                          <Box sx={{ border: 1, borderColor: stepIssue?.missing.includes('body') ? 'error.main' : 'divider', borderRadius: '12px', overflow: 'hidden', bgcolor: 'action.hover' }}>
                            <Box sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
                              <VariableToolbar onInsert={(v) => insertVariable(v, index)} onInsertSubject={(v) => updateStepField(index, 'subject', (step.subject || '') + ' ' + v)} />
                            </Box>
                            <TextField multiline minRows={6} fullWidth value={step.body} onChange={(e) => updateStepField(index, 'body', e.target.value)} placeholder="Write your custom copy stream here..." variant="standard"
                              slotProps={{ input: { disableUnderline: true, sx: { px: 1.5, py: 1, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6 } } }}
                            />
                          </Box>
                        </Stack>
                      )}
                    </CardContent>
                  </Card>
                );
              })}

              <Button fullWidth variant="outlined" color="inherit" startIcon={<Plus size={16} />} onClick={addStep} sx={{ py: 1.5, borderStyle: 'dashed', borderColor: 'divider', color: 'text.secondary', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Add Journey Step
              </Button>
            </>
          )}

          {activeTab === 'Schedule' && (
            <Card>
              <CardContent>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', pb: 1.5, mb: 2.5, borderBottom: 1, borderColor: 'divider' }}>
                  <Clock size={16} color="#2563EB" />
                  <Typography variant="overline" sx={{ fontWeight: 700 }}>Target Cadence Window</Typography>
                </Stack>
                {savedWindowNote && (
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 2, color: 'warning.main' }}>
                    <AlertTriangle size={14} />
                    <Typography variant="caption" sx={{ fontWeight: 600 }}>{savedWindowNote}</Typography>
                  </Stack>
                )}
                <Stack spacing={2.5}>
                  <FormControl fullWidth size="small">
                    <InputLabel>Outbox Timezone</InputLabel>
                    <Select label="Outbox Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                      {timezoneOptions.map(o => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
                    </Select>
                  </FormControl>
                  <Box>
                    <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', display: 'block', mb: 1, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Permitted Active Days</Typography>
                    <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
                      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => (
                        <ToggleButton key={day} value={day} selected={selectedDays.includes(day)} onChange={() => toggleDaySelection(day)} sx={{ flex: 1, py: 0.75, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>
                          {day}
                        </ToggleButton>
                      ))}
                    </Stack>
                  </Box>
                  <Box>
                    <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', display: 'block', mb: 1, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Cadence Delivery Window (Local Senders Clock)</Typography>
                    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                      <TextField fullWidth size="small" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>to</Typography>
                      <TextField fullWidth size="small" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                    </Stack>
                  </Box>
                </Stack>
              </CardContent>
            </Card>
          )}

          {activeTab === 'Options' && (
            <Card>
              <CardContent>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', pb: 1.5, mb: 2, borderBottom: 1, borderColor: 'divider' }}>
                  <ToggleLeft size={16} color="#2563EB" />
                  <Typography variant="overline" sx={{ fontWeight: 700 }}>Delivery Autopilot Flags</Typography>
                </Stack>
                <Stack spacing={1.5}>
                  {[
                    { label: 'Pause Sequence on Reply', desc: 'Stop further emails once a customer expresses interest.', val: stopOnReply, set: setStopOnReply, warning: replySyncWarning },
                    { label: 'Track Opens', desc: 'Embed a tracking pixel in HTML steps. Plain-text steps cannot track opens.', val: trackOpens, set: setTrackOpens, warning: null },
                    { label: 'Track Link Clicks', desc: 'Route links in HTML steps through the click tracker. Plain-text steps cannot track clicks.', val: trackClicks, set: setTrackClicks, warning: null },
                  ].map((f, i) => (
                    <Stack key={i} direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', p: 1.5, borderRadius: '14px', border: 1, borderColor: 'divider', bgcolor: 'action.hover' }}>
                      <Box>
                        <Typography variant="body2" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{f.label}</Typography>
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>{f.desc}</Typography>
                        {f.warning && (
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', mt: 0.75, color: 'warning.main' }}>
                            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                            <Typography variant="caption" sx={{ fontWeight: 600 }}>{f.warning}</Typography>
                          </Stack>
                        )}
                      </Box>
                      <Switch checked={f.val} onChange={(e) => f.set(e.target.checked)} />
                    </Stack>
                  ))}
                </Stack>
              </CardContent>
            </Card>
          )}

          {activeTab === 'Audience' && (
            <Card>
              <CardContent>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', pb: 1.5, mb: 2.5, borderBottom: 1, borderColor: 'divider' }}>
                  <Users size={16} color="#2563EB" />
                  <Typography variant="overline" sx={{ fontWeight: 700 }}>Audience Selection</Typography>
                </Stack>
                <Stack spacing={2}>
                  <FormControl fullWidth size="small">
                    <InputLabel>Target CRM List</InputLabel>
                    <Select label="Target CRM List" value={audienceCohort} onChange={(e) => setAudienceCohort(e.target.value)}>
                      <MenuItem value="Valid">All Active Valid Leads ({campaign?.telemetry?.validLeadsCount || 0})</MenuItem>
                      <MenuItem value="Unverified">All Unverified Leads ({campaign?.telemetry?.unverifiedLeadsCount || 0})</MenuItem>
                      {groups.map((g: any) => <MenuItem key={g.id} value={g.id}>Segment: {g.name} ({g._count?.leads || 0})</MenuItem>)}
                    </Select>
                  </FormControl>
                  <Card sx={{ bgcolor: (t) => alpha(t.palette.primary.main, 0.06), borderColor: (t) => alpha(t.palette.primary.main, 0.2) }}>
                    <CardContent>
                      <Typography variant="overline" sx={{ color: 'primary.main', fontWeight: 700 }}>Active Enrollments</Typography>
                      <Typography variant="h4" sx={{ fontWeight: 700, mt: 0.5 }}>{campaign?.telemetry?.activeEnrollments || 0}</Typography>
                      <Typography variant="caption" sx={{ color: 'primary.main' }}>Leads still in the sequence. Paused, completed, failed, bounced and removed leads are not counted.</Typography>
                    </CardContent>
                  </Card>
                </Stack>
              </CardContent>
            </Card>
          )}

          {activeTab === 'Senders' && (
            <Card>
              <CardContent>
                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', pb: 1.5, mb: 2.5, borderBottom: 1, borderColor: 'divider' }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Mail size={16} color="#2563EB" />
                    <Typography variant="overline" sx={{ fontWeight: 700 }}>Campaign Senders Pool & Rotation</Typography>
                  </Stack>
                  <Chip size="small" label={`${poolIds.length || 1} Active ${(poolIds.length || 1) === 1 ? 'Sender' : 'Senders'}`} color="primary" variant="outlined" sx={{ fontWeight: 700 }} />
                </Stack>
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 2, lineHeight: 1.6 }}>
                  Spreading outbound across multiple mailboxes protects sender reputation and circumvents daily provider caps. The send engine routes each dispatch via the least-loaded mailbox.
                </Typography>
                {replySyncWarning && (
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', mb: 2, color: 'warning.main' }}>
                    <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                    <Typography variant="caption" sx={{ fontWeight: 600 }}>{replySyncWarning}</Typography>
                  </Stack>
                )}
                <Stack spacing={1.5}>
                  {ownerMailboxes.map((mailbox) => {
                    const isPrimary = primarySenderId === mailbox.id;
                    const isChecked = selectedPoolIds.includes(mailbox.id) || isPrimary;
                    const toggleCheckbox = () => {
                      if (isPrimary) { showToast('The primary sender is always included.', 'error'); return; }
                      setSelectedPoolIds(prev => isChecked ? prev.filter(id => id !== mailbox.id) : [...prev, mailbox.id]);
                    };
                    const makePrimary = () => {
                      setPrimarySenderId(mailbox.id);
                      if (!selectedPoolIds.includes(mailbox.id)) setSelectedPoolIds(prev => [...prev, mailbox.id]);
                    };
                    return (
                      <Card key={mailbox.id} variant="outlined" sx={{ bgcolor: isPrimary ? (t) => alpha(t.palette.primary.main, 0.06) : isChecked ? 'action.hover' : 'background.paper', borderColor: isPrimary ? 'primary.main' : 'divider', opacity: isChecked ? 1 : 0.6 }}>
                        <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                          <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', gap: 1.5 }}>
                            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flex: 1 }}>
                              <Checkbox size="small" checked={isChecked} disabled={isPrimary} onChange={toggleCheckbox} />
                              <Box>
                                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                                  <Typography variant="body2" sx={{ fontWeight: 700 }}>{mailbox.name || 'SMTP Account'}</Typography>
                                  <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>({mailbox.emailAddress})</Typography>
                                  {isPrimary && <Chip size="small" label="PRIMARY" color="primary" sx={{ height: 16, fontSize: 8, fontWeight: 800 }} />}
                                  {mailbox.warmupEnabled && <Chip size="small" label="WARMUP" color="warning" sx={{ height: 16, fontSize: 8, fontWeight: 800 }} />}
                                </Stack>
                                <Stack direction="row" spacing={2} sx={{ mt: 0.5, color: 'text.secondary', fontSize: 10 }}>
                                  <span>Provider: <Box component="strong" sx={{ color: 'text.primary' }}>{mailbox.provider}</Box></span>
                                  <Box component="strong" sx={{ color: imapSyncState(mailbox) === 'failing' ? 'error.main' : undefined }}>{IMAP_SYNC_LABELS[imapSyncState(mailbox)]}</Box>
                                  <span>Last 24 Hours: <Box component="strong">{mailbox.sentLast24Hours} / {mailbox.effectiveDailyCap}</Box></span>
                                  <span>Total: <Box component="strong">{mailbox.sentTotal}</Box></span>
                                </Stack>
                              </Box>
                            </Stack>
                            {!isPrimary && (
                              <Button size="small" variant="outlined" color="inherit" onClick={makePrimary} sx={{ fontSize: 10, borderColor: 'divider', color: 'text.secondary' }}>
                                Set as Primary
                              </Button>
                            )}
                          </Stack>
                        </CardContent>
                      </Card>
                    );
                  })}
                  {ownerMailboxes.length === 0 && (
                    <Typography variant="caption" sx={{ color: listErrors.mailboxes ? 'error.main' : 'text.secondary', textAlign: 'center', py: 4, display: 'block' }}>
                      {listErrors.mailboxes
                        ? 'Mailboxes could not be loaded, so the sender pool is not shown. Use Retry above.'
                        : 'No sender accounts owned by the campaign owner. Create mailboxes in the Accounts page first.'}
                    </Typography>
                  )}
                </Stack>
              </CardContent>
            </Card>
          )}
        </Box>

        {/* Sidebar */}
        <Stack spacing={2.5}>
          <Card sx={{ bgcolor: (t) => alpha(t.palette.primary.main, 0.06), borderColor: (t) => alpha(t.palette.primary.main, 0.2) }}>
            <CardContent>
              <Typography variant="overline" sx={{ color: 'primary.main', fontWeight: 700, display: 'block', mb: 1.5 }}>Campaign Outline</Typography>
              <Stack spacing={1} sx={{ fontSize: 12 }}>
                <Stack direction="row" sx={{ justifyContent: 'space-between', pb: 0.75, borderBottom: 1, borderColor: 'divider' }}><span>Total Emails</span><Box component="strong">{steps.length} Steps</Box></Stack>
                <Stack direction="row" sx={{ justifyContent: 'space-between', pb: 0.75, borderBottom: 1, borderColor: 'divider' }}><span>Duration</span><Box component="strong">{sequenceDurationDays(steps)} Days</Box></Stack>
                <Stack direction="row" sx={{ justifyContent: 'space-between' }}><span>Active Cohort</span><Box component="strong" sx={{ color: 'primary.main', fontFamily: 'monospace' }}>{campaign?.telemetry?.activeEnrollments || 0} leads</Box></Stack>
              </Stack>
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <Typography variant="overline" sx={{ fontWeight: 700, mb: 2, display: 'block' }}>Engagement Over Time</Typography>
              <Box sx={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={campaign?.telemetry?.trend || []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="cd-o" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#4f46e5" stopOpacity={0.2}/><stop offset="95%" stopColor="#4f46e5" stopOpacity={0}/></linearGradient>
                      <linearGradient id="cd-c" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#818cf8" stopOpacity={0.15}/><stop offset="95%" stopColor="#818cf8" stopOpacity={0}/></linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" className="text-slate-200 dark:text-slate-800/80" />
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10 }} dy={10} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10 }} allowDecimals={false} />
                    <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid rgba(100,116,139,0.2)', fontSize: 11 }} />
                    <Area type="monotone" dataKey="opens" stroke="#4f46e5" strokeWidth={2} fillOpacity={1} fill="url(#cd-o)" name="Unique Opens" />
                    <Area type="monotone" dataKey="clicks" stroke="#818cf8" strokeWidth={2} fillOpacity={1} fill="url(#cd-c)" name="Unique Clicks" />
                  </AreaChart>
                </ResponsiveContainer>
              </Box>
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <Typography variant="overline" sx={{ fontWeight: 700, mb: 2, display: 'block' }}>Conversion Funnel</Typography>
              <Box sx={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart layout="vertical" data={campaign?.telemetry?.funnel || []} margin={{ top: 5, right: 5, left: 10, bottom: 5 }}>
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
              <Typography variant="overline" sx={{ fontWeight: 700, mb: 2, display: 'block' }}>Sentiment Distribution</Typography>
              <Box sx={{ height: 200, position: 'relative' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={(campaign?.telemetry?.sentiment || []).filter((s: any) => s.value > 0)} cx="50%" cy="50%" innerRadius={45} outerRadius={65} paddingAngle={3} dataKey="value" nameKey="name">
                      {(campaign?.telemetry?.sentiment || []).filter((s: any) => s.value > 0).map((entry: any, index: number) => {
                        const colors: Record<string, string> = { 'Neutral': '#94a3b8', 'Interested': '#10b981', 'Not Interested': '#f43f5e', 'Meeting Booked': '#6366f1', 'Out of Office': '#f59e0b', 'Bounced': '#8b5cf6', 'Unsubscribed': '#475569' };
                        return <Cell key={`cell-${index}`} fill={colors[entry.name] || '#3b82f6'} />;
                      })}
                    </Pie>
                    <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid rgba(100,116,139,0.2)', fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
                {(!campaign?.telemetry?.sentiment || campaign?.telemetry?.sentiment.every((s: any) => s.value === 0)) && (
                  <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>No leads enrolled.</Typography>
                  </Box>
                )}
              </Box>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 0.75, mt: 1, fontSize: 9 }}>
                {campaign?.telemetry?.sentiment?.filter((s: any) => s.value > 0).map((s: any, idx: number) => {
                  const colors: Record<string, string> = { 'Neutral': '#94a3b8', 'Interested': '#10b981', 'Not Interested': '#f43f5e', 'Meeting Booked': '#6366f1', 'Out of Office': '#f59e0b', 'Bounced': '#8b5cf6', 'Unsubscribed': '#475569' };
                  return (
                    <Stack key={idx} direction="row" spacing={0.5} sx={{ alignItems: 'center', color: 'text.secondary' }}>
                      <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: colors[s.name] || '#3b82f6' }} />
                      <Typography variant="caption" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}: {s.value}</Typography>
                    </Stack>
                  );
                })}
              </Box>
            </CardContent>
          </Card>
        </Stack>
      </Box>

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
    </Box>
  );
}

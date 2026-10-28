/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable react-hooks/exhaustive-deps */
'use client';

import {
  CornerUpLeft, Send, MailOpen, Pause, Play, ChevronDown, RefreshCw, Download, Loader2,
} from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { toCsv, downloadCsv } from '@/lib/csv';
import { decodeMimeHeader } from '@/lib/mime';
import { LoadError, loadErrorMessage, readJsonObject } from '@/lib/apiResponse';
import { Snackbar, Alert, Menu, MenuItem, Tooltip as MuiTooltip } from '@mui/material';
import { CRM_STATUSES, OPT_OUT_REASONS, SUPPRESSION_LABELS, replyBlockedReason } from '@/lib/suppression';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SearchInput } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { cn } from '@/lib/utils';

const STATUS_TONES: Record<string, BadgeTone> = {
  Interested: 'green',
  Not_Interested: 'red',
  Meeting_Booked: 'blue',
  Out_of_Office: 'amber',
};

const STATUS_DOTS: Record<BadgeTone, string> = {
  green: 'bg-emerald-500',
  red: 'bg-rose-500',
  blue: 'bg-blue-500',
  amber: 'bg-amber-500',
  neutral: 'bg-slate-400',
};

const AVATAR = 'flex shrink-0 items-center justify-center rounded-full bg-slate-100 font-semibold text-text-sub dark:bg-white/5';
const ME_AVATAR = 'mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-on-primary';
const OUT_BUBBLE = 'max-w-[80%] rounded-card rounded-tr-sm border border-primary/20 bg-primary-subtle p-3.5';
const MESSAGE_TEXT = 'text-[13px] leading-relaxed whitespace-pre-wrap text-text-main';

const readableStatus: Record<string, string> = {
  Neutral: 'Neutral',
  Interested: 'Interested',
  Not_Interested: 'Not Interested',
  Meeting_Booked: 'Meeting Booked',
  Out_of_Office: 'Out of Office',
  Bounced: 'Bounced',
  Unsubscribed: 'Unsubscribed',
};

const autoReplyLabels: Record<string, string> = {
  bounce: 'Bounce',
  'out-of-office': 'Out of Office',
  'auto-reply': 'Auto-Reply',
};

function isOptOut(lead: any): boolean {
  return !!lead?.suppression && OPT_OUT_REASONS.includes(lead.suppression.reason);
}

function leadSuppression(lead: any): { chip: string; color: 'warning' | 'error'; detail: string } | null {
  const label = lead?.suppression ? SUPPRESSION_LABELS[lead.suppression.reason as keyof typeof SUPPRESSION_LABELS] : null;
  if (!label) return null;
  return {
    chip: label.chip,
    color: label.chip === 'Unsubscribed' ? 'warning' : 'error',
    detail: `On the suppression list because ${label.cause}. ${isOptOut(lead) ? 'ArcReach never emails this address, campaigns and replies alike' : 'Campaigns never email this address'}, whatever the lead status.`,
  };
}

function showsStatusChip(lead: any): boolean {
  return !lead?.suppression || CRM_STATUSES.includes(lead?.status || 'Neutral');
}

const THREAD_PAGE_SIZE = 50;

function formatWhen(value: string | Date, withTime = false): string {
  const date = new Date(value);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return time;
  const day = date.toLocaleDateString([], {
    month: 'short', day: 'numeric', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return withTime ? `${day}, ${time}` : day;
}

function sanitizeEmailBody(body: string): string {
  if (!body) return '';
  let text = body;
  const boundaryMatch = text.match(/Content-Type:\s*multipart\/\w+;\s*boundary=["']?([^\s"';\r\n]+)["']?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = text.split('--' + boundary);
    for (const part of parts) {
      if (/Content-Type:\s*text\/plain/i.test(part)) {
        const blankLine = part.search(/\r?\n\r?\n/);
        if (blankLine !== -1) {
          const match = part.match(/\r?\n\r?\n/);
          text = part.substring(blankLine + (match ? match[0].length : 2)).trim();
          break;
        }
      }
    }
  } else if (/^Content-Type:\s*text\/plain/im.test(text.substring(0, 300))) {
    const blankLine = text.search(/\r?\n\r?\n/);
    if (blankLine !== -1) {
      const match = text.match(/\r?\n\r?\n/);
      text = text.substring(blankLine + (match ? match[0].length : 2)).trim();
    }
  }
  text = text.replace(/=([0-9A-F]{2})/gi, (_, hex) => { try { return String.fromCharCode(parseInt(hex, 16)); } catch { return _; } });
  text = text.replace(/=+(?:\r?\n|$)/g, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/?(p|div|tr|li|blockquote|h[1-6])[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
  const lines = text.split(/\r?\n/);
  const cleaned: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]; const t = line.trim();
    if (/^On\s+/i.test(t)) {
      let combined = t;
      for (let j = 1; j <= 2 && (i + j) < lines.length; j++) combined += ' ' + lines[i + j].trim();
      if (/wrote:\s*$/.test(combined)) break;
    }
    if (/^-----\s*Original Message\s*-----/i.test(t)) break;
    if (/^_{3,}\s*$/.test(t) && i > 0) break;
    if (/^From:\s+\S+@\S+/i.test(t) && cleaned.length > 0) break;
    if (/^Sent:\s+/i.test(t) && cleaned.length > 0) break;
    if (/^Date:\s+/i.test(t) && cleaned.length > 0) break;
    if (/^Subject:\s+/i.test(t) && cleaned.length > 0) break;
    if (/^To:\s+\S+@\S+/i.test(t) && cleaned.length > 0) break;
    if (t.startsWith('>')) continue;
    if (/^Content-Type:\s/i.test(t)) continue;
    if (/^Content-Transfer-Encoding:\s/i.test(t)) continue;
    if (/^MIME-Version:\s/i.test(t)) continue;
    if (/^Content-Disposition:\s/i.test(t)) continue;
    if (/^Message-ID:\s/i.test(t)) continue;
    if (/^In-Reply-To:\s/i.test(t)) continue;
    if (/^References:\s/i.test(t)) continue;
    if (/^BODY\[/i.test(t)) continue;
    if (/^HEADER\.FIELDS/i.test(t)) continue;
    if (/^charset=/i.test(t)) continue;
    if (/^--[a-zA-Z0-9_=.+/-]{10,}--?$/.test(t)) continue;
    if (/^\{\d+\}$/.test(t)) continue;
    cleaned.push(line);
  }
  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function readThreadPage(res: Response) {
  const data = await readJsonObject(res, 'Conversations');
  if (!Array.isArray(data.threads)) throw new LoadError('Conversations could not be loaded: the server did not send a list.');
  return data;
}

export default function UniboxPage() {
  const [replies, setReplies] = useState<any[]>([]);
  const [totalThreads, setTotalThreads] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [appliedQuery, setAppliedQuery] = useState('');
  const [threadMessages, setThreadMessages] = useState<Record<string, any[]>>({});
  const [messagesErrorId, setMessagesErrorId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const listRequest = useRef(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [listLoaded, setListLoaded] = useState(false);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusMenuAnchor, setStatusMenuAnchor] = useState<HTMLElement | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [toastMessage, setToastMessage] = useState('');
  const [sentRepliesLocal, setSentRepliesLocal] = useState<Record<string, Array<{ body: string; sentAt: string }>>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sendingReply, setSendingReply] = useState(false);

  const showToast = (message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(''), 3000);
  };

  const markAsRead = async (thread: any) => {
    if (!thread?.unread) return;
    try {
      const res = await fetch('/api/unibox', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId: thread.leadId, normalizedSubject: thread.normalizedSubject, unread: false }),
      });
      if (res.ok) {
        setReplies(prev => prev.map(r => r.id === thread.id ? { ...r, unread: false } : r));
        setUnreadCount(count => Math.max(0, count - 1));
      }
    } catch (err) { console.error(err); }
  };

  const loadThreadMessages = async (id: string) => {
    setMessagesErrorId(prev => (prev === id ? null : prev));
    try {
      const res = await fetch(`/api/unibox?thread=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`Loading the conversation failed (${res.status}).`);
      const data = await res.json();
      setThreadMessages(prev => ({ ...prev, [id]: data.messages }));
    } catch (e) {
      console.error(e);
      setMessagesErrorId(id);
    }
  };

  const fetchReplies = async (initial = false, query = appliedQuery) => {
    const request = ++listRequest.current;
    try {
      if (initial) setLoading(true);
      const params = new URLSearchParams();
      if (!initial) params.set('sync', 'true');
      if (query) params.set('q', query);
      if (!initial && query === appliedQuery && replies.length > THREAD_PAGE_SIZE) params.set('limit', String(replies.length));
      const res = await fetch(`/api/unibox${params.toString() ? `?${params}` : ''}`);
      if (request !== listRequest.current) return;
      const data = await readThreadPage(res);
      if (request !== listRequest.current) return;
      setReplies(data.threads);
      setTotalThreads(data.total);
      setUnreadCount(data.unreadCount);
      setNextOffset(data.nextOffset);
      setAppliedQuery(query);
      setListLoaded(true);
      setListError('');
      if (initial && data.threads.length > 0 && !selectedId) {
        setSelectedId(data.threads[0].id);
        markAsRead(data.threads[0]);
        loadThreadMessages(data.threads[0].id);
      }
      setSentRepliesLocal({});
      if (!initial) {
        setThreadMessages({});
        if (selectedId) loadThreadMessages(selectedId);
      }
    } catch (e) {
      console.error(e);
      if (request === listRequest.current) setListError(loadErrorMessage(e, 'Conversations'));
    }
    finally { if (initial) setLoading(false); }
  };

  const retryList = () => {
    const query = searchQuery.trim();
    if (listLoaded && query !== appliedQuery) setSearchAttempt(n => n + 1);
    else fetchReplies(!listLoaded, query);
  };

  const loadMoreThreads = async () => {
    if (nextOffset === null || loadingMore) return;
    const request = listRequest.current;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ offset: String(nextOffset) });
      if (appliedQuery) params.set('q', appliedQuery);
      const res = await fetch(`/api/unibox?${params}`);
      const data = await readThreadPage(res);
      if (request === listRequest.current) {
        setReplies(prev => [...prev, ...data.threads.filter((t: any) => !prev.some(p => p.id === t.id))]);
        setTotalThreads(data.total);
        setUnreadCount(data.unreadCount);
        setNextOffset(data.nextOffset);
      }
    } catch (e) { console.error(e); showToast(loadErrorMessage(e, 'More conversations')); }
    finally { setLoadingMore(false); }
  };

  useEffect(() => { fetchReplies(true); }, []);

  useEffect(() => {
    const query = searchQuery.trim();
    if (query === appliedQuery) return;
    const timer = setTimeout(() => {
      const request = ++listRequest.current;
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      fetch(`/api/unibox${params.toString() ? `?${params}` : ''}`)
        .then(async res => {
          if (request !== listRequest.current) return;
          const data = await readThreadPage(res);
          if (request !== listRequest.current) return;
          setReplies(data.threads);
          setTotalThreads(data.total);
          setUnreadCount(data.unreadCount);
          setNextOffset(data.nextOffset);
          setAppliedQuery(query);
          setListLoaded(true);
          setListError('');
        })
        .catch(e => {
          console.error(e);
          if (request === listRequest.current) {
            setListError(`${loadErrorMessage(e, 'Search results')}${listLoaded ? ' The list shows the conversations from before this search.' : ''}`);
          }
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, appliedQuery, listLoaded, searchAttempt]);

  const selectedEmail = replies.find(e => e.id === selectedId);
  const selectedMessages: any[] | undefined = selectedId ? threadMessages[selectedId] : undefined;
  const selectedSuppression = leadSuppression(selectedEmail?.lead);
  const replyBlocked = selectedEmail ? replyBlockedReason(selectedEmail.lead ?? {}, date => date.toLocaleDateString()) : null;
  const selectedSequence: any[] = (selectedEmail?.lead?.enrollments || []).filter((e: any) => e.status === 'Active' || e.status === 'Paused');
  const sequencePaused = selectedSequence.some((e: any) => e.status === 'Paused');
  const answeredReply = [...(selectedMessages || [])].reverse().find((m: any) => m.type === 'inbound');
  const currentReplyText = selectedEmail ? (drafts[selectedEmail.id] || '') : '';
  const setReplyText = (newText: string) => {
    if (!selectedEmail) return;
    setDrafts(prev => ({ ...prev, [selectedEmail.id]: newText }));
  };

  const handleSelectThread = (thread: any) => {
    setSelectedId(thread.id);
    markAsRead(thread);
    if (!threadMessages[thread.id]) loadThreadMessages(thread.id);
  };

  const handleExportCSV = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const exported = new Map<string, any>();
      let offset: number | null = 0;
      while (offset !== null) {
        const params: URLSearchParams = new URLSearchParams({ export: 'replies', offset: String(offset) });
        if (appliedQuery) params.set('q', appliedQuery);
        const res = await fetch(`/api/unibox?${params}`);
        if (!res.ok) { showToast('Failed to export replies.'); return; }
        const data = await res.json();
        for (const reply of data.replies) exported.set(reply.id, reply);
        offset = data.nextOffset !== null && data.nextOffset > offset ? data.nextOffset : null;
      }
      const rows: Record<string, any>[] = Array.from(exported.values()).map((msg: any) => ({
        receivedAt: msg.receivedAt,
        leadEmail: msg.lead?.email || '',
        leadName: msg.lead?.name || '',
        company: msg.lead?.company || '',
        campaign: msg.campaign?.name || msg.lead?.enrollments?.[0]?.campaign?.name || '',
        senderAccount: msg.senderAccount?.emailAddress || '',
        subject: msg.subject,
        body: msg.body,
        unread: msg.unread ? 'true' : 'false',
        leadStatus: msg.lead?.status || 'Neutral',
      }));
      if (rows.length === 0) { showToast('No replies to export.'); return; }
      const columns = [
        { key: 'receivedAt', label: 'Received At' },
        { key: 'leadEmail', label: 'Lead Email' },
        { key: 'leadName', label: 'Lead Name' },
        { key: 'company', label: 'Company' },
        { key: 'campaign', label: 'Campaign' },
        { key: 'senderAccount', label: 'Sender Account' },
        { key: 'subject', label: 'Subject' },
        { key: 'body', label: 'Body' },
        { key: 'unread', label: 'Unread' },
        { key: 'leadStatus', label: 'Lead Status' },
      ];
      const csvContent = toCsv(rows, columns);
      const dateStr = new Date().toISOString().split('T')[0];
      downloadCsv(`replies-${dateStr}.csv`, csvContent);
      showToast(`Successfully exported ${rows.length} replies to CSV.`);
    } catch (e) { console.error(e); showToast('Failed to export replies.'); }
    finally { setExporting(false); }
  };

  const handleUpdateStatus = async (statusKey: string) => {
    if (!selectedEmail) return;
    try {
      const res = await fetch('/api/unibox', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId: selectedEmail.lead.id, leadStatus: statusKey }),
      });
      if (res.ok) {
        setReplies(prev => prev.map(item => item.id === selectedId ? { ...item, lead: { ...item.lead, status: statusKey } } : item));
        showToast(selectedEmail.lead?.suppression
          ? `Lead status updated to ${readableStatus[statusKey]}. The address stays on the suppression list, so ${isOptOut(selectedEmail.lead) ? 'ArcReach never emails it, replies included' : 'campaigns never email it'}.`
          : `Lead status updated to ${readableStatus[statusKey]}`);
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Failed to update lead status.');
      }
    } catch (e) { console.error(e); }
    finally { setStatusMenuAnchor(null); }
  };

  const handleTogglePause = async () => {
    if (!selectedEmail || selectedSequence.length === 0) return;
    const nextStatus = sequencePaused ? 'Active' : 'Paused';
    const leadId = selectedEmail.lead.id;
    try {
      const res = await fetch('/api/unibox', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId, normalizedSubject: selectedEmail.normalizedSubject, enrollmentStatus: nextStatus }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'Failed to update the sequence.');
        return;
      }
      const statusById = new Map<string, string>((data.enrollments || []).map((en: any) => [en.id, en.status]));
      setReplies(prev => prev.map(item => item.lead?.id === leadId
        ? { ...item, lead: { ...item.lead, enrollments: (item.lead.enrollments || []).map((en: any) => statusById.has(en.id) ? { ...en, status: statusById.get(en.id) } : en) } }
        : item));
      const changed = data.changed || 0;
      showToast(changed === 0
        ? (nextStatus === 'Paused' ? 'No active sequence to pause for this prospect.' : 'No paused sequence to resume for this prospect.')
        : `Sequence ${nextStatus === 'Paused' ? 'paused' : 'resumed'} for this prospect in ${changed} campaign${changed === 1 ? '' : 's'}.`);
    } catch (e) { console.error(e); showToast('Failed to update the sequence.'); }
  };

  const handleDispatchReply = async () => {
    if (!selectedEmail || !answeredReply || !currentReplyText.trim() || sendingReply || replyBlocked) return;
    setSendingReply(true);
    try {
      const res = await fetch('/api/unibox/reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          responseId: answeredReply.id,
          body: currentReplyText,
          senderAccountId: answeredReply.senderAccountId,
        }),
      });
      if (res.ok) {
        const newReply = { body: currentReplyText, sentAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
        setSentRepliesLocal(prev => ({ ...prev, [selectedEmail.id]: [...(prev[selectedEmail.id] || []), newReply] }));
        setReplyText('');
        showToast(`Reply sent to ${selectedEmail.lead.email}!`);
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Failed to dispatch reply.');
      }
    } catch (err) { console.error(err); showToast('Error occurred dispatching reply.'); }
    finally { setSendingReply(false); }
  };

  const selectedStatus = selectedEmail?.lead?.status || 'Neutral';
  const selectedTone = STATUS_TONES[selectedStatus] ?? 'neutral';

  return (
    <div className="flex h-[calc(100vh-6rem)] gap-4 pb-2">
      <Snackbar open={!!toastMessage} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} autoHideDuration={3000} onClose={() => setToastMessage('')}>
        {toastMessage ? <Alert severity="info" variant="filled" sx={{ borderRadius: '12px' }}>{toastMessage}</Alert> : undefined}
      </Snackbar>

      {/* Left pane: thread list */}
      <Card className="flex w-[340px] shrink-0 flex-col overflow-hidden md:w-[380px]">
        <div className="space-y-3 border-b border-card-border p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold text-text-main">Unified Inbox</h1>
              {listLoaded && <Badge tone="blue">{unreadCount} Unread</Badge>}
            </div>
            <div className="flex items-center gap-0.5">
              <MuiTooltip title="Export to CSV">
                <Button variant="ghost" size="sm" iconOnly aria-label="Export to CSV" onClick={handleExportCSV} disabled={exporting}>
                  {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                </Button>
              </MuiTooltip>
              <MuiTooltip title="Refresh">
                <Button variant="ghost" size="sm" iconOnly aria-label="Refresh replies" onClick={() => fetchReplies(false)}>
                  <RefreshCw size={14} />
                </Button>
              </MuiTooltip>
            </div>
          </div>
          <SearchInput
            aria-label="Search contacts"
            placeholder="Search contacts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 p-6 text-xs text-text-muted">
            <Loader2 size={14} className="animate-spin" /> Syncing inbox…
          </div>
        ) : (
          <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
            {listError && (
              <Notice
                tone={listLoaded ? 'warning' : 'error'}
                title={listLoaded ? 'Conversations Could Not Be Refreshed' : 'Conversations Could Not Be Loaded'}
                className="mb-2 flex-col gap-2"
                action={<Button size="sm" onClick={retryList}><RefreshCw size={12} /> Retry</Button>}
              >
                {listError}
              </Notice>
            )}

            {replies.map(item => {
              const leadPaused = item.lead?.enrollments?.some((e: any) => e.status === 'Paused');
              const suppressed = leadSuppression(item.lead);
              const isSelected = selectedId === item.id;
              const status = item.lead?.status || 'Neutral';

              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={isSelected || undefined}
                  onClick={() => handleSelectThread(item)}
                  className={cn(
                    'block w-full cursor-pointer rounded-control border p-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none',
                    isSelected ? 'border-primary/40 bg-primary-subtle' : 'border-transparent hover:bg-slate-50 dark:hover:bg-white/[0.03]',
                  )}
                >
                  <span className="mb-1 flex items-start justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="relative shrink-0">
                        <span className={cn(AVATAR, 'size-7 text-[11px]')}>
                          {(item.lead?.name || item.lead?.email || 'P').charAt(0).toUpperCase()}
                        </span>
                        {item.unread && (
                          <span role="img" aria-label="Unread" className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-primary ring-2 ring-card" />
                        )}
                      </span>
                      <span className={cn('truncate text-[13px]', item.unread ? 'font-semibold text-text-main' : 'font-medium text-text-sub')}>
                        {item.lead?.name || item.lead?.email || 'Prospect'}
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] text-text-muted">{formatWhen(item.receivedAt)}</span>
                  </span>

                  <span className="mb-1 flex items-center justify-between gap-1.5 pl-9">
                    <span className={cn('truncate text-xs', item.unread ? 'font-semibold text-text-main' : 'text-text-main')}>
                      {decodeMimeHeader(item.subject)}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {leadPaused && <Badge tone="red">Paused</Badge>}
                      {suppressed && (
                        <MuiTooltip title={suppressed.detail}>
                          <span className="cursor-help"><Badge tone="amber">{suppressed.chip}</Badge></span>
                        </MuiTooltip>
                      )}
                      {showsStatusChip(item.lead) && <Badge tone={STATUS_TONES[status] ?? 'neutral'}>{readableStatus[status]}</Badge>}
                    </span>
                  </span>

                  <span className="line-clamp-1 pl-9 text-xs text-text-muted">{sanitizeEmailBody(item.preview)}</span>
                </button>
              );
            })}

            {replies.length === 0 && !listError && (
              <div className="py-12 text-center text-xs text-text-muted">No matching records found.</div>
            )}

            {nextOffset !== null && (
              <div className="flex flex-col items-center gap-1.5 pt-2 pb-3">
                <span className="text-[11px] text-text-muted">Showing {replies.length} of {totalThreads} conversations</span>
                <Button size="sm" onClick={loadMoreThreads} disabled={loadingMore}>
                  {loadingMore && <Loader2 size={12} className="animate-spin" />} Load More
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Right pane: the conversation and the reply composer */}
      <Card className="flex flex-1 flex-col overflow-hidden">
        {selectedEmail ? (
          <>
            <div className="flex items-center justify-between gap-4 border-b border-card-border p-4">
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold text-text-main">{decodeMimeHeader(selectedEmail.subject)}</h2>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className={cn(AVATAR, 'size-6 bg-primary-subtle text-[10px] text-primary dark:bg-primary-subtle')}>
                    {(selectedEmail.lead?.name || 'P').charAt(0).toUpperCase()}
                  </span>
                  <span className="text-xs font-medium text-text-main">{selectedEmail.lead?.name || 'Prospect'}</span>
                  <span className="text-xs text-text-muted">{selectedEmail.lead?.email}</span>
                  {sequencePaused && <Badge tone="red">Paused Sequence</Badge>}
                  {selectedSuppression && (
                    <MuiTooltip title={selectedSuppression.detail}>
                      <span tabIndex={0} className="cursor-help rounded-md focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none">
                        <Badge tone="amber">{selectedSuppression.chip}</Badge>
                      </span>
                    </MuiTooltip>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <MuiTooltip title={selectedSequence.length === 0 ? 'No Active or Paused Sequence' : sequencePaused ? 'Resume Sequence' : 'Pause Sequence'}>
                  <span>
                    <Button
                      size="sm" iconOnly
                      aria-label={sequencePaused ? 'Resume sequence' : 'Pause sequence'}
                      onClick={handleTogglePause}
                      disabled={selectedSequence.length === 0}
                      className={cn(sequencePaused && 'text-emerald-600 dark:text-emerald-400')}
                    >
                      {sequencePaused ? <Play size={14} /> : <Pause size={14} />}
                    </Button>
                  </span>
                </MuiTooltip>

                <Button
                  size="sm"
                  aria-haspopup="menu"
                  aria-expanded={!!statusMenuAnchor}
                  aria-label={`Lead status: ${readableStatus[selectedStatus]}`}
                  onClick={(e) => setStatusMenuAnchor(e.currentTarget)}
                >
                  <span aria-hidden className={cn('size-1.5 rounded-full', STATUS_DOTS[selectedTone])} />
                  {readableStatus[selectedStatus]}
                  <ChevronDown size={12} className="text-text-muted" />
                </Button>
                <Menu
                  anchorEl={statusMenuAnchor}
                  open={!!statusMenuAnchor}
                  onClose={() => setStatusMenuAnchor(null)}
                  anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                  transformOrigin={{ vertical: 'top', horizontal: 'right' }}
                  slotProps={{
                    backdrop: { invisible: true, sx: { backgroundColor: 'transparent', backdropFilter: 'none' } },
                    paper: { sx: { mt: 0.5, minWidth: 176, borderRadius: '8px', border: 1, borderColor: 'divider', boxShadow: '0 8px 24px rgba(15,23,42,0.12)' } },
                  }}
                >
                  {CRM_STATUSES.map(k => (
                    <MenuItem key={k} selected={k === selectedStatus} onClick={() => handleUpdateStatus(k)} sx={{ gap: 1, fontSize: 13, minHeight: 32 }}>
                      <span aria-hidden className={cn('size-1.5 rounded-full', STATUS_DOTS[STATUS_TONES[k] ?? 'neutral'])} />
                      {readableStatus[k]}
                    </MenuItem>
                  ))}
                </Menu>
              </div>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto bg-slate-50/60 p-4 md:p-6 dark:bg-white/[0.015]">
              {!selectedMessages && (messagesErrorId === selectedEmail.id ? (
                <div className="flex flex-col items-center justify-center gap-2 py-12">
                  <span className="text-xs text-text-muted">Could not load this conversation.</span>
                  <Button size="sm" onClick={() => loadThreadMessages(selectedEmail.id)}>
                    <RefreshCw size={12} /> Retry
                  </Button>
                </div>
              ) : (
                <div className="flex justify-center py-12 text-text-muted">
                  <Loader2 size={18} className="animate-spin" aria-label="Loading conversation" />
                </div>
              ))}

              {(selectedMessages || []).map((msg: any) => {
                const outbound = msg.type === 'outbound';
                return (
                  <div key={msg.id} className={cn('flex items-start gap-2.5', outbound ? 'justify-end' : 'justify-start')}>
                    {!outbound && (
                      <span className={cn(AVATAR, 'mt-1 size-7 bg-slate-200 text-[10px] dark:bg-white/10')}>
                        {(selectedEmail.lead?.name || 'P').charAt(0).toUpperCase()}
                      </span>
                    )}
                    <div className={outbound ? OUT_BUBBLE : 'max-w-[80%] rounded-card rounded-tl-sm border border-card-border bg-card p-3.5'}>
                      {!outbound && msg.autoReply && (
                        <MuiTooltip title="Automated message. It did not pause the sequence and does not count as a reply.">
                          <span tabIndex={0} className="mb-1.5 inline-block cursor-help rounded-md focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none">
                            <Badge tone="amber">{autoReplyLabels[msg.autoReply] || 'Auto-Reply'}</Badge>
                          </span>
                        </MuiTooltip>
                      )}
                      <p className={MESSAGE_TEXT}>{outbound ? msg.body : sanitizeEmailBody(msg.body)}</p>
                      {!outbound && msg.bodyUnavailable && (
                        <p className="mt-1 text-xs text-text-muted italic">
                          The text of this reply could not be read. Open it in the mailbox to see it.
                        </p>
                      )}
                      <div className={cn('mt-2 text-[11px] text-text-muted', outbound ? 'text-right' : 'text-left')}>
                        {formatWhen(msg.timestamp, true)}
                      </div>
                    </div>
                    {outbound && <span className={ME_AVATAR}>Me</span>}
                  </div>
                );
              })}

              {(sentRepliesLocal[selectedEmail.id] || []).map((sent, index) => (
                <div key={`local-${index}`} className="flex items-start justify-end gap-2.5">
                  <div className={OUT_BUBBLE}>
                    <p className={MESSAGE_TEXT}>{sent.body}</p>
                    <div className="mt-2 text-right text-[11px] text-text-muted">{sent.sentAt}</div>
                  </div>
                  <span className={ME_AVATAR}>Me</span>
                </div>
              ))}
            </div>

            <div className="border-t border-card-border p-4">
              <div className="overflow-hidden rounded-control border border-input-border bg-card transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
                <div className="flex items-center gap-2 border-b border-card-border bg-slate-50/70 px-3 py-2 dark:bg-white/[0.02]">
                  <CornerUpLeft size={14} className="text-text-muted" />
                  <span className="text-xs font-medium text-text-main">
                    Reply to {selectedEmail.lead?.name?.split(' ')[0] || 'Prospect'}
                  </span>
                </div>

                {replyBlocked ? (
                  <div className="min-h-[80px] px-3 py-3 text-xs leading-relaxed text-text-sub">{replyBlocked}</div>
                ) : (
                  <textarea
                    rows={3}
                    aria-label="Reply"
                    value={currentReplyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Type your reply here..."
                    className="block w-full resize-none bg-transparent p-3 text-[13px] leading-relaxed text-text-main placeholder:text-text-muted focus:outline-none"
                  />
                )}

                <div className="flex items-center justify-between border-t border-card-border px-3 py-2">
                  <span className="text-[11px] text-text-muted">Markdown supported</span>
                  <Button variant="primary" size="sm" onClick={handleDispatchReply} disabled={sendingReply || !answeredReply || !!replyBlocked}>
                    {sendingReply ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                    Send Reply
                  </Button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-text-muted">
            <MailOpen size={32} />
            <span className="text-[13px] font-medium text-text-sub">Select Conversation to Review</span>
          </div>
        )}
      </Card>
    </div>
  );
}

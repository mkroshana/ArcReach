/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable react-hooks/exhaustive-deps */
'use client';

import {
  Search, CornerUpLeft, Send, MailOpen, Pause, Play, ChevronDown, RefreshCw, Download,
} from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { toCsv, downloadCsv } from '@/lib/csv';
import { decodeMimeHeader } from '@/lib/mime';
import { LoadError, loadErrorMessage, readJsonObject } from '@/lib/apiResponse';
import {
  Button, Snackbar, Alert, AlertTitle, CircularProgress, Menu, MenuItem,
  Tooltip as MuiTooltip,
} from '@mui/material';
import { CRM_STATUSES, OPT_OUT_REASONS, SUPPRESSION_LABELS, replyBlockedReason } from '@/lib/suppression';

const statusColorMap: Record<string, 'success' | 'error' | 'primary' | 'warning' | 'default' | 'info'> = {
  Interested: 'success',
  Not_Interested: 'error',
  Meeting_Booked: 'primary',
  Out_of_Office: 'warning',
  Bounced: 'default',
  Unsubscribed: 'default',
  Neutral: 'info',
};

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

  return (
    <div className="h-[calc(100vh-6rem)] flex gap-4 md:gap-6 pb-2">
      <Snackbar open={!!toastMessage} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} autoHideDuration={3000} onClose={() => setToastMessage('')}>
        {toastMessage ? <Alert severity="info" variant="filled" sx={{ borderRadius: '12px' }}>{toastMessage}</Alert> : undefined}
      </Snackbar>

      {/* Left Pane: Thread List */}
      <div className="w-[340px] md:w-[380px] flex-shrink-0 flex flex-col rounded-2xl border border-[#EBF0F5] dark:border-[#1E222D] bg-white dark:bg-[#11131A] shadow-xs overflow-hidden">
        {/* Pane Header */}
        <div className="p-4 border-b border-[#EBF0F5] dark:border-[#1E222D] flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold tracking-tight text-slate-900 dark:text-white">
                Unified Inbox
              </h2>
              {listLoaded && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-900/40">
                  {unreadCount} Unread
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <MuiTooltip title="Export to CSV">
                <button
                  type="button"
                  aria-label="Export to CSV"
                  onClick={handleExportCSV}
                  disabled={exporting}
                  className="w-8 h-8 rounded-xl border border-[#EBF0F5] dark:border-[#1E222D] flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#161822] transition-colors cursor-pointer disabled:opacity-50"
                >
                  {exporting ? <CircularProgress size={13} /> : <Download size={14} />}
                </button>
              </MuiTooltip>
              <MuiTooltip title="Refresh">
                <button
                  type="button"
                  aria-label="Refresh replies"
                  onClick={() => fetchReplies(false)}
                  className="w-8 h-8 rounded-xl border border-[#EBF0F5] dark:border-[#1E222D] flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#161822] transition-colors cursor-pointer"
                >
                  <RefreshCw size={14} />
                </button>
              </MuiTooltip>
            </div>
          </div>

          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
            <input
              type="text"
              placeholder="Search contacts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-xl text-xs bg-slate-50 dark:bg-[#161822] border border-[#EBF0F5] dark:border-[#1E222D] text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>
        </div>

        {/* Pane Content */}
        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6">
            <CircularProgress size={22} />
            <span className="text-xs text-slate-500 dark:text-slate-400 font-normal">Syncing inbox…</span>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {listError && (
              <Alert severity={listLoaded ? 'warning' : 'error'} sx={{ mb: 1, borderRadius: '16px' }}>
                <AlertTitle>{listLoaded ? 'Conversations Could Not Be Refreshed' : 'Conversations Could Not Be Loaded'}</AlertTitle>
                <div className="text-xs">{listError}</div>
                <Button color="inherit" size="small" startIcon={<RefreshCw size={12} />} onClick={retryList} sx={{ mt: 1, ml: -0.5 }}>
                  Retry
                </Button>
              </Alert>
            )}

            {replies.map(item => {
              const leadPaused = item.lead?.enrollments?.some((e: any) => e.status === 'Paused');
              const suppressed = leadSuppression(item.lead);
              const isSelected = selectedId === item.id;
              const dateStr = formatWhen(item.receivedAt);

              return (
                <div
                  key={item.id}
                  onClick={() => handleSelectThread(item)}
                  className={`p-3 rounded-2xl transition-all cursor-pointer relative border ${
                    isSelected
                      ? 'bg-blue-50/60 dark:bg-blue-950/30 border-blue-500/60 dark:border-blue-500/50 shadow-xs'
                      : 'border-transparent hover:border-[#EBF0F5] dark:hover:border-[#1E222D] hover:bg-slate-50/80 dark:hover:bg-[#161822]/80'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      {/* Avatar */}
                      <div className="relative flex-shrink-0">
                        <div className="w-7 h-7 rounded-full bg-slate-100 dark:bg-[#1E222D] text-slate-700 dark:text-slate-200 text-[11px] font-bold flex items-center justify-center">
                          {(item.lead?.name || item.lead?.email || 'P').charAt(0).toUpperCase()}
                        </div>
                        {item.unread && (
                          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-blue-600 ring-2 ring-white dark:ring-[#11131A]" />
                        )}
                      </div>
                      <span className={`text-xs truncate ${item.unread ? 'font-bold text-slate-900 dark:text-white' : 'font-medium text-slate-700 dark:text-slate-300'}`}>
                        {item.lead?.name || item.lead?.email || 'Prospect'}
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-400 dark:text-slate-500 flex-shrink-0">
                      {dateStr}
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-1.5 mb-1 pl-9">
                    <span className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                      {decodeMimeHeader(item.subject)}
                    </span>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {leadPaused && (
                        <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900/40">
                          Paused
                        </span>
                      )}
                      {suppressed && (
                        <MuiTooltip title={suppressed.detail}>
                          <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-900/40 cursor-help">
                            {suppressed.chip}
                          </span>
                        </MuiTooltip>
                      )}
                      {showsStatusChip(item.lead) && (
                        <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider border ${
                          item.lead?.status === 'Interested'
                            ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60'
                            : item.lead?.status === 'Not_Interested'
                            ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800/60'
                            : item.lead?.status === 'Meeting_Booked'
                            ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800/60'
                            : item.lead?.status === 'Out_of_Office'
                            ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800/60'
                            : 'bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700/60'
                        }`}>
                          {readableStatus[item.lead?.status || 'Neutral']}
                        </span>
                      )}
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-1 pl-9">
                    {sanitizeEmailBody(item.preview)}
                  </p>
                </div>
              );
            })}

            {replies.length === 0 && !listError && (
              <div className="py-12 text-center text-xs text-slate-400 dark:text-slate-500">
                No matching records found.
              </div>
            )}

            {nextOffset !== null && (
              <div className="pt-2 pb-3 flex flex-col items-center gap-1.5">
                <span className="text-[10px] text-slate-400">
                  Showing {replies.length} of {totalThreads} conversations
                </span>
                <Button size="small" variant="outlined" onClick={loadMoreThreads} disabled={loadingMore} startIcon={loadingMore ? <CircularProgress size={12} /> : undefined}>
                  Load More
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right Pane: Message Thread & Composer */}
      <div className="flex-1 flex flex-col rounded-2xl border border-[#EBF0F5] dark:border-[#1E222D] bg-white dark:bg-[#11131A] shadow-xs overflow-hidden relative">
        {selectedEmail ? (
          <>
            {/* Frosted Thread Header */}
            <div className="sticky top-0 z-10 backdrop-blur-md bg-white/85 dark:bg-[#11131A]/85 p-4 border-b border-[#EBF0F5] dark:border-[#1E222D] flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h1 className="text-base md:text-lg font-bold text-slate-900 dark:text-white truncate">
                  {decodeMimeHeader(selectedEmail.subject)}
                </h1>
                <div className="flex items-center gap-2.5 mt-1">
                  <div className="w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 text-[10px] font-bold flex items-center justify-center">
                    {(selectedEmail.lead?.name || 'P').charAt(0).toUpperCase()}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-900 dark:text-white">
                      {selectedEmail.lead?.name || 'Prospect'}
                    </span>
                    <span className="text-[11px] text-slate-400 dark:text-slate-500">
                      {selectedEmail.lead?.email}
                    </span>
                  </div>
                  {sequencePaused && (
                    <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900/40">
                      Paused Sequence
                    </span>
                  )}
                  {selectedSuppression && (
                    <MuiTooltip title={selectedSuppression.detail}>
                      <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-900/40 cursor-help">
                        {selectedSuppression.chip}
                      </span>
                    </MuiTooltip>
                  )}
                </div>
              </div>

              {/* Action Header Controls */}
              <div className="flex items-center gap-2 flex-shrink-0">
                <MuiTooltip title={selectedSequence.length === 0 ? 'No Active or Paused Sequence' : sequencePaused ? 'Resume Sequence' : 'Pause Sequence'}>
                  <span>
                    <button
                      type="button"
                      aria-label={sequencePaused ? 'Resume sequence' : 'Pause sequence'}
                      onClick={handleTogglePause}
                      disabled={selectedSequence.length === 0}
                      className={`w-8 h-8 rounded-xl border flex items-center justify-center transition-colors cursor-pointer disabled:opacity-40 ${
                        sequencePaused
                          ? 'border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40'
                          : 'border-[#EBF0F5] dark:border-[#1E222D] text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#161822]'
                      }`}
                    >
                      {sequencePaused ? <Play size={14} /> : <Pause size={14} />}
                    </button>
                  </span>
                </MuiTooltip>

                <Button
                  size="small"
                  variant="outlined"
                  color={(() => { const c = statusColorMap[selectedEmail.lead?.status || 'Neutral']; return c === 'default' ? 'inherit' : c; })()}
                  endIcon={<ChevronDown size={12} />}
                  onClick={(e) => setStatusMenuAnchor(e.currentTarget)}
                  sx={{ borderRadius: '9999px', textTransform: 'none', fontWeight: 600, fontSize: '0.75rem' }}
                >
                  {readableStatus[selectedEmail.lead?.status || 'Neutral']}
                </Button>
                <Menu anchorEl={statusMenuAnchor} open={!!statusMenuAnchor} onClose={() => setStatusMenuAnchor(null)} slotProps={{ paper: { sx: { borderRadius: '16px' } } }}>
                  {CRM_STATUSES.map(k => (
                    <MenuItem key={k} onClick={() => handleUpdateStatus(k)} sx={{ fontSize: 12, fontWeight: 500 }}>
                      {readableStatus[k]}
                    </MenuItem>
                  ))}
                </Menu>
              </div>
            </div>

            {/* Conversation Messages Thread */}
            <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4 bg-slate-50/40 dark:bg-[#0E1017]/40">
              {!selectedMessages && (messagesErrorId === selectedEmail.id ? (
                <div className="flex flex-col items-center justify-center gap-2 py-12">
                  <span className="text-xs text-slate-400">Could not load this conversation.</span>
                  <Button size="small" variant="outlined" startIcon={<RefreshCw size={12} />} onClick={() => loadThreadMessages(selectedEmail.id)}>
                    Retry
                  </Button>
                </div>
              ) : (
                <div className="flex justify-center py-12">
                  <CircularProgress size={22} />
                </div>
              ))}

              {(selectedMessages || []).map((msg: any) => {
                const outbound = msg.type === 'outbound';
                return (
                  <div key={msg.id} className={`flex items-start gap-2.5 ${outbound ? 'justify-end' : 'justify-start'}`}>
                    {!outbound && (
                      <div className="w-7 h-7 rounded-full bg-slate-200 dark:bg-[#1E222D] text-slate-700 dark:text-slate-300 text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-1">
                        {(selectedEmail.lead?.name || 'P').charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div
                      className={`max-w-[80%] p-4 rounded-2xl shadow-xs transition-colors ${
                        outbound
                          ? 'rounded-tr-sm bg-blue-50/80 dark:bg-blue-950/40 border border-blue-200/60 dark:border-blue-900/40 text-slate-900 dark:text-white'
                          : 'rounded-tl-sm bg-white dark:bg-[#161822] border border-[#EBF0F5] dark:border-[#1E222D] text-slate-900 dark:text-white'
                      }`}
                    >
                      {!outbound && msg.autoReply && (
                        <MuiTooltip title="Automated message. It did not pause the sequence and does not count as a reply.">
                          <span className="inline-block mb-1.5 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-900/40 cursor-help">
                            {autoReplyLabels[msg.autoReply] || 'Auto-Reply'}
                          </span>
                        </MuiTooltip>
                      )}
                      <p className="whitespace-pre-wrap leading-relaxed text-xs text-slate-800 dark:text-slate-200">
                        {outbound ? msg.body : sanitizeEmailBody(msg.body)}
                      </p>
                      {!outbound && msg.bodyUnavailable && (
                        <p className="mt-1 text-xs text-slate-400 italic">
                          The text of this reply could not be read. Open it in the mailbox to see it.
                        </p>
                      )}
                      <div className={`mt-2 text-[10px] text-slate-400 dark:text-slate-500 ${outbound ? 'text-right' : 'text-left'}`}>
                        {formatWhen(msg.timestamp, true)}
                      </div>
                    </div>
                    {outbound && (
                      <div className="w-7 h-7 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-1">
                        Me
                      </div>
                    )}
                  </div>
                );
              })}

              {(sentRepliesLocal[selectedEmail.id] || []).map((sent, index) => (
                <div key={`local-${index}`} className="flex items-start gap-2.5 justify-end">
                  <div className="max-w-[80%] p-4 rounded-2xl rounded-tr-sm bg-blue-50/80 dark:bg-blue-950/40 border border-blue-200/60 dark:border-blue-900/40 text-slate-900 dark:text-white shadow-xs">
                    <p className="whitespace-pre-wrap leading-relaxed text-xs text-slate-800 dark:text-slate-200">
                      {sent.body}
                    </p>
                    <div className="mt-2 text-[10px] text-slate-400 text-right">
                      {sent.sentAt}
                    </div>
                  </div>
                  <div className="w-7 h-7 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-1">
                    Me
                  </div>
                </div>
              ))}
            </div>

            {/* Clean Reply Composer */}
            <div className="p-4 border-t border-[#EBF0F5] dark:border-[#1E222D] bg-white dark:bg-[#11131A]">
              <div className="rounded-2xl border border-[#EBF0F5] dark:border-[#1E222D] overflow-hidden bg-slate-50/50 dark:bg-[#161822]/50 focus-within:border-blue-500/50 transition-colors">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-[#EBF0F5] dark:border-[#1E222D] bg-white/50 dark:bg-[#11131A]/50">
                  <CornerUpLeft size={14} className="text-slate-400" />
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Reply to {selectedEmail.lead?.name?.split(' ')[0] || 'Prospect'}
                  </span>
                </div>

                {replyBlocked ? (
                  <div className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400 leading-relaxed min-h-[80px]">
                    {replyBlocked}
                  </div>
                ) : (
                  <textarea
                    rows={3}
                    value={currentReplyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Type your reply here..."
                    className="w-full p-3 bg-transparent text-xs text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none resize-none leading-relaxed"
                  />
                )}

                <div className="flex items-center justify-between px-3 py-2 border-t border-[#EBF0F5] dark:border-[#1E222D] bg-white/50 dark:bg-[#11131A]/50">
                  <span className="text-[10px] text-slate-400">
                    Markdown supported
                  </span>
                  <button
                    type="button"
                    onClick={handleDispatchReply}
                    disabled={sendingReply || !answeredReply || !!replyBlocked}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-xs transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    {sendingReply ? <CircularProgress size={13} color="inherit" /> : <Send size={13} />}
                    <span>Send Reply</span>
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 dark:text-slate-500 p-8">
            <MailOpen size={48} className="opacity-25 mb-3" />
            <span className="text-sm font-semibold text-slate-500 dark:text-slate-400">
              Select Conversation to Review
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

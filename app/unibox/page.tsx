/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import { Search, CornerUpLeft, Send, MailOpen, Pause, FileText, ChevronDown, RefreshCw, Download } from 'lucide-react';
import { useState, useEffect } from 'react';
import { toCsv, downloadCsv } from '@/lib/csv';
import { decodeMimeHeader } from '@/lib/mime';
import {
  Box, Card, CardContent, Stack, Typography, Button, IconButton, Chip, TextField,
  Snackbar, Alert, InputAdornment, CircularProgress, Avatar, Menu, MenuItem,
  Tooltip as MuiTooltip,
} from '@mui/material';
import { alpha } from '@mui/material/styles';

const statusColorMap: Record<string, 'success' | 'error' | 'primary' | 'warning' | 'default' | 'info'> = {
  Interested: 'success',
  Not_Interested: 'error',
  Meeting_Booked: 'primary',
  Out_of_Office: 'warning',
  Bounced: 'default',
  Neutral: 'info',
};

const readableStatus: Record<string, string> = {
  Neutral: 'Neutral',
  Interested: 'Interested',
  Not_Interested: 'Not Interested',
  Meeting_Booked: 'Meeting Booked',
  Out_of_Office: 'Out of Office',
  Bounced: 'Bounced',
};

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

export default function UniboxPage() {
  const [replies, setReplies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusMenuAnchor, setStatusMenuAnchor] = useState<HTMLElement | null>(null);
  const [templateMenuAnchor, setTemplateMenuAnchor] = useState<HTMLElement | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [toastMessage, setToastMessage] = useState('');
  const [sentRepliesLocal, setSentRepliesLocal] = useState<Record<string, Array<{ body: string; sentAt: string }>>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const showToast = (message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(''), 3000);
  };

  const markAsRead = async (id: string) => {
    try {
      const target = replies.find(r => r.id === id);
      if (target && target.unread) {
        const res = await fetch('/api/unibox', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ responseId: id, unread: false }),
        });
        if (res.ok) setReplies(prev => prev.map(r => r.id === id ? { ...r, unread: false } : r));
      }
    } catch (err) { console.error(err); }
  };

  const fetchReplies = async (initial = false) => {
    try {
      if (initial) setLoading(true);
      const url = initial ? '/api/unibox' : '/api/unibox?sync=true';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setReplies(data);
        if (initial && data.length > 0 && !selectedId) {
          setSelectedId(data[0].id);
          markAsRead(data[0].id);
        }
        setSentRepliesLocal({});
      }
    } catch (e) { console.error(e); }
    finally { if (initial) setLoading(false); }
  };

  useEffect(() => { fetchReplies(true); }, []);

  const selectedEmail = replies.find(e => e.id === selectedId);
  const currentReplyText = selectedEmail ? (drafts[selectedEmail.id] || '') : '';
  const setReplyText = (newText: string) => {
    if (!selectedEmail) return;
    setDrafts(prev => ({ ...prev, [selectedEmail.id]: newText }));
  };

  const handleSelectThread = (id: string) => { setSelectedId(id); markAsRead(id); };

  const handleExportCSV = () => {
    const rows: Record<string, any>[] = [];
    filteredInbox.forEach(thread => {
      const inboundMessages = (thread.messages || []).filter((msg: any) => msg.type === 'inbound');
      inboundMessages.forEach((msg: any) => {
        rows.push({
          receivedAt: msg.timestamp,
          leadEmail: thread.lead?.email || '',
          leadName: thread.lead?.name || '',
          company: thread.lead?.company || '',
          campaign: msg.campaign?.name || thread.lead?.enrollments?.[0]?.campaign?.name || '',
          senderAccount: msg.senderAccount?.emailAddress || thread.senderAccount?.emailAddress || '',
          subject: msg.subject,
          body: msg.body,
          unread: msg.unread ? 'true' : 'false',
          leadStatus: thread.lead?.status || 'Neutral',
        });
      });
    });
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
  };

  const templatesList = [
    { name: 'Arrange Quick Call', text: "Hi {{firstName}},\n\nI'd love to chat. Would Tuesday at 2 PM EST work for a brief 10-minute introduction call?\n\nBest,\nJohn" },
    { name: 'SaaS Demo Setup', text: "Hi {{firstName}},\n\nAwesome to hear. Here is our direct booking calendar link to choose any open slot that works for you: [Calendar Link]\n\nI look forward to our presentation!\n\nBest,\nJohn" },
    { name: 'Case Study Sharing', text: "Hey {{firstName}},\n\nNo problem! I've attached our Q2 case study deck below. Let me know if those metrics sync up with what you're trying to build.\n\nTake care,\nJohn" },
  ];

  const handleInsertTemplate = (templateText: string) => {
    if (!selectedEmail) return;
    const resolvedName = selectedEmail.lead?.name?.split(' ')[0] || 'there';
    setReplyText(templateText.replace(/\{\{firstName\}\}/g, resolvedName));
    setTemplateMenuAnchor(null);
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
        showToast(`Lead status updated to ${readableStatus[statusKey]}`);
      }
    } catch (e) { console.error(e); }
    finally { setStatusMenuAnchor(null); }
  };

  const handleTogglePause = async () => {
    if (!selectedEmail) return;
    const isPaused = selectedEmail.lead?.enrollments?.some((e: any) => e.status === 'Paused');
    const nextStatus = isPaused ? 'Active' : 'Paused';
    try {
      const res = await fetch('/api/unibox', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId: selectedEmail.lead.id, enrollmentStatus: nextStatus }),
      });
      if (res.ok) {
        setReplies(prev => prev.map(item => item.id === selectedId
          ? { ...item, lead: { ...item.lead, enrollments: item.lead.enrollments.map((en: any) => ({ ...en, status: nextStatus })) } }
          : item));
        showToast(nextStatus === 'Paused' ? 'Outbound campaigns paused for prospect' : 'Active sending resumed for prospect');
      }
    } catch (e) { console.error(e); }
  };

  const handleDispatchReply = async () => {
    if (!selectedEmail || !currentReplyText.trim()) return;
    try {
      const res = await fetch('/api/unibox/reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId: selectedEmail.lead.id,
          subject: (() => {
            const decoded = decodeMimeHeader(selectedEmail.subject).trim();
            return /^re:/i.test(decoded) ? decoded : `Re: ${decoded}`;
          })(),
          body: currentReplyText,
          senderAccountId: selectedEmail.senderAccountId,
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
  };

  const filteredInbox = replies.filter(item => {
    const senderName = item.lead?.name || 'Unknown';
    const emailAddr = item.lead?.email || '';
    const subjectLine = item.subject || '';
    const bodyText = item.body || '';
    return senderName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      emailAddr.toLowerCase().includes(searchQuery.toLowerCase()) ||
      subjectLine.toLowerCase().includes(searchQuery.toLowerCase()) ||
      bodyText.toLowerCase().includes(searchQuery.toLowerCase());
  });

  return (
    <Box sx={{ height: 'calc(100vh - 6rem)', display: 'flex', gap: 2 }}>
      <Snackbar open={!!toastMessage} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} autoHideDuration={3000} onClose={() => setToastMessage('')}>
        {toastMessage ? <Alert severity="info" variant="filled" sx={{ borderRadius: '12px' }}>{toastMessage}</Alert> : undefined}
      </Snackbar>

      {/* Left pane */}
      <Card sx={{ width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Typography variant="overline" sx={{ fontWeight: 700, letterSpacing: '0.1em' }}>Unified Inbox</Typography>
              <Chip size="small" label={`${replies.filter(e => e.unread).length} NEW`} color="primary" sx={{ height: 18, fontSize: 10, fontFamily: 'monospace', fontWeight: 700 }} />
            </Stack>
            <Stack direction="row" spacing={0.5}>
              <MuiTooltip title="Export to CSV"><IconButton aria-label="Export to CSV" size="small" onClick={handleExportCSV}><Download size={14} /></IconButton></MuiTooltip>
              <MuiTooltip title="Refresh"><IconButton aria-label="Refresh replies" size="small" onClick={() => fetchReplies(false)}><RefreshCw size={14} /></IconButton></MuiTooltip>
            </Stack>
          </Stack>
          <TextField
            fullWidth size="small" placeholder="Search contacts..." value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            slotProps={{ input: { startAdornment: <InputAdornment position="start"><Search size={14} /></InputAdornment> } }}
          />
        </Box>

        {loading ? (
          <Stack sx={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 1.5 }}>
            <CircularProgress size={22} />
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>Syncing inbox…</Typography>
          </Stack>
        ) : (
          <Box sx={{ flex: 1, overflowY: 'auto', p: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            {filteredInbox.map(item => {
              const leadPaused = item.lead?.enrollments?.some((e: any) => e.status === 'Paused');
              const isSelected = selectedId === item.id;
              const dateStr = new Date(item.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              return (
                <Box
                  key={item.id}
                  onClick={() => handleSelectThread(item.id)}
                  sx={{
                    cursor: 'pointer', p: 1.5, borderRadius: '12px', border: 1, position: 'relative',
                    borderColor: isSelected ? 'primary.main' : 'transparent',
                    bgcolor: isSelected ? (t) => alpha(t.palette.primary.main, 0.08) : 'transparent',
                    transition: 'background-color .15s, border-color .15s',
                    '&:hover': { bgcolor: isSelected ? (t) => alpha(t.palette.primary.main, 0.12) : 'action.hover' },
                  }}
                >
                  <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start', mb: 0.5 }}>
                    <Typography variant="caption" sx={{ fontWeight: 700, color: item.unread ? 'text.primary' : 'text.secondary' }}>
                      {item.lead?.name || item.lead?.email || 'Prospect'}
                    </Typography>
                    <Typography sx={{ fontSize: 10, fontFamily: 'monospace', color: 'text.secondary' }}>{dateStr}</Typography>
                  </Stack>
                  <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 0.75 }}>
                    <Typography variant="caption" sx={{ fontWeight: 600, mr: 1, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{decodeMimeHeader(item.subject)}</Typography>
                    <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
                      {leadPaused && <Chip size="small" label="PAUSED" color="error" variant="outlined" sx={{ height: 16, fontSize: 8, fontWeight: 700 }} />}
                      <Chip size="small" label={readableStatus[item.lead?.status || 'Neutral']} color={statusColorMap[item.lead?.status || 'Neutral']} variant="outlined" sx={{ height: 16, fontSize: 8, fontWeight: 700, textTransform: 'uppercase' }} />
                    </Stack>
                  </Stack>
                  <Typography variant="caption" sx={{ color: 'text.secondary', display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {sanitizeEmailBody(item.body)}
                  </Typography>
                  {item.unread && <Box sx={{ position: 'absolute', left: 4, top: '50%', transform: 'translateY(-50%)', width: 6, height: 6, borderRadius: '50%', bgcolor: 'primary.main' }} />}
                </Box>
              );
            })}
            {filteredInbox.length === 0 && (
              <Typography variant="caption" sx={{ color: 'text.secondary', textAlign: 'center', py: 5 }}>No matching records.</Typography>
            )}
          </Box>
        )}
      </Card>

      {/* Right pane */}
      <Card sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
        {selectedEmail ? (
          <>
            {/* Thread header */}
            <Box sx={{ p: 2.5, borderBottom: 1, borderColor: 'divider' }}>
              <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>{decodeMimeHeader(selectedEmail.subject)}</Typography>
                  <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                    <Avatar sx={{ width: 32, height: 32, fontSize: 12, fontWeight: 700, bgcolor: 'action.hover', color: 'primary.main' }}>
                      {(selectedEmail.lead?.name || 'P').charAt(0)}
                    </Avatar>
                    <Box>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <Typography variant="body2" sx={{ fontWeight: 700 }}>{selectedEmail.lead?.name || 'Prospect'}</Typography>
                        {selectedEmail.lead?.enrollments?.some((e: any) => e.status === 'Paused') && (
                          <Chip size="small" label="PAUSED SEQUENCE" color="error" variant="outlined" sx={{ height: 18, fontSize: 9, fontWeight: 700 }} />
                        )}
                      </Stack>
                      <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>{selectedEmail.lead?.email}</Typography>
                    </Box>
                  </Stack>
                </Box>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <MuiTooltip title={selectedEmail.lead?.enrollments?.some((e: any) => e.status === 'Paused') ? 'Resume Sequence' : 'Pause Sequence'}>
                    <IconButton aria-label={selectedEmail.lead?.enrollments?.some((e: any) => e.status === 'Paused') ? 'Resume sequence' : 'Pause sequence'} size="small" onClick={handleTogglePause} sx={{ border: 1, borderColor: 'divider', color: selectedEmail.lead?.enrollments?.some((e: any) => e.status === 'Paused') ? 'error.main' : 'text.secondary' }}>
                      <Pause size={14} />
                    </IconButton>
                  </MuiTooltip>
                  <Button
                    size="small"
                    variant="outlined"
                    color={(() => { const c = statusColorMap[selectedEmail.lead?.status || 'Neutral']; return c === 'default' ? 'inherit' : c; })()}
                    endIcon={<ChevronDown size={12} />}
                    onClick={(e) => setStatusMenuAnchor(e.currentTarget)}
                  >
                    {readableStatus[selectedEmail.lead?.status || 'Neutral']}
                  </Button>
                  <Menu anchorEl={statusMenuAnchor} open={!!statusMenuAnchor} onClose={() => setStatusMenuAnchor(null)} slotProps={{ paper: { sx: { borderRadius: '12px' } } }}>
                    {Object.keys(statusColorMap).map(k => (
                      <MenuItem key={k} onClick={() => handleUpdateStatus(k)} sx={{ fontSize: 12, fontWeight: 500 }}>{readableStatus[k]}</MenuItem>
                    ))}
                  </Menu>
                </Stack>
              </Stack>
            </Box>

            {/* Thread content */}
            <Box sx={{ flex: 1, overflowY: 'auto', p: 2.5, display: 'flex', flexDirection: 'column', gap: 2, bgcolor: 'action.hover' }}>
              {(selectedEmail.messages || []).map((msg: any) => {
                const outbound = msg.type === 'outbound';
                return (
                  <Stack key={msg.id} direction="row" spacing={1.5} sx={{ justifyContent: outbound ? 'flex-end' : 'flex-start' }}>
                    {!outbound && (
                      <Avatar variant="rounded" sx={{ width: 28, height: 28, fontSize: 10, fontWeight: 700, bgcolor: 'background.paper', border: 1, borderColor: 'divider', color: 'primary.main', borderRadius: '8px' }}>
                        {(selectedEmail.lead?.name || 'P').charAt(0)}
                      </Avatar>
                    )}
                    <Card
                      variant="outlined"
                      sx={{
                        maxWidth: '80%',
                        bgcolor: outbound ? (t) => alpha(t.palette.primary.main, 0.08) : 'background.paper',
                        borderColor: outbound ? (t) => alpha(t.palette.primary.main, 0.2) : 'divider',
                        borderRadius: '16px',
                        [outbound ? 'borderTopRightRadius' : 'borderTopLeftRadius']: '4px',
                      }}
                    >
                      <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                        <Typography variant="caption" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, display: 'block', color: 'text.primary' }}>
                          {outbound ? msg.body : sanitizeEmailBody(msg.body)}
                        </Typography>
                        <Typography sx={{ fontSize: 9, color: 'text.secondary', fontFamily: 'monospace', textAlign: outbound ? 'right' : 'left', mt: 1 }}>
                          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </Typography>
                      </CardContent>
                    </Card>
                    {outbound && <Avatar variant="rounded" sx={{ width: 28, height: 28, fontSize: 10, fontWeight: 700, bgcolor: 'primary.main', color: 'primary.contrastText', borderRadius: '8px' }}>Me</Avatar>}
                  </Stack>
                );
              })}
              {(sentRepliesLocal[selectedEmail.id] || []).map((sent, index) => (
                <Stack key={`local-${index}`} direction="row" spacing={1.5} sx={{ justifyContent: 'flex-end' }}>
                  <Card variant="outlined" sx={{ maxWidth: '80%', bgcolor: (t) => alpha(t.palette.primary.main, 0.08), borderColor: (t) => alpha(t.palette.primary.main, 0.2), borderRadius: '16px', borderTopRightRadius: '4px' }}>
                    <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                      <Typography variant="caption" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, display: 'block' }}>{sent.body}</Typography>
                      <Typography sx={{ fontSize: 9, color: 'text.secondary', fontFamily: 'monospace', textAlign: 'right', mt: 1 }}>{sent.sentAt}</Typography>
                    </CardContent>
                  </Card>
                  <Avatar variant="rounded" sx={{ width: 28, height: 28, fontSize: 10, fontWeight: 700, bgcolor: 'primary.main', color: 'primary.contrastText', borderRadius: '8px' }}>Me</Avatar>
                </Stack>
              ))}
            </Box>

            {/* Reply editor */}
            <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
              <Card variant="outlined" sx={{ borderRadius: '14px', overflow: 'hidden' }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 1.5, py: 1, bgcolor: 'action.hover', borderBottom: 1, borderColor: 'divider' }}>
                  <CornerUpLeft size={14} />
                  <Typography variant="overline" sx={{ fontWeight: 700, letterSpacing: '0.1em', color: 'text.secondary' }}>
                    Reply to {selectedEmail.lead?.name?.split(' ')[0] || 'Prospect'}
                  </Typography>
                </Stack>
                <TextField
                  multiline minRows={3} fullWidth
                  value={currentReplyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Type your reply here, or insert matching template..."
                  variant="standard"
                  slotProps={{ input: { disableUnderline: true, sx: { px: 2, py: 1.5, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6 } } }}
                />
                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', px: 1.5, py: 1, borderTop: 1, borderColor: 'divider' }}>
                  <Button
                    size="small" variant="outlined" startIcon={<FileText size={12} />}
                    onClick={(e) => setTemplateMenuAnchor(e.currentTarget)}
                    sx={{ fontSize: 10 }}
                  >
                    Templates
                  </Button>
                  <Menu anchorEl={templateMenuAnchor} open={!!templateMenuAnchor} onClose={() => setTemplateMenuAnchor(null)} anchorOrigin={{ vertical: 'top', horizontal: 'left' }} transformOrigin={{ vertical: 'bottom', horizontal: 'left' }} slotProps={{ paper: { sx: { borderRadius: '12px', maxWidth: 280 } } }}>
                    {templatesList.map(template => (
                      <MenuItem key={template.name} onClick={() => handleInsertTemplate(template.text)} sx={{ display: 'block', whiteSpace: 'normal' }}>
                        <Typography variant="body2" sx={{ fontWeight: 700 }}>{template.name}</Typography>
                        <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', display: 'block', mt: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{template.text}</Typography>
                      </MenuItem>
                    ))}
                  </Menu>
                  <Button variant="contained" size="small" startIcon={<Send size={14} />} onClick={handleDispatchReply}>Send Reply</Button>
                </Stack>
              </Card>
            </Box>
          </>
        ) : (
          <Stack sx={{ flex: 1, alignItems: 'center', justifyContent: 'center', color: 'text.secondary' }}>
            <MailOpen size={48} style={{ opacity: 0.3, marginBottom: 12 }} />
            <Typography variant="overline" sx={{ fontWeight: 700 }}>Select conversation to review</Typography>
          </Stack>
        )}
      </Card>
    </Box>
  );
}

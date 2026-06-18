/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import { Search, MoreVertical, CornerUpLeft, Send, Trash2, MailOpen, Pause, FileText, ChevronDown, X, RefreshCw } from 'lucide-react';
import { useState, useEffect } from 'react';

const statusColors: Record<string, string> = {
  'Interested': 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/30',
  'Not_Interested': 'bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-900/30',
  'Meeting_Booked': 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-900/30',
  'Out_of_Office': 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-500 border-amber-200 dark:border-amber-900/30',
  'Bounced': 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700',
  'Neutral': 'bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-900/30'
};

const readableStatus: Record<string, string> = {
  'Neutral': 'Neutral',
  'Interested': 'Interested',
  'Not_Interested': 'Not Interested',
  'Meeting_Booked': 'Meeting Booked',
  'Out_of_Office': 'Out of Office',
  'Bounced': 'Bounced'
};

/**
 * Client-side sanitizer for email bodies that may contain leaked MIME headers,
 * boundaries, or raw encoding artifacts (for data already stored in the DB).
 * Strips all reply chain history to show only the new message content.
 */
function sanitizeEmailBody(body: string): string {
  if (!body) return '';
  let text = body;

  // If the body contains a MIME boundary, try to extract the text/plain part
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
    // Single-part with headers
    const blankLine = text.search(/\r?\n\r?\n/);
    if (blankLine !== -1) {
      const match = text.match(/\r?\n\r?\n/);
      text = text.substring(blankLine + (match ? match[0].length : 2)).trim();
    }
  }

  // Decode common quoted-printable sequences
  text = text.replace(/=([0-9A-F]{2})/gi, (_, hex) => {
    try { return String.fromCharCode(parseInt(hex, 16)); } catch { return _; }
  });
  // Remove soft line breaks from QP
  text = text.replace(/=+(?:\r?\n|$)/g, '');

  // Strip HTML tags first
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/?(p|div|tr|li|blockquote|h[1-6])[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');

  // Process line by line: strip MIME artifacts, quoted text, and stop at reply chain markers
  const lines = text.split(/\r?\n/);
  const cleaned: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    // Stop processing at "On ... wrote:" reply markers (can span 1-3 lines)
    if (/^On\s+/i.test(t)) {
      let combined = t;
      for (let j = 1; j <= 2 && (i + j) < lines.length; j++) {
        combined += ' ' + lines[i + j].trim();
      }
      if (/wrote:\s*$/.test(combined)) break;
    }

    // Stop at other reply chain markers
    if (/^-----\s*Original Message\s*-----/i.test(t)) break;
    if (/^_{3,}\s*$/.test(t) && i > 0) break;
    if (/^From:\s+\S+@\S+/i.test(t) && cleaned.length > 0) break;
    if (/^Sent:\s+/i.test(t) && cleaned.length > 0) break;
    if (/^Date:\s+/i.test(t) && cleaned.length > 0) break;
    if (/^Subject:\s+/i.test(t) && cleaned.length > 0) break;
    if (/^To:\s+\S+@\S+/i.test(t) && cleaned.length > 0) break;

    // Skip quoted lines (starts with >)
    if (t.startsWith('>')) continue;

    // Skip MIME headers and artifacts
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

    // Skip MIME boundary markers
    if (/^--[a-zA-Z0-9_=.+/-]{10,}--?$/.test(t)) continue;

    // Skip IMAP fetch artifacts like "{530}"
    if (/^\{\d+\}$/.test(t)) continue;

    cleaned.push(line);
  }

  text = cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

export default function UniboxPage() {
  const [replies, setReplies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  
  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [toastMessage, setToastMessage] = useState('');

  // Keep track of sent replies locally per thread to display in history immediately
  const [sentRepliesLocal, setSentRepliesLocal] = useState<Record<string, Array<{ body: string; sentAt: string }>>>({});

  // Individual thread draft inputs
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
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ responseId: id, unread: false })
        });
        if (res.ok) {
          // Update locally
          setReplies(prev => prev.map(r => r.id === id ? { ...r, unread: false } : r));
        }
      }
    } catch (err) {
      console.error(err);
    }
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
        // Clear local sent replies stack after a successful API sync
        setSentRepliesLocal({});
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (initial) setLoading(false);
    }
  };

  useEffect(() => {
    fetchReplies(true);
  }, []);

  const selectedEmail = replies.find(e => e.id === selectedId);
  const currentReplyText = selectedEmail ? (drafts[selectedEmail.id] || '') : '';

  const setReplyText = (newText: string) => {
    if (!selectedEmail) return;
    setDrafts(prev => ({ ...prev, [selectedEmail.id]: newText }));
  };

  const handleSelectThread = (id: string) => {
    setSelectedId(id);
    markAsRead(id);
  };

  const templatesList = [
    { name: 'Arrange Quick Call', text: "Hi {{firstName}},\n\nI'd love to chat. Would Tuesday at 2 PM EST work for a brief 10-minute introduction call?\n\nBest,\nJohn" },
    { name: 'SaaS Demo Setup', text: "Hi {{firstName}},\n\nAwesome to hear. Here is our direct booking calendar link to choose any open slot that works for you: [Calendar Link]\n\nI look forward to our presentation!\n\nBest,\nJohn" },
    { name: 'Case Study Sharing', text: "Hey {{firstName}},\n\nNo problem! I've attached our Q2 case study deck below. Let me know if those metrics sync up with what you're trying to build.\n\nTake care,\nJohn" }
  ];

  const handleInsertTemplate = (templateText: string) => {
    if (!selectedEmail) return;
    const resolvedName = selectedEmail.lead?.name?.split(' ')[0] || 'there';
    const resolved = templateText.replace(/\{\{firstName\}\}/g, resolvedName);
    setReplyText(resolved);
    setShowTemplateMenu(false);
  };

  const handleUpdateStatus = async (statusKey: string) => {
    if (!selectedEmail) return;
    try {
      const res = await fetch('/api/unibox', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          leadId: selectedEmail.lead.id, 
          leadStatus: statusKey 
        })
      });
      if (res.ok) {
        // Update local list
        setReplies(prev => prev.map(item => {
          if (item.id === selectedId) {
            return {
              ...item,
              lead: {
                ...item.lead,
                status: statusKey
              }
            };
          }
          return item;
        }));
        showToast(`Lead status updated to ${readableStatus[statusKey]}`);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setShowStatusDropdown(false);
    }
  };

  const handleTogglePause = async () => {
    if (!selectedEmail) return;
    
    // Check if lead is currently paused
    const isPaused = selectedEmail.lead?.enrollments?.some((e: any) => e.status === 'Paused');
    const nextStatus = isPaused ? 'Active' : 'Paused';

    try {
      const res = await fetch('/api/unibox', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId: selectedEmail.lead.id,
          enrollmentStatus: nextStatus
        })
      });

      if (res.ok) {
        // Update local list
        setReplies(prev => prev.map(item => {
          if (item.id === selectedId) {
            const updatedEnrollments = item.lead.enrollments.map((en: any) => ({
              ...en,
              status: nextStatus
            }));
            return {
              ...item,
              lead: {
                ...item.lead,
                enrollments: updatedEnrollments
              }
            };
          }
          return item;
        }));
        showToast(nextStatus === 'Paused' ? 'Outbound campaigns paused for prospect' : 'Active sending resumed for prospect');
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDispatchReply = async () => {
    if (!selectedEmail || !currentReplyText.trim()) return;

    try {
      const res = await fetch('/api/unibox/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId: selectedEmail.lead.id,
          subject: /^re:/i.test(selectedEmail.subject.trim())
            ? selectedEmail.subject
            : `Re: ${selectedEmail.subject}`,
          body: currentReplyText,
          senderAccountId: selectedEmail.senderAccountId
        })
      });

      if (res.ok) {
        // Log reply in local thread history
        const newReply = {
          body: currentReplyText,
          sentAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        
        setSentRepliesLocal(prev => ({
          ...prev,
          [selectedEmail.id]: [...(prev[selectedEmail.id] || []), newReply]
        }));

        setReplyText('');
        showToast(`Reply sent to ${selectedEmail.lead.email}!`);
      } else {
        showToast('Failed to dispatch reply.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error occurred dispatching reply.');
    }
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
    <div className="h-[calc(100vh-6rem)] flex gap-4 animate-in fade-in duration-500">
      {/* Left Pane: Inbox List */}
      <div className="w-80 shrink-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col overflow-hidden shadow-xs">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800/80 bg-slate-50/20 dark:bg-slate-950/20 flex flex-col gap-3">
          <div className="flex justify-between items-center">
            <h2 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-widest flex items-center justify-between w-full">
              Unibox Inbox
              <span className="bg-blue-600 text-white text-[10px] font-bold px-2.5 py-0.5 rounded-full font-mono shrink-0 ml-2">
                {replies.filter(e => e.unread).length} NEW
              </span>
            </h2>
            <button 
              onClick={() => fetchReplies(false)}
              className="p-1 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white ml-2 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
              title="Refresh Unibox"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
            <input 
              type="text" 
              placeholder="Search contacts..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs rounded-lg pl-9 pr-4 py-2 outline-none focus:ring-2 focus:ring-blue-500/30 placeholder:text-slate-400 dark:placeholder:text-slate-500 text-slate-800 dark:text-white"
            />
          </div>
        </div>
        
        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 dark:text-slate-500 text-xs space-y-2">
            <div className="w-5 h-5 border-2 border-slate-300 dark:border-slate-700 border-t-blue-500 animate-spin rounded-full mx-auto" />
            <p className="font-semibold tracking-wider font-mono">Syncing streams...</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-2 space-y-1 bg-white dark:bg-slate-900/40">
            {filteredInbox.map((item) => {
              const leadPaused = item.lead?.enrollments?.some((e: any) => e.status === 'Paused');
              const isSelected = selectedId === item.id;
              const dateStr = new Date(item.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              
              return (
                <button
                  key={item.id}
                  onClick={() => handleSelectThread(item.id)}
                  className={`w-full text-left p-3.5 rounded-lg transition-all border block relative ${
                    isSelected 
                      ? 'bg-blue-50/65 dark:bg-blue-950/20 border-blue-200 dark:border-blue-500/25 shadow-xs' 
                      : 'bg-transparent border-transparent hover:bg-slate-50/80 dark:hover:bg-slate-800/40'
                  }`}
                >
                  <div className="flex justify-between items-start mb-1">
                    <span className={`text-xs font-bold ${item.unread ? 'text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-350'}`}>
                      {item.lead?.name || item.lead?.email || 'Prospect'}
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500 font-medium">{dateStr}</span>
                  </div>
                  <div className="flex justify-between items-center mb-1.5">
                     <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate mr-2 w-32">{item.subject}</div>
                     <div className="flex items-center gap-1 shrink-0">
                       {leadPaused && (
                         <span className="text-[8px] bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 font-bold px-1.5 py-0.5 rounded border border-rose-200 dark:border-rose-900/30">PAUSED</span>
                       )}
                       <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wider ${statusColors[item.lead?.status || 'Neutral']}`}>
                          {readableStatus[item.lead?.status || 'Neutral']}
                       </span>
                     </div>
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate w-[94%] leading-snug font-medium">{sanitizeEmailBody(item.body)}</div>
                  {item.unread && (
                    <div className="absolute left-1.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-blue-500" />
                  )}
                </button>
              );
            })}
            {filteredInbox.length === 0 && (
              <div className="text-center py-10 text-slate-400 dark:text-slate-500 text-xs font-medium">
                No matching records.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right Pane: Conversation Thread */}
      <div className="flex-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col overflow-hidden relative shadow-xs">
        {selectedEmail ? (
          <>
            {/* Thread Header */}
            <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex justify-between items-start bg-slate-50/20 dark:bg-slate-950/10">
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white mb-2 leading-tight">{selectedEmail.subject}</h2>
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-slate-105 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex items-center justify-center text-blue-600 dark:text-blue-400 font-bold text-xs shadow-xs">
                    {(selectedEmail.lead?.name || 'P').charAt(0)}
                  </div>
                  <div>
                    <div className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-2">
                       {selectedEmail.lead?.name || 'Prospect'}
                       {selectedEmail.lead?.enrollments?.some((e: any) => e.status === 'Paused') && (
                         <span className="text-[9px] bg-rose-50 dark:bg-rose-950/20 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900/30 px-2 py-0.5 rounded font-bold uppercase tracking-wider">PAUSED SEQUENCE</span>
                       )}
                    </div>
                    <div className="text-[10px] text-slate-400 dark:text-slate-500 font-mono mt-0.5">{selectedEmail.lead?.email}</div>
                  </div>
                </div>
              </div>
              
              <div className="flex flex-col items-end gap-2 shrink-0">
                <div className="flex gap-1.5 relative">
                    <button 
                        onClick={handleTogglePause}
                        className={`p-1.5 rounded-lg transition-colors border shadow-xs cursor-pointer ${
                          selectedEmail.lead?.enrollments?.some((e: any) => e.status === 'Paused') 
                            ? 'bg-rose-50 dark:bg-rose-950/20 hover:bg-rose-100 dark:hover:bg-rose-950/30 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-900/30' 
                            : 'bg-white dark:bg-slate-950 hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400'
                        }`} 
                        title={selectedEmail.lead?.enrollments?.some((e: any) => e.status === 'Paused') ? "Resume Lead Sequence" : "Pause Lead Sequence"}
                    >
                        <Pause className="w-3.5 h-3.5" />
                    </button>
                    <div className="relative">
                        <button 
                            onClick={() => setShowStatusDropdown(!showStatusDropdown)}
                            className={`flex items-center gap-1 px-2.5 py-1.2 rounded-lg border text-[10px] font-bold shadow-xs cursor-pointer ${statusColors[selectedEmail.lead?.status || 'Neutral']}`}
                        >
                            <span className="uppercase tracking-wider">{readableStatus[selectedEmail.lead?.status || 'Neutral']}</span>
                            <ChevronDown className="w-3 h-3" />
                        </button>
                        {showStatusDropdown && (
                            <div className="absolute right-0 top-full mt-1.5 w-44 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl overflow-hidden z-20 animate-in fade-in slide-in-from-top-2 duration-150">
                                {Object.keys(statusColors).map(statusKey => (
                                    <button 
                                        key={statusKey}
                                        onClick={() => handleUpdateStatus(statusKey)}
                                        className="w-full text-left px-3.5 py-2 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors font-medium cursor-pointer"
                                    >
                                        {readableStatus[statusKey]}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
              </div>
            </div>

            {/* Thread Content */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-slate-50/30 dark:bg-slate-950/10">
              {(selectedEmail.messages || []).map((msg: any) => {
                if (msg.type === 'outbound') {
                  return (
                    <div key={msg.id} className="flex gap-3 justify-end">
                      <div className="bg-blue-50/70 dark:bg-blue-950/20 border border-blue-150 dark:border-blue-500/10 p-4 rounded-lg rounded-tr-sm text-xs text-slate-800 dark:text-white leading-relaxed font-sans shadow-xs max-w-[80%]">
                        <div className="whitespace-pre-line">{msg.body}</div>
                        <div className="text-[9px] text-slate-400 dark:text-slate-500 mt-2 text-right font-mono font-medium">
                          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                      <div className="w-7 h-7 rounded-md bg-blue-600 flex items-center justify-center text-white text-[10px] font-bold shrink-0 shadow-xs">
                        Me
                      </div>
                    </div>
                  );
                } else {
                  return (
                    <div key={msg.id} className="flex gap-3">
                      <div className="w-7 h-7 rounded-md bg-white dark:bg-slate-950 border border-slate-220 dark:border-slate-800 flex items-center justify-center text-blue-600 dark:text-blue-400 text-[10px] font-bold shrink-0 shadow-xs">
                        {(selectedEmail.lead?.name || 'P').charAt(0)}
                      </div>
                      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-750 p-4 rounded-lg rounded-tl-sm text-xs text-slate-800 dark:text-white leading-relaxed font-sans shadow-xs whitespace-pre-line">
                        {sanitizeEmailBody(msg.body)}
                        <div className="text-[9px] text-slate-400 dark:text-slate-500 mt-2 font-mono font-medium">
                          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    </div>
                  );
                }
              })}

              {/* Local Sent Replies stack (simulates real-time thread updating) */}
              {(sentRepliesLocal[selectedEmail.id] || []).map((sent, index) => (
                <div key={`local-${index}`} className="flex gap-3 justify-end animate-in fade-in slide-in-from-bottom-2 duration-200">
                  <div className="bg-blue-50/70 dark:bg-blue-950/20 border border-blue-150 dark:border-blue-500/10 p-4 rounded-lg rounded-tr-sm text-xs text-slate-800 dark:text-white leading-relaxed font-sans shadow-xs max-w-[80%]">
                    {sent.body}
                    <div className="text-[9px] text-slate-400 dark:text-slate-500 mt-2 text-right font-mono font-medium">{sent.sentAt}</div>
                  </div>
                  <div className="w-7 h-7 rounded-md bg-blue-600 flex items-center justify-center text-white text-[10px] font-bold shrink-0 shadow-xs">
                    Me
                  </div>
                </div>
              ))}
            </div>

            {/* Reply Editor */}
            <div className="p-4 bg-slate-50/50 dark:bg-slate-950/20 border-t border-slate-200 dark:border-slate-800 bg-white">
              <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800/80 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue-500/20 transition-all shadow-xs">
                <div className="px-3.5 py-2 bg-slate-105 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-800/80 flex items-center gap-1.5 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest font-mono">
                  <CornerUpLeft className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                  Reply to {selectedEmail.lead?.name?.split(' ')[0] || 'Prospect'}
                </div>
                <textarea 
                  value={currentReplyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  className="w-full p-4 h-24 resize-none outline-none text-slate-800 dark:text-white text-xs placeholder:text-slate-400 dark:placeholder:text-slate-500 bg-transparent leading-relaxed font-mono"
                  placeholder="Type your reply here, or insert matching template..."
                ></textarea>
                
                <div className="p-2.5 border-t border-slate-200 dark:border-slate-800/80 bg-white dark:bg-slate-900 flex justify-between items-center relative z-10">
                  <div className="relative">
                    <button 
                      onClick={() => setShowTemplateMenu(!showTemplateMenu)}
                      className="hover:text-blue-700 dark:hover:text-white text-blue-600 dark:text-blue-400 font-bold flex items-center gap-1.5 bg-blue-50 dark:bg-blue-500/10 px-3 py-1.5 rounded-lg text-[10px] uppercase border border-blue-150 dark:border-blue-500/20 transition-all shadow-2xs font-sans cursor-pointer"
                    >
                        <FileText className="w-3.5 h-3.5" />
                        Templates
                    </button>
                    
                    {showTemplateMenu && (
                      <div className="absolute left-0 bottom-full mb-1.5 w-64 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-2 shadow-2xl z-30 animate-in slide-in-from-bottom-2 duration-150">
                        <p className="text-[9px] uppercase font-bold text-slate-400 dark:text-slate-500 px-2 py-1.5 tracking-widest border-b border-slate-100 dark:border-slate-800 mb-1">CRM template select</p>
                        <div className="space-y-0.5">
                          {templatesList.map(template => (
                            <button 
                              key={template.name}
                              onClick={() => handleInsertTemplate(template.text)}
                              className="w-full text-left p-2 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-350 transition-colors block border border-transparent hover:border-slate-200 dark:hover:border-slate-800 cursor-pointer"
                            >
                              <div className="font-bold text-xs text-slate-900 dark:text-white">{template.name}</div>
                              <div className="text-[10px] text-slate-400 dark:text-slate-500 truncate mt-0.5 font-mono">{template.text}</div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  
                  <button 
                    onClick={handleDispatchReply}
                    className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.8 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                    Dispatch Mail
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 dark:text-slate-500">
            <MailOpen className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-xs font-semibold uppercase tracking-wider">Select conversation to review</p>
          </div>
        )}
      </div>

      {toastMessage && (
        <div className="fixed bottom-8 right-8 bg-[#0c0d14] border border-[#1b1c26] text-white px-4 py-3 rounded-lg shadow-2xl flex items-center gap-3 z-50 animate-in slide-in-from-bottom-5 text-xs">
          <span className="font-semibold">{toastMessage}</span>
          <button onClick={() => setToastMessage('')} className="text-slate-400 hover:text-white transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

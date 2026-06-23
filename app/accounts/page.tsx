/* eslint-disable react-hooks/set-state-in-effect, react/no-unescaped-entities, react-hooks/exhaustive-deps */
'use client';

import { useState, useEffect } from 'react';
import { 
  Plus, 
  CheckCircle2, 
  AlertCircle, 
  Mail, 
  Flame, 
  TrendingUp, 
  ShieldAlert, 
  Inbox, 
  MessageSquare, 
  ArrowLeft, 
  Sparkles, 
  RefreshCw,
  Sliders,
  ChevronRight,
  X,
  Gauge,
  User,
  Activity,
  Save,
  Send,
  Loader2,
  Trash2,
  Eye,
  EyeOff
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { TableSkeleton } from '@/components/Skeleton';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';



const isSmtpDisabled = (provider: string) => {
  return provider === 'AZURE' || provider === 'MOCK';
};

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);

  const [selectedWarmupAccount, setSelectedWarmupAccount] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'accounts' | 'warmup'>('accounts');


  // Modal States
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form Field States
  const [emailAddress, setEmailAddress] = useState('');
  const [senderName, setSenderName] = useState('');
  const [provider, setProvider] = useState('Google Workspace');
  const [assignedUserId, setAssignedUserId] = useState('');
  const [minuteLimit, setMinuteLimit] = useState(5);
  const [hourlyLimit, setHourlyLimit] = useState(100);
  const [dailyLimit, setDailyLimit] = useState(500);
  const [replyTo, setReplyTo] = useState('');
  const [editReplyTo, setEditReplyTo] = useState('');
  // Global settings active provider state
  const [globalActiveProvider, setGlobalActiveProvider] = useState('MOCK');
  const [globalRateLimitMinute, setGlobalRateLimitMinute] = useState(5);
  const [globalRateLimitHour, setGlobalRateLimitHour] = useState(100);

  // Computed Network Capacity Telemetry
  const totalSentToday = accounts.reduce((sum, a) => sum + (a.sentToday || 0), 0);
  const totalDailyLimit = accounts.reduce((sum, a) => sum + (a.dailyLimit || 0), 0);
  const remainingCapacity = Math.max(0, totalDailyLimit - totalSentToday);

  // Add Modal Individual credentials
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('');
  const [imapUser, setImapUser] = useState('');
  const [imapPass, setImapPass] = useState('');

  // Selected Account Edit Credentials
  const [editSmtpHost, setEditSmtpHost] = useState('');
  const [editSmtpPort, setEditSmtpPort] = useState('');
  const [editSmtpUser, setEditSmtpUser] = useState('');
  const [editSmtpPass, setEditSmtpPass] = useState('');
  const [editImapHost, setEditImapHost] = useState('');
  const [editImapPort, setEditImapPort] = useState('');
  const [editImapUser, setEditImapUser] = useState('');
  const [editImapPass, setEditImapPass] = useState('');
  const [savingCredentials, setSavingCredentials] = useState(false);

  // Show/Hide password toggles
  const [showAddSmtpPass, setShowAddSmtpPass] = useState(false);
  const [showAddImapPass, setShowAddImapPass] = useState(false);
  const [showEditSmtpPass, setShowEditSmtpPass] = useState(false);
  const [showEditImapPass, setShowEditImapPass] = useState(false);

  // Send Test Email state
  const [sendingTestEmail, setSendingTestEmail] = useState(false);

  // Deletion state
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { toast: showToast } = useToast();

  useEffect(() => {
    if (selectedWarmupAccount) {
      setEditSmtpHost(selectedWarmupAccount.smtpHost || '');
      setEditSmtpPort(selectedWarmupAccount.smtpPort ? String(selectedWarmupAccount.smtpPort) : '');
      setEditSmtpUser(selectedWarmupAccount.smtpUser || '');
      setEditSmtpPass(selectedWarmupAccount.smtpPass || '');
      setEditImapHost(selectedWarmupAccount.imapHost || '');
      setEditImapPort(selectedWarmupAccount.imapPort ? String(selectedWarmupAccount.imapPort) : '');
      setEditImapUser(selectedWarmupAccount.imapUser || '');
      setEditImapPass(selectedWarmupAccount.imapPass || '');
      setEditReplyTo(selectedWarmupAccount.replyTo || '');
    } else {
      setEditSmtpHost('');
      setEditSmtpPort('');
      setEditSmtpUser('');
      setEditSmtpPass('');
      setEditImapHost('');
      setEditImapPort('');
      setEditImapUser('');
      setEditImapPass('');
      setEditReplyTo('');
    }
  }, [selectedWarmupAccount]);

  const handleOpenAddModal = () => {
    setIsAddOpen(true);
    setProvider('Google Workspace');
    setSmtpHost('smtp.gmail.com');
    setSmtpPort('587');
    setImapHost('imap.gmail.com');
    setImapPort('993');
    setMinuteLimit(globalRateLimitMinute);
    setHourlyLimit(globalRateLimitHour);
    setDailyLimit(500);
  };

  const handleProviderChange = (selectedProvider: string) => {
    setProvider(selectedProvider);
    if (selectedProvider === 'Google Workspace') {
      setSmtpHost('smtp.gmail.com');
      setSmtpPort('587');
      setImapHost('imap.gmail.com');
      setImapPort('993');
    } else if (selectedProvider === 'Microsoft 365') {
      setSmtpHost('smtp.office365.com');
      setSmtpPort('587');
      setImapHost('outlook.office365.com');
      setImapPort('993');
    } else if (selectedProvider === 'SendGrid Relay Node') {
      setSmtpHost('smtp.sendgrid.net');
      setSmtpPort('587');
      setImapHost('');
      setImapPort('');
    } else if (selectedProvider === 'Azure Relay Node') {
      setSmtpHost('');
      setSmtpPort('');
      setImapHost('');
      setImapPort('');
    } else {
      setSmtpHost('');
      setSmtpPort('');
      setImapHost('');
      setImapPort('');
    }
  };

  // Fetch Accounts and Session Context
  const loadData = async () => {
    try {
      setLoading(true);
      // Fetch session
      const sessRes = await fetch('/api/session');
      const sessData = await sessRes.json();
      setSession(sessData);
      setAssignedUserId(sessData.id);

      // Fetch accounts based on role (handled by GET endpoint)
      const accRes = await fetch('/api/accounts');
      const accData = await accRes.json();
      setAccounts(accData);

      // Fetch global settings
      const settingsRes = await fetch('/api/settings');
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        setGlobalActiveProvider(settingsData.settings?.activeProvider || 'MOCK');
        if (settingsData.settings) {
          const gMin = settingsData.settings.rateLimitMinute ?? 5;
          const gHour = settingsData.settings.rateLimitHour ?? 100;
          setGlobalRateLimitMinute(gMin);
          setGlobalRateLimitHour(gHour);
          setMinuteLimit(gMin);
          setHourlyLimit(gHour);
        }
      }

      // Fetch users list only if corporate Administrator
      if (sessData.role === 'ADMIN') {
        const usersRes = await fetch('/api/users');
        if (usersRes.ok) {
          const usersData = await usersRes.json();
          setUsers(usersData);
        }
      }
    } catch (err) {
      console.error('Failed to load accounts catalog:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);



  const handleUpdateWarmupSettings = async (field: string, value: any) => {
    if (!selectedWarmupAccount) return;
    const previous = { ...selectedWarmupAccount };
    const updatedLocal = { ...selectedWarmupAccount, [field]: value };
    
    // Optimistic UI update
    setSelectedWarmupAccount(updatedLocal);
    setAccounts(prev => prev.map(acc => acc.id === selectedWarmupAccount.id ? updatedLocal : acc));

    try {
      const res = await fetch('/api/accounts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selectedWarmupAccount.id,
          [field]: value
        }),
      });

      if (!res.ok) throw new Error();
      const synced = await res.json();
      setSelectedWarmupAccount(synced);
      setAccounts(prev => prev.map(acc => acc.id === selectedWarmupAccount.id ? synced : acc));
    } catch {
      // Revert on fail
      setSelectedWarmupAccount(previous);
      setAccounts(prev => prev.map(acc => acc.id === selectedWarmupAccount.id ? previous : acc));
      showToast('Autopilot values failed to save', 'error');
    }
  };

  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailAddress || submitting) return;

    try {
      setSubmitting(true);
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailAddress,
          name: senderName,
          replyTo: replyTo || null,
          provider,
          userId: assignedUserId,
          minuteLimit: Number(minuteLimit),
          hourlyLimit: Number(hourlyLimit),
          dailyLimit: Number(dailyLimit),
          smtpHost: smtpHost || null,
          smtpPort: smtpPort ? Number(smtpPort) : null,
          smtpUser: smtpUser || null,
          smtpPass: smtpPass || null,
          imapHost: imapHost || null,
          imapPort: imapPort ? Number(imapPort) : null,
          imapUser: imapUser || null,
          imapPass: imapPass || null,
        }),
      });

      if (!res.ok) {
        const errorMsg = await res.text();
        throw new Error(errorMsg || 'Failed to connect email account');
      }

      await loadData(); // Refresh list
      setIsAddOpen(false);
      setEmailAddress('');
      setSenderName('');
      setReplyTo('');
      setProvider('Google Workspace');
      setMinuteLimit(5);
      setHourlyLimit(100);
      setDailyLimit(500);
      setSmtpHost('');
      setSmtpPort('');
      setSmtpUser('');
      setSmtpPass('');
      setImapHost('');
      setImapPort('');
      setImapUser('');
      setImapPass('');
      showToast('Successfully plugged email channel into delivery grid');
    } catch (err: any) {
      showToast(err.message || 'Error occurred connecting sender account', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveAccountCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWarmupAccount) return;
    try {
      setSavingCredentials(true);
      const res = await fetch('/api/accounts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selectedWarmupAccount.id,
          replyTo: editReplyTo || null,
          smtpHost: editSmtpHost || null,
          smtpPort: editSmtpPort ? Number(editSmtpPort) : null,
          smtpUser: editSmtpUser || null,
          smtpPass: editSmtpPass || null,
          imapHost: editImapHost || null,
          imapPort: editImapPort ? Number(editImapPort) : null,
          imapUser: editImapUser || null,
          imapPass: editImapPass || null,
        }),
      });

      if (!res.ok) {
        throw new Error('Failed to update credentials.');
      }

      const updated = await res.json();
      setAccounts(prev => prev.map(acc => acc.id === selectedWarmupAccount.id ? updated : acc));
      setSelectedWarmupAccount(updated);
      showToast('Mailbox connection credentials updated successfully.');
    } catch (err: any) {
      showToast(err.message || 'Failed to update credentials.', 'error');
    } finally {
      setSavingCredentials(false);
    }
  };

  const handleSendTestEmail = async () => {
    if (!selectedWarmupAccount || sendingTestEmail) return;
    try {
      setSendingTestEmail(true);
      const res = await fetch('/api/send-email/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderAccountId: selectedWarmupAccount.id,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to send test email.');
      }

      showToast(`Test email sent to ${data.recipient || session?.email}`);
    } catch (err: any) {
      showToast(err.message || 'Failed to send test email.', 'error');
    } finally {
      setSendingTestEmail(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!selectedWarmupAccount || deleting) return;
    setConfirmOpen(false);

    try {
      setDeleting(true);
      const res = await fetch(`/api/accounts?id=${selectedWarmupAccount.id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete mailbox connection');
      }

      showToast('Mailbox connection deleted successfully');
      setSelectedWarmupAccount(null); // Go back to list
      await loadData(); // Reload accounts list
    } catch (err: any) {
      showToast(err.message || 'Error occurred deleting mailbox', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const getOwnerName = (ownerId: string | null) => {
    if (!ownerId) return 'Unassigned';
    if (ownerId === session?.id) return 'Me (' + session?.name + ')';
    const foundUser = users.find(u => u.id === ownerId);
    return foundUser ? foundUser.name : 'Unknown Team Member';
  };

  const currentActiveTab = selectedWarmupAccount ? activeTab : 'accounts';

  return (
    <div className="space-y-6 animate-in fade-in duration-501 max-w-5xl mx-auto pb-10">



      {currentActiveTab === 'accounts' ? (
        <>
          {/* Header */}
          <header className="flex justify-between items-center pb-4 border-b border-slate-200 dark:border-slate-800 mb-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white mb-0.5">Email Senders</h1>
              <p className="text-slate-500 dark:text-slate-400 text-xs">Connect sender mailboxes, set sending limits, and monitor deliverability.</p>
            </div>
            <button 
              onClick={handleOpenAddModal}
              className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg font-semibold flex items-center gap-2 transition-colors text-xs shadow-xs cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Add Sender Mailbox
            </button>
          </header>

          {/* Key Indicators Panel */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-4 shadow-xs">
              <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Total Senders</p>
              <h3 className="text-xl font-bold mt-1 text-slate-900 dark:text-white">{loading ? '...' : accounts.length} Senders</h3>
            </div>
            <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-4 shadow-xs">
              <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest flex items-center gap-1.5 font-sans">
                Active Senders
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              </p>
              <h3 className="text-xl font-bold mt-1 text-emerald-600 dark:text-emerald-400 font-mono">
                {accounts.filter(a => a.status === 'Active').length} Active
              </h3>
            </div>
            <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-4 shadow-xs">
              <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Combined Daily Limit</p>
              <h3 className="text-xl font-bold mt-1 text-blue-600 dark:text-blue-400 font-mono">
                {accounts.reduce((sum, a) => sum + (a.dailyLimit || 0), 0).toLocaleString()} Emails
              </h3>
            </div>
          </div>

          {/* Table Directory */}
          {loading ? (
            <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-6 mt-6">
              <TableSkeleton rows={4} cols={5} />
            </div>
          ) : (
            <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl overflow-hidden shadow-xs mt-6">
              <div className="p-4 border-b border-slate-200 dark:border-[#1b1c26] flex items-center justify-between bg-slate-50/40 dark:bg-slate-950/20">
                <h2 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-widest">Connected Outreach Senders</h2>
                <span className="text-[10px] font-bold text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10 px-2.5 py-0.5 rounded border border-blue-200 dark:border-blue-500/15 uppercase tracking-widest font-mono">SMTP &amp; IMAP Ready</span>
              </div>
              
              <div className="w-full overflow-x-auto animate-in fade-in duration-300">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1b1c26] text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest bg-slate-50/20 dark:bg-slate-950/10">
                      <th className="px-5 py-3">Sender Mailbox</th>
                      <th className="px-5 py-3">Protocol</th>
                      <th className="px-5 py-3">Daily Limit</th>
                      <th className="px-5 py-3">Assigned Owner</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="px-5 py-3 text-right">Configure</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#1b1c26]/60 text-slate-700 dark:text-slate-300">
                    {accounts.map((account) => (
                      <tr 
                        key={account.id} 
                        onClick={() => {
                          setSelectedWarmupAccount(account);
                          setActiveTab('warmup');
                        }}
                        className="hover:bg-slate-50/50 dark:hover:bg-white/[0.01] transition-all group cursor-pointer"
                      >
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-gray-950 border border-slate-200 dark:border-[#1b1c26] flex items-center justify-center">
                              <Mail className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                            </div>
                            <div>
                              <div className="font-semibold text-xs text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors flex items-center gap-1.5">
                                {account.emailAddress}
                                {account.warmupEnabled && (
                                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[8px] font-extrabold bg-orange-50 dark:bg-orange-500/10 text-orange-600 dark:text-orange-500 border border-orange-100 dark:border-orange-500/20 uppercase tracking-widest animate-pulse">
                                    <Flame className="w-2.5 h-2.5 fill-orange-500/10" />
                                    Warmup
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">{account.name} • {account.provider}</div>
                              <div className="text-[9px] text-slate-400 dark:text-slate-500 mt-1 flex items-center gap-2 font-mono">
                                <span>Sent: <strong className="text-slate-700 dark:text-slate-400">{account.sentTotal ?? 0}</strong></span>
                                <span>Delivered: <strong className="text-emerald-600 dark:text-emerald-400">{account.delivered ?? 0}</strong></span>
                                <span>Opens: <strong className="text-slate-700 dark:text-slate-400">{account.opens ?? 0}</strong> <span className="text-slate-400 dark:text-slate-500">({account.openRate ?? 0}%)</span></span>
                                <span>Clicks: <strong className="text-slate-700 dark:text-slate-400">{account.clicks ?? 0}</strong> <span className="text-slate-400 dark:text-slate-500">({account.clickRate ?? 0}%)</span></span>
                                <span>Replies: <strong className="text-slate-700 dark:text-slate-400">{account.replies ?? 0}</strong></span>
                                <span>Bounces: <strong className="text-rose-600 dark:text-rose-500">{account.bounced ?? 0}</strong></span>
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3.5">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-[9px] font-bold border uppercase tracking-wider font-mono
                            ${(account.provider === 'SendGrid Relay Node' || account.provider === 'Azure Relay Node') 
                              ? 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-500 border-amber-200 dark:border-amber-500/20' 
                              : 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-500/20'}
                          `}>
                            {(account.provider === 'SendGrid Relay Node' || account.provider === 'Azure Relay Node') ? 'Send-Only Relay' : 'SMTP & IMAP'}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 font-mono text-[11px]">
                          {account.warmupEnabled ? (
                            <div>
                              <span className="text-orange-600 dark:text-orange-400 font-semibold">{account.effectiveDailyCap} today</span>
                              <span className="text-slate-400 dark:text-slate-500 text-[10px]"> / {account.dailyLimit} limit</span>
                            </div>
                          ) : (
                            <div>{account.dailyLimit} daily max</div>
                          )}
                          <div className="text-[9px] text-slate-400 dark:text-slate-500 mt-0.5 font-sans leading-none flex gap-1">
                            <span>Min: {account.minuteLimit}/min</span> • <span>Hour: {account.hourlyLimit}/hr</span>
                          </div>
                        </td>
                        <td className="px-5 py-3.5 text-xs font-semibold text-slate-600 dark:text-slate-400">
                          <span className="flex items-center gap-1">
                            <User className="w-3.5 h-3.5 text-slate-400" />
                            {getOwnerName(account.userId)}
                          </span>
                        </td>
                        <td className="px-5 py-3.5">
                          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider
                            ${account.status === 'Active' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-500 border-emerald-200 dark:border-emerald-500/20' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'}
                          `}>
                            {account.status === 'Active' ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <AlertCircle className="w-3 h-3 text-slate-400" />}
                            {account.status}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <button className="text-slate-500 dark:text-slate-400 group-hover:text-slate-900 dark:group-hover:text-white p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-white/[0.02] transition-colors flex items-center gap-1 ml-auto text-xs font-semibold">
                            Configure
                            <ChevronRight className="w-4 h-4 text-slate-400" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : (
        /* Warmup Sandbox Workspace */
        <div className="space-y-6 animate-in fade-in duration-300">
          <div className="flex items-center gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
            <button 
              onClick={() => setSelectedWarmupAccount(null)}
              className="p-1.5 bg-white dark:bg-[#0e1017] hover:bg-slate-100 dark:hover:bg-white/[0.02] rounded-lg transition-colors border border-slate-200 dark:border-slate-800 shadow-2xs cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4 text-slate-700 dark:text-slate-300" />
            </button>
            <div className="flex-1">
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-bold text-slate-900 dark:text-white mb-0.5">{selectedWarmupAccount.emailAddress}</h1>
                <span className="bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 text-[10px] font-bold px-2.5 py-0.5 border border-blue-200 dark:border-blue-500/20 rounded uppercase tracking-wider flex items-center gap-1 font-mono">
                  <Sliders className="w-3 h-3" />
                  {selectedWarmupAccount.provider}
                </span>
                {selectedWarmupAccount.warmupEnabled && (
                  <span className="bg-orange-50 dark:bg-orange-500/10 text-orange-700 dark:text-orange-400 text-[10px] font-bold px-2.5 py-0.5 border border-orange-150 dark:border-orange-500/20 rounded uppercase tracking-wider flex items-center gap-1 font-mono animate-pulse">
                    <Flame className="w-3 h-3 fill-orange-500/10" />
                    Warmup Active
                  </span>
                )}
              </div>
              <p className="text-slate-500 dark:text-slate-400 text-xs font-medium">
                {selectedWarmupAccount.warmupEnabled ? (
                  (() => {
                    const startedAt = selectedWarmupAccount.warmupStartedAt ? new Date(selectedWarmupAccount.warmupStartedAt) : new Date();
                    const daysActive = Math.max(0, Math.floor((new Date().getTime() - startedAt.getTime()) / 86400000));
                    const effectiveCap = selectedWarmupAccount.effectiveDailyCap ?? selectedWarmupAccount.dailyLimit;
                    return (
                      <span className="text-orange-600 dark:text-orange-400 font-semibold flex items-center gap-1">
                        Warmup Day {daysActive + 1} • Today's Cap: {effectiveCap} / {selectedWarmupAccount.dailyLimit} daily limit
                      </span>
                    );
                  })()
                ) : (
                  "Configure sending rate limits, connection details, and credentials for this mailbox."
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleSendTestEmail}
                disabled={sendingTestEmail}
                className="flex items-center gap-2 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 text-white text-xs font-semibold rounded-lg transition-all shadow-xs cursor-pointer group"
              >
                {sendingTestEmail ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                )}
                {sendingTestEmail ? 'Sending...' : 'Send Test Email'}
              </button>
              <button
                onClick={() => setConfirmOpen(true)}
                disabled={deleting}
                className="flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800/40 dark:hover:bg-slate-800 text-rose-600 dark:text-rose-500 border border-slate-200 dark:border-slate-800 transition-all shadow-xs cursor-pointer"
              >
                {deleting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
                {deleting ? 'Deleting...' : 'Delete Mailbox'}
              </button>
            </div>
          </div>

          {/* Deliverability Summary stats block */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-4 bg-slate-50 dark:bg-slate-900/40 p-4 border border-slate-200 dark:border-slate-800 rounded-xl">
            {[
              { title: 'Total Sent', value: selectedWarmupAccount.sentTotal ?? 0, desc: 'All campaigns' },
              { title: 'Delivered', value: selectedWarmupAccount.delivered ?? 0, desc: `${selectedWarmupAccount.deliveryRate ?? 0}% delivery rate` },
              { title: 'Unique Opens', value: selectedWarmupAccount.opens ?? 0, desc: `${selectedWarmupAccount.openRate ?? 0}% open rate` },
              { title: 'Link Clicks', value: selectedWarmupAccount.clicks ?? 0, desc: `${selectedWarmupAccount.clickRate ?? 0}% clickthrough` },
              { title: 'Customer Replies', value: selectedWarmupAccount.replies ?? 0, desc: `${selectedWarmupAccount.replyRate ?? 0}% reply rate` },
              { title: 'Total Bounced', value: selectedWarmupAccount.bounced ?? 0, desc: 'Hard bounces' }
            ].map((s, idx) => (
              <div key={idx} className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-slate-800/60 rounded-lg p-3">
                <p className="text-[9px] text-slate-400 dark:text-slate-500 font-extrabold uppercase tracking-widest">{s.title}</p>
                <h3 className="text-lg font-bold mt-1 text-slate-900 dark:text-white font-mono">{s.value.toLocaleString()}</h3>
                <p className="text-[9px] text-slate-400 dark:text-slate-500 mt-1 font-medium">{s.desc}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 animate-in fade-in duration-300">
            {/* Column 1: Connection Credentials */}
            <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 space-y-4 shadow-xs h-fit">
              <h2 className="text-xs font-bold uppercase tracking-widest text-slate-700 dark:text-slate-400 flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-2.5">
                <Sliders className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                Mailbox Connection Credentials
              </h2>
              
              <form onSubmit={handleSaveAccountCredentials} className="space-y-4">
                <div className="space-y-1.5 max-w-xs">
                  <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-widest font-bold">Reply-To Address (Optional)</label>
                  <input 
                    type="email" 
                    placeholder="e.g., replies@mycompany.com"
                    value={editReplyTo}
                    onChange={(e) => setEditReplyTo(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-3 py-2 outline-none text-xs font-mono"
                  />
                </div>

                {selectedWarmupAccount.provider !== 'Azure Relay Node' && (
                  <div className="p-3.5 rounded-xl border border-slate-200 dark:border-[#1e202d] bg-slate-50/30 dark:bg-[#10121a]/50 space-y-3">
                    <h4 className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                      Outbound Email (SMTP)
                    </h4>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">SMTP Host</label>
                        <input 
                          type="text" 
                          placeholder="smtp.example.com"
                          value={editSmtpHost}
                          onChange={(e) => setEditSmtpHost(e.target.value)}
                          className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">SMTP Port</label>
                        <input 
                          type="text" 
                          placeholder="587"
                          value={editSmtpPort}
                          onChange={(e) => setEditSmtpPort(e.target.value)}
                          className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">SMTP Username</label>
                        <input 
                          type="text" 
                          placeholder="user@domain.com"
                          value={editSmtpUser}
                          onChange={(e) => setEditSmtpUser(e.target.value)}
                          className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">SMTP Password</label>
                        <div className="relative">
                          <input 
                            type={showEditSmtpPass ? "text" : "password"} 
                            placeholder="Password or App Key"
                            value={editSmtpPass}
                            onChange={(e) => setEditSmtpPass(e.target.value)}
                            className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 pr-8 text-xs font-mono"
                          />
                          <button 
                            type="button"
                            onClick={() => setShowEditSmtpPass(!showEditSmtpPass)}
                            className="absolute right-2.5 top-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer"
                          >
                            {showEditSmtpPass ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {selectedWarmupAccount.provider !== 'SendGrid Relay Node' && selectedWarmupAccount.provider !== 'Azure Relay Node' && (
                  <div className="p-3.5 rounded-xl border border-slate-200 dark:border-[#1e202d] bg-slate-50/30 dark:bg-[#10121a]/50 space-y-3">
                    <h4 className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                      Inbound Replies (IMAP)
                    </h4>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">IMAP Host</label>
                        <input 
                          type="text" 
                          placeholder="imap.example.com"
                          value={editImapHost}
                          onChange={(e) => setEditImapHost(e.target.value)}
                          className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">IMAP Port</label>
                        <input 
                          type="text" 
                          placeholder="993"
                          value={editImapPort}
                          onChange={(e) => setEditImapPort(e.target.value)}
                          className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">IMAP Username</label>
                        <input 
                          type="text" 
                          placeholder="user@domain.com"
                          value={editImapUser}
                          onChange={(e) => setEditImapUser(e.target.value)}
                          className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">IMAP Password</label>
                        <div className="relative">
                          <input 
                            type={showEditImapPass ? "text" : "password"} 
                            placeholder="Password or App Key"
                            value={editImapPass}
                            onChange={(e) => setEditImapPass(e.target.value)}
                            className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-900 dark:text-white rounded-lg px-2.5 py-1.5 pr-8 text-xs font-mono"
                          />
                          <button 
                            type="button"
                            onClick={() => setShowEditImapPass(!showEditImapPass)}
                            className="absolute right-2.5 top-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer"
                          >
                            {showEditImapPass ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex justify-end pt-2">
                  <button 
                    type="submit" 
                    disabled={savingCredentials}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white font-semibold rounded-lg text-xs transition-colors shadow-2xs cursor-pointer flex items-center gap-1.5 font-sans"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {savingCredentials ? 'Saving...' : 'Save Connection Credentials'}
                  </button>
                </div>
              </form>
            </div>

            <div className="space-y-5">
              {/* Throttling Card */}
              <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 space-y-4 shadow-xs h-fit">
                <h2 className="text-xs font-bold uppercase tracking-widest text-slate-700 dark:text-slate-400 flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-2.5">
                  <Gauge className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  Throttling & sending frequency
                </h2>
                
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Per Minute</label>
                      <input 
                        type="number" 
                        min="1"
                        value={selectedWarmupAccount.minuteLimit}
                        onChange={(e) => handleUpdateWarmupSettings('minuteLimit', parseInt(e.target.value))}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Per Hour</label>
                      <input 
                        type="number" 
                        min="1"
                        value={selectedWarmupAccount.hourlyLimit}
                        onChange={(e) => handleUpdateWarmupSettings('hourlyLimit', parseInt(e.target.value))}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Per Day</label>
                      <input 
                        type="number" 
                        min="10"
                        value={selectedWarmupAccount.dailyLimit}
                        onChange={(e) => handleUpdateWarmupSettings('dailyLimit', parseInt(e.target.value))}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono"
                      />
                    </div>
                  </div>

                  <div className="p-3 bg-blue-50/80 dark:bg-blue-950/10 border border-blue-200 dark:border-blue-500/10 rounded-lg flex gap-3 text-[11px] leading-relaxed text-blue-700 dark:text-blue-300">
                    <Sparkles className="w-4 h-4 flex-shrink-0 text-blue-600 dark:text-blue-400" />
                    <p className="font-sans font-medium">
                      <strong>Throttling tip:</strong> To protect sender reputation, sends are spread out over time. A low per-minute limit (around 5) is recommended for new mailboxes.
                    </p>
                  </div>
                </div>
              </div>

              {/* Warmup Autopilot Settings Card */}
              <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 space-y-4 shadow-xs h-fit">
                <h2 className="text-xs font-bold uppercase tracking-widest text-slate-700 dark:text-slate-400 flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-2.5">
                  <Flame className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                  Warmup Autopilot Settings
                </h2>
                
                <div className="space-y-4">
                  {/* Toggle Switch */}
                  <div className="flex items-center justify-between p-3.5 bg-slate-50/50 dark:bg-[#10121a]/30 border border-slate-200 dark:border-[#1f2130] rounded-xl">
                    <div>
                      <h4 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wide">Warmup Autopilot</h4>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 font-medium mt-0.5">Slowly ramp up mailbox daily sending volumes to establish high sender domain reputation.</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleUpdateWarmupSettings('warmupEnabled', !selectedWarmupAccount.warmupEnabled)}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out outline-none focus:ring-2 focus:ring-blue-500/35
                        ${selectedWarmupAccount.warmupEnabled ? 'bg-orange-500' : 'bg-slate-200 dark:bg-slate-800'}
                      `}
                    >
                      <span
                        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out
                          ${selectedWarmupAccount.warmupEnabled ? 'translate-x-4' : 'translate-x-0'}
                        `}
                      />
                    </button>
                  </div>

                  {selectedWarmupAccount.warmupEnabled && (
                    <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-250">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">Starting Volume (Day 1)</label>
                          <input
                            type="number"
                            min="1"
                            max={selectedWarmupAccount.dailyLimit}
                            value={selectedWarmupAccount.warmupLimit ?? 50}
                            onChange={(e) => handleUpdateWarmupSettings('warmupLimit', parseInt(e.target.value))}
                            className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-3 py-2 outline-none text-xs font-mono"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">Daily Ramp Increment</label>
                          <input
                            type="number"
                            min="0"
                            value={selectedWarmupAccount.warmupRamp ?? 2}
                            onChange={(e) => handleUpdateWarmupSettings('warmupRamp', parseInt(e.target.value))}
                            className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-3 py-2 outline-none text-xs font-mono"
                          />
                        </div>
                      </div>

                      {/* Info Telemetry box */}
                      <div className="p-3 bg-orange-50/50 dark:bg-orange-950/10 border border-orange-200/50 dark:border-orange-500/10 rounded-lg space-y-2 text-[11px] leading-relaxed text-orange-800 dark:text-orange-300">
                        <div className="flex gap-2">
                          <Flame className="w-4 h-4 flex-shrink-0 text-orange-600 dark:text-orange-400 mt-0.5" />
                          <div>
                            <p className="font-semibold">Warmup Progress Tracker</p>
                            <ul className="list-disc pl-4 mt-1.5 space-y-1">
                              <li>Started On: <strong className="font-mono">{selectedWarmupAccount.warmupStartedAt ? new Date(selectedWarmupAccount.warmupStartedAt).toLocaleDateString() : 'Just now'}</strong></li>
                              <li>Lifetime Warmup Emails Sent: <strong className="font-mono">{selectedWarmupAccount.warmupSent ?? 0}</strong></li>
                              <li>Today's Effective sending limit: <strong className="font-mono">{selectedWarmupAccount.effectiveDailyCap ?? selectedWarmupAccount.dailyLimit}</strong> emails</li>
                            </ul>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* High-Fidelity Add Sender Modal */}
      <AnimatePresence>
        {isAddOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsAddOpen(false)}
              className="absolute inset-0 bg-slate-950/40 backdrop-blur-xs"
            />

            {/* Modal Box */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] w-full max-w-2xl rounded-2xl p-6 shadow-2xl relative z-10 overflow-hidden"
            >
              <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/5 rounded-full blur-xl pointer-events-none" />

              <header className="flex justify-between items-center pb-4 border-b border-slate-100 dark:border-[#1c1d29] mb-4">
                <div className="flex items-center gap-2">
                  <Plus className="w-5 h-5 text-blue-500" />
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">Connect Sender Mailbox</h3>
                </div>
                <button
                  onClick={() => setIsAddOpen(false)}
                  className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800/50 rounded-lg text-slate-400 dark:text-slate-500 transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </header>

              <form onSubmit={handleAddAccount} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="md:col-span-2 space-y-1.5">
                    <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-widest font-bold">Sender Email Address</label>
                    <input
                      type="email"
                      required
                      placeholder="e.g., outreach@mycompany.com"
                      value={emailAddress}
                      onChange={(e) => setEmailAddress(e.target.value)}
                      className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-3 py-2 outline-none text-xs font-mono"
                    />
                  </div>

                  <div className="md:col-span-1 space-y-1.5">
                    <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-widest font-bold">Display Name (From)</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g., Michael Scott"
                      value={senderName}
                      onChange={(e) => setSenderName(e.target.value)}
                      className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-3 py-2 outline-none text-xs font-semibold"
                    />
                  </div>

                  <div className="md:col-span-2 space-y-1.5">
                    <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-widest font-bold">Reply-To Address (Optional)</label>
                    <input
                      type="email"
                      placeholder="e.g., replies@mycompany.com"
                      value={replyTo}
                      onChange={(e) => setReplyTo(e.target.value)}
                      className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-3 py-2 outline-none text-xs font-mono"
                    />
                  </div>

                  <div className="md:col-span-1 space-y-1.5">
                    <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-widest font-bold">Email Provider</label>
                    <select
                      value={provider}
                      onChange={(e) => handleProviderChange(e.target.value)}
                      className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-3 py-2 outline-none text-xs font-medium cursor-pointer"
                    >
                      <option>Google Workspace</option>
                      <option>Microsoft 365</option>
                      <option>IMAP/SMTP Custom Protocol</option>
                      <option>SendGrid Relay Node</option>
                      <option>Azure Relay Node</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-widest font-bold flex items-center gap-1">
                    <User className="w-3 h-3" />
                    Assign Mailbox Owner
                  </label>
                  <select
                    disabled={session?.role !== 'ADMIN'}
                    value={assignedUserId}
                    onChange={(e) => setAssignedUserId(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-3 py-2 outline-none text-xs font-medium disabled:opacity-65 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {session?.role !== 'ADMIN' ? (
                      <option value={session?.id}>Me ({session?.name})</option>
                    ) : (
                      users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name} ({u.role})
                        </option>
                      ))
                    )}
                  </select>
                </div>

                {provider !== 'Azure Relay Node' && (
                  <div className="p-3.5 rounded-xl border border-slate-200 dark:border-[#1e202d] bg-slate-50/30 dark:bg-[#10121a]/50 space-y-3">
                    <h4 className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                      Outbound Email (SMTP){isSmtpDisabled(globalActiveProvider) ? ' · overrides global route' : ''}
                    </h4>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">SMTP Host</label>
                        <input 
                          type="text" 
                          placeholder="smtp.example.com"
                          value={smtpHost}
                          onChange={(e) => setSmtpHost(e.target.value)}
                          className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">SMTP Port</label>
                        <input 
                          type="text" 
                          placeholder="587"
                          value={smtpPort}
                          onChange={(e) => setSmtpPort(e.target.value)}
                          className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">SMTP Username</label>
                        <input 
                          type="text" 
                          placeholder="user@domain.com"
                          value={smtpUser}
                          onChange={(e) => setSmtpUser(e.target.value)}
                          className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">SMTP Password</label>
                        <div className="relative">
                          <input 
                            type={showAddSmtpPass ? "text" : "password"} 
                            placeholder="Password or App Key"
                            value={smtpPass}
                            onChange={(e) => setSmtpPass(e.target.value)}
                            className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 pr-8 text-xs font-mono"
                          />
                          <button 
                            type="button"
                            onClick={() => setShowAddSmtpPass(!showAddSmtpPass)}
                            className="absolute right-2.5 top-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer"
                          >
                            {showAddSmtpPass ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Inbound IMAP Details */}
                {provider !== 'SendGrid Relay Node' && provider !== 'Azure Relay Node' && (
                  <div className="p-3.5 rounded-xl border border-slate-200 dark:border-[#1e202d] bg-slate-50/30 dark:bg-[#10121a]/50 space-y-3">
                    <h4 className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                      Inbound Replies (IMAP)
                    </h4>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">IMAP Host</label>
                        <input 
                          type="text" 
                          placeholder="imap.example.com"
                          value={imapHost}
                          onChange={(e) => setImapHost(e.target.value)}
                          className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">IMAP Port</label>
                        <input 
                          type="text" 
                          placeholder="993"
                          value={imapPort}
                          onChange={(e) => setImapPort(e.target.value)}
                          className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">IMAP Username</label>
                        <input 
                          type="text" 
                          placeholder="user@domain.com"
                          value={imapUser}
                          onChange={(e) => setImapUser(e.target.value)}
                          className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest leading-none">IMAP Password</label>
                        <div className="relative">
                          <input 
                            type={showAddImapPass ? "text" : "password"} 
                            placeholder="Password or App Key"
                            value={imapPass}
                            onChange={(e) => setImapPass(e.target.value)}
                            className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-1.5 pr-8 text-xs font-mono"
                          />
                          <button 
                            type="button"
                            onClick={() => setShowAddImapPass(!showAddImapPass)}
                            className="absolute right-2.5 top-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer"
                          >
                            {showAddImapPass ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Sender Frequencies & Throttle Options Panel */}
                <div className="p-4 rounded-xl border border-slate-200 dark:border-[#1e202d] bg-slate-50/50 dark:bg-[#10121a] mt-2 space-y-3.5 shadow-2xs">
                  <h3 className="text-[10px] font-extrabold uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5 text-blue-500" />
                    Sending Limits
                  </h3>
                  
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest leading-none">Max / Minute</label>
                      <input
                        type="number"
                        min="1"
                        value={minuteLimit}
                        onChange={(e) => setMinuteLimit(parseInt(e.target.value) || 1)}
                        className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-2 text-xs font-mono"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest leading-none">Max / Hour</label>
                      <input
                        type="number"
                        min="1"
                        value={hourlyLimit}
                        onChange={(e) => setHourlyLimit(parseInt(e.target.value) || 1)}
                        className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-2 text-xs font-mono"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest leading-none">Max / Day</label>
                      <input
                        type="number"
                        min="10"
                        value={dailyLimit}
                        onChange={(e) => setDailyLimit(parseInt(e.target.value) || 10)}
                        className="w-full bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-2.5 py-2 text-xs font-mono"
                      />
                    </div>
                  </div>

                  {/* Real-Time Telemetry & Allocation Overview */}
                  {accounts.length > 0 && (
                    <div className="border-t border-slate-100 dark:border-[#1c1d29] pt-3 mt-3.5 space-y-3">
                      <div className="flex justify-between items-center text-[10px] uppercase font-bold text-slate-400 dark:text-slate-500 tracking-wider">
                        <span>Combined Daily Capacity</span>
                        <span className="text-blue-600 dark:text-blue-400 font-mono">
                          {totalSentToday} / {totalDailyLimit} Sent Today
                        </span>
                      </div>
                      
                      {/* Progress bar */}
                      <div className="w-full h-1.5 bg-slate-100 dark:bg-[#12141d] rounded-full overflow-hidden border border-slate-200/50 dark:border-[#1f2130]">
                        <div 
                          className="h-full bg-blue-500 rounded-full transition-all duration-500" 
                          style={{ width: `${Math.min(100, totalDailyLimit > 0 ? (totalSentToday / totalDailyLimit) * 100 : 0)}%` }}
                        />
                      </div>

                      {/* Summary Metrics */}
                      <div className="grid grid-cols-3 gap-2.5 text-center bg-slate-50/50 dark:bg-[#12141d]/50 p-2.5 rounded-xl border border-slate-200/50 dark:border-[#1f2130] text-[10px]">
                        <div className="space-y-0.5">
                          <div className="text-slate-400 dark:text-slate-500 font-semibold uppercase tracking-wider">Remaining Capacity</div>
                          <div className="text-xs font-bold text-slate-800 dark:text-white font-mono">{remainingCapacity} / day</div>
                        </div>
                        <div className="space-y-0.5 border-x border-slate-200/60 dark:border-[#1f2130]">
                          <div className="text-slate-400 dark:text-slate-500 font-semibold uppercase tracking-wider">Connected Mailboxes</div>
                          <div className="text-xs font-bold text-slate-800 dark:text-white font-mono">{accounts.length} Accounts</div>
                        </div>
                        <div className="space-y-0.5">
                          <div className="text-slate-400 dark:text-slate-500 font-semibold uppercase tracking-wider">Avg. Allocation</div>
                          <div className="text-xs font-bold text-slate-800 dark:text-white font-mono">
                            {accounts.length > 0 ? Math.round(totalDailyLimit / accounts.length) : 0} / account
                          </div>
                        </div>
                      </div>

                      {/* Individual Account Allocation Lists */}
                      <div className="space-y-1.5 max-h-24 overflow-y-auto pr-1">
                        <div className="text-[9px] uppercase font-bold text-slate-400 dark:text-slate-500 tracking-wider">Per-Mailbox Allocation</div>
                        {accounts.map(acc => {
                          const percent = Math.min(100, acc.dailyLimit > 0 ? ((acc.sentToday || 0) / acc.dailyLimit) * 100 : 0);
                          return (
                            <div key={acc.id} className="flex justify-between items-center text-[10px] bg-white dark:bg-[#0e1017] p-2 border border-slate-100 dark:border-[#1f2130] rounded-lg">
                              <span className="font-mono text-slate-600 dark:text-slate-400 truncate max-w-[200px]">{acc.emailAddress}</span>
                              <div className="flex items-center gap-2 font-mono text-right">
                                <span className="text-[9px] text-slate-400 dark:text-slate-500">({percent.toFixed(0)}% used)</span>
                                <span className="font-semibold text-slate-800 dark:text-white">{acc.sentToday || 0} / {acc.dailyLimit}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  
                  <p className="text-[9px] text-slate-400 dark:text-slate-500 leading-normal font-sans font-medium">
                    Keep volumes conservative — most mailboxes shouldn't exceed ~500 emails/day to protect sender reputation and deliverability.
                  </p>
                </div>

                <div className="pt-2 flex justify-end gap-3 border-t border-slate-100 dark:border-[#1c1d29] mt-6">
                  <button
                    type="button"
                    onClick={() => setIsAddOpen(false)}
                    className="px-4 py-2 bg-slate-50 hover:bg-slate-100 dark:bg-[#12141d] dark:hover:bg-[#1b1d28] border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/55 rounded-lg text-white font-semibold text-xs transition-colors cursor-pointer shadow-xs"
                  >
                    {submitting ? 'Connecting...' : 'Connect Mailbox'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <ConfirmDialog
        isOpen={confirmOpen}
        title="Delete Mailbox Connection"
        message={`Are you sure you want to delete the mailbox connection for ${selectedWarmupAccount?.email || 'this account'}? All campaign records using this sender will remain, but you won't be able to send new emails from it.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={handleDeleteAccount}
        onCancel={() => setConfirmOpen(false)}
        isDestructive={true}
      />
    </div>
  );
}

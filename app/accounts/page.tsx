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
  Activity
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

const mockLogsPool = [
  'Dispatched automated daily warmup outbound email to target-rec-12@warmup-space.io',
  'Received reply from warm-client-88@reputation.net (Topic: Scheduling discussion)',
  'Saved inbound email from Spam folder and marked as Important (sender: partner-warmup-3@arcreach.net)',
  'Moved automated newsletter email from Promotions list to primary Inbox (sender: agency-warm-12@outreach-pool.org)',
  'Simulated natural user reading speed on inbound thread from partner-node-442@warmup.network',
  'Successfully replied to pending warmup discussion thread: "Re: Quick Sync Q4"'
];

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);

  const [selectedWarmupAccount, setSelectedWarmupAccount] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'accounts' | 'warmup'>('accounts');
  const [liveLogs, setLiveLogs] = useState<string[]>([]);

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

  // Success message toast
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
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

  // Warmup live feed logs simulation
  useEffect(() => {
    if (selectedWarmupAccount && selectedWarmupAccount.warmupEnabled) {
      const interval = setInterval(() => {
        const logIndex = Math.floor(Math.random() * mockLogsPool.length);
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const newLog = `[${time}] - ${mockLogsPool[logIndex]}`;
        setLiveLogs(prev => [newLog, ...prev.slice(0, 9)]);
      }, 5000);

      return () => clearInterval(interval);
    }
  }, [selectedWarmupAccount]);

  const handleToggleWarmup = async (accountId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    
    const targetAccount = accounts.find(a => a.id === accountId);
    if (!targetAccount) return;

    const nextWarmupState = !targetAccount.warmupEnabled;

    try {
      const res = await fetch('/api/accounts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: accountId,
          warmupEnabled: nextWarmupState,
        }),
      });

      if (!res.ok) {
        throw new Error('Failed to toggle warmup autopilot');
      }

      const updated = await res.json();
      setAccounts(prev => prev.map(acc => acc.id === accountId ? updated : acc));
      if (selectedWarmupAccount?.id === accountId) {
        setSelectedWarmupAccount(updated);
      }
      showToast(nextWarmupState ? 'Autopilot exchange loop enabled' : 'Autopilot sleep triggered');
    } catch {
      showToast('Error syncing warmup status', 'error');
    }
  };

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
          provider,
          userId: assignedUserId,
          minuteLimit: Number(minuteLimit),
          hourlyLimit: Number(hourlyLimit),
          dailyLimit: Number(dailyLimit)
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
      setProvider('Google Workspace');
      setMinuteLimit(5);
      setHourlyLimit(100);
      setDailyLimit(500);
      showToast('Successfully plugged email channel into delivery grid');
    } catch (err: any) {
      showToast(err.message || 'Error occurred connecting sender account', 'error');
    } finally {
      setSubmitting(false);
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

      {/* Floating Status Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div 
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20 }}
            className={`fixed top-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-xl border backdrop-blur-md min-w-[300px] ${
              toast.type === 'success' 
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400' 
                : 'bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-450'
            }`}
          >
            <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
            <p className="text-xs font-semibold leading-normal">{toast.message}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {currentActiveTab === 'accounts' ? (
        <>
          {/* Header */}
          <header className="flex justify-between items-center pb-4 border-b border-slate-200 dark:border-slate-800 mb-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white mb-0.5">Email Senders</h1>
              <p className="text-slate-500 dark:text-slate-400 text-xs">Connect domains, configure throttling frequencies, and monitor safety reputation metrics.</p>
            </div>
            <button 
              onClick={() => setIsAddOpen(true)}
              className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg font-semibold flex items-center gap-2 transition-colors text-xs shadow-xs cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Add Sender Mailbox
            </button>
          </header>

          {/* Key Indicators Panel */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-4 shadow-xs">
              <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Total Air-Gap Mailboxes</p>
              <h3 className="text-xl font-bold mt-1 text-slate-905 dark:text-white">{loading ? '...' : accounts.length} Profiles</h3>
            </div>
            <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-4 shadow-xs">
              <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest flex items-center gap-1.5 font-sans">
                Average reputation
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              </p>
              <h3 className="text-xl font-bold mt-1 text-emerald-600 dark:text-emerald-400 font-mono">
                {accounts.length > 0 
                  ? (accounts.reduce((sum, a) => sum + (a.reputationScore || 100), 0) / accounts.length).toFixed(1) + '%' 
                  : '100%'}
              </h3>
            </div>
            <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-4 shadow-xs">
              <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Warmups Transferred</p>
              <h3 className="text-xl font-bold mt-1 text-blue-600 dark:text-blue-400 font-mono">
                {accounts.reduce((sum, a) => sum + (a.warmupSent || 0), 0).toLocaleString()} Outbound
              </h3>
            </div>
          </div>

          {/* Table Directory */}
          {loading ? (
            <div className="py-20 text-center text-slate-400 dark:text-slate-500 text-xs mt-6 space-y-3">
              <div className="w-6 h-6 border-2 border-slate-300 dark:border-slate-700 border-t-blue-500 animate-spin rounded-full mx-auto" />
              <p className="font-medium tracking-wide">Syncing sender nodes with delivery matrix...</p>
            </div>
          ) : (
            <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl overflow-hidden shadow-xs mt-6">
              <div className="p-4 border-b border-slate-200 dark:border-[#1b1c26] flex items-center justify-between bg-slate-50/40 dark:bg-slate-950/20">
                <h2 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-widest">Connected Outreach Senders</h2>
                <span className="text-[10px] font-bold text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10 px-2.5 py-0.5 rounded border border-blue-150 dark:border-blue-500/15 uppercase tracking-widest font-mono">SMTP/IMAP protocol ready</span>
              </div>
              
              <div className="w-full overflow-x-auto animate-in fade-in duration-300">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-205 dark:border-[#1b1c26] text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest bg-slate-50/20 dark:bg-slate-950/10">
                      <th className="px-5 py-3">Sender Mailbox</th>
                      <th className="px-5 py-3">Warmup Autopilot</th>
                      <th className="px-5 py-3">Daily Throttling Limit</th>
                      <th className="px-5 py-3">Assigned Owner</th>
                      <th className="px-5 py-3">Deliverability Health</th>
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
                          // Populate initial live logs
                          const initialLogs = Array.from({ length: 4 }).map(() => {
                            const index = Math.floor(Math.random() * mockLogsPool.length);
                            const time = new Date(Date.now() - Math.random() * 3600000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                            return `[${time}] - ${mockLogsPool[index]}`;
                          });
                          setLiveLogs(initialLogs);
                        }}
                        className="hover:bg-slate-50/50 dark:hover:bg-white/[0.01] transition-all group cursor-pointer"
                      >
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-gray-950 border border-slate-200 dark:border-[#1b1c26] flex items-center justify-center">
                              <Mail className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                            </div>
                            <div>
                              <div className="font-semibold text-xs text-slate-905 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">{account.emailAddress}</div>
                              <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">{account.name} • {account.provider}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3.5" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-2">
                            <button 
                              onClick={(e) => handleToggleWarmup(account.id, e)}
                              className={`p-1.5 rounded-lg border flex items-center justify-center transition-colors shadow-2xs cursor-pointer ${
                                account.warmupEnabled 
                                  ? 'bg-rose-50 dark:bg-[#9d174d]/10 border-rose-200 dark:border-[#9d174d]/40 text-rose-600 dark:text-rose-450' 
                                  : 'bg-slate-100 dark:bg-[#1b1c26] border-slate-200 dark:border-[#20222f] text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                              }`}
                            >
                              <Flame className="w-3.5 h-3.5 animate-pulse" />
                            </button>
                            <span className={`text-[10px] font-bold uppercase tracking-wider ${account.warmupEnabled ? 'text-rose-600 dark:text-rose-400 animate-pulse' : 'text-slate-400 dark:text-slate-500'}`}>
                              {account.warmupEnabled ? 'AUTOPILOT' : 'OFF'}
                            </span>
                          </div>
                        </td>
                        <td className="px-5 py-3.5 font-mono text-[11px]">
                          <div>{account.dailyLimit} daily max</div>
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
                            ${account.status === 'Active' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-450 border-emerald-200 dark:border-emerald-500/20' : ''}
                            ${account.status === 'Warning' ? 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-450 border-amber-200 dark:border-amber-500/20' : ''}
                          `}>
                            {account.status === 'Active' ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <AlertCircle className="w-3 h-3 text-amber-500" />}
                            {account.reputationScore}% Rating
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <button className="text-slate-550 dark:text-slate-400 group-hover:text-slate-900 dark:group-hover:text-white p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-white/[0.02] transition-colors flex items-center gap-1 ml-auto text-xs font-semibold">
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
          <div className="flex items-center gap-4 pb-4 border-b border-slate-200 dark:border-slate-850">
            <button 
              onClick={() => setSelectedWarmupAccount(null)}
              className="p-1.5 bg-white dark:bg-[#0e1017] hover:bg-slate-100 dark:hover:bg-white/[0.02] rounded-lg transition-colors border border-slate-200 dark:border-slate-800 shadow-2xs cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4 text-slate-700 dark:text-slate-300" />
            </button>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-bold text-slate-900 dark:text-white mb-0.5">{selectedWarmupAccount.emailAddress}</h1>
                <span className="bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-400 text-[10px] font-bold px-2.5 py-0.5 border border-rose-150 dark:border-[#961747]/30 rounded uppercase tracking-wider flex items-center gap-1 font-mono">
                  <Flame className="w-3 h-3 animate-pulse" />
                  Deliverability loops
                </span>
              </div>
              <p className="text-slate-500 dark:text-slate-400 text-xs font-medium">Automate peer exchanges across secure clean IP addresses to lift domain safety scores.</p>
            </div>
          </div>

          {/* Quick Metrics */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-4 shadow-xs">
              <div className="flex justify-between items-start">
                <div>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Warmup Dispatched</p>
                  <h3 className="text-xl font-bold mt-1 text-slate-900 dark:text-white font-mono">{selectedWarmupAccount.warmupSent}</h3>
                </div>
                <div className="w-8 h-8 bg-rose-50 dark:bg-rose-500/10 rounded-lg flex items-center justify-center text-rose-600 dark:text-rose-400 border border-rose-150 dark:border-rose-500/20">
                  <Flame className="w-4 h-4" />
                </div>
              </div>
              <p className="text-[10px] text-rose-650 dark:text-rose-400 mt-2 flex items-center gap-1 font-bold">
                <TrendingUp className="w-3 h-3" />
                Auto-ramping actively
              </p>
            </div>

            <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-4 shadow-xs">
              <div className="flex justify-between items-start">
                <div>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Saved from Spam</p>
                  <h2 className="text-xl font-bold mt-1 text-emerald-600 dark:text-emerald-400 font-mono">+{selectedWarmupAccount.savedSpam}</h2>
                </div>
                <div className="w-8 h-8 bg-emerald-50 dark:bg-emerald-500/10 rounded-lg flex items-center justify-center text-emerald-600 dark:text-emerald-400 border border-emerald-150 dark:border-emerald-500/20">
                  <ShieldAlert className="w-4 h-4" />
                </div>
              </div>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2 font-medium">Auto-moved to Primary Folders</p>
            </div>

            <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-4 shadow-xs">
              <div className="flex justify-between items-start">
                <div>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Saved from Promo</p>
                  <h2 className="text-xl font-bold mt-1 text-blue-600 dark:text-blue-400 font-mono">+{selectedWarmupAccount.savedPromo}</h2>
                </div>
                <div className="w-8 h-8 bg-blue-50 dark:bg-blue-500/10 rounded-lg flex items-center justify-center text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20">
                  <Inbox className="w-4 h-4" />
                </div>
              </div>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2 font-medium">Re-routed into Primary mailbox</p>
            </div>

            <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-4 shadow-xs">
              <div className="flex justify-between items-start">
                <div>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Reply Goal Target</p>
                  <h2 className="text-xl font-bold mt-1 text-blue-600 dark:text-blue-400 font-mono">{selectedWarmupAccount.warmupReplies}%</h2>
                </div>
                <div className="w-8 h-8 bg-blue-50 dark:bg-blue-500/10 rounded-lg flex items-center justify-center text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20">
                  <MessageSquare className="w-4 h-4" />
                </div>
              </div>
              <p className="text-[10px] text-blue-600 dark:text-blue-300 mt-2 font-medium">Automatic conversation trigger</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Controls */}
            <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 space-y-5 shadow-xs">
              <h2 className="text-xs font-bold uppercase tracking-widest text-slate-700 dark:text-slate-400 flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-2.5">
                <Sliders className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                Warmup Autopilot controls
              </h2>

              <div className="space-y-4">
                <label className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] rounded-xl cursor-pointer hover:bg-slate-100/50 dark:hover:bg-white/[0.01] transition-colors shadow-2xs">
                   <div>
                      <div className="text-xs font-bold text-slate-850 dark:text-white uppercase tracking-wider">Reputation Warmup algorithm</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-550 mt-0.5 leading-normal font-medium">Allow this domain to participate in peer deliverability loops.</div>
                   </div>
                   <input 
                     type="checkbox" 
                     checked={selectedWarmupAccount.warmupEnabled}
                     onChange={() => handleToggleWarmup(selectedWarmupAccount.id)}
                     className="toggle-checkbox sr-only peer" 
                   />
                   <div className="w-10 h-5.5 bg-slate-200 dark:bg-gray-800 rounded-full peer peer-checked:bg-rose-500 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4.5 after:w-4.5 after:transition-all relative border border-slate-300 dark:border-[#1b1c26]"></div>
                 </label>

                <div className="space-y-2.5 mt-2">
                   <div className="flex justify-between text-xs">
                      <span className="text-slate-550 dark:text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Daily Maximum Outbound cap</span>
                      <span className="font-bold text-rose-600 dark:text-rose-400 font-mono">{selectedWarmupAccount.warmupLimit} emails/day</span>
                   </div>
                   <input 
                      type="range" 
                      min="10" 
                      max="100" 
                      value={selectedWarmupAccount.warmupLimit}
                      onChange={(e) => handleUpdateWarmupSettings('warmupLimit', parseInt(e.target.value))}
                      className="w-full accent-rose-500 h-1 bg-slate-200 dark:bg-gray-800 rounded-lg cursor-pointer"
                   />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-405 dark:text-slate-500 uppercase tracking-widest font-bold">Ramp-Up Slope / Day</label>
                    <input 
                      type="number" 
                      min="1"
                      max="10"
                      value={selectedWarmupAccount.warmupRamp}
                      onChange={(e) => handleUpdateWarmupSettings('warmupRamp', parseInt(e.target.value))}
                      className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-3 py-2 outline-none text-xs font-mono"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-405 dark:text-slate-500 uppercase tracking-widest font-bold">Simulated Dialog Reply (%)</label>
                    <input 
                      type="number" 
                      min="5" 
                      max="100"
                      value={selectedWarmupAccount.warmupReplies}
                      onChange={(e) => handleUpdateWarmupSettings('warmupReplies', parseInt(e.target.value))}
                      className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-805 dark:text-white rounded-lg px-3 py-2 outline-none text-xs font-mono"
                    />
                  </div>
                </div>

                {/* Granular Frequencies & Throttling Section in config */}
                <div className="border-t border-slate-100 dark:border-slate-800 pt-4 space-y-3">
                  <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                    <Gauge className="w-3.5 h-3.5" />
                    Throttling & sending frequency
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Per Minute</label>
                      <input 
                        type="number" 
                        min="1"
                        max="60"
                        value={selectedWarmupAccount.minuteLimit}
                        onChange={(e) => handleUpdateWarmupSettings('minuteLimit', parseInt(e.target.value))}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-805 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono rounded"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Per Hour</label>
                      <input 
                        type="number" 
                        min="1"
                        max="500"
                        value={selectedWarmupAccount.hourlyLimit}
                        onChange={(e) => handleUpdateWarmupSettings('hourlyLimit', parseInt(e.target.value))}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-805 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono rounded"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Per Day</label>
                      <input 
                        type="number" 
                        min="10"
                        max="2000"
                        value={selectedWarmupAccount.dailyLimit}
                        onChange={(e) => handleUpdateWarmupSettings('dailyLimit', parseInt(e.target.value))}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-805 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-mono rounded"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-3 bg-blue-50/80 dark:bg-blue-955/10 border border-blue-150 dark:border-blue-500/10 rounded-lg flex gap-3 text-[11px] leading-relaxed text-blue-750 dark:text-blue-300">
                <Sparkles className="w-4 h-4 flex-shrink-0 text-blue-600 dark:text-blue-400" />
                <p className="font-sans font-medium">
                  <strong>Throttling Advice:</strong> To protect domain DNS records, we randomize interval spaces heavily. A minute limit of 5 is recommended for new mailboxes.
                </p>
              </div>
            </div>

            {/* Live Logs */}
            <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 flex flex-col h-[420px] shadow-xs">
              <div className="flex justify-between items-center border-b border-slate-200 dark:border-[#1b1c26] pb-2.5 mb-3">
                <h2 className="text-xs font-bold uppercase tracking-widest text-slate-600 dark:text-slate-400 flex items-center gap-2">
                  <RefreshCw className="w-3.5 h-3.5 text-rose-500 animate-spin" style={{ animationDuration: '6s' }} />
                  Live delivery exchange log
                </h2>
                <span className="text-[9px] font-bold text-rose-600 dark:text-rose-450 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/15 px-2 py-0.5 rounded uppercase tracking-wider font-mono">AUTOPILOT EXCISE</span>
              </div>

              <div className="flex-1 overflow-y-auto space-y-2.5 font-mono text-[11px] pr-1">
                {selectedWarmupAccount.warmupEnabled ? (
                  liveLogs.map((log, index) => (
                    <div 
                      key={index} 
                      className={`p-2.5 rounded-lg border leading-relaxed ${
                        index === 0 
                          ? 'bg-rose-50 dark:bg-rose-500/5 border-rose-220 dark:border-rose-500/15 text-rose-650 dark:text-rose-300' 
                          : 'bg-slate-50/75 dark:bg-[#12141d]/40 border-slate-205 dark:border-[#1f2130] text-slate-500'
                      }`}
                    >
                      {log}
                    </div>
                  ))
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-center opacity-45 p-4">
                    <Flame className="w-8 h-8 mb-2 text-slate-400 dark:text-white" />
                    <p className="text-xs font-medium text-slate-500 leading-normal">Warmup autopilot is currently disabled. Toggle autopilot loop above to start deliverability exchanges.</p>
                  </div>
                )}
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
              className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] w-full max-w-lg rounded-2xl p-6 shadow-2xl relative z-10 overflow-hidden"
            >
              <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/5 rounded-full blur-xl pointer-events-none" />

              <header className="flex justify-between items-center pb-4 border-b border-slate-100 dark:border-[#1c1d29] mb-4">
                <div className="flex items-center gap-2">
                  <Plus className="w-5 h-5 text-blue-500" />
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">Connect Sender Mailbox</h3>
                </div>
                <button
                  onClick={() => setIsAddOpen(false)}
                  className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800/50 rounded-lg text-slate-400 dark:text-slate-505 transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </header>

              <form onSubmit={handleAddAccount} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-450 dark:text-slate-500 uppercase tracking-widest font-bold">Sender Email Address</label>
                    <input
                      type="email"
                      required
                      placeholder="e.g., outreach@mycompany.com"
                      value={emailAddress}
                      onChange={(e) => setEmailAddress(e.target.value)}
                      className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-850 dark:text-white rounded-lg px-3 py-2 outline-none text-xs font-mono"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-450 dark:text-slate-500 uppercase tracking-widest font-bold">Display Name (From)</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g., Michael Scott"
                      value={senderName}
                      onChange={(e) => setSenderName(e.target.value)}
                      className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-850 dark:text-white rounded-lg px-3 py-2 outline-none text-xs font-semibold"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-450 dark:text-slate-500 uppercase tracking-widest font-bold">Connection Tech Provider</label>
                    <select
                      value={provider}
                      onChange={(e) => setProvider(e.target.value)}
                      className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-805 dark:text-white rounded-lg px-3 py-2 outline-none text-xs font-medium cursor-pointer"
                    >
                      <option>Google Workspace</option>
                      <option>Microsoft 365</option>
                      <option>IMAP/SMTP Custom Protocol</option>
                      <option>SendGrid Relay Node</option>
                    </select>
                  </div>

                  {/* ADMIN Assignment select field: Only active/available if role is ADMIN */}
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-450 dark:text-slate-500 uppercase tracking-widest font-bold flex items-center gap-1">
                      <User className="w-3 h-3" />
                      Assign Mailbox Owner
                    </label>
                    <select
                      disabled={session?.role !== 'ADMIN'}
                      value={assignedUserId}
                      onChange={(e) => setAssignedUserId(e.target.value)}
                      className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-805 dark:text-white rounded-lg px-3 py-2 outline-none text-xs font-medium disabled:opacity-65 disabled:cursor-not-allowed cursor-pointer"
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
                </div>

                {/* Sender Frequencies & Throttle Options Panel */}
                <div className="p-4 rounded-xl border border-slate-200 dark:border-[#1e202d] bg-slate-50/50 dark:bg-[#10121a] mt-2 space-y-3.5 shadow-2xs">
                  <h3 className="text-[10px] font-extrabold uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5 text-blue-500" />
                    Sending Throttling Threshold Limits
                  </h3>
                  
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <label className="text-[9px] font-bold text-slate-450 uppercase tracking-widest leading-none">Max / Minute</label>
                      <input
                        type="number"
                        min="1"
                        max="60"
                        value={minuteLimit}
                        onChange={(e) => setMinuteLimit(parseInt(e.target.value) || 1)}
                        className="w-full bg-white dark:bg-[#0e1017] border border-slate-205 dark:border-[#1f2130] text-slate-805 dark:text-white rounded-lg px-2.5 py-2 text-xs font-mono"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[9px] font-bold text-slate-455 uppercase tracking-widest leading-none">Max / Hour</label>
                      <input
                        type="number"
                        min="1"
                        max="500"
                        value={hourlyLimit}
                        onChange={(e) => setHourlyLimit(parseInt(e.target.value) || 1)}
                        className="w-full bg-white dark:bg-[#0e1017] border border-slate-205 dark:border-[#1f2130] text-slate-805 dark:text-white rounded-lg px-2.5 py-2 text-xs font-mono"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[9px] font-bold text-slate-455 uppercase tracking-widest leading-none">Max / Day</label>
                      <input
                        type="number"
                        min="10"
                        max="1440"
                        value={dailyLimit}
                        onChange={(e) => setDailyLimit(parseInt(e.target.value) || 10)}
                        className="w-full bg-white dark:bg-[#0e1017] border border-slate-205 dark:border-[#1f2130] text-slate-805 dark:text-white rounded-lg px-2.5 py-2 text-xs font-mono"
                      />
                    </div>
                  </div>
                  
                  <p className="text-[9px] text-slate-400 dark:text-slate-500 leading-normal font-sans font-medium">
                    Limits are strictly audited in delivery buffers. Active warmed accounts shouldn't exceed 500 emails/day to maximize DMARC reputation health.
                  </p>
                </div>

                <div className="pt-2 flex justify-end gap-3 border-t border-slate-100 dark:border-[#1c1d29] mt-6">
                  <button
                    type="button"
                    onClick={() => setIsAddOpen(false)}
                    className="px-4 py-2 bg-slate-50 hover:bg-slate-100 dark:bg-[#12141d] dark:hover:bg-[#1b1d28] border border-slate-202 dark:border-slate-800 text-slate-700 dark:text-slate-300 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/55 rounded-lg text-white font-semibold text-xs transition-colors cursor-pointer shadow-xs"
                  >
                    {submitting ? 'Plugging domain...' : 'Plug Sender Mailbox'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}

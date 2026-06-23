/* eslint-disable react-hooks/set-state-in-effect, react/no-unescaped-entities, react-hooks/exhaustive-deps */
'use client';

import { useState, useEffect, Fragment } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { 
  Plus, 
  CheckCircle2, 
  PlayCircle, 
  Search, 
  X, 
  Layers, 
  Filter, 
  FileSpreadsheet,
  RefreshCw,
  Mail,
  User,
  ChevronRight,
  ChevronDown,
  Sparkles,
  Inbox,
  Trash2,
  Play,
  Pause,
  Send,
  Check
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

const isDispatchForStep = (dispatchSubject: string, stepSubject: string) => {
  if (!dispatchSubject || !stepSubject) return false;
  
  const cleanStep = stepSubject.trim().toLowerCase();
  const cleanDispatch = dispatchSubject.trim().toLowerCase();
  
  if (cleanDispatch === cleanStep) return true;
  
  // Convert step subject to a regex pattern
  // 1. Escape special regex characters
  let pattern = cleanStep.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  
  // 2. Make spaces flexible (allowing optional spaces only at word boundaries)
  pattern = pattern.replace(/\s+/g, '(?:\\s+|\\b)');
  
  // 3. Replace escaped variable markers `\{\{[^}]+\}\}` with wildcards `.*`
  pattern = pattern.replace(/\\\{\\\{[^}]+\\\}\\\}/g, '.*');
  
  // 4. Replace escaped spintax `\{option1\|option2\}` with regex group `(option1|option2)`
  pattern = pattern.replace(/\\\{([^{}]+)\\\}/g, (match, optionsEscaped) => {
    // Unescape the pipe character for the regex group
    const options = optionsEscaped.replace(/\\\|/g, '|');
    return `(${options})`;
  });
  
  try {
    const regex = new RegExp(`^${pattern}\\s*\\.*\\!*\\??$`);
    return regex.test(cleanDispatch);
  } catch (e) {
    return cleanDispatch.includes(cleanStep.replace(/\{\{[^}]+\}\}/g, '').replace(/\{[^}]+\}/g, '').trim());
  }
};

interface DbCampaign {
  id: string;
  name: string;
  status: 'Active' | 'Draft' | 'Paused';
  senderAccountId: string;
  senderAccount?: {
    emailAddress: string;
  };
  userId: string | null;
  createdAt: string;
  steps?: {
    id: string;
    stepOrder: number;
    waitDays: number;
    subject: string;
    body: string;
  }[];
  enrollments?: {
    id: string;
    leadId: string;
    campaignId: string;
    status: 'Active' | 'Completed' | 'Bounced' | 'Stopped';
    currentSequenceStep: number;
    nextActionDate: string | null;
  }[];
  dispatches?: {
    id: string;
    subject: string | null;
    leadId: string;
  }[];
}

export default function CampaignsPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<DbCampaign[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [expandedCampaignId, setExpandedCampaignId] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);

  const handleToggleStatus = async (id: string, currentStatus: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newStatus = currentStatus === 'Active' ? 'Paused' : 'Active';
    try {
      const res = await fetch('/api/campaigns', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: newStatus })
      });
      if (res.ok) {
        showToast(`Sequence status updated to ${newStatus}`);
        loadData();
      } else {
        showToast('Failed to update status.', 'error');
      }
    } catch {
      showToast('Error updating status.', 'error');
    }
  };

  const handleRunCampaign = async (id: string, stepOrder?: number) => {
    const key = id + (stepOrder ? `-${stepOrder}` : '');
    try {
      setExecutingId(key);
      const url = `/api/campaigns/${id}/run` + (stepOrder ? `?stepOrder=${stepOrder}` : '');
      const res = await fetch(url, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(`Manual cycle completed! Sent ${data.dispatchedCount} emails.`);
        loadData();
      } else {
        showToast(data.error || 'Failed to dispatch manual cycle.', 'error');
      }
    } catch {
      showToast('Failed to execute dispatch cycle.', 'error');
    } finally {
      setExecutingId(null);
    }
  };

  // Add campaign form
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [campaignName, setCampaignName] = useState('');
  const [selectedMailboxId, setSelectedMailboxId] = useState('');
  const [selectedPoolIds, setSelectedPoolIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Success message toast
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3050);
  };

  const loadData = async () => {
    try {
      setLoading(true);
      // Load session
      const sessRes = await fetch('/api/session');
      const sessData = await sessRes.json();
      setSession(sessData);

      // Load mailboxes for the dropdown
      const accRes = await fetch('/api/accounts');
      if (accRes.ok) {
        const accData = await accRes.json();
        setAccounts(accData);
        if (accData.length > 0) {
          setSelectedMailboxId(accData[0].id);
        }
      }

      // Load campaigns with constraints
      const cmpRes = await fetch(`/api/campaigns?t=${Date.now()}`);
      if (cmpRes.ok) {
        const cmpData = await cmpRes.json();
        setCampaigns(cmpData);
      }
    } catch {
      showToast('Error syncing sequences', 'error');
    } finally {
      setLoading(false);
    }
  };

  const refreshCampaigns = async () => {
    try {
      const cmpRes = await fetch(`/api/campaigns?t=${Date.now()}`);
      if (cmpRes.ok) {
        const cmpData = await cmpRes.json();
        setCampaigns(cmpData);
      }
    } catch (err) {
      console.error('Failed to auto-refresh campaigns:', err);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const anyCampaignActive = campaigns.some(c => c.status === 'Active');
  const isRunning = executingId !== null;

  useEffect(() => {
    if (!anyCampaignActive && !isRunning) return;

    const interval = setInterval(() => {
      refreshCampaigns();
    }, 2000);

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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: campaignName,
          senderAccountId: selectedMailboxId,
          // Rotation pool: primary plus any additional selected mailboxes (deduped).
          senderAccountIds: Array.from(new Set([selectedMailboxId, ...selectedPoolIds])),
          status: 'Draft',
        }),
      });

      if (!res.ok) {
        throw new Error(await res.text() || 'Failed to establish campaign.');
      }

      const created = await res.json();
      showToast('Campaign sequence initiated successfully');
      setCampaignName('');
      setSelectedPoolIds([]);
      setIsAddOpen(false);
      
      // Redirect to newly created campaign editor page!
      router.push(`/campaigns/${created.id}`);
    } catch (err: any) {
      showToast(err.message || 'Error occurred', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteCampaign = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to permanently delete this campaign? All step templates and metrics will be purged.')) {
      return;
    }

    try {
      const res = await fetch(`/api/campaigns?id=${id}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        setCampaigns(campaigns.filter(c => c.id !== id));
        showToast('Campaign sequence deleted.');
      } else {
        showToast('Failed to delete campaign sequence.', 'error');
      }
    } catch (err) {
      showToast('Error occurred deleting campaign.', 'error');
    }
  };

  const filteredCampaigns = campaigns.filter(c => 
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-501 relative max-w-5xl mx-auto pb-10">
      
      {/* Dynamic Toast Feedback */}
      <AnimatePresence>
        {toast && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={`fixed top-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-xl border backdrop-blur-md shadow-2xl min-w-[280px] ${
              toast.type === 'success' 
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-500' 
                : 'bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-500'
            }`}
          >
            <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
            <p className="text-xs font-semibold leading-normal">{toast.message}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="flex justify-between items-center pb-4 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white mb-0.5">Campaign Sequences</h1>
          <p className="text-slate-500 dark:text-slate-400 text-xs">Establish cold sequences, attach sender nodes, and orchestrate automated client follow-ups.</p>
        </div>
        <button 
          onClick={() => {
            if (accounts.length === 0) {
              showToast('Please first connect at least one Mailbox in the Senders view before starting a campaign.', 'error');
              return;
            }
            setIsAddOpen(true);
          }}
          className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg font-semibold flex items-center gap-2 transition-colors text-xs shadow-xs cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Create Sequence
        </button>
      </header>

      {/* Main Table Panel */}
      <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl overflow-hidden shadow-xs mt-4">
        {/* Table Management Bar */}
        <div className="p-4 border-b border-slate-200 dark:border-[#1b1c26] flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-slate-50/40 dark:bg-slate-950/20">
          <div className="relative w-full sm:w-72">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
            <input 
              type="text" 
              placeholder="Search active sequencers..." 
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-[#20222e] text-slate-800 dark:text-white text-xs rounded-lg pl-9 pr-4 py-2 outline-none focus:ring-2 focus:ring-blue-500/15 placeholder:text-slate-400 dark:placeholder:text-slate-500 transition-all shadow-xs"
            />
          </div>
          <div className="flex gap-2 w-full sm:w-auto justify-end">
            <button 
              onClick={() => showToast('Campaign criteria filters loaded')}
              className="px-3 py-1.8 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-400 transition-colors flex items-center gap-1.5 shadow-2xs cursor-pointer"
            >
              <Filter className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
              Filter
            </button>
            <button 
              onClick={() => showToast('Campaign stats CSV report ready for download')}
              className="px-3 py-1.8 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-400 transition-colors flex items-center gap-1.5 shadow-2xs cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
              Export Directory CSV
            </button>
          </div>
        </div>

        {/* Structured Table */}
        {loading ? (
          <div className="py-20 text-center text-slate-400 dark:text-slate-500 text-xs space-y-3">
            <div className="w-6 h-6 border-2 border-slate-300 dark:border-slate-700 border-t-blue-500 animate-spin rounded-full mx-auto" />
            <p className="font-medium tracking-wide">Querying corporate campaigns list secure nodes...</p>
          </div>
        ) : (
          <div className="w-full overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-[#1b1c26] text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest bg-slate-50/10 dark:bg-slate-950/20">
                  <th className="px-5 py-3">Sequence Details</th>
                  <th className="px-5 py-3">Sender Mailbox Relay</th>
                  <th className="px-5 py-3">Assign Owner</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3 text-right">Configure</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-[#1b1c26]/60 text-slate-700 dark:text-slate-300">
                {filteredCampaigns.map((campaign) => (
                  <Fragment key={campaign.id}>
                    <tr 
                      onClick={() => setExpandedCampaignId(expandedCampaignId === campaign.id ? null : campaign.id)}
                      className={`hover:bg-slate-50/50 dark:hover:bg-white/[0.01] transition-colors group cursor-pointer ${
                        expandedCampaignId === campaign.id ? 'bg-slate-50/60 dark:bg-[#12141d]/40' : ''
                      }`}
                    >
                      <td className="px-5 py-3.5">
                        <div className="font-semibold text-slate-900 dark:text-white text-xs group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors flex items-center gap-2">
                          {expandedCampaignId === campaign.id ? (
                            <ChevronDown className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
                          )}
                          <Layers className="w-4 h-4 text-slate-400 dark:text-slate-500 group-hover:text-blue-500 dark:group-hover:text-blue-400 transition-colors shrink-0" />
                          {campaign.name}
                        </div>
                        <div className="text-[10px] text-slate-400 dark:text-slate-500 font-mono mt-1 pl-5">
                          ID: {campaign.id} • Created {new Date(campaign.createdAt).toLocaleDateString()}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-xs text-slate-600 dark:text-slate-400 font-mono">
                        <span className="flex items-center gap-1.5">
                          <Mail className="w-3.5 h-3.5 text-slate-400" />
                          {campaign.senderAccount?.emailAddress || 'N/A'}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-xs text-slate-600 dark:text-slate-400">
                        <span className="flex items-center gap-1.5 font-medium">
                          <User className="w-3.5 h-3.5 text-slate-400" />
                          {campaign.userId === session?.id ? 'Me (' + session?.name + ')' : (campaign.userId || 'Company Admin')}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider
                          ${campaign.status === 'Active' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-500 border-emerald-200 dark:border-emerald-500/20' : ''}
                          ${campaign.status === 'Draft' ? 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800' : ''}
                          ${campaign.status === 'Paused' ? 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-500/20' : ''}
                        `}>
                          {campaign.status === 'Active' && <PlayCircle className="w-3 h-3 text-emerald-500" />}
                          {campaign.status}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-right" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-2">
                          <button 
                            onClick={(e) => handleDeleteCampaign(campaign.id, e)}
                            className="p-1.5 hover:bg-rose-500/10 text-slate-400 hover:text-rose-600 rounded transition-colors"
                            title="Delete Outbound Sequence"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                          <Link 
                            href={`/campaigns/${campaign.id}`}
                            className="text-slate-500 dark:text-slate-400 group-hover:text-slate-900 dark:group-hover:text-white p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-white/[0.02] transition-colors flex items-center gap-1 text-xs font-semibold"
                          >
                            Configure
                            <ChevronRight className="w-4 h-4 text-slate-400" />
                          </Link>
                        </div>
                      </td>
                    </tr>
                    {expandedCampaignId === campaign.id && (
                      <tr className="bg-slate-50/50 dark:bg-[#0c0d12]/35 border-t border-b border-slate-100 dark:border-[#1b1c26]/60">
                        <td colSpan={5} className="px-6 py-5">
                          <div className="space-y-5">
                            
                            {/* Summary row */}
                            <div className="flex flex-wrap justify-between items-center gap-3 border-b border-slate-200 dark:border-slate-800/50 pb-3">
                              <div>
                                <span className="text-[10px] text-slate-400 dark:text-slate-500 font-extrabold uppercase tracking-widest">Sequence Tracking Overview</span>
                                <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200 mt-0.5">
                                  {campaign.name} is currently in <span className="text-blue-600 dark:text-blue-400 font-extrabold">{campaign.status}</span> mode.
                                </h4>
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={(e) => handleToggleStatus(campaign.id, campaign.status, e)}
                                  className="px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-[10px] font-bold text-slate-700 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg flex items-center gap-1.5 transition-all shadow-3xs cursor-pointer"
                                >
                                  {campaign.status === 'Active' ? (
                                    <>
                                      <Pause className="w-3 h-3 text-amber-500" />
                                      Pause Campaign
                                    </>
                                  ) : (
                                    <>
                                      <Play className="w-3 h-3 text-emerald-500" />
                                      Activate Campaign
                                    </>
                                  )}
                                </button>
                                {campaign.status === 'Active' && (
                                  <button
                                    type="button"
                                    onClick={() => handleRunCampaign(campaign.id)}
                                    disabled={executingId !== null}
                                    className="px-3 py-1.5 bg-blue-600 text-white hover:bg-blue-500 text-[10px] font-bold rounded-lg flex items-center gap-1.5 transition-all shadow-3xs cursor-pointer disabled:opacity-50"
                                  >
                                    {executingId === campaign.id ? (
                                      <RefreshCw className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <PlayCircle className="w-3 h-3" />
                                    )}
                                    {executingId === campaign.id ? 'Running Cycle...' : 'Run Campaign Dispatch'}
                                  </button>
                                )}
                              </div>
                            </div>

                            {/* Tracking Flow Bar */}
                            {(!campaign.steps || campaign.steps.length === 0) ? (
                              <div className="py-6 text-center text-slate-400 dark:text-slate-500 text-xs">
                                No email steps configured yet. Please configure the campaign sequence to add dispatches.
                              </div>
                            ) : (
                              <div className="py-2 flex items-center w-full min-w-[500px] overflow-x-auto">
                                
                                {campaign.steps.map((step, idx) => {
                                  const stepLeads = campaign.enrollments?.filter(
                                    e => e.status === 'Active' && e.currentSequenceStep === step.stepOrder
                                  ) || [];
                                  const activeLeadsCount = stepLeads.length;
                                  const isActiveStep = activeLeadsCount > 0;

                                  const stepDispatches = campaign.dispatches?.filter(
                                    d => isDispatchForStep(d.subject || '', step.subject || '')
                                  ) || [];
                                  const uniqueSentLeads = new Set(stepDispatches.map(d => d.leadId).filter(Boolean));
                                  const sentCount = uniqueSentLeads.size;
                                  const totalEnrolled = campaign.enrollments?.length || 0;
                                  const progressPercent = totalEnrolled > 0 ? Math.round((sentCount / totalEnrolled) * 100) : 0;

                                  return (
                                    <Fragment key={step.id}>
                                      {/* Connecting Line */}
                                      {idx > 0 && (
                                        <div className="flex-1 min-w-[40px] px-2">
                                          <div className={`h-[3px] rounded transition-all duration-500 ${
                                            isActiveStep 
                                              ? 'bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.6)] animate-pulse' 
                                              : 'bg-slate-200 dark:bg-slate-800'
                                          }`} />
                                        </div>
                                      )}

                                      {/* Step Node Card */}
                                      <div className="flex flex-col items-center text-center space-y-2 relative">
                                        {/* Leads Badge above the node */}
                                        <div className="h-5 flex items-center">
                                          {activeLeadsCount > 0 ? (
                                            <span className="bg-blue-50 dark:bg-blue-900/60 text-blue-600 dark:text-blue-300 text-[9px] font-extrabold px-1.5 py-0.5 rounded border border-blue-100 dark:border-blue-800 animate-bounce">
                                              {activeLeadsCount} active
                                            </span>
                                          ) : (
                                            <span className="text-slate-400 dark:text-slate-600 text-[9px] font-semibold">
                                              0 active
                                            </span>
                                          )}
                                        </div>

                                        {/* Step Circle Node */}
                                        <div className={`w-9 h-9 rounded-full flex items-center justify-center font-mono text-xs font-bold transition-all duration-300 ${
                                          isActiveStep 
                                            ? 'bg-blue-600 text-white border-2 border-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.5)] scale-105' 
                                            : 'bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 text-slate-700 dark:text-slate-400'
                                        }`}>
                                          {step.stepOrder}
                                        </div>

                                        {/* Step Info below the node */}
                                        <div className="space-y-1 min-w-[110px] max-w-[140px] bg-white dark:bg-slate-900/60 p-2 rounded-lg border border-slate-200 dark:border-slate-800/80 shadow-3xs">
                                          <span className="text-[10px] text-slate-900 dark:text-white font-bold block truncate" title={step.subject}>
                                            {step.subject || '(No Subject)'}
                                          </span>
                                          {idx > 0 && (
                                            <span className="text-[9px] text-slate-400 dark:text-slate-500 font-semibold block uppercase font-mono">
                                              Wait: {step.waitDays} days
                                            </span>
                                          )}
                                          
                                          {/* Step Metrics */}
                                          <div className="mt-1.5 pt-1.5 border-t border-slate-100 dark:border-slate-800 text-[9px] space-y-0.5 text-left">
                                            <div className="flex justify-between px-0.5">
                                              <span className="text-slate-400 dark:text-slate-500">To Send:</span>
                                              <span className="font-extrabold text-slate-700 dark:text-slate-400">{activeLeadsCount}</span>
                                            </div>
                                            <div className="flex justify-between px-0.5">
                                              <span className="text-slate-400 dark:text-slate-500">Sent:</span>
                                              <span className="font-extrabold text-slate-700 dark:text-slate-400">{sentCount}</span>
                                            </div>
                                            {sentCount > 0 && (
                                              <div className="flex justify-between px-0.5">
                                                <span className="text-slate-400 dark:text-slate-500">Progress:</span>
                                                <span className="font-extrabold text-blue-600 dark:text-blue-400">{progressPercent}%</span>
                                              </div>
                                            )}
                                          </div>
                                        </div>

                                        {/* Manual Dispatch Trigger */}
                                        {campaign.status === 'Active' && (
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              handleRunCampaign(campaign.id, step.stepOrder);
                                            }}
                                            disabled={executingId !== null}
                                            className="text-[9px] text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/15 hover:bg-blue-100 hover:text-blue-700 dark:hover:bg-blue-900/35 px-2 py-0.8 rounded border border-blue-200 dark:border-blue-800 flex items-center gap-1 font-extrabold transition-all cursor-pointer shadow-3xs disabled:opacity-50 mt-1"
                                            title={`Manually run dispatches for Step ${step.stepOrder}`}
                                          >
                                            <Send className="w-2.5 h-2.5" />
                                            Send Step
                                          </button>
                                        )}
                                      </div>
                                    </Fragment>
                                  );
                                })}

                                {/* Connection Line to Completed */}
                                <div className="flex-1 min-w-[40px] px-2">
                                  <div className="h-[3px] bg-slate-200 dark:bg-slate-800 rounded" />
                                </div>

                                {/* Final Completed Node */}
                                <div className="flex flex-col items-center text-center space-y-2">
                                  <div className="h-5 flex items-center">
                                    <span className="text-slate-400 dark:text-slate-600 text-[9px] font-semibold">
                                      End
                                    </span>
                                  </div>

                                  <div className="w-9 h-9 rounded-full flex items-center justify-center bg-emerald-500 text-white shadow-[0_0_8px_rgba(16,185,129,0.2)]">
                                    <Check className="w-4 h-4" />
                                  </div>

                                  <div className="space-y-0.5 min-w-[100px] max-w-[120px]">
                                    <span className="text-[10px] text-slate-900 dark:text-white font-bold block">
                                      Completed
                                    </span>
                                    <span className="text-[9px] text-emerald-600 dark:text-emerald-500 font-bold block uppercase font-mono">
                                      {campaign.enrollments?.filter(e => e.status === 'Completed').length || 0} leads
                                    </span>
                                  </div>
                                </div>

                              </div>
                            )}

                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {filteredCampaigns.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center py-16 text-slate-500 dark:text-slate-500 text-xs">
                       <Inbox className="w-6 h-6 mx-auto mb-2 opacity-50" />
                       No sequences match your dynamic role view context.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Campaign Create Modal */}
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
              className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1f2130] w-full max-w-md rounded-2xl p-6 shadow-2xl relative z-10 overflow-hidden"
            >
              <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/5 rounded-full blur-xl pointer-events-none" />

              <header className="flex justify-between items-center pb-4 border-b border-slate-100 dark:border-[#1c1d29] mb-4">
                <div className="flex items-center gap-2">
                  <Plus className="w-5 h-5 text-blue-500" />
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">Launch Outreach Sequence</h3>
                </div>
                <button
                  onClick={() => setIsAddOpen(false)}
                  className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800/50 rounded-lg text-slate-400 dark:text-slate-500 transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </header>

              <form onSubmit={handleCreateCampaign} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] text-slate-400 dark:text-slate-500 uppercase tracking-widest font-bold">Sequence Campaign Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g., Enterprise SaaS Seed Funding Round"
                    value={campaignName}
                    onChange={(e) => setCampaignName(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-3 py-2.5 outline-none text-xs font-semibold"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] text-slate-400 dark:text-slate-500 uppercase tracking-widest font-bold flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5" />
                    Connect Sender Mailbox Node
                  </label>
                  <select
                    value={selectedMailboxId}
                    onChange={(e) => setSelectedMailboxId(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white rounded-lg px-3 py-2.5 outline-none text-xs font-medium cursor-pointer"
                  >
                    {accounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.emailAddress} ({acc.provider})
                      </option>
                    ))}
                  </select>
                </div>

                {accounts.filter((acc) => acc.id !== selectedMailboxId).length > 0 && (
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-400 dark:text-slate-500 uppercase tracking-widest font-bold flex items-center gap-1.5">
                      <Mail className="w-3.5 h-3.5" />
                      Rotate Across Additional Mailboxes (optional)
                    </label>
                    <div className="max-h-32 overflow-y-auto space-y-0.5 border border-slate-200 dark:border-[#1f2130] rounded-lg p-2 bg-slate-50 dark:bg-[#12141d]">
                      {accounts.filter((acc) => acc.id !== selectedMailboxId).map((acc) => (
                        <label key={acc.id} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 px-1.5 py-1 cursor-pointer rounded hover:bg-slate-100 dark:hover:bg-slate-800/40">
                          <input
                            type="checkbox"
                            checked={selectedPoolIds.includes(acc.id)}
                            onChange={(e) =>
                              setSelectedPoolIds((prev) =>
                                e.target.checked ? [...prev, acc.id] : prev.filter((id) => id !== acc.id)
                              )
                            }
                          />
                          <span>{acc.emailAddress} ({acc.provider})</span>
                        </label>
                      ))}
                    </div>
                    <p className="text-[10px] text-slate-400 dark:text-slate-500">Sending volume is spread across the primary plus any selected mailboxes (least-loaded first).</p>
                  </div>
                )}

                <div className="p-3 bg-blue-50/80 dark:bg-blue-950/10 border border-blue-200 dark:border-blue-500/10 rounded-lg flex gap-3 text-[11px] leading-relaxed text-blue-700 dark:text-blue-300">
                  <Sparkles className="w-4 h-4 flex-shrink-0 text-blue-600 dark:text-blue-400" />
                  <p className="font-sans font-medium">
                    This sequence will follow sending frequencies and throttling limits associated with the connected mailbox.
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
                    {submitting ? 'Constructing...' : 'Establish Sequence'}
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

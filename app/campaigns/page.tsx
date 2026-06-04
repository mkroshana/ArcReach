/* eslint-disable react-hooks/set-state-in-effect, react/no-unescaped-entities, react-hooks/exhaustive-deps */
'use client';

import { useState, useEffect } from 'react';
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
  Sparkles,
  Inbox
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface DbCampaign {
  id: string;
  name: string;
  status: 'Active' | 'Draft' | 'Paused';
  senderAccountId: string;
  senderEmail?: string;
  userId: string | null;
  createdAt: string;
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<DbCampaign[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Add campaign form
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [campaignName, setCampaignName] = useState('');
  const [selectedMailboxId, setSelectedMailboxId] = useState('');
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
      const cmpRes = await fetch('/api/campaigns');
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

  useEffect(() => {
    loadData();
  }, []);

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
          status: 'Draft',
        }),
      });

      if (!res.ok) {
        throw new Error(await res.text() || 'Failed to establish campaign.');
      }

      showToast('Campaign sequence initiated successfully');
      setCampaignName('');
      setIsAddOpen(false);
      await loadData(); // Refresh list immediately
    } catch (err: any) {
      showToast(err.message || 'Error occurred', 'error');
    } finally {
      setSubmitting(false);
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
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-450' 
                : 'bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-450'
            }`}
          >
            <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
            <p className="text-xs font-semibold leading-normal">{toast.message}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="flex justify-between items-center pb-4 border-b border-slate-205 dark:border-slate-800">
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
              className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-[#20222e] text-slate-800 dark:text-white text-xs rounded-lg pl-9 pr-4 py-2 outline-none focus:ring-2 focus:ring-blue-500/15 placeholder:text-slate-400 dark:placeholder:text-slate-505 transition-all shadow-xs"
            />
          </div>
          <div className="flex gap-2 w-full sm:w-auto justify-end">
            <button 
              onClick={() => showToast('Campaign criteria filters loaded')}
              className="px-3 py-1.8 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-350 transition-colors flex items-center gap-1.5 shadow-2xs cursor-pointer"
            >
              <Filter className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
              Filter
            </button>
            <button 
              onClick={() => showToast('Campaign stats CSV report ready for download')}
              className="px-3 py-1.8 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-350 transition-colors flex items-center gap-1.5 shadow-2xs cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
              Export Directory CSV
            </button>
          </div>
        </div>

        {/* Structured Table */}
        {loading ? (
          <div className="py-20 text-center text-slate-450 dark:text-slate-500 text-xs space-y-3">
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
                  <tr 
                    key={campaign.id} 
                    className="hover:bg-slate-50/50 dark:hover:bg-white/[0.01] transition-colors group cursor-pointer"
                  >
                    <td className="px-5 py-3.5">
                      <div className="font-semibold text-slate-900 dark:text-white text-xs group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors flex items-center gap-2">
                        <Layers className="w-4 h-4 text-slate-400 dark:text-slate-505 group-hover:text-blue-500 dark:group-hover:text-blue-400 transition-colors" />
                        {campaign.name}
                      </div>
                      <div className="text-[10px] text-slate-400 dark:text-slate-505 font-mono mt-10">ID: {campaign.id} • Enrolled {new Date(campaign.createdAt).toLocaleDateString()}</div>
                    </td>
                    <td className="px-5 py-3.5 text-xs text-slate-600 dark:text-slate-400 font-mono">
                      <span className="flex items-center gap-1.5">
                        <Mail className="w-3.5 h-3.5 text-slate-400" />
                        {campaign.senderEmail || 'N/A'}
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
                        ${campaign.status === 'Active' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-450 border-emerald-200 dark:border-emerald-500/20' : ''}
                        ${campaign.status === 'Draft' ? 'bg-slate-100 dark:bg-slate-900 text-slate-605 dark:text-slate-400 border-slate-205 dark:border-slate-800' : ''}
                        ${campaign.status === 'Paused' ? 'bg-amber-50 dark:bg-amber-500/10 text-amber-705 dark:text-amber-400 border-amber-205 dark:border-amber-500/20' : ''}
                      `}>
                        {campaign.status === 'Active' && <PlayCircle className="w-3 h-3 text-emerald-505" />}
                        {campaign.status}
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
                {filteredCampaigns.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center py-16 text-slate-550 dark:text-slate-500 text-xs">
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

      {/* Frosted Campaign Create Modal */}
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
                  className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800/50 rounded-lg text-slate-400 dark:text-slate-505 transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </header>

              <form onSubmit={handleCreateCampaign} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] text-slate-450 dark:text-slate-500 uppercase tracking-widest font-bold">Sequence Campaign Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g., Enterprise SaaS Seed Funding Round"
                    value={campaignName}
                    onChange={(e) => setCampaignName(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-850 dark:text-white rounded-lg px-3 py-2.5 outline-none text-xs font-semibold"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] text-slate-450 dark:text-slate-500 uppercase tracking-widest font-bold flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5" />
                    Connect Sender Mailbox Node
                  </label>
                  <select
                    value={selectedMailboxId}
                    onChange={(e) => setSelectedMailboxId(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-805 dark:text-white rounded-lg px-3 py-2.5 outline-none text-xs font-medium cursor-pointer"
                  >
                    {accounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.emailAddress} ({acc.provider})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="p-3 bg-blue-50/80 dark:bg-blue-955/10 border border-blue-150 dark:border-blue-500/10 rounded-lg flex gap-3 text-[11px] leading-relaxed text-blue-750 dark:text-blue-300">
                  <Sparkles className="w-4 h-4 flex-shrink-0 text-blue-600 dark:text-blue-400" />
                  <p className="font-sans font-medium">
                    This sequence will follow sending frequencies and throttling limits associated with the connected mailbox.
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

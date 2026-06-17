/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import { 
  UploadCloud, 
  FileType, 
  CheckCircle2, 
  AlertCircle, 
  Search, 
  Download, 
  Sparkles, 
  Play, 
  Trash2, 
  Plus,
  X,
  RefreshCw,
  Eye,
  MousePointerClick,
  ChevronDown,
  ChevronUp,
  Mail,
  MessageSquare,
  Clock,
  Calendar,
  Folder,
  Copy,
  Archive,
  FolderPlus
} from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';

export default function LeadsPage() {
  const [leads, setLeads] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Search and Filter states
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('All');
  
  // Verification progress states
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState(0);

  // New Lead form state
  const [showAddLead, setShowAddLead] = useState(false);
  const [newLead, setNewLead] = useState({ name: '', email: '', company: '', jobTitle: '' });

  // Outbox email timeline states
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [leadDetails, setLeadDetails] = useState<any | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [expandedEmailId, setExpandedEmailId] = useState<string | null>(null);

  // Lead Groups and Archiving states
  const [activeTab, setActiveTab] = useState<'leads' | 'groups' | 'overlaps' | 'archived'>('leads');
  const [groups, setGroups] = useState<any[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroup, setNewGroup] = useState({ name: '', description: '' });
  
  const [selectedGroupForImport, setSelectedGroupForImport] = useState('');
  const [newGroupNameForImport, setNewGroupNameForImport] = useState('');
  const [selectedGroupForAdd, setSelectedGroupForAdd] = useState('');
  const [selectedGroupIdForView, setSelectedGroupIdForView] = useState<string | null>(null);
  const [selectedGroupsForCrossCheck, setSelectedGroupsForCrossCheck] = useState<string[]>([]);

  const fetchLeadDetails = async (id: string) => {
    try {
      setLoadingDetails(true);
      setExpandedEmailId(null);
      const res = await fetch(`/api/leads?id=${id}`);
      if (res.ok) {
        const data = await res.json();
        setLeadDetails(data);
      }
    } catch (err) {
      console.error('Failed to load lead details:', err);
    } finally {
      setLoadingDetails(false);
    }
  };

  const getTimeline = () => {
    if (!leadDetails) return [];
    
    const dispatches = (leadDetails.dispatches || []).map((d: any) => ({
      id: d.id,
      type: 'dispatch',
      date: new Date(d.sentAt),
      subject: d.subject || 'No Subject',
      body: d.body || '',
      campaign: d.campaign?.name || 'Manual Outreach',
      events: d.events || []
    }));

    const replies = (leadDetails.replies || []).map((r: any) => ({
      id: r.id,
      type: 'reply',
      date: new Date(r.receivedAt),
      subject: r.subject || 'Re: Outreach',
      body: r.body || '',
      campaign: r.campaign?.name || 'Manual Outreach',
      events: []
    }));

    return [...dispatches, ...replies].sort((a, b) => b.date.getTime() - a.date.getTime());
  };

  const showToast = (message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(''), 3500);
  };

  const fetchGroups = async () => {
    try {
      setLoadingGroups(true);
      const res = await fetch('/api/leads/groups');
      if (res.ok) {
        const data = await res.json();
        setGroups(data);
      }
    } catch (err) {
      console.error('Failed to load groups:', err);
    } finally {
      setLoadingGroups(false);
    }
  };

  const fetchLeads = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/leads');
      if (res.ok) {
        const data = await res.json();
        setLeads(data);
      }
    } catch (error) {
      console.error('Failed to load leads:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLeads();
    fetchGroups();
  }, []);

  const handleBulkVerify = async () => {
    if (isVerifying) return;
    
    const unverifiedLeads = leads.filter(l => l.validationStatus === 'Unverified' || l.validationStatus === 'Risky');
    if (unverifiedLeads.length === 0) {
      showToast('All leads are already verified.');
      return;
    }

    setIsVerifying(true);
    setVerifyProgress(10);
    
    // Animate progress smoothly while making the network request
    const progressInterval = setInterval(() => {
      setVerifyProgress(prev => {
        if (prev >= 90) {
          clearInterval(progressInterval);
          return 90;
        }
        return prev + 10;
      });
    }, 200);

    try {
      const res = await fetch('/api/leads/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: unverifiedLeads.map(l => l.id) })
      });

      clearInterval(progressInterval);
      setVerifyProgress(100);

      if (res.ok) {
        const data = await res.json();
        showToast(`Email Verification Complete: ${data.verifiedLeads.length} leads validated!`);
        await fetchLeads(); // Refresh leads
      } else {
        showToast('Verification failed. Server returned error.');
      }
    } catch (err) {
      showToast('Error during email MX records verification.');
      console.error(err);
    } finally {
      setIsVerifying(false);
    }
  };

  const handleDeleteLead = async (id: string) => {
    if (!confirm('Are you sure you want to delete this lead?')) return;
    try {
      const res = await fetch(`/api/leads?id=${id}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        setLeads(leads.filter(l => l.id !== id));
        showToast('Lead record deleted successfully.');
      } else {
        showToast('Failed to delete lead.');
      }
    } catch (error) {
      showToast('Error occurred deleting lead.');
      console.error(error);
    }
  };

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroup.name.trim()) return;
    try {
      const res = await fetch('/api/leads/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newGroup.name.trim(), description: newGroup.description })
      });
      if (res.ok) {
        const created = await res.json();
        setGroups([...groups, { ...created, _count: { leads: 0 } }]);
        setNewGroup({ name: '', description: '' });
        setShowCreateGroup(false);
        showToast('Lead group created successfully.');
      } else {
        const err = await res.json();
        showToast(err.error || 'Failed to create group.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error creating group.');
    }
  };

  const handleDeleteGroup = async (id: string) => {
    if (!confirm('Are you sure you want to delete this group? The prospects themselves will not be deleted.')) return;
    try {
      const res = await fetch(`/api/leads/groups?id=${id}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        setGroups(groups.filter(g => g.id !== id));
        const updatedLeads = leads.map(l => ({
          ...l,
          groups: (l.groups || []).filter((g: any) => g.groupId !== id)
        }));
        setLeads(updatedLeads);
        showToast('Lead group deleted.');
      } else {
        showToast('Failed to delete group.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error deleting group.');
    }
  };

  const handleRemoveFromGroup = async (leadId: string, groupId: string) => {
    try {
      const res = await fetch(`/api/leads/groups/memberships?groupId=${groupId}&leadId=${leadId}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        const updatedLeads = leads.map(l => {
          if (l.id === leadId) {
            return {
              ...l,
              groups: (l.groups || []).filter((g: any) => g.groupId !== groupId)
            };
          }
          return l;
        });
        setLeads(updatedLeads);
        await fetchGroups();
        showToast('Lead removed from group.');
      } else {
        showToast('Failed to remove lead from group.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error removing lead from group.');
    }
  };

  const handleAddCustomLead = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLead.email || !newLead.name) return;
    
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newLead.name,
          email: newLead.email,
          company: newLead.company || 'Self Employed',
          jobTitle: newLead.jobTitle || null,
          status: 'Neutral',
          validationStatus: 'Unverified',
          groupIds: selectedGroupForAdd ? [selectedGroupForAdd] : []
        })
      });

      if (res.ok) {
        const created = await res.json();
        setLeads([created, ...leads]);
        setNewLead({ name: '', email: '', company: '', jobTitle: '' });
        setSelectedGroupForAdd('');
        setShowAddLead(false);
        await fetchGroups(); // refresh groups for counts
        showToast('Prospect added to CRM.');
      } else {
        const errText = await res.text();
        showToast(errText || 'Failed to create lead.');
      }
    } catch (error) {
      showToast('Error saving lead.');
      console.error(error);
    }
  };

  const handleExportCSV = () => {
    const validLeads = leads.filter(l => l.validationStatus === 'Valid');
    if (validLeads.length === 0) {
      showToast('No verified Valid status leads to export.');
      return;
    }
    const csvContent = "data:text/csv;charset=utf-8," 
      + ["Name,Email,Company,Job Title,Verification"].join(",") + "\n"
      + validLeads.map(e => `"${e.name || ''}","${e.email}","${e.company || ''}","${e.jobTitle || ''}","${e.validationStatus}"`).join("\n");
      
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "arcreach_verified_leads.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const processCSVFile = async (file: File) => {
    showToast('Importing CSV contacts data...');
    const reader = new FileReader();
    reader.onload = async (event) => {
      const text = event.target?.result as string;
      try {
        const parsedLeads = [];
        const lines = text.split(/\r?\n/);
        if (lines.length < 2) {
          showToast('Invalid CSV format. Header row required.');
          return;
        }

        const headers = lines[0].split(',').map(h => h.replace(/^["']|["']$/g, '').trim().toLowerCase());
        const emailIdx = headers.indexOf('email');
        const nameIdx = headers.indexOf('name');
        const companyIdx = headers.indexOf('company');
        const jobTitleIdx = headers.findIndex(h => h === 'job title' || h === 'jobtitle' || h === 'title');

        if (emailIdx === -1) {
          showToast('CSV must contain at least an "email" column.');
          return;
        }

        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          
          // Simple CSV column parser
          const cols = line.split(',').map(c => c.replace(/^["']|["']$/g, '').trim());
          const email = cols[emailIdx];
          
          if (email && email.includes('@')) {
            parsedLeads.push({
              email,
              name: nameIdx !== -1 && cols[nameIdx] ? cols[nameIdx] : email.split('@')[0],
              company: companyIdx !== -1 && cols[companyIdx] ? cols[companyIdx] : 'Unknown',
              jobTitle: jobTitleIdx !== -1 && cols[jobTitleIdx] ? cols[jobTitleIdx] : null
            });
          }
        }

        if (parsedLeads.length === 0) {
          showToast('No valid contacts found in CSV.');
          return;
        }

        let targetGroupId = selectedGroupForImport;
        if (newGroupNameForImport.trim()) {
          try {
            const groupRes = await fetch('/api/leads/groups', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: newGroupNameForImport.trim() })
            });
            if (groupRes.ok) {
              const newG = await groupRes.json();
              targetGroupId = newG.id;
            }
          } catch (err) {
            console.error('Failed to create group during CSV import:', err);
          }
        }

        const groupIds = targetGroupId ? [targetGroupId] : [];

        let count = 0;
        for (const lead of parsedLeads) {
          try {
            const res = await fetch('/api/leads', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: lead.name,
                email: lead.email,
                company: lead.company,
                jobTitle: lead.jobTitle,
                status: 'Neutral',
                validationStatus: 'Unverified',
                groupIds
              })
            });
            if (res.ok) count++;
          } catch (e) {}
        }

        // Reset import states
        setSelectedGroupForImport('');
        setNewGroupNameForImport('');
        await fetchGroups(); // refresh group counts

        showToast(`Spreadsheet imported! Added ${count} new contacts to CRM.`);
        fetchLeads();
      } catch (err) {
        showToast('Error parsing CSV file.');
        console.error(err);
      }
    };
    reader.readAsText(file);
  };

  const handleDropUpload = async (e: any) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      await processCSVFile(files[0]);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      await processCSVFile(files[0]);
    }
  };

  const getOverlappingLeads = () => {
    return leads.filter(lead => {
      if (lead.isArchived) return false;
      const memberGroupIds = (lead.groups || []).map((g: any) => g.groupId);
      if (selectedGroupsForCrossCheck.length > 0) {
        const intersection = memberGroupIds.filter((id: string) => selectedGroupsForCrossCheck.includes(id));
        return intersection.length > 1;
      } else {
        return memberGroupIds.length > 1;
      }
    });
  };

  const filteredLeads = leads.filter(lead => {
    if (activeTab === 'archived') {
      if (!lead.isArchived) return false;
    } else {
      if (lead.isArchived) return false;
    }

    if (activeTab === 'groups' && selectedGroupIdForView) {
      const isMember = (lead.groups || []).some((g: any) => g.groupId === selectedGroupIdForView);
      if (!isMember) return false;
    }

    const nameStr = lead.name || '';
    const emailStr = lead.email || '';
    const companyStr = lead.company || '';
    const matchesSearch = nameStr.toLowerCase().includes(search.toLowerCase()) || 
                          emailStr.toLowerCase().includes(search.toLowerCase()) ||
                          companyStr.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = filterStatus === 'All' || lead.validationStatus === filterStatus;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-5xl mx-auto">
      {/* Header */}
      <header className="flex justify-between items-start md:items-center flex-col md:flex-row gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white mb-0.5">Leads Directory</h1>
          <p className="text-slate-500 dark:text-slate-400 text-xs">Upload bulk spreadsheets, verify real deliverability state, and filter invalid addresses.</p>
        </div>
        <div className="flex gap-2.5">
          <button 
            onClick={fetchLeads}
            className="p-2 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white bg-white dark:bg-slate-900 border border-slate-202 dark:border-slate-800 rounded-lg shadow-xs"
            title="Refresh Leads Catalog"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading && !isVerifying ? 'animate-spin' : ''}`} />
          </button>
          <button 
            onClick={() => setShowAddLead(!showAddLead)}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-white px-3.5 py-1.8 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-xs"
          >
            <Plus className="w-3.5 h-3.5 text-slate-400 dark:text-slate-505" />
            Add Single Lead
          </button>
          
          <button 
            onClick={handleBulkVerify}
            disabled={isVerifying || loading}
            className="bg-blue-600 hover:bg-blue-500 disabled:bg-blue-700 text-white px-4 py-2 rounded-lg font-semibold flex items-center gap-2 transition-colors text-xs shadow-sm"
          >
            <Play className={`w-3.5 h-3.5 ${isVerifying ? 'animate-spin' : ''}`} />
            {isVerifying ? `Verifying (${verifyProgress}%)` : 'Verify Deliverability'}
          </button>
        </div>
      </header>

      {/* Verification progress status */}
      {isVerifying && (
        <div className="bg-blue-50 dark:bg-blue-955/25 border border-blue-100 dark:border-blue-500/10 p-4 rounded-xl animate-pulse flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Sparkles className="w-4 h-4 text-blue-650 dark:text-blue-400 shrink-0" />
            <div>
              <p className="text-xs font-bold text-slate-855 dark:text-white uppercase tracking-wider">Checking Mailbox MX Status</p>
              <p className="text-xs text-slate-550 dark:text-slate-405 mt-0.5 font-medium">Resolving DNS setups, catching invalid syntax sequences...</p>
            </div>
          </div>
          <div className="w-full md:w-64 font-sans">
            <div className="flex justify-between text-[11px] mb-1 font-bold">
              <span className="text-blue-650 dark:text-blue-400">SMTP Progress</span>
              <span className="text-slate-500 dark:text-slate-405">{verifyProgress}%</span>
            </div>
            <div className="w-full bg-slate-150 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
              <div className="bg-blue-650 dark:bg-blue-500 h-full rounded-full transition-all duration-300" style={{ width: `${verifyProgress}%` }}></div>
            </div>
          </div>
        </div>
      )}

      {/* Add Lead dialog */}
      {showAddLead && (
        <form onSubmit={handleAddCustomLead} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 rounded-xl space-y-4 animate-in slide-in-from-top-3 duration-200 shadow-xs">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-550 dark:text-slate-400">Add Lead Record</h3>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <input 
              type="text" 
              placeholder="Name (e.g. John Doe) *"
              value={newLead.name}
              required
              onChange={e => setNewLead({...newLead, name: e.target.value})}
              className="bg-slate-50 dark:bg-slate-955 border border-slate-202 dark:border-slate-805 p-2.5 rounded-lg text-xs placeholder:text-slate-400 text-slate-855 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            <input 
              type="email" 
              placeholder="Outreach Email *"
              value={newLead.email}
              required
              onChange={e => setNewLead({...newLead, email: e.target.value})}
              className="bg-slate-50 dark:bg-slate-955 border border-slate-202 dark:border-slate-805 p-2.5 rounded-lg text-xs placeholder:text-slate-400 text-slate-855 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            <input 
              type="text" 
              placeholder="Brand Company Name"
              value={newLead.company}
              onChange={e => setNewLead({...newLead, company: e.target.value})}
              className="bg-slate-50 dark:bg-slate-955 border border-slate-202 dark:border-slate-805 p-2.5 rounded-lg text-xs placeholder:text-slate-400 text-slate-855 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            <input 
              type="text" 
              placeholder="Job Title (e.g. CEO)"
              value={newLead.jobTitle}
              onChange={e => setNewLead({...newLead, jobTitle: e.target.value})}
              className="bg-slate-50 dark:bg-slate-955 border border-slate-202 dark:border-slate-805 p-2.5 rounded-lg text-xs placeholder:text-slate-400 text-slate-855 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            <select
              value={selectedGroupForAdd}
              onChange={e => setSelectedGroupForAdd(e.target.value)}
              className="bg-slate-50 dark:bg-slate-955 border border-slate-202 dark:border-slate-805 p-2.5 rounded-lg text-xs text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/40 cursor-pointer"
            >
              <option value="">-- No Group Assignment --</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 justify-end">
            <button 
              type="button" 
              onClick={() => setShowAddLead(false)}
              className="px-3.5 py-1.5 text-xs text-slate-400 hover:text-slate-900 dark:hover:text-white font-medium"
            >
              Cancel
            </button>
            <button 
              type="submit" 
              className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.8 rounded-lg text-xs font-semibold"
            >
              Save Record
            </button>
          </div>
        </form>
      )}

      {/* CSV Import container */}
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileChange} 
        accept=".csv" 
        className="hidden" 
      />
      <div 
        className={`relative overflow-hidden rounded-xl border border-dashed transition-all duration-200 ${
          isDragging 
            ? 'border-blue-500 bg-blue-50 dark:bg-blue-955/20' 
            : 'border-slate-355 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50/50 dark:hover:bg-slate-850/45'
        } p-8 flex flex-col items-center justify-center cursor-pointer shadow-xs`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDropUpload}
        onClick={() => fileInputRef.current?.click()}
      >
        <div className="w-10 h-10 mb-3 rounded-lg bg-slate-50 dark:bg-slate-955 flex items-center justify-center border border-slate-202 dark:border-slate-805">
          <UploadCloud className="w-4.5 h-4.5 text-blue-650 dark:text-blue-400" />
        </div>
        <h3 className="text-sm font-semibold text-slate-805 dark:text-white uppercase tracking-widest mb-1">Import bulk list CSV</h3>
        <p className="text-slate-500 dark:text-slate-400 text-center max-w-md text-xs mb-3 font-medium">
          Drag and drop contacts list, or click to select and import custom CSV spreadsheets.
        </p>
        <button className="bg-white dark:bg-slate-950 hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-205 dark:border-slate-800 text-slate-700 dark:text-slate-300 px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors shadow-xs mb-2">
          Browse Files (.csv)
        </button>

        <div className="mt-4 flex flex-col sm:flex-row gap-3 w-full max-w-md bg-slate-50/50 dark:bg-[#12141c]/50 p-4 rounded-xl border border-slate-200/50 dark:border-slate-800/40" onClick={(e) => e.stopPropagation()}>
          <div className="flex-1 col-span-1">
            <label className="block text-[9px] font-bold text-slate-450 dark:text-slate-500 uppercase tracking-wider mb-1">Add Imported to Group</label>
            <select
              value={selectedGroupForImport}
              onChange={e => {
                setSelectedGroupForImport(e.target.value);
                setNewGroupNameForImport('');
              }}
              className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-805 rounded-lg p-2 text-xs text-slate-855 dark:text-white cursor-pointer"
            >
              <option value="">-- No Group (General CRM) --</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>
          <div className="flex-1 col-span-1">
            <label className="block text-[9px] font-bold text-slate-450 dark:text-slate-500 uppercase tracking-wider mb-1">Or Create New Group</label>
            <input
              type="text"
              placeholder="e.g. Cold Leads June"
              value={newGroupNameForImport}
              onChange={e => {
                setNewGroupNameForImport(e.target.value);
                setSelectedGroupForImport('');
              }}
              className="w-full bg-white dark:bg-slate-955 border border-slate-200 dark:border-slate-805 rounded-lg p-2 text-xs text-slate-855 dark:text-white placeholder:text-slate-400"
            />
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 gap-4 mt-2">
        {[
          { id: 'leads', name: 'Leads Directory', icon: FileType },
          { id: 'groups', name: 'Lead Groups', icon: Folder },
          { id: 'overlaps', name: 'Cross-Check & Overlaps', icon: Copy },
          { id: 'archived', name: 'Archived Leads', icon: Archive }
        ].map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id as any);
                setSelectedGroupIdForView(null);
              }}
              className={`pb-3 text-xs font-bold uppercase tracking-wider border-b-2 flex items-center gap-2 transition-all cursor-pointer ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
                  : 'border-transparent text-slate-450 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-350'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.name}
            </button>
          );
        })}
      </div>

      {/* Main CRM Board Area */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-xs mt-2 animate-in fade-in duration-300">
        
        {/* Render for LEADS or ARCHIVED Tab */}
        {(activeTab === 'leads' || activeTab === 'archived') && (
          <>
            {/* Table Filter Top Bar */}
            <div className="p-4 border-b border-slate-200 dark:border-slate-800/60 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-slate-50/50 dark:bg-slate-900/50">
              <div className="flex flex-col md:flex-row gap-2.5 w-full md:w-auto">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                  <input 
                    type="text" 
                    placeholder="Search leads folder..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="bg-white dark:bg-slate-955 border border-slate-200 dark:border-slate-805 rounded-lg pl-9 pr-4 py-1.8 text-xs text-slate-800 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none w-full md:w-52 focus:ring-2 focus:ring-blue-500/40 shadow-xs"
                  />
                </div>
                
                <div className="flex items-center gap-1 p-1 bg-white dark:bg-slate-955 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xs">
                  {['All', 'Valid', 'Risky', 'Invalid', 'Unverified'].map(statusOption => (
                    <button
                      key={statusOption}
                      onClick={() => setFilterStatus(statusOption)}
                      className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all uppercase tracking-wider cursor-pointer ${
                        filterStatus === statusOption 
                          ? 'bg-blue-650 dark:bg-blue-600 text-white shadow-xs' 
                          : 'text-slate-550 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      {statusOption}
                    </button>
                  ))}
                </div>
              </div>
              
              <button 
                onClick={handleExportCSV}
                className="flex items-center gap-1.5 bg-white hover:bg-slate-50 dark:bg-slate-955 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 text-xs px-3.5 py-2 rounded-lg font-bold text-blue-650 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors shadow-xs cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Download Cleansed CSV
              </button>
            </div>

            {/* Lead Rows list */}
            {loading && !isVerifying ? (
              <div className="py-20 text-center text-slate-400 dark:text-slate-500 text-xs space-y-3">
                <div className="w-6 h-6 border-2 border-slate-300 dark:border-slate-700 border-t-blue-500 animate-spin rounded-full mx-auto" />
                <p className="font-medium tracking-wide">Syncing CRM records...</p>
              </div>
            ) : (
              <div className="w-full overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-202 dark:border-slate-800/80 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest bg-slate-50/20 dark:bg-slate-955/10">
                      <th className="px-5 py-3">Lead Target Name</th>
                      <th className="px-5 py-3">Outreach Address</th>
                      <th className="px-5 py-3">Assigned Brand</th>
                      <th className="px-5 py-3">Deliverability Validation</th>
                      {activeTab === 'leads' && <th className="px-5 py-3">Groups</th>}
                      <th className="px-5 py-3 text-right">Clear</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-105 dark:divide-slate-800/50 text-slate-700 dark:text-slate-350">
                    {filteredLeads.map((lead) => (
                      <tr 
                        key={lead.id} 
                        onClick={() => {
                          setSelectedLeadId(lead.id);
                          fetchLeadDetails(lead.id);
                        }}
                        className="hover:bg-slate-50/50 dark:hover:bg-slate-850/20 transition-all group cursor-pointer"
                      >
                        <td className="px-5 py-3.5">
                          <div className="font-semibold text-xs text-slate-909 dark:text-white">{lead.name || 'N/A'}</div>
                          {lead.jobTitle && <div className="text-[10px] text-slate-405 dark:text-slate-500 mt-0.5 font-medium">{lead.jobTitle}</div>}
                        </td>
                        <td className="px-5 py-3.5 text-xs text-slate-500 dark:text-slate-405 font-mono flex items-center gap-2">
                          <FileType className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                          {lead.email}
                        </td>
                        <td className="px-5 py-3.5 text-xs text-slate-650 dark:text-slate-405 font-medium">{lead.company || 'N/A'}</td>
                        <td className="px-5 py-3.5">
                          <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider
                            ${lead.validationStatus === 'Valid' ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/30' : ''}
                            ${lead.validationStatus === 'Invalid' ? 'bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-900/30' : ''}
                            ${lead.validationStatus === 'Risky' ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-900/30' : ''}
                            ${lead.validationStatus === 'Unverified' ? 'bg-slate-100 dark:bg-slate-850 text-slate-600 dark:text-slate-400 border-slate-201 dark:border-slate-800' : ''}
                          `}>
                            {lead.validationStatus === 'Valid' && <CheckCircle2 className="w-3.5 h-3.5" />}
                            {lead.validationStatus === 'Invalid' && <AlertCircle className="w-3.5 h-3.5" />}
                            {lead.validationStatus === 'Risky' && <AlertCircle className="w-3.5 h-3.5" />}
                            {lead.validationStatus === 'Unverified' && <span className="w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-slate-500 animate-pulse"></span>}
                            {lead.validationStatus}
                          </span>
                        </td>
                        {activeTab === 'leads' && (
                          <td className="px-5 py-3.5">
                            <div className="flex flex-wrap gap-1 max-w-[150px]">
                              {(lead.groups || []).map((g: any) => (
                                <span key={g.groupId} className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-slate-100 dark:bg-slate-850 text-slate-600 dark:text-slate-400 border border-slate-201 dark:border-slate-800 uppercase tracking-wider">
                                  {g.group?.name}
                                </span>
                              ))}
                              {(!lead.groups || lead.groups.length === 0) && (
                                <span className="text-[10px] text-slate-400 dark:text-slate-500 italic">No Group</span>
                              )}
                            </div>
                          </td>
                        )}
                        <td className="px-5 py-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <button 
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  const res = await fetch('/api/leads', {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ id: lead.id, isArchived: !lead.isArchived })
                                  });
                                  if (res.ok) {
                                    const updatedLead = await res.json();
                                    setLeads(leads.map(l => l.id === lead.id ? updatedLead : l));
                                    showToast(updatedLead.isArchived ? 'Prospect archived.' : 'Prospect unarchived.');
                                  }
                                } catch (err) {
                                  console.error(err);
                                }
                              }}
                              className={`p-1.5 rounded transition-colors ${
                                lead.isArchived 
                                  ? 'hover:bg-blue-500/10 text-blue-500' 
                                  : 'hover:bg-amber-500/10 text-slate-400 hover:text-amber-500'
                              }`}
                              title={lead.isArchived ? "Restore Prospect" : "Archive Prospect"}
                            >
                              <Archive className="w-3.5 h-3.5" />
                            </button>
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteLead(lead.id);
                              }}
                              className="p-1.5 hover:bg-rose-500/10 text-slate-400 hover:text-rose-600 rounded transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filteredLeads.length === 0 && (
                      <tr>
                        <td colSpan={activeTab === 'leads' ? 6 : 5} className="text-center py-10 text-slate-400 dark:text-slate-500 text-xs">
                          No lead records match your search filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* Render for LEAD GROUPS Tab */}
        {activeTab === 'groups' && (
          <div className="animate-in fade-in duration-300">
            {selectedGroupIdForView ? (
              /* Group Drill-down details */
              <div className="p-5 space-y-4">
                <div className="flex justify-between items-center bg-slate-50/50 dark:bg-[#12141e]/50 border border-slate-200 dark:border-slate-800 p-4 rounded-xl">
                  <div>
                    <h4 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center gap-2">
                      <Folder className="w-4.5 h-4.5 text-blue-650 dark:text-blue-400" />
                      {groups.find(g => g.id === selectedGroupIdForView)?.name}
                    </h4>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 font-medium">
                      {groups.find(g => g.id === selectedGroupIdForView)?.description || 'No description provided.'}
                    </p>
                  </div>
                  <button
                    onClick={() => setSelectedGroupIdForView(null)}
                    className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-white hover:bg-slate-50 dark:bg-slate-950 dark:hover:bg-slate-850 border border-slate-205 dark:border-slate-800 text-slate-700 dark:text-slate-300 transition-all cursor-pointer shadow-xs"
                  >
                    Back to Groups list
                  </button>
                </div>

                <div className="border border-slate-200 dark:border-slate-850 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-202 dark:border-slate-800/80 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest bg-slate-50/20 dark:bg-slate-955/10">
                        <th className="px-5 py-3">Lead Target Name</th>
                        <th className="px-5 py-3">Outreach Address</th>
                        <th className="px-5 py-3">Assigned Brand</th>
                        <th className="px-5 py-3 text-right">Clear / Remove</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-105 dark:divide-slate-800/50 text-slate-700 dark:text-slate-305">
                      {filteredLeads.map(lead => (
                        <tr 
                          key={lead.id} 
                          onClick={() => {
                            setSelectedLeadId(lead.id);
                            fetchLeadDetails(lead.id);
                          }}
                          className="hover:bg-slate-50/50 dark:hover:bg-slate-850/20 transition-all group cursor-pointer"
                        >
                          <td className="px-5 py-3.5">
                            <div className="font-semibold text-xs text-slate-909 dark:text-white">{lead.name || 'N/A'}</div>
                            {lead.jobTitle && <div className="text-[10px] text-slate-405 dark:text-slate-500 mt-0.5 font-medium">{lead.jobTitle}</div>}
                          </td>
                          <td className="px-5 py-3.5 text-xs text-slate-500 dark:text-slate-405 font-mono flex items-center gap-2">
                            <FileType className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                            {lead.email}
                          </td>
                          <td className="px-5 py-3.5 text-xs text-slate-650 dark:text-slate-405 font-medium">{lead.company || 'N/A'}</td>
                          <td className="px-5 py-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => handleRemoveFromGroup(lead.id, selectedGroupIdForView)}
                                className="px-2 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-400 rounded text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer"
                              >
                                Remove from group
                              </button>
                              <button 
                                onClick={() => handleDeleteLead(lead.id)}
                                className="p-1.5 hover:bg-rose-500/10 text-slate-400 hover:text-rose-600 rounded transition-colors"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {filteredLeads.length === 0 && (
                        <tr>
                          <td colSpan={4} className="text-center py-10 text-slate-400 dark:text-slate-500 text-xs">
                            No active prospects associated with this group.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              /* Groups grid overview */
              <div className="p-5 space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-550 dark:text-slate-405">Manage Segments</h3>
                  <button
                    onClick={() => setShowCreateGroup(!showCreateGroup)}
                    className="bg-white hover:bg-slate-50 dark:bg-slate-950 dark:hover:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-white px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-xs cursor-pointer"
                  >
                    <FolderPlus className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                    Create Lead Group
                  </button>
                </div>

                {showCreateGroup && (
                  <form onSubmit={handleCreateGroup} className="bg-slate-50 dark:bg-[#12141e] border border-slate-200 dark:border-[#1e202d] p-4 rounded-xl space-y-4 animate-in slide-in-from-top-2 duration-200">
                    <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-450 dark:text-slate-500">New Group Details</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[9px] font-bold text-slate-450 dark:text-slate-500 uppercase tracking-wider mb-1">Group Name *</label>
                        <input
                          type="text"
                          required
                          placeholder="e.g. Q3 Outbound Outreach"
                          value={newGroup.name}
                          onChange={e => setNewGroup({ ...newGroup, name: e.target.value })}
                          className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-805 rounded-lg p-2 text-xs text-slate-855 dark:text-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-blue-500/40"
                        />
                      </div>
                      <div>
                        <label className="block text-[9px] font-bold text-slate-450 dark:text-slate-500 uppercase tracking-wider mb-1">Description</label>
                        <input
                          type="text"
                          placeholder="e.g. Leads extracted from June marketing campaign"
                          value={newGroup.description}
                          onChange={e => setNewGroup({ ...newGroup, description: e.target.value })}
                          className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-805 rounded-lg p-2 text-xs text-slate-855 dark:text-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-blue-500/40"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => setShowCreateGroup(false)}
                        className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-900 dark:hover:text-white font-medium cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="bg-blue-650 hover:bg-blue-600 text-white px-4 py-1.5 rounded-lg text-xs font-semibold shadow-sm cursor-pointer"
                      >
                        Save Group
                      </button>
                    </div>
                  </form>
                )}

                {loadingGroups ? (
                  <div className="py-12 text-center text-slate-400 dark:text-slate-500 text-xs">
                    <div className="w-6 h-6 border-2 border-slate-300 dark:border-slate-700 border-t-blue-500 animate-spin rounded-full mx-auto mb-2" />
                    Syncing segments...
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {groups.map(group => (
                      <div key={group.id} className="bg-slate-50 dark:bg-[#12141e] border border-slate-200 dark:border-[#1e202d] rounded-xl p-4 flex flex-col justify-between hover:border-blue-500/50 transition-all shadow-xs">
                        <div>
                          <div className="flex justify-between items-start">
                            <h4 className="text-xs font-bold text-slate-855 dark:text-white uppercase tracking-wider">{group.name}</h4>
                            <span className="bg-blue-50 dark:bg-blue-955/20 border border-blue-200 dark:border-blue-500/10 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider">
                              {group._count?.leads || 0} leads
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-2 line-clamp-2 min-h-8">
                            {group.description || 'No description provided.'}
                          </p>
                        </div>
                        <div className="flex gap-2 justify-end mt-4 pt-3 border-t border-slate-200/60 dark:border-slate-800/40">
                          <button
                            onClick={() => setSelectedGroupIdForView(group.id)}
                            className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 transition-all cursor-pointer shadow-xs"
                          >
                            View Members
                          </button>
                          <button
                            onClick={() => handleDeleteGroup(group.id)}
                            className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-450 transition-all cursor-pointer"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                    {groups.length === 0 && (
                      <div className="col-span-full py-12 text-center text-slate-405 dark:text-slate-500 text-xs">
                        No segments created yet. Create a group to organize prospects.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Render for CROSS-CHECK / OVERLAPS Tab */}
        {activeTab === 'overlaps' && (
          <div className="p-5 space-y-5 animate-in fade-in duration-300">
            <div className="bg-slate-50/50 dark:bg-[#12141e]/50 border border-slate-200 dark:border-slate-800 p-4 rounded-xl space-y-3">
              <div>
                <h4 className="text-xs font-bold text-slate-855 dark:text-white uppercase tracking-wider">Cross-Check & Deduplication Filters</h4>
                <p className="text-[11px] text-slate-550 dark:text-slate-400 mt-0.5">Select specific groups to check for overlapping leads. If no groups are selected, it compiles duplicates across all segments.</p>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                {groups.map(group => {
                  const isSelected = selectedGroupsForCrossCheck.includes(group.id);
                  return (
                    <button
                      key={group.id}
                      onClick={() => {
                        if (isSelected) {
                          setSelectedGroupsForCrossCheck(selectedGroupsForCrossCheck.filter(id => id !== group.id));
                        } else {
                          setSelectedGroupsForCrossCheck([...selectedGroupsForCrossCheck, group.id]);
                        }
                      }}
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border uppercase tracking-wider transition-all cursor-pointer ${
                        isSelected
                          ? 'bg-blue-600 border-transparent text-white shadow-xs'
                          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-505 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                      }`}
                    >
                      {group.name}
                    </button>
                  );
                })}
                {groups.length === 0 && (
                  <span className="text-xs text-slate-450 dark:text-slate-500 italic">No segments created yet.</span>
                )}
              </div>
            </div>

            <div className="border border-slate-200 dark:border-slate-805 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-202 dark:border-slate-800/80 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest bg-slate-50/20 dark:bg-slate-955/10">
                    <th className="px-5 py-3">Lead Target Name</th>
                    <th className="px-5 py-3">Outreach Address</th>
                    <th className="px-5 py-3">Overlapping Groups</th>
                    <th className="px-5 py-3 text-right">Clear / Resolve</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-105 dark:divide-slate-800/50 text-slate-700 dark:text-slate-350">
                  {getOverlappingLeads().map(lead => (
                    <tr 
                      key={lead.id}
                      onClick={() => {
                        setSelectedLeadId(lead.id);
                        fetchLeadDetails(lead.id);
                      }}
                      className="hover:bg-slate-50/50 dark:hover:bg-slate-850/20 transition-all group cursor-pointer"
                    >
                      <td className="px-5 py-3.5">
                        <div className="font-semibold text-xs text-slate-909 dark:text-white">{lead.name || 'N/A'}</div>
                        {lead.jobTitle && <div className="text-[10px] text-slate-405 dark:text-slate-500 mt-0.5 font-medium">{lead.jobTitle}</div>}
                      </td>
                      <td className="px-5 py-3.5 text-xs text-slate-500 dark:text-slate-405 font-mono flex items-center gap-2">
                        <FileType className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                        {lead.email}
                      </td>
                      <td className="px-5 py-3.5" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-wrap gap-1.5 max-w-xs">
                          {(lead.groups || []).map((g: any) => (
                            <span 
                              key={g.groupId}
                              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[8px] font-bold bg-blue-50 dark:bg-blue-955/20 border border-blue-200 dark:border-blue-500/10 text-blue-750 dark:text-blue-400 uppercase tracking-wider"
                            >
                              {g.group?.name}
                              <button
                                onClick={() => handleRemoveFromGroup(lead.id, g.groupId)}
                                className="text-[10px] font-bold hover:text-rose-600 dark:hover:text-rose-450 transition-colors border-0 bg-transparent cursor-pointer pl-0.5"
                                title={`Remove from ${g.group?.name}`}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={async () => {
                              try {
                                const res = await fetch('/api/leads', {
                                  method: 'PUT',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ id: lead.id, isArchived: true })
                                });
                                if (res.ok) {
                                  const updatedLead = await res.json();
                                  setLeads(leads.map(l => l.id === lead.id ? updatedLead : l));
                                  showToast('Prospect archived to resolve overlaps.');
                                }
                              } catch (err) {
                                  console.error(err);
                              }
                            }}
                            className="px-2 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-450 rounded text-[9px] font-bold uppercase tracking-wider transition-colors cursor-pointer"
                          >
                            Archive Lead
                          </button>
                          <button 
                            onClick={() => handleDeleteLead(lead.id)}
                            className="p-1.5 hover:bg-rose-500/10 text-slate-400 hover:text-rose-600 rounded transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {getOverlappingLeads().length === 0 && (
                    <tr>
                      <td colSpan={4} className="text-center py-10 text-slate-405 dark:text-slate-505 text-xs">
                        No overlapping prospects found with the current cross-check filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
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

      {/* Slide-over Activity Timeline Drawer */}
      <AnimatePresence>
        {selectedLeadId && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.4 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedLeadId(null)}
              className="fixed inset-0 bg-slate-900/60 z-40 backdrop-blur-xs"
            />

            {/* Panel */}
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 bottom-0 w-full max-w-lg bg-white dark:bg-[#0e1017] border-l border-slate-200 dark:border-[#1b1c26] shadow-2xl z-50 flex flex-col font-sans"
            >
              {/* Header */}
              <div className="p-5 border-b border-slate-200 dark:border-slate-800/60 bg-slate-50/50 dark:bg-[#11131c] flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider">Prospect Activity Timeline</h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Comprehensive audit trail of sent campaigns and response history.</p>
                </div>
                <button
                  onClick={() => setSelectedLeadId(null)}
                  className="p-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg transition-colors"
                >
                  <X className="w-4.5 h-4.5" />
                </button>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto p-5 space-y-6">
                {loadingDetails ? (
                  <div className="py-20 text-center text-slate-400 dark:text-slate-500 text-xs space-y-3">
                    <div className="w-6 h-6 border-2 border-slate-300 dark:border-slate-700 border-t-blue-500 animate-spin rounded-full mx-auto" />
                    <p className="font-medium tracking-wide">Syncing prospect timeline logs...</p>
                  </div>
                ) : leadDetails ? (
                  <>
                    {/* Lead Profile Info Card */}
                    <div className="bg-slate-50 dark:bg-[#12141e] border border-slate-200 dark:border-[#1e202d] rounded-xl p-4 space-y-3.5 animate-in fade-in duration-300">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h4 className="text-sm font-bold text-slate-855 dark:text-white">{leadDetails.name || 'Anonymous Prospect'}</h4>
                          {leadDetails.jobTitle && (
                            <p className="text-[11px] text-slate-550 dark:text-slate-400 font-medium mt-0.5">{leadDetails.jobTitle}</p>
                          )}
                        </div>
                        <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider
                          ${leadDetails.validationStatus === 'Valid' ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/30' : ''}
                          ${leadDetails.validationStatus === 'Invalid' ? 'bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-900/30' : ''}
                          ${leadDetails.validationStatus === 'Risky' ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-900/30' : ''}
                          ${leadDetails.validationStatus === 'Unverified' ? 'bg-slate-100 dark:bg-slate-850 text-slate-600 dark:text-slate-400 border-slate-201 dark:border-slate-800' : ''}
                        `}>
                          {leadDetails.validationStatus}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-4 pt-2 border-t border-slate-200/60 dark:border-slate-800/40 text-[11px]">
                        <div>
                          <span className="text-slate-400 dark:text-slate-500 font-medium uppercase tracking-wider text-[9px]">Email Address</span>
                          <p className="font-mono text-slate-700 dark:text-slate-350 mt-0.5 break-all">{leadDetails.email}</p>
                        </div>
                        <div>
                          <span className="text-slate-400 dark:text-slate-500 font-medium uppercase tracking-wider text-[9px]">Company Brand</span>
                          <p className="text-slate-700 dark:text-slate-350 mt-0.5 font-semibold">{leadDetails.company || 'N/A'}</p>
                        </div>
                      </div>

                      {/* Groups Management */}
                      <div className="pt-2 border-t border-slate-200/60 dark:border-slate-800/40">
                        <span className="text-slate-400 dark:text-slate-500 font-medium uppercase tracking-wider text-[9px]">Group Memberships</span>
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          {groups.map(group => {
                            const isMember = (leadDetails.groups || []).some((g: any) => g.groupId === group.id);
                            return (
                              <button
                                key={group.id}
                                onClick={async () => {
                                  let nextGroupIds = (leadDetails.groups || []).map((g: any) => g.groupId);
                                  if (isMember) {
                                    nextGroupIds = nextGroupIds.filter((id: string) => id !== group.id);
                                  } else {
                                    nextGroupIds = [...nextGroupIds, group.id];
                                  }
                                  try {
                                    const res = await fetch('/api/leads', {
                                      method: 'PUT',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ id: leadDetails.id, groupIds: nextGroupIds })
                                    });
                                    if (res.ok) {
                                      const updatedLead = await res.json();
                                      setLeadDetails(updatedLead);
                                      setLeads(leads.map(l => l.id === leadDetails.id ? updatedLead : l));
                                      await fetchGroups();
                                      showToast('Group memberships updated.');
                                    }
                                  } catch (err) {
                                    console.error(err);
                                  }
                                }}
                                className={`px-2 py-0.5 rounded text-[9px] font-bold transition-all border uppercase tracking-wider flex items-center gap-1 cursor-pointer ${
                                  isMember
                                    ? 'bg-blue-50 dark:bg-blue-955/20 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-500/10 shadow-xs'
                                    : 'bg-transparent text-slate-400 dark:text-slate-500 border-slate-202 dark:border-slate-800 hover:text-slate-600 dark:hover:text-slate-300'
                                }`}
                              >
                                {group.name}
                              </button>
                            );
                          })}
                          {groups.length === 0 && (
                            <span className="text-[10px] text-slate-400 dark:text-slate-500 italic">No lead groups created yet.</span>
                          )}
                        </div>
                      </div>

                      {/* Archive Status */}
                      <div className="pt-2 border-t border-slate-200/60 dark:border-slate-800/40 flex justify-between items-center">
                        <span className="text-slate-400 dark:text-slate-500 font-medium uppercase tracking-wider text-[9px]">Archiving Status</span>
                        <button
                          onClick={async () => {
                            try {
                              const res = await fetch('/api/leads', {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ id: leadDetails.id, isArchived: !leadDetails.isArchived })
                              });
                              if (res.ok) {
                                const updatedLead = await res.json();
                                setLeadDetails(updatedLead);
                                setLeads(leads.map(l => l.id === leadDetails.id ? updatedLead : l));
                                showToast(updatedLead.isArchived ? 'Prospect archived.' : 'Prospect unarchived.');
                                if (updatedLead.isArchived) {
                                  setSelectedLeadId(null);
                                }
                              }
                            } catch (err) {
                              console.error(err);
                            }
                          }}
                          className={`px-2.5 py-1 text-[10px] font-bold rounded-lg border uppercase tracking-wider transition-all cursor-pointer ${
                            leadDetails.isArchived
                              ? 'bg-emerald-600 hover:bg-emerald-500 text-white border-transparent'
                              : 'bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-350'
                          }`}
                        >
                          {leadDetails.isArchived ? 'Restore Prospect' : 'Archive Prospect'}
                        </button>
                      </div>
                    </div>

                    {/* Timeline Events List */}
                    <div className="space-y-4">
                      <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500">Activity Audit Log</h4>
                      
                      {getTimeline().length === 0 ? (
                        <p className="text-slate-400 dark:text-slate-500 text-xs py-6 text-center">No outbound campaigns or inbound responses recorded for this lead yet.</p>
                      ) : (
                        <div className="relative border-l-2 border-slate-100 dark:border-slate-850 ml-3 pl-5 space-y-5">
                          {getTimeline().map((event: any) => {
                            const isExpanded = expandedEmailId === event.id;
                            const isDispatch = event.type === 'dispatch';
                            
                            // Check events
                            const opens = event.events.filter((ev: any) => ev.eventType === 'open').length;
                            const clicks = event.events.filter((ev: any) => ev.eventType === 'click').length;

                            return (
                              <div key={event.id} className="relative">
                                {/* Dot Indicator */}
                                <span className={`absolute -left-[27px] top-1.5 w-3.5 h-3.5 rounded-full border-2 bg-white dark:bg-[#0e1017] flex items-center justify-center
                                  ${isDispatch 
                                    ? 'border-blue-600 dark:border-blue-500' 
                                    : 'border-emerald-600 dark:border-emerald-500'
                                  }`}
                                >
                                  {isDispatch ? (
                                    <Mail className="w-1.5 h-1.5 text-blue-650 dark:text-blue-500" />
                                  ) : (
                                    <MessageSquare className="w-1.5 h-1.5 text-emerald-650 dark:text-emerald-505" />
                                  )}
                                </span>

                                {/* Event Card */}
                                <div className="bg-slate-50/50 dark:bg-[#12141c]/45 border border-slate-150 dark:border-[#1a1c27] rounded-xl p-3.5 space-y-2 hover:border-slate-300 dark:hover:border-[#2b2e40] transition-colors">
                                  {/* Header */}
                                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-[10px] text-slate-405 dark:text-slate-500">
                                    <span className="font-bold uppercase tracking-wider">
                                      {isDispatch 
                                        ? `Sent via ${event.campaign}`
                                        : 'Lead Inbound Reply'
                                      }
                                    </span>
                                    <span className="flex items-center gap-1">
                                      <Clock className="w-3 h-3" />
                                      {event.date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                                    </span>
                                  </div>

                                  {/* Subject */}
                                  <h5 className="text-xs font-bold text-slate-800 dark:text-white leading-snug">{event.subject}</h5>

                                  {/* Telemetry Tracking Badges */}
                                  {isDispatch && (opens > 0 || clicks > 0) && (
                                    <div className="flex gap-2 pt-0.5">
                                      {opens > 0 && (
                                        <span className="inline-flex items-center gap-1 bg-blue-50/70 dark:bg-blue-955/20 border border-blue-200/50 dark:border-blue-500/10 text-[9px] font-bold text-blue-650 dark:text-blue-400 px-2 py-0.5 rounded">
                                          <Eye className="w-3 h-3" />
                                          Opened ({opens})
                                        </span>
                                      )}
                                      {clicks > 0 && (
                                        <span className="inline-flex items-center gap-1 bg-indigo-50/70 dark:bg-indigo-955/20 border border-indigo-200/50 dark:border-indigo-500/10 text-[9px] font-bold text-indigo-650 dark:text-indigo-400 px-2 py-0.5 rounded">
                                          <MousePointerClick className="w-3 h-3" />
                                          Clicked ({clicks})
                                        </span>
                                      )}
                                    </div>
                                  )}

                                  {/* Body Toggle Button */}
                                  <button
                                    onClick={() => setExpandedEmailId(isExpanded ? null : event.id)}
                                    className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-blue-600 hover:text-blue-550 dark:text-blue-400 dark:hover:text-blue-350 cursor-pointer pt-1 border-0 bg-transparent"
                                  >
                                    {isExpanded ? (
                                      <>
                                        Hide email copy
                                        <ChevronUp className="w-3.5 h-3.5" />
                                      </>
                                    ) : (
                                      <>
                                        View email copy
                                        <ChevronDown className="w-3.5 h-3.5" />
                                      </>
                                    )}
                                  </button>

                                  {/* Body copy container */}
                                  {isExpanded && (
                                    <div 
                                      className="text-xs mt-2.5 p-3 rounded-lg bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-slate-850 text-slate-655 dark:text-slate-350 font-mono whitespace-pre-wrap max-h-56 overflow-y-auto break-words leading-relaxed"
                                      dangerouslySetInnerHTML={{ __html: event.body }}
                                    />
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-center text-slate-400 py-10 text-xs">Error loading lead data.</p>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

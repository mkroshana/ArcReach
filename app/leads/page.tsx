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
  X
} from 'lucide-react';
import { useState } from 'react';

const initialLeads = [
  { id: 1, email: 'john.doe@acpecorp.com', name: 'John Doe', status: 'Valid', company: 'Acme Corp' },
  { id: 2, email: 'sarah.j@globex.io', name: 'Sarah Jenkins', status: 'Valid', company: 'Globex' },
  { id: 3, email: 'mike.smith@invalid-domain', name: 'Mike Smith', status: 'Invalid', company: 'Unknown' },
  { id: 4, email: 'emily.r@starkind.com', name: 'Emily Rogers', status: 'Valid', company: 'Stark Industries' },
  { id: 5, email: 'contact@wayne-ent.com', name: 'Bruce Wayne', status: 'Risky', company: 'Wayne Ent.' },
  { id: 6, email: 'clark.k@dailyplanet.com', name: 'Clark Kent', status: 'Unverified', company: 'Daily Planet' },
  { id: 7, email: 'diana.p@themyscira.org', name: 'Diana Prince', status: 'Unverified', company: 'Justice Inc' },
];

export default function LeadsPage() {
  const [leads, setLeads] = useState(initialLeads);
  const [isDragging, setIsDragging] = useState(false);
  const [toastMessage, setToastMessage] = useState('');

  const showToast = (message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(''), 3500);
  };
  
  // Search and Filter states
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('All');
  
  // Verification progress states
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState(0);

  // New Lead form state
  const [showAddLead, setShowAddLead] = useState(false);
  const [newLead, setNewLead] = useState({ name: '', email: '', company: '' });

  const handleBulkVerify = () => {
    if (isVerifying) return;
    setIsVerifying(true);
    setVerifyProgress(10);
    
    // Smooth verification simulation ticks
    const interval = setInterval(() => {
      setVerifyProgress(prev => {
        if (prev >= 100) {
          clearInterval(interval);
          setIsVerifying(false);
          // Turn all 'Unverified' or 'Risky' into either Valid or verified categories
          setLeads(current => current.map(lead => {
            if (lead.status === 'Unverified') {
              // 80% Valid, 20% Invalid for realistic output
              const randomStatus = Math.random() > 0.2 ? 'Valid' : 'Invalid';
              return { ...lead, status: randomStatus };
            }
            if (lead.status === 'Risky') {
              return { ...lead, status: 'Valid' }; // resolved
            }
            return lead;
          }));
          showToast('Email Verification Complete: All lead deliverability status checked!');
          return 100;
        }
        return prev + 15;
      });
    }, 400);
  };

  const handleDeleteLead = (id: number) => {
    setLeads(leads.filter(l => l.id !== id));
  };

  const handleAddCustomLead = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLead.email || !newLead.name) return;
    
    const created = {
      id: Date.now(),
      name: newLead.name,
      email: newLead.email,
      company: newLead.company || 'Self Employed',
      status: 'Unverified'
    };
    
    setLeads([created, ...leads]);
    setNewLead({ name: '', email: '', company: '' });
    setShowAddLead(false);
  };

  const handleExportCSV = () => {
    const validLeads = leads.filter(l => l.status === 'Valid');
    if (validLeads.length === 0) {
      showToast('No verified Valid status leads to export.');
      return;
    }
    // Simulate Download
    const csvContent = "data:text/csv;charset=utf-8," 
      + ["Name,Email,Company,Verification"].join(",") + "\n"
      + validLeads.map(e => `"${e.name}","${e.email}","${e.company}","${e.status}"`).join("\n");
      
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "arcreach_verified_leads.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleDropUpload = (e: any) => {
    e.preventDefault();
    setIsDragging(false);
    
    // Simulate parsing files
    showToast('CSV Leads uploaded! 1,240 target records loaded as Pending Deliverability Check.');
  };

  const filteredLeads = leads.filter(lead => {
    const matchesSearch = lead.name.toLowerCase().includes(search.toLowerCase()) || 
                          lead.email.toLowerCase().includes(search.toLowerCase()) ||
                          lead.company.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = filterStatus === 'All' || lead.status === filterStatus;
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
            onClick={() => setShowAddLead(!showAddLead)}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-white px-3.5 py-1.8 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-xs"
          >
            <Plus className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
            Add Single Lead
          </button>
          
          <button 
            onClick={handleBulkVerify}
            disabled={isVerifying}
            className="bg-blue-600 hover:bg-blue-500 disabled:bg-blue-700 text-white px-4 py-2 rounded-lg font-semibold flex items-center gap-2 transition-colors text-xs shadow-sm"
          >
            <Play className={`w-3.5 h-3.5 ${isVerifying ? 'animate-spin' : ''}`} />
            {isVerifying ? `Verifying (${verifyProgress}%)` : 'Verify Deliverability'}
          </button>
        </div>
      </header>

      {/* Verification progress status */}
      {isVerifying && (
        <div className="bg-blue-50 dark:bg-blue-950/25 border border-blue-100 dark:border-blue-500/10 p-4 rounded-xl animate-pulse flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Sparkles className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
            <div>
              <p className="text-xs font-bold text-slate-855 dark:text-white uppercase tracking-wider">Checking Mailbox MX Status</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-medium">Resolving DNS setups, catching invalid syntax sequences...</p>
            </div>
          </div>
          <div className="w-full md:w-64 font-sans">
            <div className="flex justify-between text-[11px] mb-1 font-bold">
              <span className="text-blue-650 dark:text-blue-400">SMTP Progress</span>
              <span className="text-slate-500 dark:text-slate-400">{verifyProgress}%</span>
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
          <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">Add Lead Record</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input 
              type="text" 
              placeholder="Name (e.g. John Doe) *"
              value={newLead.name}
              required
              onChange={e => setNewLead({...newLead, name: e.target.value})}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-805 p-2.5 rounded-lg text-xs placeholder:text-slate-400 text-slate-855 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            <input 
              type="email" 
              placeholder="Outreach Email *"
              value={newLead.email}
              required
              onChange={e => setNewLead({...newLead, email: e.target.value})}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-805 p-2.5 rounded-lg text-xs placeholder:text-slate-400 text-slate-855 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            <input 
              type="text" 
              placeholder="Brand Company Name"
              value={newLead.company}
              onChange={e => setNewLead({...newLead, company: e.target.value})}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-805 p-2.5 rounded-lg text-xs placeholder:text-slate-400 text-slate-855 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/40"
            />
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

      {/* CSV Import drag and drop container */}
      <div 
        className={`relative overflow-hidden rounded-xl border border-dashed transition-all duration-200 ${
          isDragging 
            ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/20' 
            : 'border-slate-300 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50/50 dark:hover:bg-slate-850/45'
        } p-8 flex flex-col items-center justify-center cursor-pointer shadow-xs`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDropUpload}
        onClick={() => {
          const email = prompt("Enter simulated contact address:");
          if (email) {
            setLeads(current => [
              { id: Date.now(), email, name: email.split('@')[0], status: 'Unverified', company: 'Self Employed' },
              ...current
            ]);
          }
        }}
      >
        <div className="w-10 h-10 mb-3 rounded-lg bg-slate-50 dark:bg-slate-950 flex items-center justify-center border border-slate-200 dark:border-slate-805">
          <UploadCloud className="w-4.5 h-4.5 text-blue-650 dark:text-blue-400" />
        </div>
        <h3 className="text-sm font-semibold text-slate-800 dark:text-white uppercase tracking-widest mb-1">Import bulk list CSV</h3>
        <p className="text-slate-500 dark:text-slate-400 text-center max-w-md text-xs mb-3 font-medium">
          Drag and drop contacts list, or click to add custom simulated spreadsheets.
        </p>
        <button className="bg-white dark:bg-slate-950 hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-205 dark:border-slate-800 text-slate-700 dark:text-slate-300 px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors shadow-xs">
          Browse Files (.csv)
        </button>
      </div>

      {/* Main CRM contacts board */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-xs mt-4">
        {/* Table Filter Top Bar */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-800/60 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-slate-50/50 dark:bg-slate-900/50">
          <div className="flex flex-col md:flex-row gap-2.5 w-full md:w-auto">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-slate-505" />
              <input 
                type="text" 
                placeholder="Search leads folder..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-805 rounded-lg pl-9 pr-4 py-1.8 text-xs text-slate-800 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none w-full md:w-52 focus:ring-2 focus:ring-blue-500/40 shadow-xs"
              />
            </div>
            
            <div className="flex items-center gap-1 p-1 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xs">
              {['All', 'Valid', 'Risky', 'Invalid', 'Unverified'].map(statusOption => (
                <button
                  key={statusOption}
                  onClick={() => setFilterStatus(statusOption)}
                  className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all uppercase tracking-wider ${
                    filterStatus === statusOption 
                      ? 'bg-blue-650 dark:bg-blue-600 text-white shadow-xs' 
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {statusOption}
                </button>
              ))}
            </div>
          </div>
          
          <button 
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 dark:bg-slate-955 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 text-xs px-3.5 py-2 rounded-lg font-bold text-blue-650 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors shadow-xs"
          >
            <Download className="w-3.5 h-3.5" />
            Download Cleansed CSV
          </button>
        </div>

        {/* Lead Rows list */}
        <div className="w-full overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800/80 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest bg-slate-50/20 dark:bg-slate-950/10">
                <th className="px-5 py-3">Lead Target Name</th>
                <th className="px-5 py-3">Outreach Address</th>
                <th className="px-5 py-3">Assigned Brand</th>
                <th className="px-5 py-3">Deliverability Validation</th>
                <th className="px-5 py-3 text-right">Clear</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50 text-slate-700 dark:text-slate-300">
              {filteredLeads.map((lead) => (
                <tr key={lead.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-850/20 transition-all group">
                  <td className="px-5 py-3.5 font-semibold text-xs text-slate-900 dark:text-white">{lead.name}</td>
                  <td className="px-5 py-3.5 text-xs text-slate-500 dark:text-slate-400 font-mono flex items-center gap-2">
                    <FileType className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                    {lead.email}
                  </td>
                  <td className="px-5 py-3.5 text-xs text-slate-600 dark:text-slate-400 font-medium">{lead.company}</td>
                  <td className="px-5 py-3.5">
                    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider
                      ${lead.status === 'Valid' ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/30' : ''}
                      ${lead.status === 'Invalid' ? 'bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-900/30' : ''}
                      ${lead.status === 'Risky' ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-900/30' : ''}
                      ${lead.status === 'Unverified' ? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-201 dark:border-slate-700' : ''}
                    `}>
                      {lead.status === 'Valid' && <CheckCircle2 className="w-3.5 h-3.5" />}
                      {lead.status === 'Invalid' && <AlertCircle className="w-3.5 h-3.5" />}
                      {lead.status === 'Risky' && <AlertCircle className="w-3.5 h-3.5" />}
                      {lead.status === 'Unverified' && <span className="w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-slate-500 animate-pulse"></span>}
                      {lead.status}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <button 
                      onClick={() => handleDeleteLead(lead.id)}
                      className="p-1.5 hover:bg-rose-500/10 text-slate-400 hover:text-rose-600 rounded transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
              {filteredLeads.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center py-10 text-slate-400 dark:text-slate-400 text-xs">
                    No lead records match your search filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {toastMessage && (
        <div className="fixed bottom-8 right-8 bg-slate-900 dark:bg-[#0c0d14] border border-slate-800 text-white px-4 py-3 rounded-lg shadow-2xl flex items-center gap-3 z-50 animate-in slide-in-from-bottom-5 text-xs">
          <span className="font-semibold">{toastMessage}</span>
          <button onClick={() => setToastMessage('')} className="text-slate-400 hover:text-white transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

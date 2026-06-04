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
  RefreshCw
} from 'lucide-react';
import { useState, useEffect, useRef } from 'react';

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
  const [newLead, setNewLead] = useState({ name: '', email: '', company: '' });

  const showToast = (message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(''), 3500);
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
          status: 'Neutral',
          validationStatus: 'Unverified'
        })
      });

      if (res.ok) {
        const created = await res.json();
        setLeads([created, ...leads]);
        setNewLead({ name: '', email: '', company: '' });
        setShowAddLead(false);
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
      + ["Name,Email,Company,Verification"].join(",") + "\n"
      + validLeads.map(e => `"${e.name || ''}","${e.email}","${e.company || ''}","${e.validationStatus}"`).join("\n");
      
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
              company: companyIdx !== -1 && cols[companyIdx] ? cols[companyIdx] : 'Unknown'
            });
          }
        }

        if (parsedLeads.length === 0) {
          showToast('No valid contacts found in CSV.');
          return;
        }

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
                status: 'Neutral',
                validationStatus: 'Unverified'
              })
            });
            if (res.ok) count++;
          } catch (e) {}
        }

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

  const filteredLeads = leads.filter(lead => {
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
          <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">Add Lead Record</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input 
              type="text" 
              placeholder="Name (e.g. John Doe) *"
              value={newLead.name}
              required
              onChange={e => setNewLead({...newLead, name: e.target.value})}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-202 dark:border-slate-805 p-2.5 rounded-lg text-xs placeholder:text-slate-400 text-slate-855 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            <input 
              type="email" 
              placeholder="Outreach Email *"
              value={newLead.email}
              required
              onChange={e => setNewLead({...newLead, email: e.target.value})}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-202 dark:border-slate-805 p-2.5 rounded-lg text-xs placeholder:text-slate-400 text-slate-855 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            <input 
              type="text" 
              placeholder="Brand Company Name"
              value={newLead.company}
              onChange={e => setNewLead({...newLead, company: e.target.value})}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-202 dark:border-slate-805 p-2.5 rounded-lg text-xs placeholder:text-slate-400 text-slate-855 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/40"
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
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
              <input 
                type="text" 
                placeholder="Search leads folder..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-805 rounded-lg pl-9 pr-4 py-1.8 text-xs text-slate-800 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none w-full md:w-52 focus:ring-2 focus:ring-blue-500/40 shadow-xs"
              />
            </div>
            
            <div className="flex items-center gap-1 p-1 bg-white dark:bg-slate-955 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xs">
              {['All', 'Valid', 'Risky', 'Invalid', 'Unverified'].map(statusOption => (
                <button
                  key={statusOption}
                  onClick={() => setFilterStatus(statusOption)}
                  className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all uppercase tracking-wider ${
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
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 dark:bg-slate-955 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 text-xs px-3.5 py-2 rounded-lg font-bold text-blue-650 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors shadow-xs"
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
                <tr className="border-b border-slate-202 dark:border-slate-800/80 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest bg-slate-50/20 dark:bg-slate-950/10">
                  <th className="px-5 py-3">Lead Target Name</th>
                  <th className="px-5 py-3">Outreach Address</th>
                  <th className="px-5 py-3">Assigned Brand</th>
                  <th className="px-5 py-3">Deliverability Validation</th>
                  <th className="px-5 py-3 text-right">Clear</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-105 dark:divide-slate-800/50 text-slate-700 dark:text-slate-300">
                {filteredLeads.map((lead) => (
                  <tr key={lead.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-850/20 transition-all group">
                    <td className="px-5 py-3.5 font-semibold text-xs text-slate-909 dark:text-white">{lead.name || 'N/A'}</td>
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
                    <td colSpan={5} className="text-center py-10 text-slate-400 dark:text-slate-500 text-xs">
                      No lead records match your search filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
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

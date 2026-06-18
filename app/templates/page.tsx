/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import { useState, useEffect } from 'react';
import { FileText, Search, Plus, Eye, Sparkles, Copy, Check, Trash2, ArrowRight, X } from 'lucide-react';
import VariableToolbar from '@/components/VariableToolbar';

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [editingTemplate, setEditingTemplate] = useState<any>(null);
  const [activeStepIndex, setActiveStepIndex] = useState<number>(0);
  const [copiedId, setCopiedId] = useState<any>(null);
  const [previewResolved, setPreviewResolved] = useState(false);
  const [toastMessage, setToastMessage] = useState('');

  const showToast = (message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(''), 3005);
  };

  const selectTemplate = (template: any) => {
    if (!template) {
      setEditingTemplate(null);
      return;
    }
    let normalizedSteps = [];
    if (template.steps && Array.isArray(template.steps)) {
      normalizedSteps = [...template.steps];
    } else {
      normalizedSteps = [{
        id: 'step-1',
        waitDays: 0,
        subject: template.subject || '',
        body: template.body || ''
      }];
    }
    setEditingTemplate({
      ...template,
      steps: normalizedSteps
    });
    setPreviewResolved(false);
    setActiveStepIndex(0);
  };

  const fetchTemplates = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/templates');
      if (res.ok) {
        const data = await res.json();
        setTemplates(data);
        if (data.length > 0) {
          selectTemplate(data[0]);
        }
      }
    } catch (e) {
      console.error('Failed to fetch templates:', e);
      showToast('Error loading templates');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTemplates();
  }, []);

  // Spintax and Variable Resolver
  const resolveTemplateText = (text: string) => {
    if (!text) return '';
    let result = text;
    // Replace variables with mock values
    result = result.replace(/\{\{firstName\}\}/g, 'Emily');
    result = result.replace(/\{\{company\}\}/g, 'Stark Industries');
    result = result.replace(/\{\{name\}\}/g, 'Emily Carter');
    result = result.replace(/\{\{jobTitle\}\}/g, 'VP of Marketing');
    result = result.replace(/\{\{email\}\}/g, 'emily@starkindustries.com');
    result = result.replace(/\{\{\s*\$json\.name\s*\|\|\s*'[^']*'\s*\}\}/g, 'Emily');
    result = result.replace(/\{\{\s*\$json\.name\s*\}\}/g, 'Emily');

    // Basic Spintax solver: {A|B|C} -> selects the first option for consistency in preview
    const spintaxRegex = /\{([^{}]+)\}/g;
    result = result.replace(spintaxRegex, (match, options) => {
      const choices = options.split('|');
      return choices[0] || '';
    });

    return result;
  };

  const isHtml = (text: string) => {
    if (!text) return false;
    const clean = text.trim().toLowerCase();
    return clean.startsWith('<!doctype html') || clean.startsWith('<html') || clean.startsWith('<body') || clean.includes('<div') || clean.includes('<table');
  };

  const handleCopy = (id: any, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const categories = ['All', ...Array.from(new Set(templates.map(t => t.category)))];

  const filteredTemplates = templates.filter(t => {
    const matchesSearch = t.name.toLowerCase().includes(search.toLowerCase()) || 
                          t.subject.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = selectedCategory === 'All' || t.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const addStep = () => {
    if (!editingTemplate) return;
    const newSteps = [
      ...(editingTemplate.steps || []),
      {
        id: `step-${Date.now()}`,
        waitDays: 3,
        subject: 'Follow-up query',
        body: 'Hi {{firstName}},\n\nJust bumping this in case it got buried.\n\nBest,\nJohn'
      }
    ];
    setEditingTemplate({ ...editingTemplate, steps: newSteps });
    setActiveStepIndex(newSteps.length - 1);
  };

  const removeStep = (indexToRemove: number) => {
    if (!editingTemplate || (editingTemplate.steps?.length || 0) <= 1) return;
    const newSteps = editingTemplate.steps.filter((_: any, idx: number) => idx !== indexToRemove);
    setEditingTemplate({ ...editingTemplate, steps: newSteps });
    setActiveStepIndex(Math.max(0, indexToRemove - 1));
  };

  const updateStepField = (index: number, field: string, value: any) => {
    if (!editingTemplate) return;
    const newSteps = editingTemplate.steps.map((step: any, idx: number) => {
      if (idx === index) {
        return { ...step, [field]: value };
      }
      return step;
    });
    setEditingTemplate({ ...editingTemplate, steps: newSteps });
  };

  const handleSave = async () => {
    if (!editingTemplate) return;
    try {
      const isNew = typeof editingTemplate.id === 'number'; // Local temporary ID (Date.now())
      const method = isNew ? 'POST' : 'PUT';

      // Ensure we keep subject/body at the top level for backward compatibility
      const firstStep = editingTemplate.steps?.[0] || { subject: editingTemplate.subject, body: editingTemplate.body };

      const payload = {
        name: editingTemplate.name,
        subject: firstStep.subject || '',
        body: firstStep.body || '',
        category: editingTemplate.category,
        steps: editingTemplate.steps || null,
        ...(isNew ? {} : { id: editingTemplate.id })
      };

      const res = await fetch('/api/templates', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        const saved = await res.json();
        const updated = templates.map(t => t.id === editingTemplate.id ? saved : t);
        setTemplates(updated);
        selectTemplate(saved);
        showToast('Template saved successfully!');
      } else {
        const err = await res.json();
        showToast(`Failed to save: ${err.error || 'Unknown error'}`);
      }
    } catch (e) {
      console.error(e);
      showToast('Connection error while saving template');
    }
  };

  const deleteTemplate = async (id: any) => {
    if (confirm('Are you sure you want to delete this template?')) {
      try {
        const isNew = typeof id === 'number';
        if (isNew) {
          const updated = templates.filter(t => t.id !== id);
          setTemplates(updated);
          if (editingTemplate?.id === id) {
            selectTemplate(updated[0] || null);
          }
          showToast('Draft template discarded.');
          return;
        }

        const res = await fetch(`/api/templates?id=${id}`, {
          method: 'DELETE'
        });

        if (res.ok) {
          const updated = templates.filter(t => t.id !== id);
          setTemplates(updated);
          if (editingTemplate?.id === id) {
            selectTemplate(updated[0] || null);
          }
          showToast('Template deleted successfully!');
        } else {
          const err = await res.json();
          showToast(`Failed to delete: ${err.error || 'Unknown error'}`);
        }
      } catch (e) {
        console.error(e);
        showToast('Connection error while deleting template');
      }
    }
  };

  const createNewTemplate = () => {
    const newT = {
      id: Date.now(),
      name: 'New Custom Template',
      subject: 'Quick question {{firstName}}',
      body: 'Hi {{firstName}},\n\nWrite your email copy here...',
      category: 'Cold Outreach',
      steps: [{
        id: 'step-1',
        waitDays: 0,
        subject: 'Quick question {{firstName}}',
        body: 'Hi {{firstName}},\n\nWrite your email copy here...'
      }]
    };
    setTemplates([newT, ...templates]);
    selectTemplate(newT);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-6xl mx-auto pb-10">
      {/* Header */}
      <header className="flex justify-between items-center pb-4 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white mb-0.5">Copy Library</h1>
          <p className="text-slate-500 dark:text-slate-400 text-xs font-semibold">Write and manage high-converting cold email COPY strings with dynamic spintax spins.</p>
        </div>
        <button 
          onClick={createNewTemplate}
          className="bg-blue-600 hover:bg-blue-500 border border-blue-500 text-white px-4 py-2 rounded-lg font-semibold flex items-center gap-2 transition-colors text-xs shadow-sm cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Create Template
        </button>
      </header>

      {/* Filter and Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: templates list */}
        <div className="lg:col-span-1 space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 dark:text-slate-400" />
            <input 
              type="text" 
              placeholder="Search templates folder..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-slate-50 dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-lg pl-9 pr-4 py-2 text-xs text-slate-800 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none focus:ring-2 focus:ring-blue-500/40 shadow-xs"
            />
          </div>

          {/* Category Tabs */}
          <div className="flex flex-wrap gap-1 p-1 bg-slate-50 dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-lg shadow-2xs">
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-3 py-1 text-[10px] rounded-md font-bold transition-all uppercase tracking-wider cursor-pointer ${
                  selectedCategory === cat 
                    ? 'bg-blue-600 text-white shadow-xs' 
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Templates Stack */}
          <div className="space-y-2 overflow-y-auto max-h-[500px]">
            {loading ? (
              <div className="py-12 text-center text-slate-400 dark:text-slate-500 text-xs">
                <div className="w-5 h-5 border-2 border-slate-200 dark:border-slate-800 border-t-blue-500 animate-spin rounded-full mx-auto mb-2.5" />
                <p className="font-medium tracking-wide">Retrieving copy templates...</p>
              </div>
            ) : (
              <>
                {filteredTemplates.map(t => (
                  <div 
                    key={t.id}
                    onClick={() => {
                      selectTemplate(t);
                    }}
                    className={`p-4 rounded-lg border text-left cursor-pointer transition-all ${
                      editingTemplate?.id === t.id 
                        ? 'bg-blue-50/50 dark:bg-blue-600/10 border-blue-200 dark:border-blue-500/15' 
                        : 'bg-white dark:bg-[#0e1017] border-slate-200 dark:border-[#1b1c26] hover:bg-slate-50/50 dark:hover:bg-white/[0.01]'
                    }`}
                  >
                    <div className="flex justify-between items-start mb-1.5 font-sans">
                      <h3 className="font-bold text-xs text-slate-900 dark:text-white line-clamp-1">{t.name}</h3>
                      <div className="flex gap-1 items-center shrink-0">
                        {t.steps && Array.isArray(t.steps) && t.steps.length > 1 && (
                          <span className="text-[8px] bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 font-bold px-1.5 py-0.5 rounded font-mono">
                            {t.steps.length} Steps
                          </span>
                        )}
                        <span className="text-[8px] bg-blue-50 dark:bg-blue-500/15 border border-blue-200 dark:border-blue-500/15 text-blue-700 dark:text-blue-400 font-bold px-1.5 py-0.5 rounded uppercase tracking-widest font-mono">
                          {t.category}
                        </span>
                      </div>
                    </div>
                    <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono mb-2 truncate font-semibold">{t.steps?.[0]?.subject || t.subject}</p>
                    <p className="text-[11px] text-slate-600 dark:text-slate-400 line-clamp-2 leading-relaxed">{t.steps?.[0]?.body || t.body}</p>
                  </div>
                ))}
                {filteredTemplates.length === 0 && (
                  <div className="text-center py-10 bg-white dark:bg-[#0e1017] border border-dashed border-slate-200 dark:border-[#1b1c26] rounded-lg">
                    <FileText className="w-6 h-6 mx-auto text-slate-400 dark:text-gray-500 mb-2" />
                    <p className="text-xs text-slate-500 dark:text-gray-500 font-medium">No email templates found</p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right Columns: Editing & Preview Workspace */}
        <div className="lg:col-span-2 space-y-6">
          {editingTemplate ? (
            <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 relative shadow-xs">
              <div className="flex justify-between items-center pb-3 border-b border-slate-200 dark:border-[#1b1c26] mb-5">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-800 dark:text-white">Edit: {editingTemplate.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => setPreviewResolved(!previewResolved)}
                    className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1.5 border uppercase shadow-xs cursor-pointer ${
                      previewResolved 
                        ? 'bg-blue-50 dark:bg-blue-600/10 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-500/15' 
                        : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-[#1f2130] hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    <Eye className="w-3.5 h-3.5" />
                    {previewResolved ? 'Edit Mode' : 'Sandbox Preview'}
                  </button>
                  <button 
                    onClick={() => deleteTemplate(editingTemplate.id)}
                    className="p-1.5 bg-rose-50 dark:bg-rose-500/5 hover:bg-rose-100 dark:hover:bg-rose-500/10 text-rose-700 dark:text-rose-500 border border-rose-200 dark:border-[#1f2130] rounded-lg transition-all cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Drip sequence step tabs */}
              <div className="flex flex-wrap items-center gap-2 mb-5 pb-3 border-b border-slate-100 dark:border-slate-800/60">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mr-2">Sequence steps:</span>
                {editingTemplate.steps?.map((step: any, idx: number) => (
                  <div key={step.id || idx} className="flex items-center gap-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-[#1f2130] rounded-lg p-0.5">
                    <button
                      type="button"
                      onClick={() => { setActiveStepIndex(idx); }}
                      className={`px-3 py-1 rounded text-[10px] font-bold transition-all cursor-pointer ${
                        activeStepIndex === idx 
                          ? 'bg-blue-600 text-white shadow-xs' 
                          : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      Step {idx + 1} {idx > 0 && `(+${step.waitDays}d)`}
                    </button>
                    {editingTemplate.steps.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeStep(idx)}
                        className="p-1 hover:text-rose-600 text-slate-400 cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addStep}
                  className="px-3 py-1 rounded-lg border border-dashed border-slate-400 dark:border-slate-800 text-[10px] font-bold text-slate-500 hover:text-slate-800 dark:hover:text-white transition-colors cursor-pointer"
                >
                  + Add Step
                </button>
              </div>

              {previewResolved ? (
                /* Dynamic Preview Window */
                <div className="space-y-4 animate-in fade-in">
                  <div className="bg-blue-50 dark:bg-blue-950/15 border border-blue-200 dark:border-blue-500/15 p-4 rounded-lg flex items-start gap-3">
                    <Sparkles className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[10px] text-blue-700 dark:text-blue-400 font-bold uppercase tracking-wider">Dynamic Resolve Active (Step {activeStepIndex + 1})</p>
                      <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 font-medium leading-relaxed">Resolving variables for contact address <strong className="text-slate-900 dark:text-white">Emily</strong> at company <strong className="text-slate-950 dark:text-white">Stark Industries</strong> with Spintax resolved.</p>
                    </div>
                  </div>

                  <div className="space-y-4 font-sans bg-slate-50 dark:bg-[#12141d] border border-slate-100 dark:border-[#1f2130] p-4 rounded-lg">
                    <div className="border-b border-slate-200 dark:border-[#1b1c26] pb-3">
                      <span className="text-[10px] text-slate-400 dark:text-slate-500 uppercase tracking-widest font-bold font-mono">Subject Outcome:</span>
                      <p className="text-xs font-semibold text-slate-900 dark:text-white mt-1">{resolveTemplateText(editingTemplate.steps?.[activeStepIndex]?.subject || '')}</p>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-400 dark:text-slate-500 uppercase tracking-widest font-bold font-mono mb-2 block">Message Outcome:</span>
                      {isHtml(resolveTemplateText(editingTemplate.steps?.[activeStepIndex]?.body || '')) ? (
                        <iframe 
                          srcDoc={resolveTemplateText(editingTemplate.steps?.[activeStepIndex]?.body || '')}
                          title="Email Preview"
                          className="w-full h-[500px] border border-slate-200 dark:border-slate-800 rounded-lg bg-white"
                          sandbox="allow-same-origin"
                        />
                      ) : (
                        <p className="text-xs text-slate-700 dark:text-gray-400 whitespace-pre-wrap leading-relaxed font-sans">{resolveTemplateText(editingTemplate.steps?.[activeStepIndex]?.body || '')}</p>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                /* Main Editor Setup */
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">Template Title</label>
                      <input 
                        type="text" 
                        value={editingTemplate.name}
                        onChange={(e) => setEditingTemplate({...editingTemplate, name: e.target.value})}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] rounded-lg px-3 py-2 text-xs text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/30"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">Campaign Segment Category</label>
                      <input 
                        type="text"
                        list="categories-list"
                        value={editingTemplate.category}
                        onChange={(e) => setEditingTemplate({...editingTemplate, category: e.target.value})}
                        placeholder="e.g. Cold Outreach"
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] rounded-lg px-3 py-2 text-xs text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/30"
                      />
                      <datalist id="categories-list">
                        {Array.from(new Set(templates.map(t => t.category))).map(cat => (
                          <option key={cat} value={cat} />
                        ))}
                      </datalist>
                    </div>
                  </div>

                  {activeStepIndex > 0 && (
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">Wait Days before sending this follow-up</label>
                      <input 
                        type="number" 
                        min="1"
                        value={editingTemplate.steps?.[activeStepIndex]?.waitDays || 3}
                        onChange={(e) => updateStepField(activeStepIndex, 'waitDays', parseInt(e.target.value) || 1)}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] rounded-lg px-3 py-2 text-xs text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/30 font-mono"
                      />
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">Email Subject line</label>
                    <input 
                      type="text" 
                      value={editingTemplate.steps?.[activeStepIndex]?.subject || ''}
                      onChange={(e) => updateStepField(activeStepIndex, 'subject', e.target.value)}
                      className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] rounded-lg px-3 py-2 text-xs text-slate-800 dark:text-white font-mono outline-none focus:ring-2 focus:ring-blue-500/30"
                    />
                  </div>

                  <div className="bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] rounded-lg px-3 py-2">
                    <VariableToolbar
                      onInsert={(v) => updateStepField(activeStepIndex, 'body', (editingTemplate.steps?.[activeStepIndex]?.body || '') + ' ' + v)}
                      onInsertSubject={(v) => updateStepField(activeStepIndex, 'subject', (editingTemplate.steps?.[activeStepIndex]?.subject || '') + ' ' + v)}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">Body copy & variables (Supports HTML/Text)</label>
                    <textarea 
                      value={editingTemplate.steps?.[activeStepIndex]?.body || ''}
                      onChange={(e) => updateStepField(activeStepIndex, 'body', e.target.value)}
                      className="w-full h-96 p-4 outline-none bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-slate-200 text-xs rounded-lg resize-none font-mono leading-relaxed shadow-xs"
                      placeholder="Write your email copy or paste HTML template code here..."
                    ></textarea>
                  </div>

                  <div className="flex justify-between items-center pt-2">
                    <button 
                      onClick={() => handleCopy(editingTemplate.id, editingTemplate.steps?.[activeStepIndex]?.body || '')}
                      className="text-[10px] text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white flex items-center gap-1 bg-slate-50 dark:bg-[#12141d] px-3 py-1.8 rounded-lg border border-slate-200 dark:border-[#1f2130] font-bold uppercase transition-colors shadow-2xs cursor-pointer"
                    >
                      {copiedId === editingTemplate.id ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                      {copiedId === editingTemplate.id ? 'Copied' : 'Copy Code'}
                    </button>
                    <button 
                      onClick={handleSave}
                      className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-xs cursor-pointer"
                    >
                      Save Template
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-20 border border-dashed border-slate-300 dark:border-[#1b1c26] rounded-xl bg-white dark:bg-[#0e1017] shadow-2xs">
              <FileText className="w-10 h-10 mx-auto text-slate-400 dark:text-gray-500 mb-2" />
              <p className="text-xs text-slate-500 dark:text-gray-500 font-semibold tracking-wider uppercase">Select template to configure copy</p>
            </div>
          )}
        </div>
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

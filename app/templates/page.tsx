/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable react-hooks/exhaustive-deps */
'use client';

import { useState, useEffect, useRef } from 'react';
import {
  FileText, Search, Plus, Eye, Copy, Check, Trash2, ArrowRight, Upload, AlertTriangle, RefreshCw,
} from 'lucide-react';
import VariableToolbar from '@/components/VariableToolbar';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { personalizePreview, previewEmailBody } from '@/lib/personalize';
import { loadErrorMessage, readJsonList } from '@/lib/apiResponse';
import {
  readEmailFile, importRefusal, sortImportedEmails, importWaitDays, sequenceTemplate, separateTemplates,
  DEFAULT_IMPORT_WAIT_DAYS, type ImportedEmail, type ImportedTemplate,
} from '@/lib/templateImport';
import {
  Box, Stack, Typography, Button, Chip, TextField,
  ToggleButtonGroup, ToggleButton, Snackbar, Alert, AlertTitle,
  CircularProgress, Tooltip as MuiTooltip, Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [editingTemplate, setEditingTemplate] = useState<any>(null);
  const [activeStepIndex, setActiveStepIndex] = useState<number>(0);
  const [copiedId, setCopiedId] = useState<any>(null);
  const [previewResolved, setPreviewResolved] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [confirmState, setConfirmState] = useState<{ title: string; message: string; confirmLabel: string; onConfirm: () => void } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importEmails, setImportEmails] = useState<ImportedEmail[]>([]);
  const [importRefused, setImportRefused] = useState<{ fileName: string; reason: string }[]>([]);
  const [importMode, setImportMode] = useState<'sequence' | 'separate'>('sequence');
  const [importName, setImportName] = useState('');
  const [importCategory, setImportCategory] = useState('Cold Outreach');
  const [importWait, setImportWait] = useState(String(DEFAULT_IMPORT_WAIT_DAYS));
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);

  const showToast = (message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(''), 3005);
  };

  const selectTemplate = (template: any) => {
    if (!template) { setEditingTemplate(null); return; }
    let normalizedSteps = [];
    if (template.steps && Array.isArray(template.steps)) {
      normalizedSteps = [...template.steps];
    } else {
      normalizedSteps = [{ id: 'step-1', waitDays: 0, subject: template.subject || '', body: template.body || '' }];
    }
    setEditingTemplate({ ...template, steps: normalizedSteps });
    setPreviewResolved(false);
    setActiveStepIndex(0);
  };

  const fetchTemplates = async () => {
    try {
      setLoading(true);
      setLoadError('');
      const data = await readJsonList(await fetch('/api/templates'), 'Templates');
      setTemplates(data);
      if (data.length > 0) selectTemplate(data[0]);
    } catch (e) {
      console.error('Failed to fetch templates:', e);
      setLoadError(loadErrorMessage(e, 'Templates'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTemplates(); }, []);

  const handleCopy = (id: any, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const categories = ['All', ...Array.from(new Set(templates.map(t => t.category)))];

  const filteredTemplates = templates.filter(t => {
    const matchesSearch = t.name.toLowerCase().includes(search.toLowerCase()) || t.subject.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = selectedCategory === 'All' || t.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const addStep = () => {
    if (!editingTemplate) return;
    const newSteps = [...(editingTemplate.steps || []), {
      id: `step-${Date.now()}`,
      waitDays: 3,
      subject: 'Follow-up query',
      body: 'Hi {{firstName}},\n\nJust bumping this in case it got buried.',
    }];
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
    const newSteps = editingTemplate.steps.map((step: any, idx: number) =>
      idx === index ? { ...step, [field]: value } : step
    );
    setEditingTemplate({ ...editingTemplate, steps: newSteps });
  };

  const handleSave = async () => {
    if (!editingTemplate || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const isNew = typeof editingTemplate.id === 'number';
      const method = isNew ? 'POST' : 'PUT';
      const firstStep = editingTemplate.steps?.[0] || { subject: editingTemplate.subject, body: editingTemplate.body };
      const payload = {
        name: editingTemplate.name,
        subject: firstStep.subject || '',
        body: firstStep.body || '',
        category: editingTemplate.category,
        steps: editingTemplate.steps || null,
        ...(isNew ? {} : { id: editingTemplate.id }),
      };
      const res = await fetch('/api/templates', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const deleteTemplate = (id: any) => {
    setConfirmState({
      title: 'Delete Template',
      message: 'This removes the template and all of its sequence steps. This cannot be undone.',
      confirmLabel: 'Delete',
      onConfirm: () => { setConfirmState(null); performDeleteTemplate(id); },
    });
  };

  const performDeleteTemplate = async (id: any) => {
    try {
      const isNew = typeof id === 'number';
      if (isNew) {
        const updated = templates.filter(t => t.id !== id);
        setTemplates(updated);
        if (editingTemplate?.id === id) selectTemplate(updated[0] || null);
        showToast('Draft template discarded.');
        return;
      }
      const res = await fetch(`/api/templates?id=${id}`, { method: 'DELETE' });
      if (res.ok) {
        const updated = templates.filter(t => t.id !== id);
        setTemplates(updated);
        if (editingTemplate?.id === id) selectTemplate(updated[0] || null);
        showToast('Template deleted successfully!');
      } else {
        const err = await res.json();
        showToast(`Failed to delete: ${err.error || 'Unknown error'}`);
      }
    } catch (e) {
      console.error(e);
      showToast('Connection error while deleting template');
    }
  };

  const createNewTemplate = () => {
    const newT = {
      id: Date.now(),
      name: 'New Custom Template',
      subject: 'Quick question {{firstName}}',
      body: 'Hi {{firstName}},\n\nWrite your email copy here...',
      category: 'Cold Outreach',
      steps: [{ id: 'step-1', waitDays: 0, subject: 'Quick question {{firstName}}', body: 'Hi {{firstName}},\n\nWrite your email copy here...' }],
    };
    setTemplates([newT, ...templates]);
    selectTemplate(newT);
  };

  const handleImportFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;

    const emails: ImportedEmail[] = [];
    const refused: { fileName: string; reason: string }[] = [];
    for (const file of files) {
      const refusal = importRefusal(file.name, file.size);
      if (refusal) { refused.push({ fileName: file.name, reason: refusal }); continue; }
      try {
        const result = readEmailFile(file.name, new Uint8Array(await file.arrayBuffer()));
        if (result.ok) emails.push(result.email);
        else refused.push({ fileName: result.fileName, reason: result.reason });
      } catch (err) {
        console.error(err);
        refused.push({ fileName: file.name, reason: 'The file could not be read.' });
      }
    }

    const sorted = sortImportedEmails(emails);
    setImportEmails(sorted);
    setImportRefused(refused);
    setImportMode('sequence');
    setImportName(sorted.length === 1 ? sorted[0].name : '');
    setImportCategory('Cold Outreach');
    setImportWait(String(DEFAULT_IMPORT_WAIT_DAYS));
    setImportError('');
    setImportOpen(true);
  };

  const closeImport = () => {
    if (!importingRef.current) setImportOpen(false);
  };

  const importAsOne = importEmails.length <= 1 || importMode === 'sequence';
  const importNames = importAsOne ? [importName.trim()] : importEmails.map(email => email.name);
  const importNameClashes = importNames.filter(name => name && templates.some(t => String(t.name).trim().toLowerCase() === name.toLowerCase()));

  const runImport = async () => {
    if (importEmails.length === 0 || importingRef.current) return;
    if (importAsOne && !importName.trim()) return;
    const category = importCategory.trim() || 'Cold Outreach';
    const one = importAsOne ? sequenceTemplate(importEmails, importName, category, importWait) : null;
    const drafts: ImportedTemplate[] = one ? [one] : separateTemplates(importEmails, category);

    importingRef.current = true;
    setImporting(true);
    setImportError('');
    const created: any[] = [];
    let failure = '';
    let remaining = drafts.length;
    while (remaining > 0) {
      try {
        const res = await fetch('/api/templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(drafts[remaining - 1]),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          failure = err.error || `The server answered ${res.status}.`;
          break;
        }
        created.unshift(await res.json());
        remaining--;
      } catch (err) {
        console.error(err);
        failure = 'Connection error.';
        break;
      }
    }
    importingRef.current = false;
    setImporting(false);

    if (created.length > 0) {
      setTemplates(prev => [...created, ...prev]);
      selectTemplate(created[0]);
    }
    if (failure) {
      if (created.length > 0) setImportEmails(importEmails.slice(0, remaining));
      setImportError(created.length > 0
        ? `Imported ${created.length} of ${drafts.length} templates, then "${drafts[remaining - 1].name}" failed: ${failure} The files listed below were not imported.`
        : `Nothing was imported: ${failure}`);
      return;
    }
    setImportOpen(false);
    showToast(one
      ? `Imported "${one.name}" with ${one.steps.length} ${one.steps.length === 1 ? 'step' : 'steps'}.`
      : `Imported ${created.length} templates.`);
  };

  const bodyPreview = previewResolved && editingTemplate ? previewEmailBody(editingTemplate.steps?.[activeStepIndex]?.body || '') : null;

  return (
    <div className="space-y-6 pb-12 w-full">
      <Snackbar open={!!toastMessage} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} autoHideDuration={3000} onClose={() => setToastMessage('')}>
        {toastMessage ? <Alert severity="info" variant="filled" sx={{ borderRadius: '12px' }}>{toastMessage}</Alert> : undefined}
      </Snackbar>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#EBF0F5] dark:border-[#1E222D]">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white">
            Copy Library
          </h1>
          <p className="text-xs md:text-sm text-slate-500 dark:text-slate-400 mt-1">
            Write and manage reusable email templates with personalization variables and Spintax.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <input ref={fileInputRef} type="file" accept=".html,.htm,text/html" multiple hidden onChange={handleImportFiles} />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!!loadError}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-[#EBF0F5] dark:border-[#1E222D] bg-white dark:bg-[#11131A] text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-[#161822] transition-colors cursor-pointer disabled:opacity-50"
          >
            <Upload size={14} />
            <span>Import HTML</span>
          </button>
          <button
            type="button"
            onClick={createNewTemplate}
            disabled={!!loadError}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer disabled:opacity-50"
          >
            <Plus size={14} />
            <span>Create Template</span>
          </button>
        </div>
      </div>

      {loadError ? (
        <Alert
          severity="error"
          sx={{ borderRadius: '16px' }}
          action={<Button color="inherit" size="small" startIcon={<RefreshCw size={14} />} onClick={() => fetchTemplates()}>Retry</Button>}
        >
          <AlertTitle>Templates Could Not Be Loaded</AlertTitle>
          {loadError}
        </Alert>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column: Template Library */}
          <div className="space-y-4">
            <div className="relative">
              <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search templates..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl text-xs bg-white dark:bg-[#11131A] border border-[#EBF0F5] dark:border-[#1E222D] text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:border-blue-500 shadow-xs transition-colors"
              />
            </div>

            {/* Category Pills Bar */}
            <div className="flex flex-wrap gap-1.5 p-1.5 rounded-2xl bg-slate-100/70 dark:bg-[#161822]/70 border border-[#EBF0F5] dark:border-[#1E222D]">
              {categories.map(cat => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedCategory(cat)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition-all cursor-pointer ${
                    selectedCategory === cat
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* Template Card List */}
            <div className="max-h-[580px] overflow-y-auto space-y-2.5 pr-1">
              {loading ? (
                <div className="flex flex-col items-center justify-center py-12 gap-2">
                  <CircularProgress size={24} />
                  <span className="text-xs text-slate-500 dark:text-slate-400">Retrieving templates…</span>
                </div>
              ) : filteredTemplates.length === 0 ? (
                <div className="p-8 rounded-[24px] border border-dashed border-[#EBF0F5] dark:border-[#1E222D] text-center">
                  <FileText size={28} className="mx-auto text-slate-400 opacity-40 mb-2" />
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {templates.length === 0 ? 'No templates yet' : 'No templates match this search or category'}
                  </span>
                </div>
              ) : (
                filteredTemplates.map(t => {
                  const isSelected = editingTemplate?.id === t.id;
                  return (
                    <div
                      key={t.id}
                      onClick={() => selectTemplate(t)}
                      className={`p-4 rounded-[20px] border transition-all cursor-pointer ${
                        isSelected
                          ? 'border-blue-600 dark:border-blue-500 bg-blue-50/40 dark:bg-blue-950/20 shadow-xs'
                          : 'border-[#EBF0F5] dark:border-[#1E222D] bg-white dark:bg-[#11131A] hover:border-slate-300 dark:hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <span className="text-xs font-bold text-slate-900 dark:text-white truncate">
                          {t.name}
                        </span>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {t.steps && Array.isArray(t.steps) && t.steps.length > 1 && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold font-mono bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                              {t.steps.length} Steps
                            </span>
                          )}
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-900/40">
                            {t.category}
                          </span>
                        </div>
                      </div>

                      <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate mb-1">
                        {t.steps?.[0]?.subject || t.subject}
                      </div>

                      <p className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2 leading-relaxed">
                        {t.steps?.[0]?.body || t.body}
                      </p>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Column: Template Editor / Preview */}
          <div className="lg:col-span-2">
            {editingTemplate ? (
              <div className="rounded-[24px] border border-[#EBF0F5] dark:border-[#1E222D] bg-white dark:bg-[#11131A] p-6 shadow-xs space-y-5">
                {/* Editor Header */}
                <div className="flex items-center justify-between pb-4 border-b border-[#EBF0F5] dark:border-[#1E222D]">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText size={18} className="text-blue-600 flex-shrink-0" />
                    <h2 className="text-sm font-bold text-slate-900 dark:text-white tracking-tight truncate">
                      Edit: {editingTemplate.name}
                    </h2>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPreviewResolved(!previewResolved)}
                      className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors cursor-pointer ${
                        previewResolved
                          ? 'bg-blue-600 text-white'
                          : 'border border-[#EBF0F5] dark:border-[#1E222D] text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#161822]'
                      }`}
                    >
                      <Eye size={13} />
                      <span>{previewResolved ? 'Edit Mode' : 'Preview'}</span>
                    </button>
                    <MuiTooltip title="Delete Template">
                      <button
                        type="button"
                        aria-label="Delete template"
                        onClick={() => deleteTemplate(editingTemplate.id)}
                        className="w-8 h-8 rounded-full border border-rose-200 dark:border-rose-900/60 flex items-center justify-center text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
                      >
                        <Trash2 size={14} />
                      </button>
                    </MuiTooltip>
                  </div>
                </div>

                {/* Sequence Step Chips */}
                <div className="flex flex-wrap items-center gap-2 pb-4 border-b border-[#EBF0F5] dark:border-[#1E222D]">
                  <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mr-1">
                    Sequence Steps:
                  </span>
                  {editingTemplate.steps?.map((step: any, idx: number) => (
                    <Chip
                      key={step.id || idx}
                      label={`Step ${idx + 1}${idx > 0 ? ` (+${step.waitDays}d)` : ''}`}
                      onClick={() => setActiveStepIndex(idx)}
                      onDelete={editingTemplate.steps.length > 1 ? () => removeStep(idx) : undefined}
                      color={activeStepIndex === idx ? 'primary' : 'default'}
                      variant={activeStepIndex === idx ? 'filled' : 'outlined'}
                      sx={{ fontWeight: 700, fontSize: 11, borderRadius: '9999px' }}
                    />
                  ))}
                  <button
                    type="button"
                    onClick={addStep}
                    className="inline-flex items-center gap-1 px-3 py-1 rounded-full border border-dashed border-[#EBF0F5] dark:border-[#1E222D] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white text-xs font-semibold transition-colors cursor-pointer"
                  >
                    <Plus size={12} />
                    <span>Add Step</span>
                  </button>
                </div>

                {/* Mode: Preview or Edit */}
                {previewResolved ? (
                  <div className="space-y-4">
                    <div className="p-4 rounded-2xl bg-blue-50/60 dark:bg-blue-950/30 border border-blue-200/60 dark:border-blue-900/40 flex items-start gap-3">
                      <Eye size={16} className="text-blue-600 mt-0.5 flex-shrink-0" />
                      <div>
                        <div className="text-xs font-bold text-blue-700 dark:text-blue-400 uppercase tracking-wider">
                          Live Preview (Step {activeStepIndex + 1})
                        </div>
                        <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                          Variables and Spintax resolved for sample contact <strong className="text-slate-900 dark:text-white">Emily</strong> at <strong className="text-slate-900 dark:text-white">Stark Industries</strong>.
                        </p>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-[#EBF0F5] dark:border-[#1E222D] bg-slate-50/40 dark:bg-[#161822]/40 p-5 space-y-4">
                      <div className="pb-3 border-b border-[#EBF0F5] dark:border-[#1E222D]">
                        <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">Subject Preview:</span>
                        <div className="text-sm font-semibold text-slate-900 dark:text-white mt-1">
                          {personalizePreview(editingTemplate.steps?.[activeStepIndex]?.subject || '')}
                        </div>
                      </div>
                      <div>
                        <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider block mb-2">Message Preview:</span>
                        {bodyPreview?.isHtml ? (
                          <iframe srcDoc={bodyPreview.body} title="Email Preview" sandbox="" className="w-full h-[480px] border border-[#EBF0F5] dark:border-[#1E222D] rounded-xl bg-white" />
                        ) : (
                          <div className="whitespace-pre-wrap text-xs text-slate-900 dark:text-white leading-relaxed">
                            {bodyPreview?.body}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <TextField fullWidth size="small" label="Template Title" value={editingTemplate.name} onChange={(e) => setEditingTemplate({ ...editingTemplate, name: e.target.value })} />
                      <TextField
                        fullWidth size="small" label="Category" placeholder="e.g. Cold Outreach"
                        value={editingTemplate.category}
                        onChange={(e) => setEditingTemplate({ ...editingTemplate, category: e.target.value })}
                        slotProps={{ htmlInput: { list: 'categories-list' } }}
                      />
                      <datalist id="categories-list">
                        {Array.from(new Set(templates.map(t => t.category))).map(cat => (<option key={cat} value={cat} />))}
                      </datalist>
                    </div>

                    {activeStepIndex > 0 && (
                      <TextField
                        size="small" label="Wait Days Before Sending This Follow-Up" type="number"
                        value={editingTemplate.steps?.[activeStepIndex]?.waitDays || 3}
                        onChange={(e) => updateStepField(activeStepIndex, 'waitDays', parseInt(e.target.value) || 1)}
                        slotProps={{ htmlInput: { min: 1 } }}
                      />
                    )}

                    <TextField
                      fullWidth size="small" label="Subject Line"
                      value={editingTemplate.steps?.[activeStepIndex]?.subject || ''}
                      onChange={(e) => updateStepField(activeStepIndex, 'subject', e.target.value)}
                      slotProps={{ input: { sx: { fontFamily: 'monospace' } } }}
                    />

                    <div className="bg-slate-50 dark:bg-[#161822] border border-[#EBF0F5] dark:border-[#1E222D] rounded-xl px-3 py-2">
                      <VariableToolbar
                        onInsert={(v) => updateStepField(activeStepIndex, 'body', (editingTemplate.steps?.[activeStepIndex]?.body || '') + ' ' + v)}
                        onInsertSubject={(v) => updateStepField(activeStepIndex, 'subject', (editingTemplate.steps?.[activeStepIndex]?.subject || '') + ' ' + v)}
                      />
                    </div>

                    <TextField
                      fullWidth multiline minRows={14} label="Email Body (HTML or Plain Text)"
                      placeholder="Write your email copy or paste HTML template code here..."
                      value={editingTemplate.steps?.[activeStepIndex]?.body || ''}
                      onChange={(e) => updateStepField(activeStepIndex, 'body', e.target.value)}
                      slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6 } } }}
                    />

                    <div className="flex items-center justify-between pt-2">
                      <button
                        type="button"
                        onClick={() => handleCopy(editingTemplate.id, editingTemplate.steps?.[activeStepIndex]?.body || '')}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-[#EBF0F5] dark:border-[#1E222D] text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#161822] transition-colors cursor-pointer"
                      >
                        {copiedId === editingTemplate.id ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                        <span>{copiedId === editingTemplate.id ? 'Copied' : 'Copy Code'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleSave}
                        disabled={saving}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer disabled:opacity-50"
                      >
                        {saving ? <CircularProgress size={14} color="inherit" /> : <ArrowRight size={14} />}
                        <span>Save Template</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : !loading && templates.length === 0 ? (
              <div className="p-12 rounded-[24px] border border-dashed border-[#EBF0F5] dark:border-[#1E222D] text-center">
                <FileText size={44} className="mx-auto text-slate-400 opacity-30 mb-3" />
                <h3 className="text-sm font-bold text-slate-900 dark:text-white tracking-tight">
                  Your Copy Library Is Empty
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto mt-1 mb-5">
                  Create a template to write a reusable email sequence. Campaigns can then fill their steps from it with Use Template.
                </p>
                <button
                  type="button"
                  onClick={createNewTemplate}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-blue-600 text-white text-xs font-semibold cursor-pointer"
                >
                  <Plus size={14} />
                  <span>Create Template</span>
                </button>
              </div>
            ) : (
              <div className="p-12 rounded-[24px] border border-dashed border-[#EBF0F5] dark:border-[#1E222D] text-center">
                <FileText size={44} className="mx-auto text-slate-400 opacity-30 mb-3" />
                <span className="text-sm font-semibold text-slate-500 dark:text-slate-400">
                  Select Template to Configure Copy
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Import HTML Files Dialog */}
      <Dialog open={importOpen} onClose={closeImport} maxWidth="sm" fullWidth slotProps={{ paper: { sx: { borderRadius: '24px' } } }}>
        <form onSubmit={(e) => { e.preventDefault(); runImport(); }}>
          <DialogTitle>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <Upload size={20} color="#2563EB" />
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Import HTML Files</Typography>
            </Stack>
          </DialogTitle>
          <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {importError && <Alert severity="error">{importError}</Alert>}

            {importRefused.length > 0 && (
              <Alert severity="warning">
                <AlertTitle>{importRefused.length === 1 ? '1 File Was Not Read' : `${importRefused.length} Files Were Not Read`}</AlertTitle>
                {importRefused.map((file, idx) => (
                  <Typography key={idx} variant="caption" sx={{ display: 'block' }}>{file.fileName}: {file.reason}</Typography>
                ))}
              </Alert>
            )}

            {importEmails.length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                None of the files picked can be imported. Pick .html or .htm files, one per email.
              </Typography>
            ) : (
              <>
                {importEmails.length > 1 && (
                  <Box>
                    <ToggleButtonGroup value={importMode} exclusive fullWidth size="small" disabled={importing} onChange={(_, v) => v && setImportMode(v)}>
                      <ToggleButton value="sequence" sx={{ fontWeight: 700 }}>One Template, {importEmails.length} Steps</ToggleButton>
                      <ToggleButton value="separate" sx={{ fontWeight: 700 }}>{importEmails.length} Separate Templates</ToggleButton>
                    </ToggleButtonGroup>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
                      {importMode === 'sequence'
                        ? 'The files become the steps of one template, in file-name order. Use Template on a campaign then fills every step at once.'
                        : 'Each file becomes its own single-step template, named after the file.'}
                    </Typography>
                  </Box>
                )}

                {importAsOne && (
                  <TextField
                    label="Template Name" required size="small" autoFocus
                    placeholder="e.g. Win-Back Emails"
                    value={importName} onChange={(e) => setImportName(e.target.value)} disabled={importing}
                  />
                )}
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <TextField
                    fullWidth size="small" label="Category" placeholder="e.g. Cold Outreach"
                    value={importCategory} onChange={(e) => setImportCategory(e.target.value)} disabled={importing}
                    slotProps={{ htmlInput: { list: 'import-categories-list' } }}
                  />
                  <datalist id="import-categories-list">
                    {Array.from(new Set(templates.map(t => t.category))).map(cat => (<option key={cat} value={cat} />))}
                  </datalist>
                  {importAsOne && importEmails.length > 1 && (
                    <TextField
                      fullWidth size="small" type="number" label="Days Between Steps"
                      value={importWait} onChange={(e) => setImportWait(e.target.value)}
                      onBlur={() => setImportWait(String(importWaitDays(importWait)))} disabled={importing}
                      slotProps={{ htmlInput: { min: 1 } }}
                    />
                  )}
                </Stack>
                {importAsOne && importEmails.length > 1 && (
                  <Typography variant="caption" sx={{ color: 'text.secondary', mt: -1 }}>
                    Step 1 is sent on enrollment. Each later step waits this many days after the one before it; any step&apos;s wait can be changed after the import.
                  </Typography>
                )}

                <Box sx={{ maxHeight: 280, overflowY: 'auto', border: 1, borderColor: 'divider', borderRadius: '12px' }}>
                  {importEmails.map((email, idx) => (
                    <Stack key={`${idx}-${email.fileName}`} direction="row" spacing={1.5} sx={{ alignItems: 'flex-start', px: 1.5, py: 1.25, borderTop: idx === 0 ? 0 : 1, borderColor: 'divider' }}>
                      {importAsOne && importEmails.length > 1 && (
                        <Chip size="small" label={`Step ${idx + 1}`} sx={{ height: 20, fontSize: 10, fontWeight: 700, flexShrink: 0, mt: 0.25 }} />
                      )}
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap title={email.subject}>{email.subject}</Typography>
                        <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', display: 'block' }} noWrap title={email.fileName}>{email.fileName}</Typography>
                        {!email.subjectFromTitle && (
                          <Typography variant="caption" sx={{ color: 'warning.main', display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25 }}>
                            <AlertTriangle size={12} style={{ flexShrink: 0 }} /> No &lt;title&gt; in the file, so the file name is used as the subject.
                          </Typography>
                        )}
                        {email.hasUnreadableText && (
                          <Typography variant="caption" sx={{ color: 'warning.main', display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25 }}>
                            <AlertTriangle size={12} style={{ flexShrink: 0 }} /> Some characters could not be read and would be sent as {'\uFFFD'}. Save the file as UTF-8 and import it again.
                          </Typography>
                        )}
                      </Box>
                    </Stack>
                  ))}
                </Box>
                <Typography variant="caption" sx={{ color: 'text.secondary', mt: -1 }}>
                  Each subject is its file&apos;s &lt;title&gt;. The whole file becomes the email body, unchanged.
                </Typography>

                {importNameClashes.length > 0 && (
                  <Alert severity="info">
                    {importNameClashes.length === 1
                      ? `A template named "${importNameClashes[0]}" is already in the library.`
                      : `${importNameClashes.length} of these names are already in the library.`}{' '}
                    The import adds new templates and leaves the existing ones as they are.
                  </Alert>
                )}
              </>
            )}
          </DialogContent>
          <DialogActions sx={{ p: 2 }}>
            <Button color="inherit" onClick={closeImport} disabled={importing}>{importEmails.length === 0 ? 'Close' : 'Cancel'}</Button>
            {importEmails.length > 0 && (
              <Button
                type="submit" variant="contained"
                startIcon={importing ? <CircularProgress size={16} color="inherit" /> : <Upload size={16} />}
                disabled={importing || (importAsOne && !importName.trim())}
              >
                {importAsOne ? 'Import Template' : `Import ${importEmails.length} Templates`}
              </Button>
            )}
          </DialogActions>
        </form>
      </Dialog>

      <ConfirmDialog
        isOpen={!!confirmState}
        title={confirmState?.title || ''}
        message={confirmState?.message || ''}
        confirmLabel={confirmState?.confirmLabel}
        isDestructive
        onConfirm={() => confirmState?.onConfirm()}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
}

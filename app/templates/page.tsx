/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable react-hooks/exhaustive-deps */
'use client';

import { useState, useEffect, useRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import {
  FileText, Plus, Eye, PenLine, Copy, Check, Trash2, Upload, AlertTriangle, RefreshCw, Loader2, X,
} from 'lucide-react';
import VariableToolbar from '@/components/VariableToolbar';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { personalizePreview, previewEmailBody } from '@/lib/personalize';
import { loadErrorMessage, readJsonList } from '@/lib/apiResponse';
import {
  readEmailFile, importRefusal, sortImportedEmails, importWaitDays, sequenceTemplate, separateTemplates,
  DEFAULT_IMPORT_WAIT_DAYS, type ImportedEmail, type ImportedTemplate,
} from '@/lib/templateImport';
import { Snackbar, Alert, Tooltip as MuiTooltip, Dialog } from '@mui/material';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { inputClasses, SearchInput } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Segmented } from '@/components/ui/Segmented';
import { cn } from '@/lib/utils';

const LABEL = 'mb-1.5 block text-[13px] font-medium text-text-main';
const CAPTION = 'text-xs text-text-sub';
const WARN_LINE = 'mt-0.5 flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400';
const WARN_BOX = 'rounded-control border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-500/10 dark:text-amber-300';
const ERROR_BOX = 'rounded-control border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-900/50 dark:bg-rose-500/10 dark:text-rose-300';
const INFO_BOX = 'rounded-control bg-primary-subtle p-3 text-xs text-text-main';
const EMPTY_BOX = 'rounded-card border border-dashed border-card-border text-center';

/** A labelled native text field, the label above it. */
function TextInput({ label, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className={LABEL}>
        {label}{props.required && <span className="text-rose-500"> *</span>}
      </label>
      <input id={id} className={inputClasses('h-9 disabled:cursor-not-allowed disabled:opacity-60')} {...props} />
    </div>
  );
}

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
  const categoryOptions = categories.map(cat => ({ value: cat, label: cat }));
  const knownCategories = Array.from(new Set(templates.map(t => t.category)));

  return (
    <div className="w-full space-y-5 pb-12">
      <Snackbar open={!!toastMessage} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} autoHideDuration={3000} onClose={() => setToastMessage('')}>
        {toastMessage ? <Alert severity="info" variant="filled" sx={{ borderRadius: '12px' }}>{toastMessage}</Alert> : undefined}
      </Snackbar>

      <PageHeader
        title="Copy Library"
        actions={
          <>
            <input ref={fileInputRef} type="file" accept=".html,.htm,text/html" multiple hidden onChange={handleImportFiles} />
            <Button onClick={() => fileInputRef.current?.click()} disabled={!!loadError}>
              <Upload size={14} /> Import HTML
            </Button>
            <Button variant="primary" onClick={createNewTemplate} disabled={!!loadError}>
              <Plus size={14} /> Create Template
            </Button>
          </>
        }
      />

      {loadError ? (
        <Notice
          tone="error"
          title="Templates Could Not Be Loaded"
          action={<Button size="sm" onClick={() => fetchTemplates()}><RefreshCw size={12} /> Retry</Button>}
        >
          {loadError}
        </Notice>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          {/* Left column: the template library */}
          <div className="space-y-3">
            <SearchInput
              aria-label="Search templates"
              placeholder="Search templates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />

            <Segmented label="Template categories" options={categoryOptions} value={selectedCategory} onChange={setSelectedCategory} className="flex flex-wrap" />

            <div className="max-h-[580px] space-y-2 overflow-y-auto pr-1">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-12 text-xs text-text-muted">
                  <Loader2 size={14} className="animate-spin" /> Retrieving templates…
                </div>
              ) : filteredTemplates.length === 0 ? (
                <div className={cn(EMPTY_BOX, 'p-8 text-xs text-text-muted')}>
                  {templates.length === 0 ? 'No templates yet' : 'No templates match this search or category'}
                </div>
              ) : (
                filteredTemplates.map(t => {
                  const isSelected = editingTemplate?.id === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => selectTemplate(t)}
                      className={cn(
                        'block w-full cursor-pointer rounded-card border p-3.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none',
                        isSelected
                          ? 'border-primary bg-primary-subtle'
                          : 'border-card-border bg-card hover:border-input-border hover:bg-slate-50 dark:hover:bg-white/[0.02]',
                      )}
                    >
                      <span className="mb-1 flex items-start justify-between gap-2">
                        <span className="truncate text-[13px] font-semibold text-text-main">{t.name}</span>
                        <span className="flex shrink-0 items-center gap-1">
                          {t.steps && Array.isArray(t.steps) && t.steps.length > 1 && <Badge>{t.steps.length} Steps</Badge>}
                          <Badge tone="blue">{t.category}</Badge>
                        </span>
                      </span>
                      <span className="mb-1 block truncate text-xs text-text-sub">{t.steps?.[0]?.subject || t.subject}</span>
                      <span className="line-clamp-2 text-xs leading-relaxed text-text-muted">{t.steps?.[0]?.body || t.body}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Right column: the template editor or its preview */}
          <div className="lg:col-span-2">
            {editingTemplate ? (
              <Card className="space-y-4 p-5">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="min-w-0 truncate text-sm font-semibold text-text-main">Edit: {editingTemplate.name}</h2>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button size="sm" aria-pressed={previewResolved} onClick={() => setPreviewResolved(!previewResolved)}>
                      {previewResolved ? <><PenLine size={12} /> Edit Mode</> : <><Eye size={12} /> Preview</>}
                    </Button>
                    <MuiTooltip title="Delete Template">
                      <Button
                        variant="ghost" size="sm" iconOnly aria-label="Delete template"
                        onClick={() => deleteTemplate(editingTemplate.id)}
                        className="hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
                      >
                        <Trash2 size={14} />
                      </Button>
                    </MuiTooltip>
                  </div>
                </div>

                {/* Sequence steps */}
                <div className="flex flex-wrap items-center gap-1.5 border-y border-card-border py-3">
                  <span className="mr-1 text-xs text-text-sub">Sequence Steps</span>
                  {editingTemplate.steps?.map((step: any, idx: number) => {
                    const active = activeStepIndex === idx;
                    return (
                      <span
                        key={step.id || idx}
                        className={cn(
                          'inline-flex h-7 items-center rounded-control border text-xs font-medium transition-colors',
                          active ? 'border-primary bg-primary-subtle text-primary' : 'border-input-border bg-card text-text-sub hover:text-text-main',
                        )}
                      >
                        <button
                          type="button"
                          aria-pressed={active}
                          onClick={() => setActiveStepIndex(idx)}
                          className={cn('h-full cursor-pointer px-2.5', editingTemplate.steps.length > 1 && 'pr-1.5')}
                        >
                          Step {idx + 1}{idx > 0 && <span className="font-normal opacity-70"> (+{step.waitDays}d)</span>}
                        </button>
                        {editingTemplate.steps.length > 1 && (
                          <button
                            type="button"
                            aria-label={`Remove step ${idx + 1}`}
                            onClick={() => removeStep(idx)}
                            className="mr-1 flex size-5 cursor-pointer items-center justify-center rounded opacity-60 hover:bg-rose-50 hover:text-rose-600 hover:opacity-100 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
                          >
                            <X size={12} />
                          </button>
                        )}
                      </span>
                    );
                  })}
                  <Button variant="ghost" size="sm" onClick={addStep}>
                    <Plus size={12} /> Add Step
                  </Button>
                </div>

                {previewResolved ? (
                  <div className="space-y-3">
                    <div className={INFO_BOX}>
                      <div className="font-medium">Live Preview (Step {activeStepIndex + 1})</div>
                      <p className="mt-0.5 text-text-sub">
                        Variables and Spintax resolved for sample contact <strong className="font-medium text-text-main">Emily</strong> at <strong className="font-medium text-text-main">Stark Industries</strong>.
                      </p>
                    </div>

                    <div className="rounded-control border border-card-border">
                      <div className="border-b border-card-border px-4 py-3">
                        <div className="text-[11px] text-text-muted">Subject Preview</div>
                        <p className="mt-0.5 text-[13px] font-medium text-text-main">
                          {personalizePreview(editingTemplate.steps?.[activeStepIndex]?.subject || '')}
                        </p>
                      </div>
                      <div className="px-4 py-3">
                        <div className="mb-1.5 text-[11px] text-text-muted">Message Preview</div>
                        {bodyPreview?.isHtml ? (
                          <iframe srcDoc={bodyPreview.body} title="Email Preview" sandbox="" className="h-[480px] w-full rounded-control border border-card-border bg-white" />
                        ) : (
                          <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-text-main">{bodyPreview?.body}</p>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3.5">
                    <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
                      <TextInput label="Template Title" value={editingTemplate.name} onChange={(e) => setEditingTemplate({ ...editingTemplate, name: e.target.value })} />
                      <TextInput
                        label="Category" placeholder="e.g. Cold Outreach" list="categories-list"
                        value={editingTemplate.category}
                        onChange={(e) => setEditingTemplate({ ...editingTemplate, category: e.target.value })}
                      />
                      <datalist id="categories-list">
                        {knownCategories.map(cat => (<option key={cat} value={cat} />))}
                      </datalist>
                    </div>

                    {activeStepIndex > 0 && (
                      <TextInput
                        label="Wait Days Before Sending This Follow-Up" type="number" min={1} className="sm:max-w-xs"
                        value={editingTemplate.steps?.[activeStepIndex]?.waitDays || 3}
                        onChange={(e) => updateStepField(activeStepIndex, 'waitDays', parseInt(e.target.value) || 1)}
                      />
                    )}

                    <TextInput
                      label="Subject Line"
                      value={editingTemplate.steps?.[activeStepIndex]?.subject || ''}
                      onChange={(e) => updateStepField(activeStepIndex, 'subject', e.target.value)}
                    />

                    <div>
                      <label htmlFor="template-body" className={LABEL}>Email Body (HTML or Plain Text)</label>
                      <div className="overflow-hidden rounded-control border border-input-border bg-card focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
                        <div className="border-b border-card-border bg-slate-50/70 px-3 py-2 dark:bg-white/[0.02]">
                          <VariableToolbar
                            onInsert={(v) => updateStepField(activeStepIndex, 'body', (editingTemplate.steps?.[activeStepIndex]?.body || '') + ' ' + v)}
                            onInsertSubject={(v) => updateStepField(activeStepIndex, 'subject', (editingTemplate.steps?.[activeStepIndex]?.subject || '') + ' ' + v)}
                          />
                        </div>
                        <textarea
                          id="template-body"
                          rows={16}
                          placeholder="Write your email copy or paste HTML template code here..."
                          value={editingTemplate.steps?.[activeStepIndex]?.body || ''}
                          onChange={(e) => updateStepField(activeStepIndex, 'body', e.target.value)}
                          className="block w-full resize-y bg-transparent px-3 py-2.5 font-mono text-xs leading-relaxed text-text-main placeholder:text-text-muted focus:outline-none"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 pt-1">
                      <Button onClick={() => handleCopy(editingTemplate.id, editingTemplate.steps?.[activeStepIndex]?.body || '')}>
                        {copiedId === editingTemplate.id ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                        {copiedId === editingTemplate.id ? 'Copied' : 'Copy Code'}
                      </Button>
                      <Button variant="primary" onClick={handleSave} disabled={saving}>
                        {saving && <Loader2 size={14} className="animate-spin" />}
                        Save Template
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            ) : !loading && templates.length === 0 ? (
              <div className={cn(EMPTY_BOX, 'p-12')}>
                <FileText size={28} className="mx-auto mb-3 text-text-muted" />
                <h3 className="text-sm font-semibold text-text-main">Your Copy Library Is Empty</h3>
                <p className="mx-auto mt-1 mb-5 max-w-sm text-xs text-text-sub">
                  Create a template to write a reusable email sequence. Campaigns can then fill their steps from it with Use Template.
                </p>
                <Button variant="primary" onClick={createNewTemplate} className="mx-auto">
                  <Plus size={14} /> Create Template
                </Button>
              </div>
            ) : (
              <div className={cn(EMPTY_BOX, 'p-12 text-[13px] text-text-muted')}>
                Select Template to Configure Copy
              </div>
            )}
          </div>
        </div>
      )}

      {/* Import HTML files dialog */}
      <Dialog open={importOpen} onClose={closeImport} maxWidth="sm" fullWidth slotProps={{ paper: { sx: { borderRadius: '12px', backgroundImage: 'none' } } }}>
        <form onSubmit={(e) => { e.preventDefault(); runImport(); }}>
          <h2 className="px-5 pt-5 pb-4 text-[15px] font-semibold text-text-main">Import HTML Files</h2>
          <div className="space-y-4 border-y border-card-border px-5 py-4">
            {importError && <div role="alert" className={ERROR_BOX}>{importError}</div>}

            {importRefused.length > 0 && (
              <div className={WARN_BOX}>
                <div className="mb-1 font-semibold">{importRefused.length === 1 ? '1 File Was Not Read' : `${importRefused.length} Files Were Not Read`}</div>
                {importRefused.map((file, idx) => (
                  <div key={idx}>{file.fileName}: {file.reason}</div>
                ))}
              </div>
            )}

            {importEmails.length === 0 ? (
              <p className="text-[13px] text-text-sub">
                None of the files picked can be imported. Pick .html or .htm files, one per email.
              </p>
            ) : (
              <>
                {importEmails.length > 1 && (
                  <fieldset disabled={importing} className="min-w-0">
                    <Segmented
                      label="Import as"
                      value={importMode}
                      onChange={setImportMode}
                      options={[
                        { value: 'sequence', label: `One Template, ${importEmails.length} Steps` },
                        { value: 'separate', label: `${importEmails.length} Separate Templates` },
                      ]}
                    />
                    <p className={cn(CAPTION, 'mt-1.5')}>
                      {importMode === 'sequence'
                        ? 'The files become the steps of one template, in file-name order. Use Template on a campaign then fills every step at once.'
                        : 'Each file becomes its own single-step template, named after the file.'}
                    </p>
                  </fieldset>
                )}

                {importAsOne && (
                  <TextInput
                    label="Template Name" required autoFocus
                    placeholder="e.g. Win-Back Emails"
                    value={importName} onChange={(e) => setImportName(e.target.value)} disabled={importing}
                  />
                )}
                <div className="flex flex-col gap-3.5 sm:flex-row">
                  <TextInput
                    label="Category" placeholder="e.g. Cold Outreach" list="import-categories-list" className="flex-1"
                    value={importCategory} onChange={(e) => setImportCategory(e.target.value)} disabled={importing}
                  />
                  <datalist id="import-categories-list">
                    {knownCategories.map(cat => (<option key={cat} value={cat} />))}
                  </datalist>
                  {importAsOne && importEmails.length > 1 && (
                    <TextInput
                      label="Days Between Steps" type="number" min={1} className="flex-1"
                      value={importWait} onChange={(e) => setImportWait(e.target.value)}
                      onBlur={() => setImportWait(String(importWaitDays(importWait)))} disabled={importing}
                    />
                  )}
                </div>
                {importAsOne && importEmails.length > 1 && (
                  <p className={cn(CAPTION, '-mt-2')}>
                    Step 1 is sent on enrollment. Each later step waits this many days after the one before it; any step&apos;s wait can be changed after the import.
                  </p>
                )}

                <div>
                  <div className="max-h-[280px] divide-y divide-card-border overflow-y-auto rounded-control border border-card-border">
                    {importEmails.map((email, idx) => (
                      <div key={`${idx}-${email.fileName}`} className="flex items-start gap-2.5 px-3 py-2.5">
                        {importAsOne && importEmails.length > 1 && <Badge className="mt-0.5">Step {idx + 1}</Badge>}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium text-text-main" title={email.subject}>{email.subject}</div>
                          <div className="truncate text-[11px] text-text-muted" title={email.fileName}>{email.fileName}</div>
                          {!email.subjectFromTitle && (
                            <div className={WARN_LINE}>
                              <AlertTriangle size={12} className="shrink-0" /> No &lt;title&gt; in the file, so the file name is used as the subject.
                            </div>
                          )}
                          {email.hasUnreadableText && (
                            <div className={WARN_LINE}>
                              <AlertTriangle size={12} className="shrink-0" /> Some characters could not be read and would be sent as {'�'}. Save the file as UTF-8 and import it again.
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className={cn(CAPTION, 'mt-1.5')}>
                    Each subject is its file&apos;s &lt;title&gt;. The whole file becomes the email body, unchanged.
                  </p>
                </div>

                {importNameClashes.length > 0 && (
                  <div role="status" className={INFO_BOX}>
                    {importNameClashes.length === 1
                      ? `A template named "${importNameClashes[0]}" is already in the library.`
                      : `${importNameClashes.length} of these names are already in the library.`}{' '}
                    The import adds new templates and leaves the existing ones as they are.
                  </div>
                )}
              </>
            )}
          </div>
          <div className="flex justify-end gap-2 px-5 py-4">
            <Button variant="ghost" onClick={closeImport} disabled={importing}>{importEmails.length === 0 ? 'Close' : 'Cancel'}</Button>
            {importEmails.length > 0 && (
              <Button type="submit" variant="primary" disabled={importing || (importAsOne && !importName.trim())}>
                {importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {importAsOne ? 'Import Template' : `Import ${importEmails.length} Templates`}
              </Button>
            )}
          </div>
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

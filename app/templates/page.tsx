/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import { useState, useEffect } from 'react';
import { FileText, Search, Plus, Eye, Sparkles, Copy, Check, Trash2, ArrowRight, X, RefreshCw } from 'lucide-react';
import VariableToolbar from '@/components/VariableToolbar';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { personalizePreview, previewEmailBody } from '@/lib/personalize';
import { loadErrorMessage, readJsonList } from '@/lib/apiResponse';
import {
  Box, Card, CardContent, Stack, Typography, Button, IconButton, Chip, TextField,
  ToggleButtonGroup, ToggleButton, Snackbar, Alert, AlertTitle, InputAdornment, CircularProgress,
  Tooltip as MuiTooltip,
} from '@mui/material';
import { alpha } from '@mui/material/styles';

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed load shows an error with Retry, never the empty library.
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [editingTemplate, setEditingTemplate] = useState<any>(null);
  const [activeStepIndex, setActiveStepIndex] = useState<number>(0);
  const [copiedId, setCopiedId] = useState<any>(null);
  const [previewResolved, setPreviewResolved] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [confirmState, setConfirmState] = useState<{ title: string; message: string; confirmLabel: string; onConfirm: () => void } | null>(null);

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
    if (!editingTemplate) return;
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
    }
  };

  const deleteTemplate = (id: any) => {
    setConfirmState({
      title: 'Delete template?',
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

  const bodyPreview = previewResolved && editingTemplate ? previewEmailBody(editingTemplate.steps?.[activeStepIndex]?.body || '') : null;

  return (
    <Box sx={{ maxWidth: 1280, mx: 'auto', pb: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Snackbar open={!!toastMessage} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} autoHideDuration={3000} onClose={() => setToastMessage('')}>
        {toastMessage ? <Alert severity="info" variant="filled" sx={{ borderRadius: '12px' }}>{toastMessage}</Alert> : undefined}
      </Snackbar>

      {/* Header */}
      <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', sm: 'center' }, gap: 2, pb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>Copy Library</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>Write and manage reusable email templates with personalization variables and Spintax.</Typography>
        </Box>
        <Button variant="contained" startIcon={<Plus size={16} />} onClick={createNewTemplate} disabled={!!loadError}>Create Template</Button>
      </Stack>

      {loadError ? (
        <Alert
          severity="error"
          action={<Button color="inherit" size="small" startIcon={<RefreshCw size={14} />} onClick={() => fetchTemplates()}>Retry</Button>}
        >
          <AlertTitle>Templates Could Not Be Loaded</AlertTitle>
          {loadError}
        </Alert>
      ) : (
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 2fr' }, gap: 3 }}>
        {/* Left: list */}
        <Stack spacing={2}>
          <TextField
            fullWidth
            size="small"
            placeholder="Search templates..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            slotProps={{ input: { startAdornment: <InputAdornment position="start"><Search size={16} /></InputAdornment> } }}
          />

          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, p: 0.75, borderRadius: '12px', bgcolor: 'action.hover', border: 1, borderColor: 'divider' }}>
            {categories.map(cat => (
              <Button
                key={cat}
                size="small"
                onClick={() => setSelectedCategory(cat)}
                variant={selectedCategory === cat ? 'contained' : 'text'}
                sx={{ minHeight: 28, py: 0.5, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: selectedCategory === cat ? undefined : 'text.secondary' }}
              >
                {cat}
              </Button>
            ))}
          </Stack>

          <Box sx={{ maxHeight: 540, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
            {loading ? (
              <Stack sx={{ alignItems: 'center', py: 6, gap: 1.5 }}>
                <CircularProgress size={24} />
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Retrieving templates…</Typography>
              </Stack>
            ) : filteredTemplates.length === 0 ? (
              <Card sx={{ borderStyle: 'dashed', textAlign: 'center', py: 5 }}>
                <FileText size={24} style={{ margin: '0 auto', opacity: 0.5 }} />
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
                  {templates.length === 0 ? 'No templates yet' : 'No templates match this search or category'}
                </Typography>
              </Card>
            ) : (
              filteredTemplates.map(t => {
                const isSelected = editingTemplate?.id === t.id;
                return (
                  <Card
                    key={t.id}
                    onClick={() => selectTemplate(t)}
                    sx={{
                      cursor: 'pointer',
                      borderColor: isSelected ? 'primary.main' : 'divider',
                      bgcolor: isSelected ? (theme) => alpha(theme.palette.primary.main, 0.08) : 'background.paper',
                      transition: 'border-color .15s, background-color .15s',
                      '&:hover': { borderColor: isSelected ? 'primary.main' : 'text.disabled' },
                    }}
                  >
                    <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start', mb: 0.5, gap: 1 }}>
                        <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>{t.name}</Typography>
                        <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
                          {t.steps && Array.isArray(t.steps) && t.steps.length > 1 && (
                            <Chip size="small" label={`${t.steps.length} steps`} sx={{ height: 18, fontSize: 9, fontWeight: 700, fontFamily: 'monospace' }} />
                          )}
                          <Chip size="small" label={t.category} color="primary" variant="outlined" sx={{ height: 18, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }} />
                        </Stack>
                      </Stack>
                      <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', display: 'block', mb: 1 }} noWrap>{t.steps?.[0]?.subject || t.subject}</Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {t.steps?.[0]?.body || t.body}
                      </Typography>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </Box>
        </Stack>

        {/* Right: editor */}
        <Box>
          {editingTemplate ? (
            <Card>
              <CardContent sx={{ p: 3 }}>
                {/* Header row */}
                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', pb: 2, mb: 2.5, borderBottom: 1, borderColor: 'divider' }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <FileText size={16} color="#2563EB" />
                    <Typography variant="overline" sx={{ fontWeight: 700, letterSpacing: '0.1em' }}>Edit: {editingTemplate.name}</Typography>
                  </Stack>
                  <Stack direction="row" spacing={1}>
                    <Button
                      size="small"
                      variant={previewResolved ? 'contained' : 'outlined'}
                      color={previewResolved ? 'primary' : 'inherit'}
                      startIcon={<Eye size={14} />}
                      onClick={() => setPreviewResolved(!previewResolved)}
                      sx={{ borderColor: previewResolved ? undefined : 'divider', color: previewResolved ? undefined : 'text.secondary' }}
                    >
                      {previewResolved ? 'Edit Mode' : 'Preview'}
                    </Button>
                    <MuiTooltip title="Delete template">
                      <IconButton aria-label="Delete template" size="small" onClick={() => deleteTemplate(editingTemplate.id)} sx={{ border: 1, borderColor: (t) => alpha(t.palette.error.main, 0.3), color: 'error.main' }}>
                        <Trash2 size={14} />
                      </IconButton>
                    </MuiTooltip>
                  </Stack>
                </Stack>

                {/* Step tabs */}
                <Stack direction="row" sx={{ flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 2.5, pb: 2, borderBottom: 1, borderColor: 'divider' }}>
                  <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', letterSpacing: '0.06em', textTransform: 'uppercase', mr: 1 }}>Sequence steps:</Typography>
                  {editingTemplate.steps?.map((step: any, idx: number) => (
                    <Chip
                      key={step.id || idx}
                      label={`Step ${idx + 1}${idx > 0 ? ` (+${step.waitDays}d)` : ''}`}
                      onClick={() => setActiveStepIndex(idx)}
                      onDelete={editingTemplate.steps.length > 1 ? () => removeStep(idx) : undefined}
                      color={activeStepIndex === idx ? 'primary' : 'default'}
                      variant={activeStepIndex === idx ? 'filled' : 'outlined'}
                      sx={{ fontWeight: 700, fontSize: 10 }}
                    />
                  ))}
                  <Button size="small" variant="outlined" color="inherit" startIcon={<Plus size={12} />} onClick={addStep} sx={{ borderStyle: 'dashed', color: 'text.secondary', borderColor: 'divider' }}>
                    Add Step
                  </Button>
                </Stack>

                {previewResolved ? (
                  <Stack spacing={2}>
                    <Card sx={{ bgcolor: (t) => alpha(t.palette.primary.main, 0.06), borderColor: (t) => alpha(t.palette.primary.main, 0.2) }}>
                      <CardContent sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
                        <Sparkles size={16} color="#2563EB" style={{ marginTop: 2, flexShrink: 0 }} />
                        <Box>
                          <Typography variant="overline" sx={{ color: 'primary.main', fontWeight: 700 }}>Live Preview (Step {activeStepIndex + 1})</Typography>
                          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
                            Variables and Spintax resolved for sample contact <strong style={{ color: 'inherit' }}>Emily</strong> at <strong style={{ color: 'inherit' }}>Stark Industries</strong>.
                          </Typography>
                        </Box>
                      </CardContent>
                    </Card>
                    <Card sx={{ bgcolor: 'action.hover' }}>
                      <CardContent>
                        <Box sx={{ pb: 1.5, borderBottom: 1, borderColor: 'divider', mb: 1.5 }}>
                          <Typography variant="overline" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>Subject Preview:</Typography>
                          <Typography variant="body2" sx={{ fontWeight: 600, mt: 0.5 }}>{personalizePreview(editingTemplate.steps?.[activeStepIndex]?.subject || '')}</Typography>
                        </Box>
                        <Typography variant="overline" sx={{ color: 'text.secondary', fontFamily: 'monospace', display: 'block', mb: 1 }}>Message Preview:</Typography>
                        {bodyPreview?.isHtml ? (
                          <Box component="iframe" srcDoc={bodyPreview.body} title="Email Preview" sandbox="" sx={{ width: '100%', height: 500, border: 1, borderColor: 'divider', borderRadius: '12px', bgcolor: '#fff' }} />
                        ) : (
                          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, color: 'text.primary' }}>
                            {bodyPreview?.body}
                          </Typography>
                        )}
                      </CardContent>
                    </Card>
                  </Stack>
                ) : (
                  <Stack spacing={2}>
                    <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
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
                    </Stack>

                    {activeStepIndex > 0 && (
                      <TextField
                        size="small" label="Wait days before sending this follow-up" type="number"
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

                    <Box sx={{ bgcolor: 'action.hover', border: 1, borderColor: 'divider', borderRadius: '12px', px: 1.5, py: 1 }}>
                      <VariableToolbar
                        onInsert={(v) => updateStepField(activeStepIndex, 'body', (editingTemplate.steps?.[activeStepIndex]?.body || '') + ' ' + v)}
                        onInsertSubject={(v) => updateStepField(activeStepIndex, 'subject', (editingTemplate.steps?.[activeStepIndex]?.subject || '') + ' ' + v)}
                      />
                    </Box>

                    <TextField
                      fullWidth multiline minRows={16} label="Email Body (HTML or plain text)"
                      placeholder="Write your email copy or paste HTML template code here..."
                      value={editingTemplate.steps?.[activeStepIndex]?.body || ''}
                      onChange={(e) => updateStepField(activeStepIndex, 'body', e.target.value)}
                      slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6 } } }}
                    />

                    <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', pt: 1 }}>
                      <Button
                        size="small" variant="outlined" color="inherit"
                        startIcon={copiedId === editingTemplate.id ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
                        onClick={() => handleCopy(editingTemplate.id, editingTemplate.steps?.[activeStepIndex]?.body || '')}
                        sx={{ borderColor: 'divider', color: 'text.secondary' }}
                      >
                        {copiedId === editingTemplate.id ? 'Copied' : 'Copy Code'}
                      </Button>
                      <Button variant="contained" endIcon={<ArrowRight size={16} />} onClick={handleSave}>Save Template</Button>
                    </Stack>
                  </Stack>
                )}
              </CardContent>
            </Card>
          ) : !loading && templates.length === 0 ? (
            <Card sx={{ borderStyle: 'dashed', textAlign: 'center', py: 8, px: 3 }}>
              <FileText size={40} style={{ margin: '0 auto', opacity: 0.4 }} />
              <Typography variant="overline" sx={{ color: 'text.secondary', display: 'block', mt: 1.5 }}>Your Copy Library Is Empty</Typography>
              <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 420, mx: 'auto', mt: 0.5 }}>
                Create a template to write a reusable email sequence. Campaigns can then fill their steps from it with Use Template.
              </Typography>
              <Button variant="contained" startIcon={<Plus size={16} />} onClick={createNewTemplate} sx={{ mt: 2.5 }}>Create Template</Button>
            </Card>
          ) : (
            <Card sx={{ borderStyle: 'dashed', textAlign: 'center', py: 8 }}>
              <FileText size={40} style={{ margin: '0 auto', opacity: 0.4 }} />
              <Typography variant="overline" sx={{ color: 'text.secondary', display: 'block', mt: 1.5 }}>Select template to configure copy</Typography>
            </Card>
          )}
        </Box>
      </Box>
      )}

      <ConfirmDialog
        isOpen={!!confirmState}
        title={confirmState?.title || ''}
        message={confirmState?.message || ''}
        confirmLabel={confirmState?.confirmLabel}
        isDestructive
        onConfirm={() => confirmState?.onConfirm()}
        onCancel={() => setConfirmState(null)}
      />
    </Box>
  );
}

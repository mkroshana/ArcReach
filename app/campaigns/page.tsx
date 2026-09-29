/* eslint-disable react-hooks/set-state-in-effect, react/no-unescaped-entities, react-hooks/exhaustive-deps */
'use client';

import { useState, useEffect, Fragment } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Plus, PlayCircle, Search, Layers, Filter, FileSpreadsheet, RefreshCw,
  Mail, User, ChevronRight, ChevronDown, Sparkles, Inbox, Trash2, Play, Pause, Send, Check,
} from 'lucide-react';
import {
  Box, Card, CardContent, Stack, Typography, Button, IconButton, Chip, TextField,
  Dialog, DialogTitle, DialogContent, DialogActions, Table, TableHead, TableBody, TableRow, TableCell,
  Snackbar, Alert, InputAdornment, CircularProgress, Tooltip as MuiTooltip, Select, MenuItem,
  Checkbox, FormControlLabel,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { queuedLeadsMessage } from '@/lib/campaignSteps';

interface DbCampaign {
  id: string;
  name: string;
  status: 'Active' | 'Draft' | 'Paused';
  senderAccountId: string;
  senderAccount?: { emailAddress: string };
  userId: string | null;
  user?: { id: string; name: string | null; email: string } | null;
  createdAt: string;
  steps?: { id: string; stepOrder: number; waitDays: number; subject: string; body: string }[];
  // Server-side aggregates — raw enrollment/dispatch rows are never shipped
  // (payloads at scale OOM'd the server).
  stepStats?: { stepOrder: number; active: number; sent: number; delivered: number; failed: number }[];
  enrollmentSummary?: { total: number; active: number; completed: number };
}

const statusColorMap = { Active: 'success', Draft: 'default', Paused: 'warning' } as const;

export default function CampaignsPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<DbCampaign[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [expandedCampaignId, setExpandedCampaignId] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [campaignName, setCampaignName] = useState('');
  const [selectedMailboxId, setSelectedMailboxId] = useState('');
  const [selectedPoolIds, setSelectedPoolIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [confirmState, setConfirmState] = useState<{ title: string; message: string; confirmLabel: string; onConfirm: () => void } | null>(null);
  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3050);
  };

  const handleToggleStatus = async (id: string, currentStatus: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newStatus = currentStatus === 'Active' ? 'Paused' : 'Active';
    try {
      const res = await fetch('/api/campaigns', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: newStatus }),
      });
      if (res.ok) { showToast(`Sequence status updated to ${newStatus}`); loadData(); }
      else {
        const data = await res.json().catch(() => null);
        showToast(data?.error || 'Failed to update status.', 'error');
      }
    } catch { showToast('Error updating status.', 'error'); }
  };

  const handleRunCampaign = async (id: string, stepOrder?: number) => {
    const key = id + (stepOrder ? `-${stepOrder}` : '');
    try {
      setExecutingId(key);
      const url = `/api/campaigns/${id}/run` + (stepOrder ? `?stepOrder=${stepOrder}` : '');
      const res = await fetch(url, { method: 'POST' });
      const data = await res.json().catch(() => null);
      // The route only queues leads; the background worker sends them.
      if (res.ok && typeof data?.queued === 'number') { showToast(queuedLeadsMessage(data.queued, stepOrder)); loadData(); }
      else showToast(data?.error || 'Failed to queue leads.', 'error');
    } catch { showToast('Failed to queue leads.', 'error'); }
    finally { setExecutingId(null); }
  };

  const loadData = async () => {
    try {
      setLoading(true);
      const sessRes = await fetch('/api/session');
      const sessData = await sessRes.json();
      setSession(sessData);
      const accRes = await fetch('/api/accounts');
      if (accRes.ok) {
        const accData = await accRes.json();
        setAccounts(accData);
        if (accData.length > 0) setSelectedMailboxId(accData[0].id);
      }
      const cmpRes = await fetch(`/api/campaigns?t=${Date.now()}`);
      if (cmpRes.ok) setCampaigns(await cmpRes.json());
    } catch { showToast('Error syncing sequences', 'error'); }
    finally { setLoading(false); }
  };

  const refreshCampaigns = async () => {
    try {
      const cmpRes = await fetch(`/api/campaigns?t=${Date.now()}`);
      if (cmpRes.ok) setCampaigns(await cmpRes.json());
    } catch (err) { console.error('Failed to auto-refresh campaigns:', err); }
  };

  useEffect(() => { loadData(); }, []);

  const anyCampaignActive = campaigns.some(c => c.status === 'Active');
  const isRunning = executingId !== null;

  useEffect(() => {
    if (!anyCampaignActive && !isRunning) return;
    const interval = setInterval(() => refreshCampaigns(), 2000);
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
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: campaignName,
          senderAccountId: selectedMailboxId,
          senderAccountIds: Array.from(new Set([selectedMailboxId, ...selectedPoolIds])),
          status: 'Draft',
        }),
      });
      if (!res.ok) throw new Error(await res.text() || 'Failed to establish campaign.');
      const created = await res.json();
      showToast('Campaign sequence initiated successfully');
      setCampaignName(''); setSelectedPoolIds([]); setIsAddOpen(false);
      router.push(`/campaigns/${created.id}`);
    } catch (err: any) {
      showToast(err.message || 'Error occurred', 'error');
    } finally { setSubmitting(false); }
  };

  const handleDeleteCampaign = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmState({
      title: 'Delete Campaign?',
      message: 'Permanently delete this campaign, its steps and its lead enrollments? This cannot be undone. Emails it already sent and the replies they received are kept but unlinked from it, so they stay in lead timelines and Unibox and the links in those emails keep working.',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/campaigns?id=${id}`, { method: 'DELETE' });
          if (res.ok) { setCampaigns(campaigns.filter(c => c.id !== id)); showToast('Campaign sequence deleted.'); }
          else showToast('Failed to delete campaign sequence.', 'error');
        } catch (err) { showToast('Error occurred deleting campaign.', 'error'); }
      },
    });
  };

  const filteredCampaigns = campaigns.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto', pb: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Snackbar open={!!toast} anchorOrigin={{ vertical: 'top', horizontal: 'right' }} autoHideDuration={3000} onClose={() => setToast(null)}>
        {toast ? <Alert severity={toast.type} variant="filled" sx={{ borderRadius: '12px' }}>{toast.message}</Alert> : undefined}
      </Snackbar>

      {/* Header */}
      <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', sm: 'center' }, gap: 2, pb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>Campaign Sequences</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>Build cold email sequences, connect sender mailboxes, and automate your follow-ups.</Typography>
        </Box>
        <Button
          variant="contained" startIcon={<Plus size={16} />}
          onClick={() => {
            if (accounts.length === 0) { showToast('Please first connect at least one Mailbox in the Senders view before starting a campaign.', 'error'); return; }
            setIsAddOpen(true);
          }}
        >Create Sequence</Button>
      </Stack>

      <Card>
        {/* Toolbar */}
        <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', sm: 'center' }, gap: 1.5, p: 2, borderBottom: 1, borderColor: 'divider' }}>
          <TextField
            size="small" sx={{ width: { xs: '100%', sm: 280 } }} placeholder="Search campaigns..."
            value={search} onChange={e => setSearch(e.target.value)}
            slotProps={{ input: { startAdornment: <InputAdornment position="start"><Search size={14} /></InputAdornment> } }}
          />
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="outlined" color="inherit" startIcon={<Filter size={14} />} onClick={() => showToast('Campaign criteria filters loaded')} sx={{ borderColor: 'divider', color: 'text.secondary' }}>Filter</Button>
            <Button size="small" variant="outlined" color="inherit" startIcon={<FileSpreadsheet size={14} />} onClick={() => showToast('Campaign stats CSV report ready for download')} sx={{ borderColor: 'divider', color: 'text.secondary' }}>Export CSV</Button>
          </Stack>
        </Stack>

        {loading ? (
          <Stack sx={{ alignItems: 'center', py: 8, gap: 2 }}>
            <CircularProgress size={24} />
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>Loading campaigns…</Typography>
          </Stack>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ '& th': { fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, color: 'text.secondary' } }}>
                  <TableCell>Sequence Details</TableCell>
                  <TableCell>Sender Mailbox</TableCell>
                  <TableCell>Owner</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell align="right">Configure</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredCampaigns.map(campaign => {
                  const isExpanded = expandedCampaignId === campaign.id;
                  return (
                    <Fragment key={campaign.id}>
                      <TableRow hover onClick={() => setExpandedCampaignId(isExpanded ? null : campaign.id)} sx={{ cursor: 'pointer', bgcolor: isExpanded ? 'action.hover' : undefined }}>
                        <TableCell>
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <Layers size={16} color="#94a3b8" />
                            <Typography variant="body2" sx={{ fontWeight: 700 }}>{campaign.name}</Typography>
                          </Stack>
                          <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', ml: 4, display: 'block' }}>
                            ID: {campaign.id.slice(0, 12)}… · Created {new Date(campaign.createdAt).toLocaleDateString()}
                          </Typography>
                        </TableCell>
                        <TableCell sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                            <Mail size={14} /> {campaign.senderAccount?.emailAddress || 'N/A'}
                          </Stack>
                        </TableCell>
                        <TableCell sx={{ color: 'text.secondary' }}>
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                            <User size={14} /> {campaign.userId === session?.id ? `Me (${session?.name})` : (campaign.user?.name || campaign.user?.email || 'Company Admin')}
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            icon={campaign.status === 'Active' ? <PlayCircle size={10} /> : undefined}
                            label={campaign.status}
                            color={statusColorMap[campaign.status] as any === 'default' ? undefined : statusColorMap[campaign.status] as any}
                            variant="outlined"
                            sx={{ fontWeight: 700, fontSize: 10 }}
                          />
                        </TableCell>
                        <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                          <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                            <MuiTooltip title="Delete">
                              <IconButton aria-label="Delete campaign" size="small" onClick={(e) => handleDeleteCampaign(campaign.id, e)} sx={{ color: 'error.main' }}>
                                <Trash2 size={14} />
                              </IconButton>
                            </MuiTooltip>
                            <Button component={Link as any} href={`/campaigns/${campaign.id}`} size="small" variant="text" endIcon={<ChevronRight size={14} />} color="inherit" sx={{ color: 'text.secondary' }}>
                              Configure
                            </Button>
                          </Stack>
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow sx={{ bgcolor: 'action.hover' }}>
                          <TableCell colSpan={5} sx={{ p: 3 }}>
                            <Stack spacing={2.5}>
                              <Stack direction={{ xs: 'column', md: 'row' }} sx={{ justifyContent: 'space-between', alignItems: { md: 'center' }, gap: 1.5, pb: 1.5, borderBottom: 1, borderColor: 'divider' }}>
                                <Box>
                                  <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 700 }}>Sequence Tracking Overview</Typography>
                                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                    {campaign.name} is in <Box component="span" sx={{ color: 'primary.main', fontWeight: 800 }}>{campaign.status}</Box> mode.
                                  </Typography>
                                </Box>
                                <Stack direction="row" spacing={1}>
                                  <Button
                                    size="small" variant="outlined" color="inherit"
                                    startIcon={campaign.status === 'Active' ? <Pause size={12} color="#d97706" /> : <Play size={12} color="#10b981" />}
                                    onClick={(e) => handleToggleStatus(campaign.id, campaign.status, e)}
                                    sx={{ borderColor: 'divider' }}
                                  >
                                    {campaign.status === 'Active' ? 'Pause' : 'Activate'}
                                  </Button>
                                  {campaign.status === 'Active' && (
                                    <Button
                                      size="small" variant="contained"
                                      startIcon={executingId === campaign.id ? <RefreshCw size={12} className="animate-spin" /> : <PlayCircle size={12} />}
                                      onClick={() => handleRunCampaign(campaign.id)}
                                      disabled={executingId !== null}
                                    >
                                      {executingId === campaign.id ? 'Running…' : 'Run Now'}
                                    </Button>
                                  )}
                                </Stack>
                              </Stack>

                              {(!campaign.steps || campaign.steps.length === 0) ? (
                                <Typography variant="caption" sx={{ color: 'text.secondary', textAlign: 'center', py: 4, display: 'block' }}>
                                  No email steps configured yet. Please configure the campaign sequence to add dispatches.
                                </Typography>
                              ) : (
                                <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 1.5, py: 1 }}>
                                  {campaign.steps.map((step, idx) => {
                                    const stats = campaign.stepStats?.find(s => s.stepOrder === step.stepOrder);
                                    const activeLeadsCount = stats?.active || 0;
                                    const isActiveStep = activeLeadsCount > 0;
                                    const sentCount = stats?.sent || 0;
                                    const deliveredCount = stats?.delivered || 0;
                                    const failedCount = stats?.failed || 0;
                                    const totalEnrolled = campaign.enrollmentSummary?.total || 0;
                                    const progressPercent = totalEnrolled > 0 ? Math.round((sentCount / totalEnrolled) * 100) : 0;
                                    return (
                                      <Stack key={step.id} sx={{ alignItems: 'center', textAlign: 'center', gap: 0.75, position: 'relative', width: 150 }}>
                                        <Chip size="small" label={`${activeLeadsCount} active`} color={isActiveStep ? 'primary' : 'default'} variant={isActiveStep ? 'filled' : 'outlined'} sx={{ height: 18, fontSize: 9, fontWeight: 800 }} />
                                        <Box sx={{ width: 36, height: 36, borderRadius: '50%', display: 'grid', placeItems: 'center', fontFamily: 'monospace', fontWeight: 700, fontSize: 12,
                                          bgcolor: isActiveStep ? 'primary.main' : 'background.paper',
                                          color: isActiveStep ? 'primary.contrastText' : 'text.secondary',
                                          border: isActiveStep ? 'none' : 1, borderColor: 'divider',
                                          boxShadow: isActiveStep ? '0 0 12px rgba(37,99,235,0.4)' : 'none',
                                        }}>{step.stepOrder}</Box>
                                        <Card sx={{ width: '100%', p: 1, borderRadius: '12px' }}>
                                          <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
                                            <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={step.subject}>{step.subject || '(No Subject)'}</Typography>
                                            {idx > 0 && <Typography sx={{ fontSize: 9, color: 'text.secondary', fontFamily: 'monospace', textTransform: 'uppercase', display: 'block', mb: 0.5 }}>Wait: {step.waitDays}d</Typography>}
                                            <Box sx={{ mt: 0.75, pt: 0.75, borderTop: 1, borderColor: 'divider', display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                                              <Stack direction="row" sx={{ justifyContent: 'space-between', fontSize: 9 }}><Box component="span" sx={{ color: 'text.secondary' }}>To send:</Box><Box component="span" sx={{ fontWeight: 800, color: activeLeadsCount > 0 ? 'warning.main' : 'text.disabled' }}>{activeLeadsCount}</Box></Stack>
                                              <Stack direction="row" sx={{ justifyContent: 'space-between', fontSize: 9 }}><Box component="span" sx={{ color: 'text.secondary' }}>Sent:</Box><Box component="span" sx={{ fontWeight: 800 }}>{sentCount}</Box></Stack>
                                              {sentCount > 0 && <Stack direction="row" sx={{ justifyContent: 'space-between', fontSize: 9 }}><Box component="span" sx={{ color: 'text.secondary' }}>Delivered:</Box><Box component="span" sx={{ fontWeight: 800, color: 'success.main' }}>{deliveredCount}</Box></Stack>}
                                              {failedCount > 0 && <Stack direction="row" sx={{ justifyContent: 'space-between', fontSize: 9 }}><Box component="span" sx={{ color: 'text.secondary' }}>Failed:</Box><Box component="span" sx={{ fontWeight: 800, color: 'error.main' }}>{failedCount}</Box></Stack>}
                                              {sentCount > 0 && <Stack direction="row" sx={{ justifyContent: 'space-between', fontSize: 9 }}><Box component="span" sx={{ color: 'text.secondary' }}>Progress:</Box><Box component="span" sx={{ fontWeight: 800, color: 'primary.main' }}>{progressPercent}%</Box></Stack>}
                                            </Box>
                                          </CardContent>
                                        </Card>
                                        {campaign.status === 'Active' && (
                                          <MuiTooltip title={activeLeadsCount === 0 ? 'No leads are queued at this step' : `Send to ${activeLeadsCount} queued lead${activeLeadsCount === 1 ? '' : 's'}`}>
                                            <Box component="span" sx={{ mt: 0.5 }}>
                                              <Button size="small" variant="outlined" startIcon={<Send size={10} />} onClick={(e) => { e.stopPropagation(); handleRunCampaign(campaign.id, step.stepOrder); }} disabled={executingId !== null || activeLeadsCount === 0} sx={{ fontSize: 9, py: 0.25 }}>
                                                Send Step
                                              </Button>
                                            </Box>
                                          </MuiTooltip>
                                        )}
                                      </Stack>
                                    );
                                  })}
                                  {/* End node */}
                                  <Stack sx={{ alignItems: 'center', textAlign: 'center', gap: 0.75, width: 150 }}>
                                    <Chip size="small" label="end" variant="outlined" sx={{ height: 18, fontSize: 9, fontWeight: 800, textTransform: 'uppercase', visibility: 'hidden' }} />
                                    <Box sx={{ width: 36, height: 36, borderRadius: '50%', display: 'grid', placeItems: 'center', bgcolor: 'success.main', color: 'success.contrastText', boxShadow: '0 0 8px rgba(16,185,129,0.4)' }}>
                                      <Check size={16} />
                                    </Box>
                                    <Box>
                                      <Typography variant="caption" sx={{ fontWeight: 700, display: 'block' }}>Completed</Typography>
                                      <Typography sx={{ fontSize: 9, color: 'success.main', fontWeight: 800, fontFamily: 'monospace', textTransform: 'uppercase' }}>
                                        {campaign.enrollmentSummary?.completed || 0} leads
                                      </Typography>
                                    </Box>
                                  </Stack>
                                </Box>
                              )}
                            </Stack>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
                {filteredCampaigns.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} sx={{ textAlign: 'center', py: 8, color: 'text.secondary' }}>
                      <Inbox size={24} style={{ margin: '0 auto', opacity: 0.5 }} />
                      <Typography variant="caption" sx={{ display: 'block', mt: 1 }}>No sequences match your role view.</Typography>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
        )}
      </Card>

      {/* Create modal */}
      <Dialog open={isAddOpen} onClose={() => setIsAddOpen(false)} maxWidth="sm" fullWidth slotProps={{ paper: { sx: { borderRadius: '20px' } } }}>
        <form onSubmit={handleCreateCampaign}>
          <DialogTitle>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <Plus size={20} color="#2563EB" />
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Launch Outreach Sequence</Typography>
            </Stack>
          </DialogTitle>
          <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <TextField label="Sequence Campaign Name" required value={campaignName} onChange={(e) => setCampaignName(e.target.value)} size="small" placeholder="e.g., Enterprise SaaS Seed Funding Round" />
            <Box>
              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
                <Mail size={14} /> Connect Sender Mailbox
              </Typography>
              <Select size="small" fullWidth value={selectedMailboxId} onChange={(e) => setSelectedMailboxId(e.target.value)}>
                {accounts.map((acc) => (
                  <MenuItem key={acc.id} value={acc.id}>{acc.emailAddress} ({acc.provider})</MenuItem>
                ))}
              </Select>
            </Box>
            {accounts.filter((acc) => acc.id !== selectedMailboxId).length > 0 && (
              <Box>
                <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
                  <Mail size={14} /> Rotate Across Additional Mailboxes (optional)
                </Typography>
                <Box sx={{ maxHeight: 130, overflowY: 'auto', border: 1, borderColor: 'divider', borderRadius: '12px', p: 1, bgcolor: 'action.hover' }}>
                  {accounts.filter((acc) => acc.id !== selectedMailboxId).map((acc) => (
                    <FormControlLabel
                      key={acc.id}
                      sx={{ display: 'flex', m: 0 }}
                      control={
                        <Checkbox size="small" checked={selectedPoolIds.includes(acc.id)} onChange={(e) =>
                          setSelectedPoolIds(prev => e.target.checked ? [...prev, acc.id] : prev.filter(id => id !== acc.id))
                        } />
                      }
                      label={<Typography variant="caption">{acc.emailAddress} ({acc.provider})</Typography>}
                    />
                  ))}
                </Box>
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
                  Sending volume spreads across the primary plus any selected mailboxes (least-loaded first).
                </Typography>
              </Box>
            )}
            <Card sx={{ bgcolor: (t) => alpha(t.palette.primary.main, 0.06), borderColor: (t) => alpha(t.palette.primary.main, 0.2) }}>
              <CardContent sx={{ p: 2, '&:last-child': { pb: 2 }, display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
                <Sparkles size={16} color="#2563EB" style={{ marginTop: 2, flexShrink: 0 }} />
                <Typography variant="caption" sx={{ color: 'primary.main', lineHeight: 1.6 }}>
                  This sequence will follow the sending limits configured on the connected mailbox(es).
                </Typography>
              </CardContent>
            </Card>
          </DialogContent>
          <DialogActions sx={{ p: 2 }}>
            <Button color="inherit" onClick={() => setIsAddOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create Sequence'}
            </Button>
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
    </Box>
  );
}

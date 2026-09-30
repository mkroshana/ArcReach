/* eslint-disable react-hooks/set-state-in-effect, react/no-unescaped-entities, react-hooks/exhaustive-deps */
'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Plus, CheckCircle2, AlertCircle, Mail, Flame, ArrowLeft, Sliders,
  ChevronRight, Gauge, User, Activity, Save, Send, Loader2, Trash2, Eye, EyeOff, ShieldAlert,
  MailCheck, MailWarning, MailX, Clock, Settings,
} from 'lucide-react';
import { TableSkeleton } from '@/components/Skeleton';
import { IMAP_SYNC_LABELS, MICROSOFT_IMAP_NOTE, imapSyncState, isMicrosoftImapHost } from '@/lib/imapSyncStatus';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  Box, Card, CardContent, Stack, Typography, Button, IconButton, Chip, TextField,
  Dialog, DialogTitle, DialogContent, DialogActions, Table, TableHead, TableBody, TableRow, TableCell,
  InputAdornment, Select, MenuItem, FormControl, InputLabel, Switch, Avatar, LinearProgress,
  Tooltip as MuiTooltip, FormControlLabel,
} from '@mui/material';
import { alpha } from '@mui/material/styles';

const isSmtpDisabled = (provider: string) => provider === 'AZURE' || provider === 'DISABLED';

/** Per-mailbox opt-in that turns off IMAP certificate verification, labelled with what it risks. */
function AllowSelfSignedSwitch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <FormControlLabel
      labelPlacement="start"
      sx={{ m: 0, gap: 1.5, justifyContent: 'space-between', alignItems: 'center' }}
      control={<Switch checked={checked} onChange={(e) => onChange(e.target.checked)} color="warning" />}
      disableTypography
      label={
        <Box component="span" sx={{ display: 'block' }}>
          <Typography component="span" variant="body2" sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <ShieldAlert size={14} color="#D97706" /> Allow Self-Signed Certificate
          </Typography>
          <Typography component="span" variant="caption" sx={{ color: 'warning.main', display: 'block' }}>
            Turns off certificate checks for this IMAP server, so anyone on the network path could pose as it and capture the mailbox password. Turn on only for a server you run that uses a self-signed certificate.
          </Typography>
        </Box>
      }
    />
  );
}

/** The workspace-wide caps from Settings; null or 0 is no cap, as the send engine reads them. */
type GlobalRateLimitValues = { minute: number | null; hour: number | null };

const formatRateLimit = (limit: number | null, unit: string) =>
  limit && limit > 0 ? `${limit.toLocaleString()} / ${unit}` : 'No limit';

/** The per-minute and per-hour limits, which the send engine applies to all mailboxes together,
 *  shown read-only. Only admins can read them (null otherwise), and they are edited in Settings. */
function GlobalRateLimits({ limits }: { limits: GlobalRateLimitValues | null }) {
  return (
    <Box sx={{ p: 1.5, borderRadius: '12px', bgcolor: 'action.hover', border: 1, borderColor: 'divider' }}>
      <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block' }}>Global Rate Limits</Typography>
      {limits && (
        <Stack direction="row" spacing={3} sx={{ mt: 0.5 }}>
          <Typography sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{formatRateLimit(limits.minute, 'minute')}</Typography>
          <Typography sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{formatRateLimit(limits.hour, 'hour')}</Typography>
        </Stack>
      )}
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
        Per-minute and per-hour limits apply to all mailboxes together, not to each one.{limits ? '' : ' An admin sets them in Settings.'}
      </Typography>
      {limits && (
        <Button component={Link as any} href="/settings" size="small" variant="text" startIcon={<Settings size={14} />} sx={{ mt: 0.5, ml: -0.5 }}>
          Change in Settings
        </Button>
      )}
    </Box>
  );
}

const REPLY_SYNC_ICONS = { off: MailX, waiting: Clock, ok: MailCheck, failing: MailWarning } as const;
const REPLY_SYNC_COLORS = { off: 'default', waiting: 'default', ok: 'success', failing: 'error' } as const;

/** What a mailbox's reply-sync state means for it: when it last synced, or why it doesn't. */
function replySyncDetail(account: any): string {
  const lastSynced = account.imapLastSyncAt ? new Date(account.imapLastSyncAt).toLocaleString() : null;
  switch (imapSyncState(account)) {
    case 'ok': return `Last synced ${lastSynced}.`;
    case 'failing': return `${account.imapLastSyncError} Last successful sync: ${lastSynced ?? 'never'}.`;
    case 'waiting': return 'IMAP details saved. Replies are read once the first sync finishes.';
    default: return account.status && account.status !== 'Active'
      ? 'This mailbox is not Active, so its replies are not synced.'
      : 'No IMAP details, so replies to this mailbox are not read and Pause Sequence on Reply cannot pause its leads.';
  }
}

/** The mailbox's reply-sync state, read from its last sync result; the tooltip says what it means. */
function ReplySyncChip({ account, withTooltip = true }: { account: any; withTooltip?: boolean }) {
  const state = imapSyncState(account);
  const Icon = REPLY_SYNC_ICONS[state];
  const chip = <Chip size="small" icon={<Icon size={11} />} label={IMAP_SYNC_LABELS[state]} color={REPLY_SYNC_COLORS[state]} variant="outlined" sx={{ fontWeight: 700, fontSize: 10 }} />;
  return withTooltip ? <MuiTooltip title={replySyncDetail(account)}>{chip}</MuiTooltip> : chip;
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [selectedWarmupAccount, setSelectedWarmupAccount] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'accounts' | 'warmup'>('accounts');
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [emailAddress, setEmailAddress] = useState('');
  const [senderName, setSenderName] = useState('');
  const [provider, setProvider] = useState('Google Workspace');
  const [assignedUserId, setAssignedUserId] = useState('');
  const [dailyLimit, setDailyLimit] = useState(500);
  const [replyTo, setReplyTo] = useState('');
  const [editReplyTo, setEditReplyTo] = useState('');
  const [globalActiveProvider, setGlobalActiveProvider] = useState('DISABLED');
  const [globalRateLimits, setGlobalRateLimits] = useState<GlobalRateLimitValues | null>(null);

  const totalSentLast24Hours = accounts.reduce((sum, a) => sum + (a.sentLast24Hours || 0), 0);
  const totalDailyLimit = accounts.reduce((sum, a) => sum + (a.dailyLimit || 0), 0);
  const remainingCapacity = Math.max(0, totalDailyLimit - totalSentLast24Hours);
  const failingSyncCount = accounts.filter(a => imapSyncState(a) === 'failing').length;

  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('');
  const [imapUser, setImapUser] = useState('');
  const [imapPass, setImapPass] = useState('');
  const [imapAllowSelfSigned, setImapAllowSelfSigned] = useState(false);
  const [editSmtpHost, setEditSmtpHost] = useState('');
  const [editSmtpPort, setEditSmtpPort] = useState('');
  const [editSmtpUser, setEditSmtpUser] = useState('');
  const [editSmtpPass, setEditSmtpPass] = useState('');
  const [editImapHost, setEditImapHost] = useState('');
  const [editImapPort, setEditImapPort] = useState('');
  const [editImapUser, setEditImapUser] = useState('');
  const [editImapPass, setEditImapPass] = useState('');
  const [editImapAllowSelfSigned, setEditImapAllowSelfSigned] = useState(false);
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [showAddSmtpPass, setShowAddSmtpPass] = useState(false);
  const [showAddImapPass, setShowAddImapPass] = useState(false);
  const [showEditSmtpPass, setShowEditSmtpPass] = useState(false);
  const [showEditImapPass, setShowEditImapPass] = useState(false);
  const [sendingTestEmail, setSendingTestEmail] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { toast: showToast } = useToast();

  useEffect(() => {
    if (selectedWarmupAccount) {
      setEditSmtpHost(selectedWarmupAccount.smtpHost || '');
      setEditSmtpPort(selectedWarmupAccount.smtpPort ? String(selectedWarmupAccount.smtpPort) : '');
      setEditSmtpUser(selectedWarmupAccount.smtpUser || '');
      setEditSmtpPass(selectedWarmupAccount.smtpPass || '');
      setEditImapHost(selectedWarmupAccount.imapHost || '');
      setEditImapPort(selectedWarmupAccount.imapPort ? String(selectedWarmupAccount.imapPort) : '');
      setEditImapUser(selectedWarmupAccount.imapUser || '');
      setEditImapPass(selectedWarmupAccount.imapPass || '');
      setEditImapAllowSelfSigned(!!selectedWarmupAccount.imapAllowSelfSigned);
      setEditReplyTo(selectedWarmupAccount.replyTo || '');
    }
  }, [selectedWarmupAccount]);

  const handleOpenAddModal = () => {
    setIsAddOpen(true);
    setProvider('Google Workspace');
    setSmtpHost('smtp.gmail.com'); setSmtpPort('587');
    setImapHost('imap.gmail.com'); setImapPort('993'); setImapAllowSelfSigned(false);
    setDailyLimit(500);
  };

  const handleProviderChange = (selectedProvider: string) => {
    setProvider(selectedProvider);
    if (selectedProvider === 'Google Workspace') { setSmtpHost('smtp.gmail.com'); setSmtpPort('587'); setImapHost('imap.gmail.com'); setImapPort('993'); }
    // Microsoft 365 refuses password IMAP sign-in, so no IMAP host is filled in for it.
    else if (selectedProvider === 'Microsoft 365') { setSmtpHost('smtp.office365.com'); setSmtpPort('587'); setImapHost(''); setImapPort(''); }
    else if (selectedProvider === 'SendGrid Relay Node') { setSmtpHost('smtp.sendgrid.net'); setSmtpPort('587'); setImapHost(''); setImapPort(''); }
    else { setSmtpHost(''); setSmtpPort(''); setImapHost(''); setImapPort(''); }
  };

  const loadData = async () => {
    try {
      setLoading(true);
      const sessRes = await fetch('/api/session');
      const sessData = await sessRes.json();
      setSession(sessData);
      setAssignedUserId(sessData.id);
      const accRes = await fetch('/api/accounts');
      const accData = await accRes.json();
      setAccounts(accData);
      const settingsRes = await fetch('/api/settings');
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        setGlobalActiveProvider(settingsData.settings?.activeProvider || 'DISABLED');
        // Settings come back for admins only, so other roles see the limits described without values.
        if (settingsData.settings) {
          setGlobalRateLimits({ minute: settingsData.settings.rateLimitMinute ?? null, hour: settingsData.settings.rateLimitHour ?? null });
        }
      }
      if (sessData.role === 'ADMIN') {
        const usersRes = await fetch('/api/users');
        if (usersRes.ok) setUsers(await usersRes.json());
      }
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, []);

  const handleUpdateWarmupSettings = async (field: string, value: any) => {
    if (!selectedWarmupAccount) return;
    const previous = { ...selectedWarmupAccount };
    const updatedLocal = { ...selectedWarmupAccount, [field]: value };
    // Turning warmup on restarts the ramp on the server; show Day 1 while the save is in flight.
    if (field === 'warmupEnabled' && value === true && !selectedWarmupAccount.warmupEnabled) {
      updatedLocal.warmupStartedAt = new Date().toISOString();
      updatedLocal.warmupSent = 0;
    }
    setSelectedWarmupAccount(updatedLocal);
    setAccounts(prev => prev.map(acc => acc.id === selectedWarmupAccount.id ? updatedLocal : acc));
    try {
      const res = await fetch('/api/accounts', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selectedWarmupAccount.id, [field]: value }),
      });
      if (!res.ok) throw new Error();
      const synced = await res.json();
      setSelectedWarmupAccount(synced);
      setAccounts(prev => prev.map(acc => acc.id === selectedWarmupAccount.id ? synced : acc));
    } catch {
      setSelectedWarmupAccount(previous);
      setAccounts(prev => prev.map(acc => acc.id === selectedWarmupAccount.id ? previous : acc));
      showToast('Autopilot values failed to save', 'error');
    }
  };

  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailAddress || submitting) return;
    try {
      setSubmitting(true);
      const res = await fetch('/api/accounts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailAddress, name: senderName, replyTo: replyTo || null, provider, userId: assignedUserId,
          dailyLimit: Number(dailyLimit),
          smtpHost: smtpHost || null, smtpPort: smtpPort ? Number(smtpPort) : null, smtpUser: smtpUser || null, smtpPass: smtpPass || null,
          imapHost: imapHost || null, imapPort: imapPort ? Number(imapPort) : null, imapUser: imapUser || null, imapPass: imapPass || null,
          imapAllowSelfSigned,
        }),
      });
      if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || 'Failed to connect email account'); }
      await loadData();
      setIsAddOpen(false);
      setEmailAddress(''); setSenderName(''); setReplyTo(''); setProvider('Google Workspace');
      setDailyLimit(500);
      setSmtpHost(''); setSmtpPort(''); setSmtpUser(''); setSmtpPass('');
      setImapHost(''); setImapPort(''); setImapUser(''); setImapPass('');
      showToast('Mailbox connected successfully');
    } catch (err: any) {
      showToast(err.message || 'Error connecting sender account', 'error');
    } finally { setSubmitting(false); }
  };

  const handleSaveAccountCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWarmupAccount) return;
    try {
      setSavingCredentials(true);
      const res = await fetch('/api/accounts', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selectedWarmupAccount.id, replyTo: editReplyTo || null,
          smtpHost: editSmtpHost || null, smtpPort: editSmtpPort ? Number(editSmtpPort) : null, smtpUser: editSmtpUser || null, smtpPass: editSmtpPass || null,
          imapHost: editImapHost || null, imapPort: editImapPort ? Number(editImapPort) : null, imapUser: editImapUser || null, imapPass: editImapPass || null,
          imapAllowSelfSigned: editImapAllowSelfSigned,
        }),
      });
      if (!res.ok) throw new Error('Failed to update credentials.');
      const updated = await res.json();
      setAccounts(prev => prev.map(acc => acc.id === selectedWarmupAccount.id ? updated : acc));
      setSelectedWarmupAccount(updated);
      showToast('Mailbox connection credentials updated successfully.');
    } catch (err: any) { showToast(err.message || 'Failed to update credentials.', 'error'); }
    finally { setSavingCredentials(false); }
  };

  const handleSendTestEmail = async () => {
    if (!selectedWarmupAccount || sendingTestEmail) return;
    try {
      setSendingTestEmail(true);
      const res = await fetch('/api/send-email/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senderAccountId: selectedWarmupAccount.id }),
      });
      const data = await res.json().catch(() => ({}));
      // 409 means sending is disabled: nothing was sent, which is a warning rather than a failure.
      if (res.status === 409) { showToast(data.error || 'Sending is disabled. No test email was sent.', 'warning'); return; }
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to send test email.');
      showToast(data.message || `Test email sent to ${data.recipient || session?.email}.`);
    } catch (err: any) { showToast(err.message || 'Failed to send test email.', 'error'); }
    finally { setSendingTestEmail(false); }
  };

  const handleDeleteAccount = async () => {
    if (!selectedWarmupAccount || deleting) return;
    setConfirmOpen(false);
    try {
      setDeleting(true);
      const res = await fetch(`/api/accounts?id=${selectedWarmupAccount.id}`, { method: 'DELETE' });
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || 'Failed to delete mailbox connection'); }
      showToast('Mailbox connection deleted successfully');
      setSelectedWarmupAccount(null);
      await loadData();
    } catch (err: any) { showToast(err.message || 'Error deleting mailbox', 'error'); }
    finally { setDeleting(false); }
  };

  const getOwnerName = (ownerId: string | null) => {
    if (!ownerId) return 'Unassigned';
    if (ownerId === session?.id) return `Me (${session?.name})`;
    const u = users.find(u => u.id === ownerId);
    return u ? u.name : 'Unknown Team Member';
  };

  const currentActiveTab = selectedWarmupAccount ? activeTab : 'accounts';

  // Reusable password TextField
  const PwField = (props: { label: string; value: string; onChange: (v: string) => void; show: boolean; setShow: (v: boolean) => void; placeholder?: string; disabled?: boolean }) => (
    <TextField fullWidth size="small" label={props.label} type={props.show ? 'text' : 'password'} disabled={props.disabled}
      value={props.value} onChange={(e) => props.onChange(e.target.value)} placeholder={props.placeholder}
      slotProps={{ input: { sx: { fontFamily: 'monospace' }, endAdornment: !props.disabled ? (<InputAdornment position="end"><IconButton aria-label={props.show ? 'Hide password' : 'Show password'} size="small" onClick={() => props.setShow(!props.show)}>{props.show ? <EyeOff size={14} /> : <Eye size={14} />}</IconButton></InputAdornment>) : undefined } }}
    />
  );

  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto', pb: 6 }}>
      {currentActiveTab === 'accounts' ? (
        <Stack spacing={3}>
          {/* Header */}
          <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', sm: 'center' }, gap: 2, pb: 2, borderBottom: 1, borderColor: 'divider' }}>
            <Box>
              <Typography variant="h4" sx={{ fontWeight: 700 }}>Email Senders</Typography>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>Connect sender mailboxes, set sending limits, and monitor deliverability.</Typography>
            </Box>
            <Button variant="contained" startIcon={<Plus size={16} />} onClick={handleOpenAddModal}>Add Sender Mailbox</Button>
          </Stack>

          {/* KPIs */}
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' }, gap: 2 }}>
            {[
              { label: 'Total Senders', value: loading ? '…' : `${accounts.length} Senders`, color: undefined },
              { label: 'Active Senders', value: `${accounts.filter(a => a.status === 'Active').length} Active`, color: '#10b981', pulse: true },
              { label: 'Combined Daily Limit', value: `${accounts.reduce((sum, a) => sum + (a.dailyLimit || 0), 0).toLocaleString()} Emails`, color: '#2563EB' },
            ].map((kpi, i) => (
              <Card key={i}>
                <CardContent>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 700 }}>{kpi.label}</Typography>
                    {kpi.pulse && <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'success.main', animation: 'pulse 2s infinite' }} />}
                  </Stack>
                  <Typography variant="h6" sx={{ fontWeight: 700, fontFamily: 'monospace', mt: 0.5, color: kpi.color }}>{kpi.value}</Typography>
                </CardContent>
              </Card>
            ))}
          </Box>

          {/* Table */}
          {loading ? (
            <Card><CardContent><TableSkeleton rows={4} cols={5} /></CardContent></Card>
          ) : (
            <Card>
              <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', p: 2, borderBottom: 1, borderColor: 'divider' }}>
                <Typography variant="overline" sx={{ fontWeight: 700, letterSpacing: '0.1em' }}>Connected Outreach Senders</Typography>
                {failingSyncCount > 0 && (
                  <Chip size="small" icon={<MailWarning size={11} />} label={`${failingSyncCount} ${failingSyncCount === 1 ? 'Mailbox' : 'Mailboxes'} Failing Reply Sync`} color="error" variant="outlined" sx={{ fontWeight: 700, fontSize: 9, fontFamily: 'monospace' }} />
                )}
              </Stack>
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow sx={{ '& th': { fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, color: 'text.secondary' } }}>
                      <TableCell>Sender Mailbox</TableCell>
                      <TableCell>Reply Sync</TableCell>
                      <TableCell>Daily Limit</TableCell>
                      <TableCell>Owner</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell align="right">Configure</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {accounts.map((account) => (
                      <TableRow key={account.id} hover onClick={() => { setSelectedWarmupAccount(account); setActiveTab('warmup'); }} sx={{ cursor: 'pointer' }}>
                        <TableCell>
                          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                            <Avatar variant="rounded" sx={{ width: 36, height: 36, bgcolor: 'action.hover', color: 'text.secondary', borderRadius: '10px' }}>
                              <Mail size={16} />
                            </Avatar>
                            <Box sx={{ minWidth: 0 }}>
                              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                                <Typography variant="body2" sx={{ fontWeight: 700 }}>{account.emailAddress}</Typography>
                                {account.warmupEnabled && <Chip size="small" icon={<Flame size={10} />} label="Warmup" sx={{ height: 18, fontSize: 9, fontWeight: 700, bgcolor: (t) => alpha(t.palette.warning.main, 0.14), color: 'warning.main', '.MuiChip-icon': { color: 'warning.main' } }} />}
                              </Stack>
                              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{account.name} • {account.provider}</Typography>
                              <Stack direction="row" spacing={1.5} sx={{ mt: 0.5, fontFamily: 'monospace', fontSize: 9, color: 'text.secondary', flexWrap: 'wrap' }}>
                                <span>Sent: <strong>{account.sentTotal ?? 0}</strong></span>
                                <span>Delivered: <Box component="strong" sx={{ color: 'success.main' }}>{account.delivered ?? 0}</Box></span>
                                <span>Opens: <strong>{account.opens ?? 0}</strong> ({account.openRate ?? 0}%)</span>
                                <span>Clicks: <strong>{account.clicks ?? 0}</strong> ({account.clickRate ?? 0}%)</span>
                                <span>Replies: <strong>{account.replies ?? 0}</strong></span>
                                <span>Bounces: <Box component="strong" sx={{ color: 'error.main' }}>{account.bounced ?? 0}</Box></span>
                              </Stack>
                            </Box>
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <ReplySyncChip account={account} />
                        </TableCell>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                          {account.warmupEnabled ? (
                            <>
                              <Box component="span" sx={{ color: 'warning.main', fontWeight: 700 }}>{account.effectiveDailyCap} now</Box>
                              <Box component="span" sx={{ color: 'text.secondary' }}> / {account.dailyLimit}</Box>
                            </>
                          ) : (<>{account.dailyLimit} daily max</>)}
                        </TableCell>
                        <TableCell sx={{ color: 'text.secondary' }}>
                          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}><User size={12} /> {getOwnerName(account.userId)}</Stack>
                        </TableCell>
                        <TableCell>
                          <Chip size="small" icon={account.status === 'Active' ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />} label={account.status} color={account.status === 'Active' ? 'success' : 'default'} variant="outlined" sx={{ fontWeight: 700, fontSize: 10 }} />
                        </TableCell>
                        <TableCell align="right">
                          <Button size="small" variant="text" color="inherit" endIcon={<ChevronRight size={14} />} sx={{ color: 'text.secondary' }}>Configure</Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            </Card>
          )}
        </Stack>
      ) : (
        /* Detail view */
        <Stack spacing={3}>
          <Stack direction={{ xs: 'column', md: 'row' }} sx={{ gap: 2, alignItems: { md: 'center' }, pb: 2, borderBottom: 1, borderColor: 'divider' }}>
            <IconButton aria-label="Back to mailbox list" onClick={() => setSelectedWarmupAccount(null)} sx={{ border: 1, borderColor: 'divider', alignSelf: 'flex-start' }}>
              <ArrowLeft size={16} />
            </IconButton>
            <Box sx={{ flex: 1 }}>
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography variant="h5" sx={{ fontWeight: 700 }}>{selectedWarmupAccount.emailAddress}</Typography>
                <Chip size="small" icon={<Sliders size={11} />} label={selectedWarmupAccount.provider} color="primary" variant="outlined" sx={{ fontWeight: 700, fontSize: 10 }} />
                {selectedWarmupAccount.warmupEnabled && <Chip size="small" icon={<Flame size={11} />} label="Warmup Active" sx={{ fontWeight: 700, fontSize: 10, bgcolor: (t) => alpha(t.palette.warning.main, 0.14), color: 'warning.main', '.MuiChip-icon': { color: 'warning.main' } }} />}
              </Stack>
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
                {selectedWarmupAccount.warmupEnabled ? (() => {
                  const startedAt = selectedWarmupAccount.warmupStartedAt ? new Date(selectedWarmupAccount.warmupStartedAt) : new Date();
                  const daysActive = Math.max(0, Math.floor((new Date().getTime() - startedAt.getTime()) / 86400000));
                  const effectiveCap = selectedWarmupAccount.effectiveDailyCap ?? selectedWarmupAccount.dailyLimit;
                  return <Box component="span" sx={{ color: 'warning.main', fontWeight: 600 }}>Warmup Day {daysActive + 1} · Current Cap: {effectiveCap} / {selectedWarmupAccount.dailyLimit} daily limit</Box>;
                })() : 'Configure the daily sending limit, connection details, and credentials for this mailbox.'}
              </Typography>
            </Box>
            <Stack direction="row" spacing={1}>
              <Button variant="contained" color="success" disabled={sendingTestEmail} startIcon={sendingTestEmail ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} onClick={handleSendTestEmail}>
                {sendingTestEmail ? 'Sending…' : 'Send Test Email'}
              </Button>
              <Button variant="outlined" color="error" disabled={deleting} startIcon={deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} onClick={() => setConfirmOpen(true)}>
                {deleting ? 'Deleting…' : 'Delete Mailbox'}
              </Button>
            </Stack>
          </Stack>

          {/* Deliverability stats */}
          <Card>
            <CardContent>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: 'repeat(6, 1fr)' }, gap: 2 }}>
                {[
                  { title: 'Total Sent', value: selectedWarmupAccount.sentTotal ?? 0, desc: 'All campaigns' },
                  { title: 'Delivered', value: selectedWarmupAccount.delivered ?? 0, desc: `${selectedWarmupAccount.deliveryRate ?? 0}% delivery rate` },
                  { title: 'Unique Opens', value: selectedWarmupAccount.opens ?? 0, desc: `${selectedWarmupAccount.openRate ?? 0}% open rate` },
                  { title: 'Unique Clicks', value: selectedWarmupAccount.clicks ?? 0, desc: `${selectedWarmupAccount.clickRate ?? 0}% click rate` },
                  { title: 'Replies', value: selectedWarmupAccount.replies ?? 0, desc: `${selectedWarmupAccount.replyRate ?? 0}% reply rate` },
                  { title: 'Bounced', value: selectedWarmupAccount.bounced ?? 0, desc: 'Hard bounces' },
                ].map((s, idx) => (
                  <Box key={idx} sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: '12px', border: 1, borderColor: 'divider' }}>
                    <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 700, fontSize: 9 }}>{s.title}</Typography>
                    <Typography variant="h6" sx={{ fontWeight: 700, fontFamily: 'monospace' }}>{s.value.toLocaleString()}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 9, display: 'block' }}>{s.desc}</Typography>
                  </Box>
                ))}
              </Box>
            </CardContent>
          </Card>

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 3 }}>
            {/* Credentials */}
            <Card sx={{ height: 'fit-content' }}>
              <CardContent>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', pb: 1.5, mb: 2, borderBottom: 1, borderColor: 'divider' }}>
                  <Sliders size={16} color="#2563EB" />
                  <Typography variant="overline" sx={{ fontWeight: 700 }}>Mailbox Connection Credentials</Typography>
                </Stack>
                <form onSubmit={handleSaveAccountCredentials}>
                  <Stack spacing={2}>
                    <TextField size="small" label="Reply-To Address (Optional)" type="email" placeholder="replies@mycompany.com" value={editReplyTo} onChange={(e) => setEditReplyTo(e.target.value)} sx={{ maxWidth: 360 }} slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                    {selectedWarmupAccount.provider !== 'Azure Relay Node' && (
                      <Card variant="outlined" sx={{ bgcolor: 'action.hover' }}>
                        <CardContent>
                          <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 700, display: 'block', mb: 1.5 }}>Outbound Email (SMTP)</Typography>
                          <Stack spacing={1.5}>
                            <Stack direction="row" spacing={1.5}>
                              <TextField fullWidth size="small" label="SMTP Host" value={editSmtpHost} onChange={(e) => setEditSmtpHost(e.target.value)} slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                              <TextField fullWidth size="small" label="Port" value={editSmtpPort} onChange={(e) => setEditSmtpPort(e.target.value)} slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                            </Stack>
                            <Stack direction="row" spacing={1.5}>
                              <TextField fullWidth size="small" label="Username" value={editSmtpUser} onChange={(e) => setEditSmtpUser(e.target.value)} slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                              <PwField label="Password" value={editSmtpPass} onChange={setEditSmtpPass} show={showEditSmtpPass} setShow={setShowEditSmtpPass} />
                            </Stack>
                          </Stack>
                        </CardContent>
                      </Card>
                    )}
                    {/* Any mailbox can sync replies over IMAP, whatever its provider label */}
                    <Card variant="outlined" sx={{ bgcolor: 'action.hover' }}>
                      <CardContent>
                        <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 700, display: 'block', mb: 1.5 }}>Inbound Replies (IMAP)</Typography>
                        <Stack spacing={1.5}>
                          <Box>
                            <ReplySyncChip account={selectedWarmupAccount} withTooltip={false} />
                            <Typography variant="caption" sx={{ color: imapSyncState(selectedWarmupAccount) === 'failing' ? 'error.main' : 'text.secondary', display: 'block', mt: 0.75, overflowWrap: 'anywhere' }}>
                              {replySyncDetail(selectedWarmupAccount)}
                            </Typography>
                          </Box>
                          {(selectedWarmupAccount.provider === 'Microsoft 365' || isMicrosoftImapHost(editImapHost)) && (
                            <Typography variant="caption" sx={{ color: 'warning.main', display: 'block' }}>{MICROSOFT_IMAP_NOTE}</Typography>
                          )}
                          <Stack direction="row" spacing={1.5}>
                            <TextField fullWidth size="small" label="IMAP Host" value={editImapHost} onChange={(e) => setEditImapHost(e.target.value)} slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                            <TextField fullWidth size="small" label="Port" value={editImapPort} onChange={(e) => setEditImapPort(e.target.value)} slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                          </Stack>
                          <Stack direction="row" spacing={1.5}>
                            <TextField fullWidth size="small" label="Username" value={editImapUser} onChange={(e) => setEditImapUser(e.target.value)} slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                            <PwField label="Password" value={editImapPass} onChange={setEditImapPass} show={showEditImapPass} setShow={setShowEditImapPass} />
                          </Stack>
                          <AllowSelfSignedSwitch checked={editImapAllowSelfSigned} onChange={setEditImapAllowSelfSigned} />
                        </Stack>
                      </CardContent>
                    </Card>
                    <Stack direction="row" sx={{ justifyContent: 'flex-end', pt: 1 }}>
                      <Button type="submit" variant="contained" disabled={savingCredentials} startIcon={<Save size={14} />}>
                        {savingCredentials ? 'Saving…' : 'Save Credentials'}
                      </Button>
                    </Stack>
                  </Stack>
                </form>
              </CardContent>
            </Card>

            <Stack spacing={2.5}>
              {/* Sending limits */}
              <Card>
                <CardContent>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', pb: 1.5, mb: 2, borderBottom: 1, borderColor: 'divider' }}>
                    <Gauge size={16} color="#2563EB" />
                    <Typography variant="overline" sx={{ fontWeight: 700 }}>Sending Limits</Typography>
                  </Stack>
                  <TextField fullWidth size="small" label="Per Day" type="number" value={selectedWarmupAccount.dailyLimit} onChange={(e) => handleUpdateWarmupSettings('dailyLimit', parseInt(e.target.value))} sx={{ maxWidth: 240 }} slotProps={{ input: { sx: { fontFamily: 'monospace' } }, htmlInput: { min: 10 } }} />
                  <Box sx={{ mt: 2 }}><GlobalRateLimits limits={globalRateLimits} /></Box>
                </CardContent>
              </Card>

              {/* Warmup */}
              <Card>
                <CardContent>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', pb: 1.5, mb: 2, borderBottom: 1, borderColor: 'divider' }}>
                    <Flame size={16} color="#D97706" />
                    <Typography variant="overline" sx={{ fontWeight: 700 }}>Warmup Autopilot Settings</Typography>
                  </Stack>
                  <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', p: 2, borderRadius: '14px', border: 1, borderColor: 'divider', bgcolor: 'action.hover' }}>
                    <Box>
                      <Typography variant="body2" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Warmup Autopilot</Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>Slowly ramp up daily volume to establish sender domain reputation. Turning it on again restarts the ramp at Day 1.</Typography>
                    </Box>
                    <Switch checked={!!selectedWarmupAccount.warmupEnabled} onChange={(e) => handleUpdateWarmupSettings('warmupEnabled', e.target.checked)} color="warning" />
                  </Stack>
                  {selectedWarmupAccount.warmupEnabled && (
                    <Stack spacing={2} sx={{ mt: 2 }}>
                      <Stack direction="row" spacing={2}>
                        <TextField fullWidth size="small" label="Starting Volume (Day 1)" type="number" value={selectedWarmupAccount.warmupLimit ?? 50} onChange={(e) => handleUpdateWarmupSettings('warmupLimit', parseInt(e.target.value))} slotProps={{ input: { sx: { fontFamily: 'monospace' } }, htmlInput: { min: 1, max: selectedWarmupAccount.dailyLimit } }} />
                        <TextField fullWidth size="small" label="Daily Ramp Increment" type="number" value={selectedWarmupAccount.warmupRamp ?? 2} onChange={(e) => handleUpdateWarmupSettings('warmupRamp', parseInt(e.target.value))} slotProps={{ input: { sx: { fontFamily: 'monospace' } }, htmlInput: { min: 0 } }} />
                      </Stack>
                      <Card sx={{ bgcolor: (t) => alpha(t.palette.warning.main, 0.06), borderColor: (t) => alpha(t.palette.warning.main, 0.2) }}>
                        <CardContent>
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                            <Flame size={14} color="#D97706" style={{ flexShrink: 0, marginTop: 2 }} />
                            <Box>
                              <Typography variant="caption" sx={{ fontWeight: 700, color: 'warning.main', display: 'block', mb: 0.5 }}>Warmup Progress</Typography>
                              <Box component="ul" sx={{ pl: 2, m: 0, fontSize: 11, color: 'warning.main' }}>
                                <li>Started On: <Box component="strong" sx={{ fontFamily: 'monospace' }}>{selectedWarmupAccount.warmupStartedAt ? new Date(selectedWarmupAccount.warmupStartedAt).toLocaleDateString() : 'Just now'}</Box></li>
                                <li>Emails Sent This Ramp: <Box component="strong" sx={{ fontFamily: 'monospace' }}>{selectedWarmupAccount.warmupSent ?? 0}</Box></li>
                                <li>Current Limit: <Box component="strong" sx={{ fontFamily: 'monospace' }}>{selectedWarmupAccount.effectiveDailyCap ?? selectedWarmupAccount.dailyLimit}</Box> emails per 24 hours</li>
                              </Box>
                            </Box>
                          </Stack>
                        </CardContent>
                      </Card>
                    </Stack>
                  )}
                </CardContent>
              </Card>
            </Stack>
          </Box>
        </Stack>
      )}

      {/* Add mailbox dialog */}
      <Dialog open={isAddOpen} onClose={() => setIsAddOpen(false)} maxWidth="md" fullWidth slotProps={{ paper: { sx: { borderRadius: '20px' } } }}>
        <form onSubmit={handleAddAccount}>
          <DialogTitle>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <Plus size={20} color="#2563EB" />
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Connect Sender Mailbox</Typography>
            </Stack>
          </DialogTitle>
          <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '2fr 1fr' }, gap: 2 }}>
              <TextField label="Sender Email Address" type="email" required value={emailAddress} onChange={(e) => setEmailAddress(e.target.value)} size="small" placeholder="outreach@mycompany.com" slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
              <TextField label="Internal Label" required value={senderName} onChange={(e) => setSenderName(e.target.value)} size="small" placeholder="Sales Outreach" helperText="Shown only in ArcReach. Recipients see the From name set on the sender username in Azure." />
              <TextField label="Reply-To (Optional)" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} size="small" placeholder="replies@mycompany.com" slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
              <FormControl size="small">
                <InputLabel>Email Provider</InputLabel>
                <Select label="Email Provider" value={provider} onChange={(e) => handleProviderChange(e.target.value)}>
                  <MenuItem value="Google Workspace">Google Workspace</MenuItem>
                  <MenuItem value="Microsoft 365">Microsoft 365</MenuItem>
                  <MenuItem value="IMAP/SMTP Custom Protocol">IMAP/SMTP Custom</MenuItem>
                  <MenuItem value="SendGrid Relay Node">SendGrid Relay</MenuItem>
                  <MenuItem value="Azure Relay Node">Azure Relay</MenuItem>
                </Select>
              </FormControl>
            </Box>

            <FormControl size="small" disabled={session?.role !== 'ADMIN'}>
              <InputLabel>Assign Mailbox Owner</InputLabel>
              <Select label="Assign Mailbox Owner" value={assignedUserId} onChange={(e) => setAssignedUserId(e.target.value)}>
                {session?.role !== 'ADMIN' ? (
                  <MenuItem value={session?.id}>Me ({session?.name})</MenuItem>
                ) : (
                  users.map((u) => <MenuItem key={u.id} value={u.id}>{u.name} ({u.role})</MenuItem>)
                )}
              </Select>
            </FormControl>

            {provider !== 'Azure Relay Node' && (
              <Card variant="outlined" sx={{ bgcolor: 'action.hover' }}>
                <CardContent>
                  <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 700, display: 'block', mb: 1.5 }}>
                    Outbound Email (SMTP){isSmtpDisabled(globalActiveProvider) ? ' · overrides global route' : ''}
                  </Typography>
                  <Stack spacing={1.5}>
                    <Stack direction="row" spacing={1.5}>
                      <TextField fullWidth size="small" label="SMTP Host" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                      <TextField fullWidth size="small" label="Port" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder="587" slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                    </Stack>
                    <Stack direction="row" spacing={1.5}>
                      <TextField fullWidth size="small" label="Username" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder="user@domain.com" slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                      <PwField label="Password" value={smtpPass} onChange={setSmtpPass} show={showAddSmtpPass} setShow={setShowAddSmtpPass} placeholder="Password or App Key" />
                    </Stack>
                  </Stack>
                </CardContent>
              </Card>
            )}

            {/* Any mailbox can sync replies over IMAP, whatever its provider label */}
            <Card variant="outlined" sx={{ bgcolor: 'action.hover' }}>
              <CardContent>
                <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 700, display: 'block', mb: 1.5 }}>Inbound Replies (IMAP)</Typography>
                <Stack spacing={1.5}>
                  {(provider === 'Microsoft 365' || isMicrosoftImapHost(imapHost)) && (
                    <Typography variant="caption" sx={{ color: 'warning.main', display: 'block' }}>{MICROSOFT_IMAP_NOTE}</Typography>
                  )}
                  <Stack direction="row" spacing={1.5}>
                    <TextField fullWidth size="small" label="IMAP Host" value={imapHost} onChange={(e) => setImapHost(e.target.value)} slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                    <TextField fullWidth size="small" label="Port" value={imapPort} onChange={(e) => setImapPort(e.target.value)} placeholder="993" slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                  </Stack>
                  <Stack direction="row" spacing={1.5}>
                    <TextField fullWidth size="small" label="Username" value={imapUser} onChange={(e) => setImapUser(e.target.value)} placeholder="user@domain.com" slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                    <PwField label="Password" value={imapPass} onChange={setImapPass} show={showAddImapPass} setShow={setShowAddImapPass} placeholder="Password or App Key" />
                  </Stack>
                  <AllowSelfSignedSwitch checked={imapAllowSelfSigned} onChange={setImapAllowSelfSigned} />
                </Stack>
              </CardContent>
            </Card>

            <Card variant="outlined">
              <CardContent>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1.5 }}>
                  <Activity size={14} color="#2563EB" />
                  <Typography variant="overline" sx={{ fontWeight: 700, color: 'text.secondary' }}>Sending Limits</Typography>
                </Stack>
                <TextField fullWidth size="small" label="Max / Day" type="number" value={dailyLimit} onChange={(e) => setDailyLimit(parseInt(e.target.value) || 10)} sx={{ maxWidth: 240 }} slotProps={{ input: { sx: { fontFamily: 'monospace' } }, htmlInput: { min: 10 } }} />
                <Box sx={{ mt: 2 }}><GlobalRateLimits limits={globalRateLimits} /></Box>
                {accounts.length > 0 && (
                  <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}>
                    <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                      <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Combined Daily Capacity</Typography>
                      <Typography variant="caption" sx={{ fontWeight: 700, color: 'primary.main', fontFamily: 'monospace' }}>{totalSentLast24Hours} / {totalDailyLimit} sent in the last 24 hours</Typography>
                    </Stack>
                    <LinearProgress variant="determinate" value={Math.min(100, totalDailyLimit > 0 ? (totalSentLast24Hours / totalDailyLimit) * 100 : 0)} sx={{ height: 6, borderRadius: 999 }} />
                    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1.5, mt: 2, p: 1.5, borderRadius: '12px', bgcolor: 'action.hover', border: 1, borderColor: 'divider', textAlign: 'center', fontSize: 10 }}>
                      <Box><Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700 }}>Remaining</Typography><Typography sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{remainingCapacity} / day</Typography></Box>
                      <Box><Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700 }}>Mailboxes</Typography><Typography sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{accounts.length}</Typography></Box>
                      <Box><Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700 }}>Avg / Account</Typography><Typography sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{accounts.length > 0 ? Math.round(totalDailyLimit / accounts.length) : 0}</Typography></Box>
                    </Box>
                  </Box>
                )}
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1.5 }}>
                  Keep volumes conservative — most mailboxes shouldn't exceed ~500 emails/day to protect sender reputation.
                </Typography>
              </CardContent>
            </Card>
          </DialogContent>
          <DialogActions sx={{ p: 2 }}>
            <Button color="inherit" onClick={() => setIsAddOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={submitting}>{submitting ? 'Connecting…' : 'Connect Mailbox'}</Button>
          </DialogActions>
        </form>
      </Dialog>

      <ConfirmDialog
        isOpen={confirmOpen}
        title="Delete Mailbox Connection"
        message={`Delete the mailbox connection for ${selectedWarmupAccount?.emailAddress || 'this account'}? You will no longer be able to send from it. Its sent-mail history and received replies are kept but unlinked from it, so only admins will still see those replies in Unibox. If any campaign still sends from this mailbox, nothing is deleted until you switch that campaign to another mailbox or delete it.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={handleDeleteAccount}
        onCancel={() => setConfirmOpen(false)}
        isDestructive={true}
      />
    </Box>
  );
}

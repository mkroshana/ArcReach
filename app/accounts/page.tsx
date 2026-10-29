/* eslint-disable react-hooks/set-state-in-effect, react/no-unescaped-entities, react-hooks/exhaustive-deps */
'use client';

import { useState, useEffect, useRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import Link from 'next/link';
import {
  Plus, AlertCircle, Flame, ArrowLeft,
  ChevronRight, Gauge, User, Send, Loader2, Trash2, Eye, EyeOff, ShieldAlert, Users,
  MailCheck, MailWarning, MailX, Clock, Settings, RefreshCw, AlertTriangle,
} from 'lucide-react';
import { TableSkeleton } from '@/components/Skeleton';
import { MICROSOFT_IMAP_NOTE, imapSyncState, isMicrosoftImapHost, mailboxRepliesFigure, mailboxReplySync, mailboxReplySyncLabel } from '@/lib/imapSyncStatus';
import { deliveryRateText } from '@/lib/deliveryStats';
import { bounceFigure } from '@/lib/bounceStats';
import { useToast } from '@/components/Toast';
import { LoadError, loadErrorMessage, readJsonList, readJsonObject, responseErrorMessage } from '@/lib/apiResponse';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { RecipientDomainsInput } from '@/components/RecipientDomainsInput';
import { MAILBOX_LIMIT_FIELDS, type MailboxLimitField, MailboxSettingsSaves, mailboxLimitInputValue } from '@/lib/mailboxSettingsSave';
import { combinedDailyCapacity, mailboxRemaining, type GlobalDailyAllowance } from '@/lib/mailboxCapacity';
import { ActionDrawer } from '@/components/ActionDrawer';
import { Tooltip as MuiTooltip } from '@mui/material';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { inputClasses } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { Switch } from '@/components/ui/Switch';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { cn } from '@/lib/utils';

const LABEL = 'mb-1.5 block text-[13px] font-medium text-text-main';
const SUB_BOX = 'rounded-control border border-card-border bg-slate-50/60 p-4 dark:bg-white/[0.02]';
const MINI_TILES = 'grid gap-2 rounded-control bg-slate-50 p-3 text-center dark:bg-white/[0.03]';

interface MailboxCapacityGaugeProps {
  used: number;
  total: number;
  warmup?: boolean;
  warmupCap?: number;
  remaining?: number;
  compact?: boolean;
}

/** Clean daily capacity gauge showing volume used, capacity limit, and progress bar or circular SVG indicator. */
function MailboxCapacityGauge({
  used,
  total,
  warmup = false,
  warmupCap,
  remaining,
  compact = false,
}: MailboxCapacityGaugeProps) {
  const effectiveLimit = warmupCap ?? total;
  const pct = effectiveLimit > 0 ? Math.min(100, Math.round((used / effectiveLimit) * 100)) : 0;

  const barColor =
    pct > 90
      ? 'bg-rose-500'
      : pct > 75
      ? 'bg-amber-500'
      : 'bg-primary';

  const textColor =
    pct > 90
      ? 'text-rose-600 dark:text-rose-400'
      : pct > 75
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-primary';

  if (compact) {
    return (
      <div className="w-full max-w-[170px] space-y-1 text-[11px]">
        <div className="flex items-center justify-between gap-2 whitespace-nowrap text-text-sub">
          <span className={cn('font-semibold', textColor)}>{used.toLocaleString()}</span>
          <span>/ {effectiveLimit.toLocaleString()}{warmup ? ' (cap)' : ''}</span>
        </div>
        <ProgressBar pct={pct} className={barColor} />
        {remaining !== undefined && (
          <div className="text-text-muted">
            {remaining.toLocaleString()} left
          </div>
        )}
      </div>
    );
  }

  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const strokeOffset = circumference - (pct / 100) * circumference;

  return (
    <div className="flex items-center gap-3">
      <div className="relative flex size-12 shrink-0 items-center justify-center">
        <svg className="size-12 -rotate-90" viewBox="0 0 48 48">
          <circle cx="24" cy="24" r={radius} className="stroke-slate-100 dark:stroke-white/10" strokeWidth="4" fill="none" />
          <circle
            cx="24"
            cy="24"
            r={radius}
            className={cn('transition-all duration-500', pct > 90 ? 'stroke-rose-500' : pct > 75 ? 'stroke-amber-500' : 'stroke-primary')}
            strokeWidth="4"
            strokeDasharray={circumference}
            strokeDashoffset={strokeOffset}
            strokeLinecap="round"
            fill="none"
          />
        </svg>
        <span className={cn('absolute text-[10px] font-semibold', textColor)}>
          {pct}%
        </span>
      </div>
      <div className="min-w-0 text-xs">
        <div className="font-semibold text-text-main">
          {used.toLocaleString()} / {effectiveLimit.toLocaleString()}
        </div>
        <div className="text-[11px] text-text-muted">
          {remaining !== undefined ? `${remaining.toLocaleString()} left today` : 'Daily capacity'}
        </div>
      </div>
    </div>
  );
}

/** A thin bar filled to `pct` percent. */
function ProgressBar({ pct, className = 'bg-primary' }: { pct: number; className?: string }) {
  return (
    <div role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-white/10">
      <div className={cn('h-full rounded-full transition-all duration-300', className)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A labelled text field; `hint` is the small line under it. Declared at module scope so the input keeps focus while typing. */
function TextInput({ label, hint, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className={LABEL}>
        {label}{props.required && <span className="text-rose-500"> *</span>}
      </label>
      <input id={id} className={inputClasses('h-9 disabled:cursor-not-allowed disabled:opacity-60')} {...props} />
      {hint && <p className="mt-1 text-[11px] text-text-muted">{hint}</p>}
    </div>
  );
}

/** Per-mailbox opt-in that turns off IMAP certificate verification, labelled with what it risks. */
function AllowSelfSignedSwitch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <span id={id} className="flex items-center gap-1.5 text-[13px] font-medium text-text-main">
          <ShieldAlert size={14} className="text-amber-600 dark:text-amber-400" /> Allow Self-Signed Certificate
        </span>
        <span className="mt-0.5 block text-xs text-amber-700 dark:text-amber-300">
          Turns off certificate checks for this IMAP server, so anyone on the network path could pose as it and capture the mailbox password. Turn on only for a server you run that uses a self-signed certificate.
        </span>
      </div>
      <Switch checked={checked} onChange={onChange} aria-labelledby={id} className="mt-0.5" />
    </div>
  );
}

/** Reusable password field. Declared at module scope so the input keeps focus while typing
 *  (a component declared inside the page is a new type each render and remounts). */
function PwField(props: { label: string; value: string; onChange: (v: string) => void; show: boolean; setShow: (v: boolean) => void; placeholder?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={LABEL}>{props.label}</label>
      <div className="relative">
        <input
          id={id}
          type={props.show ? 'text' : 'password'}
          disabled={props.disabled}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={props.placeholder}
          autoComplete="new-password"
          className={inputClasses('h-9 pr-9')}
        />
        {!props.disabled && (
          <button
            type="button"
            aria-label={props.show ? 'Hide password' : 'Show password'}
            onClick={() => props.setShow(!props.show)}
            className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-text-muted transition-colors hover:text-text-main"
          >
            {props.show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
      </div>
    </div>
  );
}

/** The name recipients see beside the Reply-To address. It is sent only with one, so the field is off until `replyTo` is filled in. */
function ReplyToNameField(props: { value: string; onChange: (v: string) => void; replyTo: string; className?: string }) {
  return (
    <TextInput label="Reply-To Name (Optional)" value={props.value} onChange={(e) => props.onChange(e.target.value)}
      disabled={!props.replyTo} placeholder="My Company Support" className={props.className} maxLength={100}
      hint={props.replyTo ? 'Recipients see this name beside the Reply-To address.' : 'Needs a Reply-To address.'}
    />
  );
}

/** Why there are no SMTP fields: Azure sends every email, so per-mailbox SMTP details would never be used. */
function SmtpNotUsedNote() {
  return (
    <p className="text-xs text-text-sub">
      Outgoing email is sent through Azure Communication Services, so this mailbox needs no SMTP details. IMAP below is used only to read replies.
    </p>
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
    <div className="rounded-control border border-card-border bg-slate-50/60 p-3 dark:bg-white/[0.02]">
      <span className="text-[11px] font-medium text-text-muted">Global Rate Limits</span>
      {limits && (
        <div className="mt-1 flex gap-6 text-[13px] font-semibold text-text-main">
          <span>{formatRateLimit(limits.minute, 'minute')}</span>
          <span>{formatRateLimit(limits.hour, 'hour')}</span>
        </div>
      )}
      <p className="mt-1 text-xs text-text-sub">
        Per-minute and per-hour limits apply to all mailboxes together, not to each one.{limits ? '' : ' An admin sets them in Settings.'}
      </p>
      {limits && (
        <Link href="/settings" className={buttonClasses({ variant: 'ghost', size: 'sm', className: 'mt-1 -ml-2.5' })}>
          <Settings size={14} />
          Change in Settings
        </Link>
      )}
    </div>
  );
}

const REPLY_SYNC_ICONS = { off: MailX, waiting: Clock, ok: MailCheck, failing: MailWarning } as const;
const REPLY_SYNC_TONES: Record<keyof typeof REPLY_SYNC_ICONS, BadgeTone> = { off: 'neutral', waiting: 'neutral', ok: 'green', failing: 'red' };

/**
 * What a mailbox's reply-sync state means for it: when it last synced, or why it doesn't.
 * For one read through its Reply-To mailbox (mailboxReplySync) it says so, with that mailbox's sync result.
 */
function replySyncDetail(account: any, accounts: any[]): string {
  const { state, via, reader } = mailboxReplySync(account, accounts);
  const lastSynced = reader.imapLastSyncAt ? new Date(reader.imapLastSyncAt).toLocaleString() : null;
  const readVia = via ? `Replies to this mailbox's emails go to its Reply-To address, ${via}, and are read with that mailbox's reply sync. ` : '';
  switch (state) {
    case 'ok': return `${readVia}Last synced ${lastSynced}.`;
    case 'failing': return `${readVia}${reader.imapLastSyncError} Last successful sync: ${lastSynced ?? 'never'}.`;
    case 'waiting': return via ? `${readVia}Its first sync has not finished yet.` : 'IMAP details saved. Replies are read once the first sync finishes.';
    default: return account.status && account.status !== 'Active'
      ? 'This mailbox is not Active, so its replies are not synced.'
      : 'No IMAP details, so replies to this mailbox are not read and Pause Sequence on Reply cannot pause its leads.';
  }
}

/** The state of the reply sync that reads the mailbox's replies (mailboxReplySync), from its last sync result; the tooltip says what it means. */
function ReplySyncChip({ account, accounts, withTooltip = true }: { account: any; accounts: any[]; withTooltip?: boolean }) {
  const sync = mailboxReplySync(account, accounts);
  const Icon = REPLY_SYNC_ICONS[sync.state];
  const badge = (
    <Badge tone={REPLY_SYNC_TONES[sync.state]}>
      <Icon size={12} aria-hidden />
      {mailboxReplySyncLabel(sync)}
    </Badge>
  );
  return withTooltip ? (
    <MuiTooltip title={replySyncDetail(account, accounts)}>
      <span tabIndex={0} className="inline-flex rounded-md focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none">{badge}</span>
    </MuiTooltip>
  ) : badge;
}

const NO_DELIVERY_REPORTS_NOTE = "No delivery reports have arrived for this mailbox's emails, so how many were delivered is not known.";

/** Whether the mailbox sent emails but no delivery report arrived for any of them, so its Delivered is unknown rather than 0. */
function deliveryUnknown(account: any): boolean {
  return (account.sentTotal ?? 0) > 0 && (account.reported ?? 0) === 0;
}

const NO_BOUNCE_REPORTS_NOTE = "No delivery reports have arrived for this mailbox's emails and none bounced when sending, so how many bounced is not known.";

/**
 * Whether the mailbox's Bounced is unknown rather than 0 (bounceFigure, as the campaign page's mailbox rows):
 * it sent emails, no delivery report arrived for any of them and none bounced when sending.
 */
function bouncesUnknown(account: any): boolean {
  const row = { sent: account.sentTotal ?? 0, reported: account.reported ?? 0, bounced: account.bounced };
  // The mailbox's own emails decide it, as noReportsFor does for a mailbox row.
  return bounceFigure(row, { noDeliveryReports: false }).count === null;
}

/** A tile of the mailbox's deliverability stats; a `caveat` shows as a warning mark beside its description. */
type StatTile = { title: string; value: string | number; desc: string; caveat?: string | null };

/** The mailbox's Replies tile (mailboxRepliesFigure): '—' where its count is unknown. */
function repliesTile(account: any, accounts: any[]) {
  const { count, sub, caveat } = mailboxRepliesFigure(account, accounts);
  return { title: 'Replies', value: count ?? '—', desc: sub, caveat };
}

/** A small warning mark with its reason on hover and focus. */
function CaveatMark({ note }: { note: string }) {
  return (
    <MuiTooltip title={note} arrow>
      <span tabIndex={0} aria-label={note} className="ml-1 inline-flex align-middle text-amber-600 dark:text-amber-400">
        <AlertTriangle size={12} />
      </span>
    </MuiTooltip>
  );
}

/** An unknown figure, '—', with its reason on hover and focus. */
function UnknownFigure({ note, label }: { note: string; label: string }) {
  return (
    <MuiTooltip title={note}>
      <strong tabIndex={0} aria-label={label} className="font-semibold text-text-main">—</strong>
    </MuiTooltip>
  );
}

/** A mailbox row's Replies, as its Replies tile (mailboxRepliesFigure): '—' where the count is unknown, and its caveat as a warning mark. */
function RowReplies({ account, accounts }: { account: any; accounts: any[] }) {
  const { count, caveat } = mailboxRepliesFigure(account, accounts);
  return (
    <span>Replies: {count === null ? (
      // Unknown only while the mailbox's own reply sync is off, which replySyncDetail explains.
      <UnknownFigure note={replySyncDetail(account, accounts)} label={mailboxReplySync(account, accounts).via ? 'Replies are read at the Reply-To address' : 'Reply sync off'} />
    ) : <strong className="font-semibold text-text-main">{count}</strong>}{caveat && <CaveatMark note={caveat} />}</span>
  );
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed load shows an error with Retry: the empty list and zero totals would read as no mailboxes.
  const [loadError, setLoadError] = useState('');
  const [session, setSession] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  // Why the team list (admins only) could not be loaded; owners then show as Unknown Team Member.
  const [usersError, setUsersError] = useState('');
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
  const [replyToName, setReplyToName] = useState('');
  const [editReplyTo, setEditReplyTo] = useState('');
  const [editReplyToName, setEditReplyToName] = useState('');
  const [globalRateLimits, setGlobalRateLimits] = useState<GlobalRateLimitValues | null>(null);

  // The daily allowance all mailboxes share while a global rate limit is set. Then the mailboxes
  // have no daily limits of their own, and the page shows what is left of the allowance instead.
  const [globalDaily, setGlobalDaily] = useState<GlobalDailyAllowance | null>(null);

  const totalDailyLimit = accounts.reduce((sum, a) => sum + (a.dailyLimit || 0), 0);
  // With no global rate limit, what the mailboxes may send now: each one's enforced cap, which
  // warmup holds below its daily limit.
  const dailyCapacity = combinedDailyCapacity(accounts);
  // A mailbox's cap for display. While a save that turns warmup on is in flight the server's cap
  // has not arrived yet, so the ramp's Day 1 volume stands in for it when daily limits are off.
  const currentCap = (account: any): number => account.effectiveDailyCap ?? (globalDaily ? account.warmupLimit ?? 50 : account.dailyLimit);
  // What a mailbox may still send of the shared allowance, which only its warmup ramp holds it below.
  const remainingOfAllowance = (account: any): number =>
    mailboxRemaining({ sentLast24Hours: account.sentLast24Hours, effectiveDailyCap: account.warmupEnabled ? currentCap(account) : null }, globalDaily);
  // The global limit that sets the shared allowance, as "800 / hour".
  const globalDailySource = globalDaily ? formatRateLimit(globalDaily.limit / (globalDaily.per === 'hour' ? 24 : 1440), globalDaily.per) : '';
  const failingSyncCount = accounts.filter(a => imapSyncState(a) === 'failing').length;

  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('');
  const [imapUser, setImapUser] = useState('');
  const [imapPass, setImapPass] = useState('');
  const [imapAllowSelfSigned, setImapAllowSelfSigned] = useState(false);
  const [editImapHost, setEditImapHost] = useState('');
  const [editImapPort, setEditImapPort] = useState('');
  const [editImapUser, setEditImapUser] = useState('');
  const [editImapPass, setEditImapPass] = useState('');
  const [editImapAllowSelfSigned, setEditImapAllowSelfSigned] = useState(false);
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [showAddImapPass, setShowAddImapPass] = useState(false);
  const [showEditImapPass, setShowEditImapPass] = useState(false);
  const [sendingTestEmail, setSendingTestEmail] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Limit inputs as typed, until they are saved when they lose focus (never per keystroke).
  const [limitDrafts, setLimitDrafts] = useState<Partial<Record<MailboxLimitField, string>>>({});
  // Limit and warmup saves, one at a time in the order made, so the last value made is the one stored.
  const [settingsSaves] = useState(() => new MailboxSettingsSaves());
  // The open mailbox's id, for a credentials save answered after the user left it.
  const openAccountId = useRef<string | null>(null);
  const { toast: showToast } = useToast();

  /** Fill the credentials form with a mailbox's stored details (the password comes back masked). */
  const seedCredentialForm = (account: any) => {
    setEditImapHost(account.imapHost || '');
    setEditImapPort(account.imapPort ? String(account.imapPort) : '');
    setEditImapUser(account.imapUser || '');
    setEditImapPass(account.imapPass || '');
    setEditImapAllowSelfSigned(!!account.imapAllowSelfSigned);
    setEditReplyTo(account.replyTo || '');
    setEditReplyToName(account.replyToName || '');
  };

  // Only opening a mailbox resets its forms: a limit or warmup save replaces the open mailbox
  // object, which must not discard credential edits not yet saved.
  useEffect(() => {
    openAccountId.current = selectedWarmupAccount?.id ?? null;
    if (selectedWarmupAccount) seedCredentialForm(selectedWarmupAccount);
    setLimitDrafts({});
  }, [selectedWarmupAccount?.id]);

  /** Merge saved (or about to be saved) columns into a mailbox in the list and, if still open, the detail
   *  view. A PUT answers without the stats GET counted, so those are kept rather than replaced. */
  const mergeAccount = (id: string, fields: Record<string, any>) => {
    setAccounts(prev => prev.map(acc => acc.id === id ? { ...acc, ...fields } : acc));
    setSelectedWarmupAccount((cur: any) => cur && cur.id === id ? { ...cur, ...fields } : cur);
  };

  const handleOpenAddModal = () => {
    setIsAddOpen(true);
    setProvider('Google Workspace');
    setImapHost('imap.gmail.com'); setImapPort('993'); setImapAllowSelfSigned(false);
    setDailyLimit(500);
  };

  const handleProviderChange = (selectedProvider: string) => {
    setProvider(selectedProvider);
    if (selectedProvider === 'Google Workspace') { setImapHost('imap.gmail.com'); setImapPort('993'); }
    // Microsoft 365 refuses password IMAP sign-in, so no IMAP host is filled in for it.
    else { setImapHost(''); setImapPort(''); }
  };

  const loadData = async () => {
    try {
      setLoading(true);
      setLoadError('');
      setUsersError('');
      const sessData = await readJsonObject(await fetch('/api/session'), 'Your session');
      if (!sessData.id) throw new LoadError('Your session could not be loaded. Sign in again.');
      setSession(sessData);
      setAssignedUserId(sessData.id);
      setAccounts(await readJsonList(await fetch('/api/accounts'), 'Mailboxes'));
      // Whether the mailboxes share a global daily allowance decides which limits the page shows.
      const capacity = await readJsonObject(await fetch('/api/accounts/capacity'), 'Sending limits');
      setGlobalDaily(capacity.globalDaily ?? null);
      const settingsRes = await fetch('/api/settings');
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        // Settings come back for admins only, so other roles see the limits described without values.
        if (settingsData.settings) {
          setGlobalRateLimits({ minute: settingsData.settings.rateLimitMinute ?? null, hour: settingsData.settings.rateLimitHour ?? null });
        }
      }
      if (sessData.role === 'ADMIN') {
        // Owner names and the owner picker come from this list, so the page says when it did not load.
        try {
          setUsers(await readJsonList(await fetch('/api/users'), 'Team members'));
        } catch (err) { console.error(err); setUsersError(loadErrorMessage(err, 'Team members')); }
      }
    } catch (err) { console.error(err); setLoadError(loadErrorMessage(err, 'Mailboxes')); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, []);

  const handleUpdateWarmupSettings = (field: string, value: any, failure = 'Autopilot values failed to save.') => {
    if (!selectedWarmupAccount) return;
    const account = selectedWarmupAccount;
    const optimistic: Record<string, any> = { [field]: value };
    // Turning warmup on restarts the ramp on the server; show Day 1 while the save is in flight.
    if (field === 'warmupEnabled' && value === true && !account.warmupEnabled) {
      optimistic.warmupStartedAt = new Date().toISOString();
      optimistic.warmupSent = 0;
    }
    mergeAccount(account.id, optimistic);
    settingsSaves.enqueue({
      accountId: account.id, field, shown: account,
      send: async () => {
        const res = await fetch('/api/accounts', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: account.id, [field]: value }),
        });
        if (!res.ok) throw new LoadError(await responseErrorMessage(res, failure));
        return res.json();
      },
      onSaved: (synced) => mergeAccount(account.id, synced),
      onFailed: (restore, err) => {
        mergeAccount(account.id, restore);
        // The server's reason when it answered one, else the generic message (not the browser's "Failed to fetch")
        showToast(err instanceof LoadError ? err.message : failure, 'error');
      },
    });
  };

  /** Save a typed limit once its input loses focus; a value the field does not allow shows the saved one again. */
  const commitLimitDraft = (field: MailboxLimitField) => {
    const draft = limitDrafts[field];
    if (draft === undefined || !selectedWarmupAccount) return;
    setLimitDrafts(prev => { const next = { ...prev }; delete next[field]; return next; });
    const { value, error } = mailboxLimitInputValue(field, draft);
    if (error) { showToast(`${error} It was not saved.`, 'error'); return; }
    if (value !== selectedWarmupAccount[field]) handleUpdateWarmupSettings(field, value);
  };

  /** Value and handlers for a limit input: typing edits a draft, blur or Enter saves it. */
  const limitInputProps = (field: MailboxLimitField, saved: number) => ({
    value: limitDrafts[field] ?? saved,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const text = e.target.value;
      setLimitDrafts(prev => ({ ...prev, [field]: text }));
    },
    onBlur: () => commitLimitDraft(field),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') (e.target as HTMLElement).blur(); },
  });

  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailAddress || submitting) return;
    try {
      setSubmitting(true);
      const res = await fetch('/api/accounts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailAddress, name: senderName, replyTo: replyTo || null, replyToName: replyTo ? replyToName.trim() || null : null, provider, userId: assignedUserId,
          dailyLimit: Number(dailyLimit),
          imapHost: imapHost || null, imapPort: imapPort ? Number(imapPort) : null, imapUser: imapUser || null, imapPass: imapPass || null,
          imapAllowSelfSigned,
        }),
      });
      if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || 'Failed to connect email account'); }
      await loadData();
      setIsAddOpen(false);
      setEmailAddress(''); setSenderName(''); setReplyTo(''); setReplyToName(''); setProvider('Google Workspace');
      setDailyLimit(500);
      setImapHost(''); setImapPort(''); setImapUser(''); setImapPass('');
      showToast('Mailbox connected successfully');
    } catch (err: any) {
      showToast(err.message || 'Error connecting sender account', 'error');
    } finally { setSubmitting(false); }
  };

  const handleSaveAccountCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWarmupAccount) return;
    const id = selectedWarmupAccount.id;
    try {
      setSavingCredentials(true);
      const res = await fetch('/api/accounts', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id, replyTo: editReplyTo || null, replyToName: editReplyTo ? editReplyToName.trim() || null : null,
          imapHost: editImapHost || null, imapPort: editImapPort ? Number(editImapPort) : null, imapUser: editImapUser || null, imapPass: editImapPass || null,
          imapAllowSelfSigned: editImapAllowSelfSigned,
        }),
      });
      if (!res.ok) throw new Error(await responseErrorMessage(res, 'Failed to update credentials.'));
      const updated = await res.json();
      // Limit or warmup values a queued save is about to change keep showing that save's value.
      mergeAccount(id, settingsSaves.withoutQueuedFields(id, updated));
      // The form shows what was stored, the password as a mask, unless the user has left this mailbox.
      if (openAccountId.current === id) seedCredentialForm(updated);
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

  const retryButton = (
    <Button size="sm" onClick={() => loadData()}>
      <RefreshCw size={14} />
      Retry
    </Button>
  );

  const openAccount = (account: any) => { setSelectedWarmupAccount(account); setActiveTab('warmup'); };

  return (
    <div className="flex w-full flex-col gap-4 pb-12">
      {currentActiveTab === 'accounts' ? (
        <>
          <PageHeader
            title="Email Senders"
            actions={
              <Button variant="primary" onClick={handleOpenAddModal}>
                <Plus size={14} />
                Add Sender Mailbox
              </Button>
            }
          />

          {loadError && !loading && (
            <Notice tone="error" title="Mailboxes Could Not Be Loaded" action={retryButton}>
              {loadError}
            </Notice>
          )}

          {usersError && !loadError && !loading && (
            <Notice tone="warning" title="Team Members Could Not Be Loaded" action={retryButton}>
              Mailboxes owned by others show Unknown Team Member, and the owner picker lists no one until the list loads. {usersError}
            </Notice>
          )}

          {/* KPIs */}
          {!loadError && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <StatCard
                label="Total Senders"
                icon={Users}
                value={loading ? '…' : accounts.length}
                footer="Connected outreach mailboxes"
              />
              <StatCard
                label={globalDaily ? 'Global Limit Remaining' : 'Combined Daily Limit'}
                icon={Gauge}
                value={loading ? '…' : globalDaily ? globalDaily.remaining.toLocaleString() : totalDailyLimit.toLocaleString()}
                footer={globalDaily
                  ? `Of ${globalDaily.limit.toLocaleString()} in 24 hours (${globalDailySource})`
                  : 'Total emails / day across all mailboxes'}
              />
            </div>
          )}

          {/* Table */}
          {loading ? (
            <Card className="p-6">
              <TableSkeleton rows={4} cols={5} />
            </Card>
          ) : loadError ? null : (
            <Card className="overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-card-border px-4 py-3">
                <h2 className="text-sm font-semibold text-text-main">Connected Outreach Senders</h2>
                {failingSyncCount > 0 && (
                  <Badge tone="red">
                    <MailWarning size={12} aria-hidden />
                    {failingSyncCount} {failingSyncCount === 1 ? 'Mailbox' : 'Mailboxes'} Failing Reply Sync
                  </Badge>
                )}
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <tr>
                      <TH>Sender Mailbox</TH>
                      <TH>Reply Sync</TH>
                      <TH>{globalDaily ? 'Remaining' : 'Daily Limit'}</TH>
                      <TH>Owner</TH>
                      <TH>Status</TH>
                      <TH className="text-right">Configure</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {accounts.map((account) => (
                      <TR key={account.id} onClick={() => openAccount(account)} className="cursor-pointer">
                        <TD>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{account.emailAddress}</span>
                            {account.warmupEnabled && (
                              <Badge tone="amber">
                                <Flame size={12} aria-hidden />
                                Warmup
                              </Badge>
                            )}
                          </div>
                          <div className="mt-0.5 text-xs text-text-sub">{account.name} • {account.provider}</div>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-text-muted">
                            <span>Sent: <strong className="font-semibold text-text-main">{account.sentTotal ?? 0}</strong></span>
                            <span>Delivered: {deliveryUnknown(account) ? (
                              <UnknownFigure note={NO_DELIVERY_REPORTS_NOTE} label="No delivery reports" />
                            ) : <><strong className="font-semibold text-emerald-600 dark:text-emerald-400">{account.delivered ?? 0}</strong> ({deliveryRateText(account.deliveryRate, account.reported)})</>}</span>
                            <span>Opens: <strong className="font-semibold text-text-main">{account.opens ?? 0}</strong> ({account.openRate ?? 0}%)</span>
                            <span>Clicks: <strong className="font-semibold text-text-main">{account.clicks ?? 0}</strong> ({account.clickRate ?? 0}%)</span>
                            <RowReplies account={account} accounts={accounts} />
                            <span>Bounces: {bouncesUnknown(account) ? (
                              <UnknownFigure note={NO_BOUNCE_REPORTS_NOTE} label="No delivery reports" />
                            ) : <strong className="font-semibold text-rose-600 dark:text-rose-400">{account.bounced ?? 0}</strong>}</span>
                          </div>
                        </TD>
                        <TD>
                          <ReplySyncChip account={account} accounts={accounts} />
                        </TD>
                        <TD className="min-w-[150px]">
                          <MailboxCapacityGauge
                            used={account.sentLast24Hours ?? 0}
                            total={account.dailyLimit ?? 0}
                            warmup={account.warmupEnabled}
                            warmupCap={account.warmupEnabled ? currentCap(account) : undefined}
                            remaining={globalDaily ? remainingOfAllowance(account) : mailboxRemaining(account)}
                            compact={true}
                          />
                        </TD>
                        <TD className="text-text-sub">
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><User size={12} aria-hidden /> {getOwnerName(account.userId)}</span>
                        </TD>
                        <TD>
                          {account.status === 'Active' ? (
                            <Badge tone="green" dot>Active</Badge>
                          ) : (
                            <Badge>
                              <AlertCircle size={12} aria-hidden />
                              {account.status}
                            </Badge>
                          )}
                        </TD>
                        <TD className="text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => { e.stopPropagation(); openAccount(account); }}
                            aria-label={`Configure ${account.emailAddress}`}
                          >
                            Configure
                            <ChevronRight size={14} />
                          </Button>
                        </TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </div>
            </Card>
          )}
        </>
      ) : (
        /* Detail view */
        <>
          <div className="flex flex-col gap-3 md:flex-row md:items-start">
            <Button iconOnly aria-label="Back to mailbox list" title="Back to Mailboxes" onClick={() => setSelectedWarmupAccount(null)}>
              <ArrowLeft size={16} />
            </Button>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight break-all text-text-main">{selectedWarmupAccount.emailAddress}</h1>
                <Badge tone="blue">{selectedWarmupAccount.provider}</Badge>
                {selectedWarmupAccount.warmupEnabled && (
                  <Badge tone="amber">
                    <Flame size={12} aria-hidden />
                    Warmup Active
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-text-sub">
                {selectedWarmupAccount.warmupEnabled ? (() => {
                  const startedAt = selectedWarmupAccount.warmupStartedAt ? new Date(selectedWarmupAccount.warmupStartedAt) : new Date();
                  const daysActive = Math.max(0, Math.floor((new Date().getTime() - startedAt.getTime()) / 86400000));
                  const effectiveCap = currentCap(selectedWarmupAccount);
                  return <span className="font-medium text-amber-700 dark:text-amber-300">Warmup Day {daysActive + 1} · Current Cap: {effectiveCap}{globalDaily ? '' : ` / ${selectedWarmupAccount.dailyLimit} daily limit`}</span>;
                })() : globalDaily
                  ? 'Configure warmup, connection details, and credentials for this mailbox.'
                  : 'Configure the daily sending limit, connection details, and credentials for this mailbox.'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={sendingTestEmail} onClick={handleSendTestEmail}>
                {sendingTestEmail ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                {sendingTestEmail ? 'Sending…' : 'Send Test Email'}
              </Button>
              <Button variant="danger" disabled={deleting} onClick={() => setConfirmOpen(true)}>
                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                {deleting ? 'Deleting…' : 'Delete Mailbox'}
              </Button>
            </div>
          </div>

          {/* Deliverability stats */}
          <Card className="p-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
              {[
                { title: 'Total Sent', value: selectedWarmupAccount.sentTotal ?? 0, desc: 'All campaigns' },
                deliveryUnknown(selectedWarmupAccount)
                  ? { title: 'Delivered', value: '—', desc: 'No delivery reports for these emails' }
                  : { title: 'Delivered', value: selectedWarmupAccount.delivered ?? 0, desc: deliveryRateText(selectedWarmupAccount.deliveryRate, selectedWarmupAccount.reported) },
                { title: 'Unique Opens', value: selectedWarmupAccount.opens ?? 0, desc: `${selectedWarmupAccount.openRate ?? 0}% open rate` },
                { title: 'Unique Clicks', value: selectedWarmupAccount.clicks ?? 0, desc: `${selectedWarmupAccount.clickRate ?? 0}% click rate` },
                // Per 100 emails sent where that means something, not a share of leads: replies to this mailbox may answer another mailbox's emails.
                repliesTile(selectedWarmupAccount, accounts),
                bouncesUnknown(selectedWarmupAccount)
                  ? { title: 'Bounced', value: '—', desc: 'No delivery reports for these emails', caveat: NO_BOUNCE_REPORTS_NOTE }
                  : { title: 'Bounced', value: selectedWarmupAccount.bounced ?? 0, desc: 'Hard bounces' },
              ].map((s: StatTile, idx) => (
                <div key={idx} className="rounded-control bg-slate-50 p-3 dark:bg-white/[0.03]">
                  <div className="text-[11px] font-medium text-text-muted">{s.title}</div>
                  <div className="mt-1 text-lg font-semibold text-text-main">{s.value.toLocaleString()}</div>
                  <div className="mt-0.5 text-[11px] text-text-muted">{s.desc}{s.caveat && <CaveatMark note={s.caveat} />}</div>
                </div>
              ))}
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
            {/* Credentials */}
            <Card className="p-4">
              <CardHeader title="Mailbox Connection Credentials" className="mb-3" />
              <form onSubmit={handleSaveAccountCredentials} className="space-y-4">
                <TextInput label="Reply-To Address (Optional)" type="email" placeholder="replies@mycompany.com" value={editReplyTo} onChange={(e) => setEditReplyTo(e.target.value)} className="max-w-[360px]" />
                <ReplyToNameField value={editReplyToName} onChange={setEditReplyToName} replyTo={editReplyTo} className="max-w-[360px]" />
                <SmtpNotUsedNote />
                {/* Any mailbox can sync replies over IMAP, whatever its provider label */}
                <div className={cn(SUB_BOX, 'space-y-3')}>
                  <h3 className="text-[13px] font-semibold text-text-main">Inbound Replies (IMAP)</h3>
                  <div>
                    <ReplySyncChip account={selectedWarmupAccount} accounts={accounts} withTooltip={false} />
                    <p className={cn('mt-1.5 text-xs [overflow-wrap:anywhere]', mailboxReplySync(selectedWarmupAccount, accounts).state === 'failing' ? 'text-rose-600 dark:text-rose-400' : 'text-text-sub')}>
                      {replySyncDetail(selectedWarmupAccount, accounts)}
                    </p>
                  </div>
                  {(selectedWarmupAccount.provider === 'Microsoft 365' || isMicrosoftImapHost(editImapHost)) && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">{MICROSOFT_IMAP_NOTE}</p>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <TextInput label="IMAP Host" value={editImapHost} onChange={(e) => setEditImapHost(e.target.value)} autoComplete="off" />
                    <TextInput label="Port" value={editImapPort} onChange={(e) => setEditImapPort(e.target.value)} autoComplete="off" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <TextInput label="Username" value={editImapUser} onChange={(e) => setEditImapUser(e.target.value)} autoComplete="off" />
                    <PwField label="Password" value={editImapPass} onChange={setEditImapPass} show={showEditImapPass} setShow={setShowEditImapPass} />
                  </div>
                  <AllowSelfSignedSwitch checked={editImapAllowSelfSigned} onChange={setEditImapAllowSelfSigned} />
                </div>
                <div className="flex justify-end">
                  <Button type="submit" variant="primary" disabled={savingCredentials}>
                    {savingCredentials ? <Loader2 size={14} className="animate-spin" /> : null}
                    {savingCredentials ? 'Saving…' : 'Save Credentials'}
                  </Button>
                </div>
              </form>
            </Card>

            <div className="flex flex-col gap-4">
              {/* Sending limits */}
              <Card className="p-4">
                <CardHeader title="Sending Limits" className="mb-3" />
                {globalDaily ? (
                  <p className="text-[13px] text-text-sub">
                    This mailbox has no daily limit of its own while a global rate limit is set. All mailboxes share {globalDaily.limit.toLocaleString()} emails in any 24 hours ({globalDailySource}), and <strong className="font-semibold text-text-main">{remainingOfAllowance(selectedWarmupAccount).toLocaleString()}</strong> {selectedWarmupAccount.warmupEnabled ? 'are left for this mailbox under its warmup cap.' : 'are left.'}
                  </p>
                ) : (
                  <TextInput label={MAILBOX_LIMIT_FIELDS.dailyLimit.label} type="number" {...limitInputProps('dailyLimit', selectedWarmupAccount.dailyLimit)} min={MAILBOX_LIMIT_FIELDS.dailyLimit.min} className="max-w-[240px]" />
                )}
                <div className="mt-4"><GlobalRateLimits limits={globalRateLimits} /></div>
              </Card>

              {/* Recipient domains: saved as the list changes, like the limits */}
              <Card className="p-4">
                <CardHeader title="Recipient Domains" className="mb-3" />
                <RecipientDomainsInput
                  value={selectedWarmupAccount.recipientDomains ?? []}
                  onChange={(domains) => handleUpdateWarmupSettings('recipientDomains', domains, 'Recipient Domains failed to save.')}
                  onInvalid={(error) => showToast(`${error} It was not saved.`, 'error')}
                  helperText={(selectedWarmupAccount.recipientDomains ?? []).length > 0
                    ? 'In every campaign, this mailbox sends only to leads at these domains and mail providers. Clear the list to set it per campaign on the Senders tab.'
                    : 'Leave empty to set it per campaign on the Senders tab. With domains or mail providers here, this mailbox sends only to leads at them, in every campaign.'}
                />
                <p className="mt-3 text-xs text-text-sub">
                  A domain matches exactly: gmail.com does not cover a company address whose mail Google hosts. A mail provider covers every address it hosts, company domains included.
                </p>
              </Card>

              {/* Warmup */}
              <Card className="p-4">
                <CardHeader title="Warmup Autopilot Settings" className="mb-3" />
                <div className="flex items-start justify-between gap-3 rounded-control border border-card-border p-3">
                  <div>
                    <span id="warmup-autopilot-label" className="block text-[13px] font-medium text-text-main">Warmup Autopilot</span>
                    <span className="mt-0.5 block text-xs text-text-sub">Slowly ramp up daily volume to establish sender domain reputation. Turning it on again restarts the ramp at Day 1.</span>
                  </div>
                  <Switch
                    checked={!!selectedWarmupAccount.warmupEnabled}
                    onChange={(checked) => handleUpdateWarmupSettings('warmupEnabled', checked)}
                    aria-labelledby="warmup-autopilot-label"
                    className="mt-0.5"
                  />
                </div>
                {selectedWarmupAccount.warmupEnabled && (
                  <div className="mt-4 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <TextInput label={MAILBOX_LIMIT_FIELDS.warmupLimit.label} type="number" {...limitInputProps('warmupLimit', selectedWarmupAccount.warmupLimit ?? 50)} min={MAILBOX_LIMIT_FIELDS.warmupLimit.min} max={globalDaily ? undefined : selectedWarmupAccount.dailyLimit} />
                      <TextInput label={MAILBOX_LIMIT_FIELDS.warmupRamp.label} type="number" {...limitInputProps('warmupRamp', selectedWarmupAccount.warmupRamp ?? 2)} min={MAILBOX_LIMIT_FIELDS.warmupRamp.min} />
                    </div>
                    <div className="rounded-control border border-amber-200 bg-amber-50 p-3 text-amber-800 dark:border-amber-900/50 dark:bg-amber-500/10 dark:text-amber-300">
                      <div className="mb-1 text-xs font-semibold">Warmup Progress</div>
                      <ul className="list-disc space-y-0.5 pl-4 text-xs">
                        <li>Started On: <strong>{selectedWarmupAccount.warmupStartedAt ? new Date(selectedWarmupAccount.warmupStartedAt).toLocaleDateString() : 'Just now'}</strong></li>
                        <li>Emails Sent This Ramp: <strong>{selectedWarmupAccount.warmupSent ?? 0}</strong></li>
                        <li>Current Limit: <strong>{currentCap(selectedWarmupAccount)}</strong> emails per 24 hours</li>
                      </ul>
                    </div>
                  </div>
                )}
              </Card>
            </div>
          </div>
        </>
      )}

      {/* Connect Mailbox Action Drawer */}
      <ActionDrawer
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        title="Connect Mailbox"
        subtitle="Add an authenticated SMTP or Microsoft 365 sending account"
        icon={Plus}
        width="md"
        onSubmit={handleAddAccount}
        primaryLabel={submitting ? 'Connecting…' : 'Connect Mailbox'}
        primaryLoading={submitting}
        primaryDisabled={submitting || !emailAddress.trim() || !senderName.trim()}
        cancelLabel="Cancel"
        onCancel={() => setIsAddOpen(false)}
      >
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[2fr_1fr]">
            <TextInput label="Sender Email Address" type="email" required value={emailAddress} onChange={(e) => setEmailAddress(e.target.value)} placeholder="outreach@mycompany.com" />
            <TextInput label="Internal Label" required value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="Sales Outreach" hint="Shown only in ArcReach. Recipients see the From name set on the sender username in Azure." />
            <TextInput label="Reply-To (Optional)" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="replies@mycompany.com" />
            <ReplyToNameField value={replyToName} onChange={setReplyToName} replyTo={replyTo} />
            <div className="md:col-span-2">
              <label htmlFor="add-mailbox-provider" className={LABEL}>Email Provider</label>
              <select id="add-mailbox-provider" value={provider} onChange={(e) => handleProviderChange(e.target.value)} className={inputClasses('h-9 cursor-pointer')}>
                <option value="Google Workspace">Google Workspace</option>
                <option value="Microsoft 365">Microsoft 365</option>
                <option value="IMAP/SMTP Custom Protocol">IMAP/SMTP Custom</option>
                <option value="SendGrid Relay Node">SendGrid Relay</option>
                <option value="Azure Relay Node">Azure Relay</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="add-mailbox-owner" className={LABEL}>Assign Mailbox Owner</label>
            <select
              id="add-mailbox-owner"
              value={assignedUserId}
              onChange={(e) => setAssignedUserId(e.target.value)}
              disabled={session?.role !== 'ADMIN'}
              className={inputClasses('h-9 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60')}
            >
              {session?.role !== 'ADMIN' ? (
                <option value={session?.id}>Me ({session?.name})</option>
              ) : (
                // Disabled users cannot sign in, so they are not offered as owners.
                users.filter((u) => !u.disabledAt).map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)
              )}
            </select>
          </div>

          <div className="rounded-control bg-slate-50 p-3 dark:bg-white/[0.03]">
            <SmtpNotUsedNote />
          </div>

          {/* Any mailbox can sync replies over IMAP, whatever its provider label */}
          <div className={cn(SUB_BOX, 'space-y-3')}>
            <h3 className="text-[13px] font-semibold text-text-main">Inbound Replies (IMAP)</h3>
            {(provider === 'Microsoft 365' || isMicrosoftImapHost(imapHost)) && (
              <p className="text-xs text-amber-700 dark:text-amber-300">{MICROSOFT_IMAP_NOTE}</p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <TextInput label="IMAP Host" value={imapHost} onChange={(e) => setImapHost(e.target.value)} autoComplete="off" />
              <TextInput label="Port" value={imapPort} onChange={(e) => setImapPort(e.target.value)} placeholder="993" autoComplete="off" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <TextInput label="Username" value={imapUser} onChange={(e) => setImapUser(e.target.value)} placeholder="user@domain.com" autoComplete="off" />
              <PwField label="Password" value={imapPass} onChange={setImapPass} show={showAddImapPass} setShow={setShowAddImapPass} placeholder="Password or App Key" />
            </div>
            <AllowSelfSignedSwitch checked={imapAllowSelfSigned} onChange={setImapAllowSelfSigned} />
          </div>

          <div className={cn(SUB_BOX, 'space-y-4')}>
            <h3 className="text-[13px] font-semibold text-text-main">Sending Limits</h3>
            {!globalDaily && (
              <TextInput label="Max / Day" type="number" value={dailyLimit} onChange={(e) => setDailyLimit(parseInt(e.target.value) || 10)} min={10} className="max-w-[240px]" />
            )}
            <GlobalRateLimits limits={globalRateLimits} />
            {globalDaily ? (
              <div className="space-y-2 border-t border-card-border pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-text-muted">Global Daily Allowance</span>
                  <span className="text-xs font-medium text-primary">{globalDaily.sent.toLocaleString()} / {globalDaily.limit.toLocaleString()} sent in the last 24 hours</span>
                </div>
                <ProgressBar pct={Math.min(100, (globalDaily.sent / globalDaily.limit) * 100)} />
                <p className="text-xs text-text-sub">
                  All mailboxes share this allowance, which is {globalDaily.per === 'hour' ? '24' : '1,440'} times the global limit of {globalDailySource}. A mailbox has no daily limit of its own while a global rate limit is set; only its warmup ramp holds it lower.
                </p>
                <div className={cn(MINI_TILES, 'grid-cols-2')}>
                  <div><div className="text-[11px] text-text-muted">Remaining</div><div className="text-[13px] font-semibold text-text-main">{globalDaily.remaining.toLocaleString()} / day</div></div>
                  <div><div className="text-[11px] text-text-muted">Mailboxes</div><div className="text-[13px] font-semibold text-text-main">{accounts.length}</div></div>
                </div>
              </div>
            ) : accounts.length > 0 && (
              <div className="space-y-2 border-t border-card-border pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-text-muted">Combined Daily Capacity</span>
                  <span className="text-xs font-medium text-primary">{dailyCapacity.sent.toLocaleString()} / {dailyCapacity.cap.toLocaleString()} sent in the last 24 hours</span>
                </div>
                <ProgressBar pct={Math.min(100, dailyCapacity.cap > 0 ? (dailyCapacity.sent / dailyCapacity.cap) * 100 : 0)} />
                <div className={cn(MINI_TILES, 'grid-cols-3')}>
                  <div><div className="text-[11px] text-text-muted">Remaining</div><div className="text-[13px] font-semibold text-text-main">{dailyCapacity.remaining.toLocaleString()} / day</div></div>
                  <div><div className="text-[11px] text-text-muted">Mailboxes</div><div className="text-[13px] font-semibold text-text-main">{accounts.length}</div></div>
                  <div><div className="text-[11px] text-text-muted">Avg / Account</div><div className="text-[13px] font-semibold text-text-main">{accounts.length > 0 ? Math.round(dailyCapacity.cap / accounts.length).toLocaleString() : 0}</div></div>
                </div>
              </div>
            )}
            <p className="text-xs text-text-sub">
              Keep volumes conservative — most mailboxes shouldn't exceed ~500 emails/day to protect sender reputation.
            </p>
          </div>
        </div>
      </ActionDrawer>

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
    </div>
  );
}

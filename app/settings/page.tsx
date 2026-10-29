/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import {
  Save, User, Send, Eye, EyeOff, RefreshCw, Lock, MailX, Loader2,
} from 'lucide-react';
import { useState, useEffect, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { MIN_PASSWORD_LENGTH, passwordPolicyError } from '@/lib/passwordPolicy';
import { profileInitials } from '@/lib/profileInitials';
import { type RateLimitInput, type RateLimitPeriod, rateLimitInputFrom, rateLimitInputValue } from '@/lib/rateLimitPolicy';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Snackbar, Alert, Autocomplete, TextField } from '@mui/material';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { inputClasses } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { cn } from '@/lib/utils';

const LABEL = 'mb-1.5 block text-[13px] font-medium text-text-main';
const CARD_DESC = 'mt-1 text-xs leading-relaxed text-text-sub';
const FORM_FOOTER = 'flex items-center justify-end gap-2 border-t border-card-border pt-4';

/** A labelled native text field, the label above it and an optional hint or error below. */
function TextInput({ label, hint, error, reserveHint, className, ...props }: InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode; hint?: ReactNode; error?: string;
  /** Keep the hint line's height when there is no hint, so fields side by side stay aligned. */
  reserveHint?: boolean;
}) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className={LABEL}>
        {label}{props.required && <span className="text-rose-500"> *</span>}
      </label>
      <input
        id={id}
        aria-invalid={!!error || undefined}
        className={inputClasses(cn('h-9 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-text-sub dark:disabled:bg-white/[0.03]', error && 'border-rose-400 dark:border-rose-700'))}
        {...props}
      />
      {error
        ? <p className="mt-1 min-h-4 text-[11px] leading-4 text-rose-600 dark:text-rose-400">{error}</p>
        : (hint || reserveHint) && <p className="mt-1 min-h-4 text-[11px] leading-4 text-text-muted">{hint}</p>}
    </div>
  );
}

/** A secret field with a show/hide toggle at its end. */
function SecretInput({ label, show, setShow, toggleLabel, mono, className, ...props }: InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode; show: boolean; setShow: (show: boolean) => void; toggleLabel: string; mono?: boolean;
}) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className={LABEL}>
        {label}{props.required && <span className="text-rose-500"> *</span>}
      </label>
      <div className="relative">
        <input id={id} type={show ? 'text' : 'password'} className={inputClasses(cn('h-9 pr-9', mono && 'font-mono text-xs'))} {...props} />
        <button
          type="button"
          aria-label={`${show ? 'Hide' : 'Show'} ${toggleLabel}`}
          onClick={() => setShow(!show)}
          className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-text-muted transition-colors hover:text-text-main"
        >
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </div>
  );
}

function RateLimitField({ per, input, error, onChange }: {
  per: RateLimitPeriod; input: RateLimitInput; error: string; onChange: (input: RateLimitInput) => void;
}) {
  const unit = per === 'minute' ? 'Minute' : 'Hour';
  return (
    <div className="flex-1 space-y-2">
      <TextInput
        type="number" min={1} step={1} label={`Max Emails / ${unit}`}
        value={input.noLimit ? '' : input.text} onChange={(e) => onChange({ ...input, text: e.target.value })}
        disabled={input.noLimit} required={!input.noLimit} placeholder={input.noLimit ? 'No limit' : undefined}
        error={error} hint={input.noLimit ? `Emails are not capped per ${per}.` : undefined} reserveHint
      />
      <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-text-main">
        <input type="checkbox" className="size-4 cursor-pointer accent-primary" checked={input.noLimit} onChange={(e) => onChange({ ...input, noLimit: e.target.checked })} />
        No Limit
      </label>
    </div>
  );
}

const NAV_ITEM = 'flex w-full cursor-pointer items-center gap-2.5 rounded-control px-3 py-2 text-[13px] font-medium whitespace-nowrap transition-colors';
const NAV_ON = 'bg-primary-subtle text-primary';
const NAV_OFF = 'text-text-sub hover:bg-slate-100 hover:text-text-main dark:hover:bg-white/5';

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<'profile' | 'integrations'>('profile');
  const [toastMessage, setToastMessage] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const triggerToast = (msg: string) => { setToastMessage(msg); setTimeout(() => setToastMessage(''), 4000); };

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [orgName, setOrgName] = useState('');
  const avatarInitials = profileInitials(firstName, lastName, email);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [showNewPass, setShowNewPass] = useState(false);
  const [showConfirmPass, setShowConfirmPass] = useState(false);

  const [activeProvider, setActiveProvider] = useState('');
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  const [azureConnString, setAzureConnString] = useState('');
  const [azureSenderDomains, setAzureSenderDomains] = useState<string[]>([]);
  const [showAzureConnString, setShowAzureConnString] = useState(false);

  const [rateLimitMinute, setRateLimitMinute] = useState<RateLimitInput>({ noLimit: false, text: '' });
  const [rateLimitHour, setRateLimitHour] = useState<RateLimitInput>({ noLimit: false, text: '' });
  const [rateLimitErrors, setRateLimitErrors] = useState({ minute: '', hour: '' });
  const [rateLimitLoading, setRateLimitLoading] = useState(false);

  const loadSettings = async () => {
    try {
      setLoading(true);
      setLoadError('');
      const res = await fetch('/api/settings');
      const data = await res.json().catch(() => ({}));
      const admin = data.settings != null;
      if (res.ok && data.user) {
        setIsAdmin(admin);
        const fullName = data.user.name || '';
        const parts = fullName.split(' ');
        setFirstName(parts[0] || '');
        setLastName(parts.slice(1).join(' ') || '');
        setEmail(data.user.email || '');
        setOrgName(data.user.organization || '');
        if (data.settings) {
          setActiveProvider(data.settings.activeProvider === 'AZURE' ? 'AZURE' : 'DISABLED');
          setAzureConnString(data.settings.azureConnString || '');
          const domains = Array.isArray(data.settings.azureSenderDomains) ? data.settings.azureSenderDomains
            : (data.settings.azureSenderDomain ? [data.settings.azureSenderDomain] : []);
          setAzureSenderDomains(domains.map((d: string) => String(d).trim().toLowerCase()).filter(Boolean));
          setRateLimitMinute(rateLimitInputFrom(data.settings.rateLimitMinute));
          setRateLimitHour(rateLimitInputFrom(data.settings.rateLimitHour));
          setRateLimitErrors({ minute: '', hour: '' });
        }
      } else {
        setLoadError(data.error || 'The server did not return your settings.');
      }
    } catch (e) { console.error(e); setLoadError('The settings request failed. Check your connection and try again.'); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadSettings(); }, []);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${firstName} ${lastName}`.trim(), organization: orgName }),
      });
      if (res.ok) { triggerToast('Profile information saved successfully.'); window.location.reload(); }
      else triggerToast('Failed to save profile.');
    } catch (err) { console.error(err); triggerToast('Error saving profile.'); }
  };

  const handleSaveRateLimits = async (e: React.FormEvent) => {
    e.preventDefault();
    const minute = rateLimitInputValue(rateLimitMinute, 'minute');
    const hour = rateLimitInputValue(rateLimitHour, 'hour');
    setRateLimitErrors({ minute: minute.error || '', hour: hour.error || '' });
    if (minute.error || hour.error) return;
    setRateLimitLoading(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rateLimitMinute: minute.value, rateLimitHour: hour.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (data.settings) {
          setRateLimitMinute(rateLimitInputFrom(data.settings.rateLimitMinute));
          setRateLimitHour(rateLimitInputFrom(data.settings.rateLimitHour));
        }
        triggerToast('Service-level rate limits saved successfully.');
      } else {
        triggerToast(data.error || 'Failed to save rate limits.');
      }
    } catch (err) { console.error(err); triggerToast('Error saving rate limits.'); }
    finally { setRateLimitLoading(false); }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPassword || !newPassword) { triggerToast('Please fill out all password fields.'); return; }
    const passwordError = passwordPolicyError(newPassword);
    if (passwordError) { triggerToast(passwordError); return; }
    if (newPassword !== confirmPassword) { triggerToast('New passwords do not match.'); return; }
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (res.ok) {
        triggerToast('Password updated. Your other sessions were signed out.');
        setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      } else {
        const errData = await res.json();
        triggerToast(errData.error || 'Failed to update password.');
      }
    } catch (err) { console.error(err); triggerToast('Error updating password.'); }
  };

  const handleProviderChange = async (newProvider: string) => {
    const previousProvider = activeProvider;
    setPendingProvider(null);
    setActiveProvider(newProvider);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeProvider: newProvider }),
      });
      if (res.ok) {
        triggerToast(newProvider === 'AZURE' ? 'Delivery provider set to Azure Communication Services.' : 'Sending disabled. No email will be sent.');
      } else {
        setActiveProvider(previousProvider);
        const data = await res.json().catch(() => ({}));
        triggerToast(data.error || 'Failed to update active delivery provider.');
      }
    } catch (e) { console.error(e); setActiveProvider(previousProvider); triggerToast('Error updating active delivery provider.'); }
  };

  const handleSaveAzureConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ azureConnString, azureSenderDomains }),
      });
      triggerToast(res.ok ? 'Azure Communication Services configuration saved successfully.' : 'Failed to save Azure settings.');
    } catch (err) { console.error(err); triggerToast('Error saving Azure settings.'); }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-xs text-text-muted">
        <Loader2 size={14} className="animate-spin" /> Loading settings…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-[900px] py-12">
        <Notice
          tone="error"
          title="Settings Could Not Be Loaded"
          action={<Button size="sm" onClick={() => loadSettings()}><RefreshCw size={12} /> Retry</Button>}
        >
          {loadError}
        </Notice>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[960px] space-y-5 pb-16">
      <ConfirmDialog
        isOpen={pendingProvider !== null}
        title={pendingProvider === 'AZURE' ? 'Switch to Azure Communication Services?' : 'Disable Sending?'}
        message={pendingProvider === 'AZURE'
          ? 'Active campaigns will send real email to their leads through Azure Communication Services once its connection string and verified sender domains are saved.'
          : 'No email will be sent while sending is disabled. Active campaigns stop progressing, and campaign runs, Unibox replies and test emails are refused until Azure Communication Services is selected again.'}
        confirmLabel={pendingProvider === 'AZURE' ? 'Use Azure' : 'Disable Sending'}
        onConfirm={() => { if (pendingProvider) handleProviderChange(pendingProvider); }}
        onCancel={() => setPendingProvider(null)}
        isDestructive={pendingProvider !== 'AZURE'}
      />
      <Snackbar open={!!toastMessage} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} autoHideDuration={4000} onClose={() => setToastMessage('')}>
        {toastMessage ? <Alert severity="info" variant="filled" sx={{ borderRadius: '12px' }}>{toastMessage}</Alert> : undefined}
      </Snackbar>

      <div>
        <PageHeader title="Settings" />
        <p className="mt-1 text-xs text-text-sub">
          {isAdmin ? 'Manage your profile, password, and email delivery settings.' : 'Manage your profile and password. Email delivery is managed by your admin.'}
        </p>
      </div>

      <div className="flex flex-col gap-5 md:flex-row">
        <nav aria-label="Settings sections" className="w-full shrink-0 md:w-52">
          <div className="flex gap-1 md:flex-col">
            <button
              type="button"
              aria-current={activeTab === 'profile' ? 'page' : undefined}
              onClick={() => setActiveTab('profile')}
              className={cn(NAV_ITEM, activeTab === 'profile' ? NAV_ON : NAV_OFF)}
            >
              <User size={15} /> My Profile
            </button>
            {isAdmin && (
              <button
                type="button"
                aria-current={activeTab === 'integrations' ? 'page' : undefined}
                onClick={() => setActiveTab('integrations')}
                className={cn(NAV_ITEM, activeTab === 'integrations' ? NAV_ON : NAV_OFF)}
              >
                <Send size={15} /> Email Delivery
              </button>
            )}
          </div>
        </nav>

        <div className="min-w-0 flex-1 space-y-5">
          {activeTab === 'profile' && (
            <>
              <Card className="p-5">
                <CardHeader title="Profile Information" />
                <form onSubmit={handleSaveProfile} className="mt-4 space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-base font-semibold text-primary">
                      {avatarInitials || <User size={20} />}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-text-main">{firstName} {lastName}</div>
                      <div className="mt-0.5 truncate text-xs text-text-muted">{email}</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <TextInput label="First Name" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" />
                    <TextInput label="Last Name" value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" />
                  </div>
                  <TextInput label="Organization" value={orgName} onChange={(e) => setOrgName(e.target.value)} autoComplete="organization" />
                  <TextInput label="Email Address" type="email" value={email} disabled />

                  <div className={FORM_FOOTER}>
                    <Button variant="ghost" onClick={() => loadSettings()}>Reset Fields</Button>
                    <Button type="submit" variant="primary"><Save size={14} /> Save Profile</Button>
                  </div>
                </form>
              </Card>

              <Card className="p-5">
                <CardHeader title="Change Password" />
                <form onSubmit={handleUpdatePassword} className="mt-4 space-y-4">
                  <SecretInput
                    label="Current Password" toggleLabel="current password" autoComplete="current-password"
                    show={showPass} setShow={setShowPass}
                    value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
                  />
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <SecretInput
                      label="New Password" toggleLabel="new password" autoComplete="new-password"
                      show={showNewPass} setShow={setShowNewPass} placeholder={`Min. ${MIN_PASSWORD_LENGTH} characters`}
                      value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                    />
                    <SecretInput
                      label="Confirm New Password" toggleLabel="confirmation password" autoComplete="new-password"
                      show={showConfirmPass} setShow={setShowConfirmPass} placeholder="Retype password"
                      value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                    />
                  </div>

                  <div className={FORM_FOOTER}>
                    <Button type="submit" variant="primary"><Lock size={14} /> Update Password</Button>
                  </div>
                </form>
              </Card>
            </>
          )}

          {isAdmin && activeTab === 'integrations' && (
            <>
              <Card className="space-y-4 p-5">
                <div>
                  <CardHeader title="Email Delivery Provider" />
                  <p className={CARD_DESC}>Choose the provider used to send your outbound email.</p>
                </div>

                <div className="max-w-[380px]">
                  <label htmlFor="delivery-provider" className={LABEL}>Provider</label>
                  <select
                    id="delivery-provider"
                    value={activeProvider}
                    onChange={(e) => { if (e.target.value !== activeProvider) setPendingProvider(e.target.value); }}
                    className={inputClasses('h-9 cursor-pointer')}
                  >
                    <option value="DISABLED">Sending Disabled (no email is sent)</option>
                    <option value="AZURE">Azure Communication Services</option>
                  </select>
                </div>

                {activeProvider === 'DISABLED' && (
                  <div className="flex items-start gap-2.5 rounded-control border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-500/10">
                    <MailX size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                    <div>
                      <div className="text-[13px] font-semibold text-amber-800 dark:text-amber-300">Sending Disabled</div>
                      <p className="mt-0.5 text-xs leading-relaxed text-amber-800/90 dark:text-amber-300/90">
                        No email is sent and campaigns do not progress. Campaign runs, Unibox replies and test emails are refused until Azure Communication Services is selected and configured.
                      </p>
                    </div>
                  </div>
                )}

                {activeProvider === 'AZURE' && (
                  <form onSubmit={handleSaveAzureConfig} className="space-y-4 rounded-control border border-card-border bg-slate-50/60 p-4 dark:bg-white/[0.02]">
                    <SecretInput
                      label="Azure Connection String" toggleLabel="connection string" required mono autoComplete="off"
                      show={showAzureConnString} setShow={setShowAzureConnString}
                      value={azureConnString} onChange={(e) => setAzureConnString(e.target.value)}
                      placeholder="endpoint=https://...;accesskey=..."
                    />
                    <Autocomplete
                      multiple freeSolo options={[] as string[]}
                      value={azureSenderDomains}
                      onChange={(_, v) => setAzureSenderDomains(
                        (v as string[]).map((d) => String(d).trim().toLowerCase()).filter(Boolean)
                      )}
                      renderInput={(params) => (
                        <TextField
                          {...params} size="small" label="Verified Sender Domains"
                          placeholder="Type a domain and press Enter"
                          helperText="Each sender account sends from its own address; its domain must be verified here."
                        />
                      )}
                    />
                    <div className="flex justify-end">
                      <Button type="submit" variant="primary"><Save size={14} /> Save Azure Configuration</Button>
                    </div>
                  </form>
                )}
              </Card>

              <Card className="p-5">
                <CardHeader title="Global Sending Rate Limits" />
                <p className={CARD_DESC}>
                  Caps total outbound volume across all campaigns and sender mailboxes. Choose No Limit to leave a period uncapped. While either limit is set, mailboxes have no daily limits of their own: together they share 24 times the hourly limit in any 24 hours (or 1,440 times the per-minute limit, if that is lower), and only a warmup ramp holds a mailbox below that. With both set to No Limit, each mailbox is held to its own daily limit.
                </p>

                <form onSubmit={handleSaveRateLimits} className="mt-4 space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <RateLimitField per="minute" input={rateLimitMinute} error={rateLimitErrors.minute}
                      onChange={(v) => { setRateLimitMinute(v); setRateLimitErrors((errs) => ({ ...errs, minute: '' })); }} />
                    <RateLimitField per="hour" input={rateLimitHour} error={rateLimitErrors.hour}
                      onChange={(v) => { setRateLimitHour(v); setRateLimitErrors((errs) => ({ ...errs, hour: '' })); }} />
                  </div>
                  <div className={FORM_FOOTER}>
                    <Button type="submit" variant="primary" disabled={rateLimitLoading}>
                      {rateLimitLoading ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                      {rateLimitLoading ? 'Saving…' : 'Save Limits'}
                    </Button>
                  </div>
                </form>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

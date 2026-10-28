/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import {
  Save, User, Key, Eye, EyeOff, RefreshCw, Lock, MailX,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { MIN_PASSWORD_LENGTH, passwordPolicyError } from '@/lib/passwordPolicy';
import { profileInitials } from '@/lib/profileInitials';
import { type RateLimitInput, type RateLimitPeriod, rateLimitInputFrom, rateLimitInputValue } from '@/lib/rateLimitPolicy';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  TextField, Select, MenuItem, FormControl, InputLabel, Snackbar, Alert, AlertTitle,
  InputAdornment, CircularProgress, Autocomplete, Checkbox, FormControlLabel,
} from '@mui/material';

function RateLimitField({ per, input, error, onChange }: {
  per: RateLimitPeriod; input: RateLimitInput; error: string; onChange: (input: RateLimitInput) => void;
}) {
  const unit = per === 'minute' ? 'Minute' : 'Hour';
  return (
    <div className="flex-1 space-y-1.5">
      <TextField
        fullWidth size="small" type="number" label={`Max Emails / ${unit}`}
        value={input.noLimit ? '' : input.text} onChange={(e) => onChange({ ...input, text: e.target.value })}
        disabled={input.noLimit} required={!input.noLimit} placeholder={input.noLimit ? 'No limit' : undefined}
        error={!!error} helperText={error || (input.noLimit ? `Emails are not capped per ${per}.` : ' ')}
        slotProps={{ htmlInput: { min: 1, step: 1 } }}
      />
      <FormControlLabel
        control={<Checkbox size="small" checked={input.noLimit} onChange={(e) => onChange({ ...input, noLimit: e.target.checked })} />}
        label={<span className="text-xs font-semibold text-slate-700 dark:text-slate-300">No Limit</span>}
      />
    </div>
  );
}

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
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <CircularProgress size={28} />
        <span className="text-xs text-slate-500">Loading settings…</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-[900px] mx-auto py-12">
        <Alert
          severity="error"
          sx={{ borderRadius: '16px' }}
          action={<button type="button" className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-white/20 hover:bg-white/30 text-inherit cursor-pointer" onClick={() => loadSettings()}><RefreshCw size={14} /> Retry</button>}
        >
          <AlertTitle>Settings Could Not Be Loaded</AlertTitle>
          {loadError}
        </Alert>
      </div>
    );
  }

  return (
    <div className="max-w-[960px] mx-auto pb-16 space-y-6">
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

      {/* Header */}
      <div className="pb-2 border-b border-[#EBF0F5] dark:border-[#1E222D]">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          Settings
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          {isAdmin ? 'Manage your profile, password, and email delivery settings.' : 'Manage your profile and password. Email delivery is managed by your admin.'}
        </p>
      </div>

      <div className="flex flex-col md:flex-row gap-6">
        {/* Left Navigation Rails */}
        <div className="w-full md:w-56 flex-shrink-0">
          <div className="flex md:flex-col gap-1.5 p-1.5 rounded-2xl bg-slate-100/70 dark:bg-[#161822]/70 border border-[#EBF0F5] dark:border-[#1E222D]">
            <button
              type="button"
              onClick={() => setActiveTab('profile')}
              className={`flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                activeTab === 'profile'
                  ? 'bg-white dark:bg-[#11131A] text-blue-600 dark:text-blue-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <User size={15} />
              <span>My Profile</span>
            </button>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setActiveTab('integrations')}
                className={`flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  activeTab === 'integrations'
                    ? 'bg-white dark:bg-[#11131A] text-blue-600 dark:text-blue-400 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Key size={15} />
                <span>Email Delivery</span>
              </button>
            )}
          </div>
        </div>

        {/* Content Area with 24px token spacing */}
        <div className="flex-1 space-y-6">
          {activeTab === 'profile' && (
            <>
              {/* Profile Information Card */}
              <div className="rounded-2xl border border-[#EBF0F5] dark:border-[#1E222D] bg-white dark:bg-[#11131A] p-6 shadow-xs">
                <div className="pb-3 mb-6 border-b border-[#EBF0F5] dark:border-[#1E222D]">
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                    Profile Information
                  </h2>
                </div>

                <form onSubmit={handleSaveProfile} className="space-y-6">
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 rounded-2xl bg-blue-100 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 text-lg font-bold flex items-center justify-center shadow-xs">
                      {avatarInitials || <User size={24} />}
                    </div>
                    <div>
                      <div className="text-sm font-bold text-slate-900 dark:text-white">
                        {firstName} {lastName}
                      </div>
                      <div className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                        {email}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <TextField fullWidth size="small" label="First Name" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                    <TextField fullWidth size="small" label="Last Name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
                  </div>

                  <div className="space-y-4">
                    <TextField fullWidth size="small" label="Organization" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
                    <TextField fullWidth size="small" label="Email Address" type="email" value={email} disabled sx={{ '& .MuiInputBase-root.Mui-disabled': { bgcolor: 'action.hover' } }} />
                  </div>

                  <div className="flex items-center justify-end gap-2.5 pt-4 border-t border-[#EBF0F5] dark:border-[#1E222D]">
                    <button
                      type="button"
                      onClick={() => loadSettings()}
                      className="px-4 py-2 rounded-full border border-[#EBF0F5] dark:border-[#1E222D] text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#161822] transition-colors cursor-pointer"
                    >
                      Reset Fields
                    </button>
                    <button
                      type="submit"
                      className="inline-flex items-center gap-2 px-5 py-2 rounded-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
                    >
                      <Save size={14} />
                      <span>Save Profile</span>
                    </button>
                  </div>
                </form>
              </div>

              {/* Change Password Card */}
              <div className="rounded-2xl border border-[#EBF0F5] dark:border-[#1E222D] bg-white dark:bg-[#11131A] p-6 shadow-xs">
                <div className="pb-3 mb-6 border-b border-[#EBF0F5] dark:border-[#1E222D]">
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                    Change Password
                  </h2>
                </div>

                <form onSubmit={handleUpdatePassword} className="space-y-4">
                  <TextField
                    fullWidth size="small" label="Current Password" type={showPass ? 'text' : 'password'}
                    value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
                    slotProps={{ input: { sx: { fontFamily: 'monospace' }, endAdornment: (<InputAdornment position="end"><button type="button" aria-label={showPass ? 'Hide current password' : 'Show current password'} className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer" onClick={() => setShowPass(!showPass)}>{showPass ? <EyeOff size={14} /> : <Eye size={14} />}</button></InputAdornment>) } }}
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <TextField
                      fullWidth size="small" label="New Password" type={showNewPass ? 'text' : 'password'}
                      value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder={`Min. ${MIN_PASSWORD_LENGTH} characters`}
                      slotProps={{ input: { sx: { fontFamily: 'monospace' }, endAdornment: (<InputAdornment position="end"><button type="button" aria-label={showNewPass ? 'Hide new password' : 'Show new password'} className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer" onClick={() => setShowNewPass(!showNewPass)}>{showNewPass ? <EyeOff size={14} /> : <Eye size={14} />}</button></InputAdornment>) } }}
                    />
                    <TextField
                      fullWidth size="small" label="Confirm New Password" type={showConfirmPass ? 'text' : 'password'}
                      value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Retype password"
                      slotProps={{ input: { sx: { fontFamily: 'monospace' }, endAdornment: (<InputAdornment position="end"><button type="button" aria-label={showConfirmPass ? 'Hide confirmation password' : 'Show confirmation password'} className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer" onClick={() => setShowConfirmPass(!showConfirmPass)}>{showConfirmPass ? <EyeOff size={14} /> : <Eye size={14} />}</button></InputAdornment>) } }}
                    />
                  </div>

                  <div className="flex items-center justify-end pt-4 border-t border-[#EBF0F5] dark:border-[#1E222D]">
                    <button
                      type="submit"
                      className="inline-flex items-center gap-2 px-5 py-2 rounded-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
                    >
                      <Lock size={14} />
                      <span>Update Password</span>
                    </button>
                  </div>
                </form>
              </div>
            </>
          )}

          {isAdmin && activeTab === 'integrations' && (
            <>
              {/* Delivery Engine Provider Card */}
              <div className="rounded-2xl border border-[#EBF0F5] dark:border-[#1E222D] bg-white dark:bg-[#11131A] p-6 shadow-xs space-y-5">
                <div className="pb-3 border-b border-[#EBF0F5] dark:border-[#1E222D]">
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                    Email Delivery Provider
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Choose the provider used to send your outbound email.
                  </p>
                </div>

                <FormControl size="small" sx={{ maxWidth: 380 }} fullWidth>
                  <InputLabel>Provider</InputLabel>
                  <Select label="Provider" value={activeProvider} onChange={(e) => { if (e.target.value !== activeProvider) setPendingProvider(e.target.value); }}>
                    <MenuItem value="DISABLED">Sending Disabled (no email is sent)</MenuItem>
                    <MenuItem value="AZURE">Azure Communication Services</MenuItem>
                  </Select>
                </FormControl>

                {activeProvider === 'DISABLED' && (
                  <div className="p-4 rounded-2xl bg-amber-50/60 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-900/40 flex items-start gap-3">
                    <MailX size={16} className="text-amber-600 mt-0.5 flex-shrink-0" />
                    <div>
                      <div className="text-xs font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wider">
                        Sending Disabled
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5 leading-relaxed">
                        No email is sent and campaigns do not progress. Campaign runs, Unibox replies and test emails are refused until Azure Communication Services is selected and configured.
                      </p>
                    </div>
                  </div>
                )}

                {activeProvider === 'AZURE' && (
                  <div className="p-5 rounded-2xl bg-slate-50/50 dark:bg-[#161822]/50 border border-[#EBF0F5] dark:border-[#1E222D]">
                    <form onSubmit={handleSaveAzureConfig} className="space-y-4">
                      <TextField
                        fullWidth size="small" required label="Azure Connection String"
                        type={showAzureConnString ? 'text' : 'password'}
                        value={azureConnString} onChange={(e) => setAzureConnString(e.target.value)}
                        placeholder="endpoint=https://...;accesskey=..."
                        slotProps={{ input: { sx: { fontFamily: 'monospace' }, endAdornment: (<InputAdornment position="end"><button type="button" aria-label={showAzureConnString ? 'Hide connection string' : 'Show connection string'} className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer" onClick={() => setShowAzureConnString(!showAzureConnString)}>{showAzureConnString ? <EyeOff size={14} /> : <Eye size={14} />}</button></InputAdornment>) } }}
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
                      <div className="flex items-center justify-end pt-2">
                        <button
                          type="submit"
                          className="inline-flex items-center gap-2 px-5 py-2 rounded-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
                        >
                          <Save size={14} />
                          <span>Save Azure Configuration</span>
                        </button>
                      </div>
                    </form>
                  </div>
                )}
              </div>

              {/* Rate Limits Card */}
              <div className="rounded-2xl border border-[#EBF0F5] dark:border-[#1E222D] bg-white dark:bg-[#11131A] p-6 shadow-xs space-y-5">
                <div className="pb-3 border-b border-[#EBF0F5] dark:border-[#1E222D]">
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                    Global Sending Rate Limits
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                    Caps total outbound volume across all campaigns and sender mailboxes. Choose No Limit to leave a period uncapped. While either limit is set, mailboxes have no daily limits of their own: together they share 24 times the hourly limit in any 24 hours (or 1,440 times the per-minute limit, if that is lower), and only a warmup ramp holds a mailbox below that. With both set to No Limit, each mailbox is held to its own daily limit.
                  </p>
                </div>

                <form onSubmit={handleSaveRateLimits} className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <RateLimitField per="minute" input={rateLimitMinute} error={rateLimitErrors.minute}
                      onChange={(v) => { setRateLimitMinute(v); setRateLimitErrors((errs) => ({ ...errs, minute: '' })); }} />
                    <RateLimitField per="hour" input={rateLimitHour} error={rateLimitErrors.hour}
                      onChange={(v) => { setRateLimitHour(v); setRateLimitErrors((errs) => ({ ...errs, hour: '' })); }} />
                  </div>
                  <div className="flex items-center justify-end pt-3 border-t border-[#EBF0F5] dark:border-[#1E222D]">
                    <button
                      type="submit"
                      disabled={rateLimitLoading}
                      className="inline-flex items-center gap-2 px-5 py-2 rounded-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <Save size={14} />
                      <span>{rateLimitLoading ? 'Saving…' : 'Save Limits'}</span>
                    </button>
                  </div>
                </form>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

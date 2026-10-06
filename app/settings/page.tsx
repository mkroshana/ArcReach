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
  Box, Card, CardContent, Stack, Typography, Button, IconButton, TextField, Select, MenuItem,
  FormControl, InputLabel, Snackbar, Alert, AlertTitle, InputAdornment, CircularProgress, Avatar,
  Tabs, Tab, Autocomplete, Checkbox, FormControlLabel,
} from '@mui/material';
import { alpha } from '@mui/material/styles';

/** One global rate limit: a whole number of emails, or an explicit No Limit, which saves null and leaves the period uncapped. */
function RateLimitField({ per, input, error, onChange }: {
  per: RateLimitPeriod; input: RateLimitInput; error: string; onChange: (input: RateLimitInput) => void;
}) {
  const unit = per === 'minute' ? 'Minute' : 'Hour';
  return (
    <Box sx={{ flex: 1 }}>
      <TextField
        fullWidth size="small" type="number" label={`Max Emails / ${unit}`}
        value={input.noLimit ? '' : input.text} onChange={(e) => onChange({ ...input, text: e.target.value })}
        disabled={input.noLimit} required={!input.noLimit} placeholder={input.noLimit ? 'No limit' : undefined}
        error={!!error} helperText={error || (input.noLimit ? `Emails are not capped per ${per}.` : ' ')}
        slotProps={{ htmlInput: { min: 1, step: 1 }, input: { sx: { fontFamily: 'monospace' } } }}
      />
      <FormControlLabel
        control={<Checkbox size="small" checked={input.noLimit} onChange={(e) => onChange({ ...input, noLimit: e.target.checked })} />}
        label={<Typography variant="body2">No Limit</Typography>}
      />
    </Box>
  );
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<'profile' | 'integrations'>('profile');
  const [toastMessage, setToastMessage] = useState<string>('');
  const [loading, setLoading] = useState(true);
  // A failed load shows an error state; rendering the form would present defaults as saved values.
  const [loadError, setLoadError] = useState('');
  // Delivery settings are admin-only (GET returns none for other roles), so only admins see that tab.
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

  // Empty until loaded: showing a provider before the server says which would be a guess.
  const [activeProvider, setActiveProvider] = useState('');
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  const [azureConnString, setAzureConnString] = useState('');
  const [azureSenderDomains, setAzureSenderDomains] = useState<string[]>([]);
  const [showAzureConnString, setShowAzureConnString] = useState(false);

  // Set from the stored values on load; null (No Limit) is shown as No Limit, never as a default number.
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
      // The server returns settings exactly when the session role is ADMIN, the same check PUT enforces,
      // so that decides the admin view (the DB role can be ahead of a not-yet-refreshed session).
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
          // Anything but AZURE (including the retired MOCK value) sends nothing.
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
    // An empty field is an error, not No Limit: only the No Limit choice saves null.
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
        // Show what was stored, so the form matches what the send engine reads.
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
      <Stack sx={{ alignItems: 'center', py: 12, gap: 2 }}>
        <CircularProgress size={28} />
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>Loading settings…</Typography>
      </Stack>
    );
  }

  if (loadError) {
    return (
      <Box sx={{ maxWidth: 900, mx: 'auto', py: 8 }}>
        <Alert
          severity="error"
          action={<Button color="inherit" size="small" startIcon={<RefreshCw size={14} />} onClick={() => loadSettings()}>Retry</Button>}
        >
          <AlertTitle>Settings Could Not Be Loaded</AlertTitle>
          {loadError}
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto', pb: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
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

      <Box sx={{ pb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="h4" sx={{ fontWeight: 700 }}>Settings</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {isAdmin ? 'Manage your profile, password, and email delivery settings.' : 'Manage your profile and password. Email delivery is managed by your admin.'}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 3 }}>
        {/* Tabs */}
        <Box sx={{ width: { xs: '100%', md: 220 }, flexShrink: 0 }}>
          <Tabs
            value={activeTab}
            onChange={(_, v) => setActiveTab(v)}
            orientation="vertical"
            sx={{
              '& .MuiTab-root': { alignItems: 'flex-start', justifyContent: 'flex-start', minHeight: 40, textTransform: 'none', borderRadius: '12px', mb: 0.5, fontSize: 13, fontWeight: 600 },
              '& .MuiTabs-indicator': { display: 'none' },
              '& .Mui-selected': { bgcolor: (t) => alpha(t.palette.primary.main, 0.12), color: 'primary.main' },
            }}
          >
            <Tab value="profile" icon={<User size={16} />} iconPosition="start" label="My Profile" />
            {isAdmin && <Tab value="integrations" icon={<Key size={16} />} iconPosition="start" label="Email Delivery" />}
          </Tabs>
        </Box>

        {/* Content */}
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {activeTab === 'profile' && (
            <>
              <Card>
                <CardContent sx={{ p: 3 }}>
                  <Typography variant="overline" sx={{ fontWeight: 700, color: 'text.secondary', display: 'block', pb: 1.5, mb: 2, borderBottom: 1, borderColor: 'divider' }}>Profile Information</Typography>
                  <form onSubmit={handleSaveProfile}>
                    <Stack direction="row" spacing={2.5} sx={{ alignItems: 'center', mb: 3 }}>
                      <Avatar variant="rounded" sx={{ width: 56, height: 56, fontSize: 18, fontWeight: 700, bgcolor: (t) => alpha(t.palette.primary.main, 0.14), color: 'primary.main', fontFamily: 'monospace', borderRadius: '14px' }}>
                        {avatarInitials || <User size={24} />}
                      </Avatar>
                    </Stack>

                    <Stack spacing={2.5}>
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                        <TextField fullWidth size="small" label="First Name" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                        <TextField fullWidth size="small" label="Last Name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
                      </Stack>
                      <TextField fullWidth size="small" label="Organization" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
                      <TextField fullWidth size="small" label="Email Address" type="email" value={email} disabled sx={{ '& .MuiInputBase-root.Mui-disabled': { bgcolor: 'action.hover' } }} />
                    </Stack>

                    <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end', mt: 3, pt: 2.5, borderTop: 1, borderColor: 'divider' }}>
                      <Button color="inherit" variant="outlined" onClick={() => loadSettings()} sx={{ borderColor: 'divider', color: 'text.secondary' }}>Reset Fields</Button>
                      <Button type="submit" variant="contained" startIcon={<Save size={14} />}>Save Profile</Button>
                    </Stack>
                  </form>
                </CardContent>
              </Card>

              <Card>
                <CardContent sx={{ p: 3 }}>
                  <Typography variant="overline" sx={{ fontWeight: 700, color: 'text.secondary', display: 'block', pb: 1.5, mb: 2, borderBottom: 1, borderColor: 'divider' }}>Change Password</Typography>
                  <form onSubmit={handleUpdatePassword}>
                    <Stack spacing={2}>
                      <TextField
                        fullWidth size="small" label="Current Password" type={showPass ? 'text' : 'password'}
                        value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
                        slotProps={{ input: { sx: { fontFamily: 'monospace' }, endAdornment: (<InputAdornment position="end"><IconButton aria-label={showPass ? 'Hide current password' : 'Show current password'} size="small" onClick={() => setShowPass(!showPass)}>{showPass ? <EyeOff size={14} /> : <Eye size={14} />}</IconButton></InputAdornment>) } }}
                      />
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                        <TextField
                          fullWidth size="small" label="New Password" type={showNewPass ? 'text' : 'password'}
                          value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder={`Min. ${MIN_PASSWORD_LENGTH} characters`}
                          slotProps={{ input: { sx: { fontFamily: 'monospace' }, endAdornment: (<InputAdornment position="end"><IconButton aria-label={showNewPass ? 'Hide new password' : 'Show new password'} size="small" onClick={() => setShowNewPass(!showNewPass)}>{showNewPass ? <EyeOff size={14} /> : <Eye size={14} />}</IconButton></InputAdornment>) } }}
                        />
                        <TextField
                          fullWidth size="small" label="Confirm New Password" type={showConfirmPass ? 'text' : 'password'}
                          value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Retype password"
                          slotProps={{ input: { sx: { fontFamily: 'monospace' }, endAdornment: (<InputAdornment position="end"><IconButton aria-label={showConfirmPass ? 'Hide confirmation password' : 'Show confirmation password'} size="small" onClick={() => setShowConfirmPass(!showConfirmPass)}>{showConfirmPass ? <EyeOff size={14} /> : <Eye size={14} />}</IconButton></InputAdornment>) } }}
                        />
                      </Stack>
                    </Stack>
                    <Stack direction="row" sx={{ justifyContent: 'flex-end', mt: 2.5, pt: 2, borderTop: 1, borderColor: 'divider' }}>
                      <Button type="submit" variant="contained" startIcon={<Lock size={14} />}>Update Password</Button>
                    </Stack>
                  </form>
                </CardContent>
              </Card>
            </>
          )}

          {isAdmin && activeTab === 'integrations' && (
            <>
              <Card>
                <CardContent sx={{ p: 3 }}>
                  <Box sx={{ pb: 1.5, mb: 2.5, borderBottom: 1, borderColor: 'divider' }}>
                    <Typography variant="overline" sx={{ fontWeight: 700 }}>Email Delivery Provider</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>Choose the provider used to send your outbound email.</Typography>
                  </Box>

                  <FormControl size="small" sx={{ maxWidth: 380, mb: 2.5 }} fullWidth>
                    <InputLabel>Provider</InputLabel>
                    <Select label="Provider" value={activeProvider} onChange={(e) => { if (e.target.value !== activeProvider) setPendingProvider(e.target.value); }}>
                      <MenuItem value="DISABLED">Sending Disabled (no email is sent)</MenuItem>
                      <MenuItem value="AZURE">Azure Communication Services</MenuItem>
                    </Select>
                  </FormControl>

                  {activeProvider === 'DISABLED' && (
                    <Card sx={{ bgcolor: 'action.hover' }}>
                      <CardContent sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
                        <MailX size={16} color="#d97706" style={{ marginTop: 2, flexShrink: 0 }} />
                        <Box>
                          <Typography variant="body2" sx={{ fontWeight: 700 }}>Sending Disabled</Typography>
                          <Typography variant="caption" sx={{ color: 'text.secondary' }}>No email is sent and campaigns do not progress. Campaign runs, Unibox replies and test emails are refused until Azure Communication Services is selected and configured.</Typography>
                        </Box>
                      </CardContent>
                    </Card>
                  )}

                  {activeProvider === 'AZURE' && (
                    <Card sx={{ bgcolor: 'action.hover' }}>
                      <CardContent>
                        <form onSubmit={handleSaveAzureConfig}>
                          <Stack spacing={2}>
                            <TextField
                              fullWidth size="small" required label="Azure Connection String"
                              type={showAzureConnString ? 'text' : 'password'}
                              value={azureConnString} onChange={(e) => setAzureConnString(e.target.value)}
                              placeholder="endpoint=https://...;accesskey=..."
                              slotProps={{ input: { sx: { fontFamily: 'monospace' }, endAdornment: (<InputAdornment position="end"><IconButton aria-label={showAzureConnString ? 'Hide connection string' : 'Show connection string'} size="small" onClick={() => setShowAzureConnString(!showAzureConnString)}>{showAzureConnString ? <EyeOff size={14} /> : <Eye size={14} />}</IconButton></InputAdornment>) } }}
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
                                  sx={{ '& .MuiInputBase-input': { fontFamily: 'monospace' } }}
                                />
                              )}
                            />
                            <Stack direction="row" sx={{ justifyContent: 'flex-end' }}>
                              <Button type="submit" variant="contained" startIcon={<Save size={14} />}>Save Azure Configuration</Button>
                            </Stack>
                          </Stack>
                        </form>
                      </CardContent>
                    </Card>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardContent sx={{ p: 3 }}>
                  <Typography variant="overline" sx={{ fontWeight: 700 }}>Global Sending Rate Limits</Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 2 }}>Caps total outbound volume across all campaigns and sender mailboxes. Choose No Limit to leave a period uncapped. While either limit is set, mailboxes have no daily limits of their own: together they share 24 times the hourly limit in any 24 hours (or 1,440 times the per-minute limit, if that is lower), and only a warmup ramp holds a mailbox below that. With both set to No Limit, each mailbox is held to its own daily limit.</Typography>
                  <form onSubmit={handleSaveRateLimits}>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                      <RateLimitField per="minute" input={rateLimitMinute} error={rateLimitErrors.minute}
                        onChange={(v) => { setRateLimitMinute(v); setRateLimitErrors((errs) => ({ ...errs, minute: '' })); }} />
                      <RateLimitField per="hour" input={rateLimitHour} error={rateLimitErrors.hour}
                        onChange={(v) => { setRateLimitHour(v); setRateLimitErrors((errs) => ({ ...errs, hour: '' })); }} />
                    </Stack>
                    <Stack direction="row" sx={{ justifyContent: 'flex-end', mt: 2.5, pt: 2, borderTop: 1, borderColor: 'divider' }}>
                      <Button type="submit" variant="contained" disabled={rateLimitLoading} startIcon={<Save size={14} />}>
                        {rateLimitLoading ? 'Saving…' : 'Save Limits'}
                      </Button>
                    </Stack>
                  </form>
                </CardContent>
              </Card>
            </>
          )}
        </Box>
      </Box>
    </Box>
  );
}

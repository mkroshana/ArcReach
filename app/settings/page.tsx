/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import {
  Save, User, Key, Eye, EyeOff, RefreshCw, Lock, Info,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { useTimezones } from '@/hooks/use-timezones';
import {
  Box, Card, CardContent, Stack, Typography, Button, IconButton, TextField, Select, MenuItem,
  FormControl, InputLabel, Snackbar, Alert, InputAdornment, CircularProgress, Avatar,
  Tabs, Tab,
} from '@mui/material';
import { alpha } from '@mui/material/styles';

const getGlobalSmtpStatusLabel = (provider: string) => {
  switch (provider) {
    case 'AZURE': return '[Inactive — Routed via Azure Communication Services]';
    case 'MOCK': return '[Inactive — Simulated via Development Sandbox]';
    default: return '';
  }
};
const isGlobalSmtpDisabled = (provider: string) => provider === 'AZURE' || provider === 'MOCK';

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<'profile' | 'integrations'>('profile');
  const [toastMessage, setToastMessage] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const timezoneOptions = useTimezones();
  const triggerToast = (msg: string) => { setToastMessage(msg); setTimeout(() => setToastMessage(''), 4000); };

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [orgName, setOrgName] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const profileInitials = `${firstName.trim().charAt(0) || 'J'}${lastName.trim().charAt(0) || 'D'}`.toUpperCase();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [showNewPass, setShowNewPass] = useState(false);
  const [showConfirmPass, setShowConfirmPass] = useState(false);

  const [activeProvider, setActiveProvider] = useState('MOCK');
  const [azureConnString, setAzureConnString] = useState('');
  const [azureSenderDomain, setAzureSenderDomain] = useState('');
  const [showAzureConnString, setShowAzureConnString] = useState(false);

  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [showSmtpPass, setShowSmtpPass] = useState(false);
  const [smtpLogs, setSmtpLogs] = useState<string[]>([]);
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('');
  const [imapUser, setImapUser] = useState('');
  const [imapPass, setImapPass] = useState('');
  const [showImapPass, setShowImapPass] = useState(false);
  const [smtpLoading, setSmtpLoading] = useState(false);

  const [rateLimitMinute, setRateLimitMinute] = useState('');
  const [rateLimitHour, setRateLimitHour] = useState('');
  const [rateLimitLoading, setRateLimitLoading] = useState(false);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        const fullName = data.user.name || '';
        const parts = fullName.split(' ');
        setFirstName(parts[0] || '');
        setLastName(parts.slice(1).join(' ') || '');
        setEmail(data.user.email || '');
        setOrgName(data.user.organization || '');
        setTimezone(data.user.timezone || 'America/New_York');
        if (data.settings) {
          setActiveProvider(data.settings.activeProvider || 'MOCK');
          setAzureConnString(data.settings.azureConnString || '');
          setAzureSenderDomain(data.settings.azureSenderDomain || '');
          setSmtpHost(data.settings.smtpHost || '');
          setSmtpPort(data.settings.smtpPort ? String(data.settings.smtpPort) : '');
          setSmtpUser(data.settings.smtpUser || '');
          setSmtpPass(data.settings.smtpPass || '');
          setImapHost(data.settings.imapHost || '');
          setImapPort(data.settings.imapPort ? String(data.settings.imapPort) : '');
          setImapUser(data.settings.imapUser || '');
          setImapPass(data.settings.imapPass || '');
          setRateLimitMinute(data.settings.rateLimitMinute != null ? String(data.settings.rateLimitMinute) : '60');
          setRateLimitHour(data.settings.rateLimitHour != null ? String(data.settings.rateLimitHour) : '1000');
        }
      }
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadSettings(); }, []);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${firstName} ${lastName}`.trim(), organization: orgName, timezone }),
      });
      if (res.ok) { triggerToast('Profile information saved successfully.'); window.location.reload(); }
      else triggerToast('Failed to save profile.');
    } catch (err) { console.error(err); triggerToast('Error saving profile.'); }
  };

  const handleTestSmtpConnection = async () => {
    setSmtpLoading(true); setSmtpLogs([]);
    try {
      const testRes = await fetch('/api/settings/test-smtp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ smtpHost, smtpPort, smtpUser, smtpPass }),
      });
      const testData = await testRes.json();
      setSmtpLogs(testData.logs || []);
      if (testData.success) {
        const saveRes = await fetch('/api/settings', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ smtpHost, smtpPort, smtpUser, smtpPass, imapHost, imapPort, imapUser, imapPass }),
        });
        if (saveRes.ok) triggerToast('Outbound SMTP configuration validated and saved!');
      } else { triggerToast('SMTP validation failed.'); }
    } catch (error) { triggerToast('Error validating SMTP connection.'); console.error(error); }
    finally { setSmtpLoading(false); }
  };

  const handleSaveSmtpImap = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ smtpHost, smtpPort, smtpUser, smtpPass, imapHost, imapPort, imapUser, imapPass }),
      });
      triggerToast(res.ok ? 'SMTP and IMAP configurations saved successfully.' : 'Failed to save SMTP/IMAP settings.');
    } catch (err) { console.error(err); triggerToast('Error saving SMTP/IMAP settings.'); }
  };

  const handleSaveRateLimits = async (e: React.FormEvent) => {
    e.preventDefault(); setRateLimitLoading(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rateLimitMinute: rateLimitMinute ? Number(rateLimitMinute) : null,
          rateLimitHour: rateLimitHour ? Number(rateLimitHour) : null,
        }),
      });
      triggerToast(res.ok ? 'Service-level rate limits saved successfully.' : 'Failed to save rate limits.');
    } catch (err) { console.error(err); triggerToast('Error saving rate limits.'); }
    finally { setRateLimitLoading(false); }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPassword || !newPassword) { triggerToast('Please fill out all password fields.'); return; }
    if (newPassword !== confirmPassword) { triggerToast('New passwords do not match.'); return; }
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (res.ok) {
        triggerToast('Password updated successfully.');
        setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      } else {
        const errData = await res.json();
        triggerToast(errData.error || 'Failed to update password.');
      }
    } catch (err) { console.error(err); triggerToast('Error updating password.'); }
  };

  const handleProviderChange = async (newProvider: string) => {
    setActiveProvider(newProvider);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeProvider: newProvider }),
      });
      triggerToast(res.ok ? `Active delivery provider updated to ${newProvider}` : 'Failed to update active delivery provider.');
    } catch (e) { console.error(e); triggerToast('Error updating active delivery provider.'); }
  };

  const handleSaveAzureConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ azureConnString, azureSenderDomain }),
      });
      triggerToast(res.ok ? 'Azure Communication Services configuration saved successfully.' : 'Failed to save Azure settings.');
    } catch (err) { console.error(err); triggerToast('Error saving Azure settings.'); }
  };

  const handleRandomizeAvatar = () => {
    const randomFirstNames = ['Evelyn', 'Marcus', 'Sienna', 'Damian', 'Clara', 'Julian'];
    const randomLastNames = ['Vance', 'Sterling', 'Gale', 'Manning', 'Kemp', 'Brooks'];
    setFirstName(randomFirstNames[Math.floor(Math.random() * randomFirstNames.length)]);
    setLastName(randomLastNames[Math.floor(Math.random() * randomLastNames.length)]);
    triggerToast(`Avatar updated. Remember to Save Profile!`);
  };

  if (loading) {
    return (
      <Stack sx={{ alignItems: 'center', py: 12, gap: 2 }}>
        <CircularProgress size={28} />
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>Loading settings…</Typography>
      </Stack>
    );
  }

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto', pb: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Snackbar open={!!toastMessage} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} autoHideDuration={4000} onClose={() => setToastMessage('')}>
        {toastMessage ? <Alert severity="info" variant="filled" sx={{ borderRadius: '12px' }}>{toastMessage}</Alert> : undefined}
      </Snackbar>

      <Box sx={{ pb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="h4" sx={{ fontWeight: 700 }}>Settings</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>Manage your profile, password, and email delivery settings.</Typography>
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
            <Tab value="integrations" icon={<Key size={16} />} iconPosition="start" label="Email Delivery" />
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
                        {profileInitials}
                      </Avatar>
                      <Box>
                        <Button size="small" variant="outlined" color="inherit" onClick={handleRandomizeAvatar} sx={{ borderColor: 'divider', color: 'text.secondary', mb: 0.5 }}>Randomize Avatar</Button>
                        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>Generates a placeholder avatar from random initials.</Typography>
                      </Box>
                    </Stack>

                    <Stack spacing={2.5}>
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                        <TextField fullWidth size="small" label="First Name" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                        <TextField fullWidth size="small" label="Last Name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
                      </Stack>
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                        <TextField fullWidth size="small" label="Organization" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
                        <FormControl fullWidth size="small">
                          <InputLabel>Timezone</InputLabel>
                          <Select label="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                            {timezoneOptions.map(option => (<MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>))}
                          </Select>
                        </FormControl>
                      </Stack>
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
                        slotProps={{ input: { sx: { fontFamily: 'monospace' }, endAdornment: (<InputAdornment position="end"><IconButton size="small" onClick={() => setShowPass(!showPass)}>{showPass ? <EyeOff size={14} /> : <Eye size={14} />}</IconButton></InputAdornment>) } }}
                      />
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                        <TextField
                          fullWidth size="small" label="New Password" type={showNewPass ? 'text' : 'password'}
                          value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Min. 8 characters"
                          slotProps={{ input: { sx: { fontFamily: 'monospace' }, endAdornment: (<InputAdornment position="end"><IconButton size="small" onClick={() => setShowNewPass(!showNewPass)}>{showNewPass ? <EyeOff size={14} /> : <Eye size={14} />}</IconButton></InputAdornment>) } }}
                        />
                        <TextField
                          fullWidth size="small" label="Confirm New Password" type={showConfirmPass ? 'text' : 'password'}
                          value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Retype password"
                          slotProps={{ input: { sx: { fontFamily: 'monospace' }, endAdornment: (<InputAdornment position="end"><IconButton size="small" onClick={() => setShowConfirmPass(!showConfirmPass)}>{showConfirmPass ? <EyeOff size={14} /> : <Eye size={14} />}</IconButton></InputAdornment>) } }}
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

          {activeTab === 'integrations' && (
            <>
              <Card>
                <CardContent sx={{ p: 3 }}>
                  <Box sx={{ pb: 1.5, mb: 2.5, borderBottom: 1, borderColor: 'divider' }}>
                    <Typography variant="overline" sx={{ fontWeight: 700 }}>Email Delivery Provider</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>Choose the provider used to send your outbound email.</Typography>
                  </Box>

                  <FormControl size="small" sx={{ maxWidth: 380, mb: 2.5 }} fullWidth>
                    <InputLabel>Provider</InputLabel>
                    <Select label="Provider" value={activeProvider} onChange={(e) => handleProviderChange(e.target.value)}>
                      <MenuItem value="MOCK">Development Sandbox (MOCK)</MenuItem>
                      <MenuItem value="AZURE">Azure Communication Services</MenuItem>
                    </Select>
                  </FormControl>

                  {activeProvider === 'MOCK' && (
                    <Card sx={{ bgcolor: 'action.hover' }}>
                      <CardContent sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
                        <Info size={16} color="#2563EB" style={{ marginTop: 2, flexShrink: 0 }} />
                        <Box>
                          <Typography variant="body2" sx={{ fontWeight: 700 }}>Development Sandbox Mode Active</Typography>
                          <Typography variant="caption" sx={{ color: 'text.secondary' }}>Emails generated by outreach sequences are simulated and logged to the server console — no real email is dispatched.</Typography>
                        </Box>
                      </CardContent>
                    </Card>
                  )}

                  {activeProvider === 'AZURE' && (
                    <Card sx={{ bgcolor: 'action.hover' }}>
                      <CardContent>
                        <form onSubmit={handleSaveAzureConfig}>
                          <Stack spacing={2}>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                              <TextField
                                fullWidth size="small" required label="Azure Connection String"
                                type={showAzureConnString ? 'text' : 'password'}
                                value={azureConnString} onChange={(e) => setAzureConnString(e.target.value)}
                                placeholder="endpoint=https://...;accesskey=..."
                                slotProps={{ input: { sx: { fontFamily: 'monospace' }, endAdornment: (<InputAdornment position="end"><IconButton size="small" onClick={() => setShowAzureConnString(!showAzureConnString)}>{showAzureConnString ? <EyeOff size={14} /> : <Eye size={14} />}</IconButton></InputAdornment>) } }}
                              />
                              <TextField
                                fullWidth size="small" required label="Verified Sender Domain"
                                value={azureSenderDomain} onChange={(e) => setAzureSenderDomain(e.target.value)}
                                placeholder="outbound.yourdomain.com"
                                slotProps={{ input: { sx: { fontFamily: 'monospace' } } }}
                              />
                            </Stack>
                            <Stack direction="row" sx={{ justifyContent: 'flex-end' }}>
                              <Button type="submit" variant="contained" startIcon={<Save size={14} />}>Save Azure Configuration</Button>
                            </Stack>
                          </Stack>
                        </form>
                      </CardContent>
                    </Card>
                  )}

                  {(activeProvider === 'SMTP' || activeProvider === 'GOOGLE' || activeProvider === 'MICROSOFT') && (
                    <Card sx={{ bgcolor: 'action.hover' }}>
                      <CardContent>
                        <form onSubmit={handleSaveSmtpImap}>
                          <Stack spacing={2.5}>
                            <Typography variant="overline" sx={{ color: 'text.secondary', pb: 0.5, borderBottom: 1, borderColor: 'divider', display: 'block' }}>
                              Outbound (SMTP) {getGlobalSmtpStatusLabel(activeProvider)}
                            </Typography>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                              <TextField fullWidth size="small" disabled={isGlobalSmtpDisabled(activeProvider)} label="Host" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder={activeProvider === 'GOOGLE' ? 'smtp.gmail.com' : activeProvider === 'MICROSOFT' ? 'smtp.office365.com' : 'e.g. smtp.mailgun.org'} slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                              <TextField fullWidth size="small" disabled={isGlobalSmtpDisabled(activeProvider)} label="Port" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder="587" slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                              <TextField fullWidth size="small" disabled={isGlobalSmtpDisabled(activeProvider)} label="Username" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder="user@yourdomain.com" slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                            </Stack>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                              <TextField fullWidth size="small" disabled={isGlobalSmtpDisabled(activeProvider)} label="Password" type={showSmtpPass ? 'text' : 'password'} value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} slotProps={{ input: { sx: { fontFamily: 'monospace' }, endAdornment: !isGlobalSmtpDisabled(activeProvider) ? (<InputAdornment position="end"><IconButton size="small" onClick={() => setShowSmtpPass(!showSmtpPass)}>{showSmtpPass ? <EyeOff size={14} /> : <Eye size={14} />}</IconButton></InputAdornment>) : undefined } }} />
                              <Button fullWidth variant="outlined" disabled={smtpLoading || isGlobalSmtpDisabled(activeProvider)} onClick={handleTestSmtpConnection} startIcon={<RefreshCw size={14} className={smtpLoading ? 'animate-spin' : ''} />}>
                                {smtpLoading ? 'Connecting…' : 'Test SMTP Connection'}
                              </Button>
                            </Stack>
                            <Typography variant="overline" sx={{ color: 'text.secondary', pb: 0.5, borderBottom: 1, borderColor: 'divider', display: 'block', mt: 1 }}>
                              Inbound (IMAP) {getGlobalSmtpStatusLabel(activeProvider)}
                            </Typography>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                              <TextField fullWidth size="small" disabled={isGlobalSmtpDisabled(activeProvider)} label="Host" value={imapHost} onChange={(e) => setImapHost(e.target.value)} placeholder={activeProvider === 'GOOGLE' ? 'imap.gmail.com' : activeProvider === 'MICROSOFT' ? 'outlook.office365.com' : 'e.g. imap.mailgun.org'} slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                              <TextField fullWidth size="small" disabled={isGlobalSmtpDisabled(activeProvider)} label="Port" value={imapPort} onChange={(e) => setImapPort(e.target.value)} placeholder="993" slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                              <TextField fullWidth size="small" disabled={isGlobalSmtpDisabled(activeProvider)} label="Username" value={imapUser} onChange={(e) => setImapUser(e.target.value)} placeholder="user@yourdomain.com" slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                            </Stack>
                            <TextField size="small" disabled={isGlobalSmtpDisabled(activeProvider)} label="IMAP Password" type={showImapPass ? 'text' : 'password'} value={imapPass} onChange={(e) => setImapPass(e.target.value)} sx={{ maxWidth: { sm: '50%' } }} slotProps={{ input: { sx: { fontFamily: 'monospace' }, endAdornment: !isGlobalSmtpDisabled(activeProvider) ? (<InputAdornment position="end"><IconButton size="small" onClick={() => setShowImapPass(!showImapPass)}>{showImapPass ? <EyeOff size={14} /> : <Eye size={14} />}</IconButton></InputAdornment>) : undefined } }} />
                            <Stack direction="row" sx={{ justifyContent: 'flex-end', pt: 1.5, borderTop: 1, borderColor: 'divider' }}>
                              <Button type="submit" variant="contained" disabled={isGlobalSmtpDisabled(activeProvider)} startIcon={<Save size={14} />}>Save SMTP & IMAP</Button>
                            </Stack>
                            {(smtpLogs.length > 0 || smtpLoading) && (
                              <Box sx={{ p: 1.5, bgcolor: '#0a0c12', color: '#cbd5e1', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6, borderRadius: '12px', border: 1, borderColor: '#1e2030', maxHeight: 220, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                                <Stack direction="row" sx={{ justifyContent: 'space-between', pb: 1, mb: 1, borderBottom: 1, borderColor: '#1a1c28' }}>
                                  <Typography sx={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.1em' }}>SMTP DIAGNOSTIC CONSOLE</Typography>
                                  {smtpLoading && <Typography sx={{ fontSize: 9, fontWeight: 700, color: '#60a5fa' }}>CONNECTING…</Typography>}
                                </Stack>
                                {smtpLogs.map((logStr, idx) => (
                                  <Box key={idx} sx={{ color: logStr.startsWith('✓') ? '#34d399' : '#cbd5e1', fontWeight: logStr.startsWith('✓') ? 700 : 400 }}>{logStr}</Box>
                                ))}
                              </Box>
                            )}
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
                  <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 2 }}>Caps total outbound volume across all campaigns and sender mailboxes.</Typography>
                  <form onSubmit={handleSaveRateLimits}>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                      <TextField fullWidth size="small" type="number" label="Max Emails / Minute" value={rateLimitMinute} onChange={(e) => setRateLimitMinute(e.target.value)} placeholder="60" slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
                      <TextField fullWidth size="small" type="number" label="Max Emails / Hour" value={rateLimitHour} onChange={(e) => setRateLimitHour(e.target.value)} placeholder="1000" slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
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

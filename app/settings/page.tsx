/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import { 
  Save, 
  User, 
  Shield, 
  Bell, 
  Key, 
  Eye, 
  EyeOff, 
  Copy, 
  Check, 
  Trash2, 
  Plus, 
  RefreshCw, 
  Mail, 
  Lock, 
  AlertCircle, 
  Globe, 
  Server, 
  CheckCircle,
  X,
  Info,
  ChevronRight,
  UserCheck
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { useTimezones } from '@/hooks/use-timezones';

interface ApiKeyItem {
  id: string;
  name: string;
  key: string;
  role: string;
  created: string;
  lastUsed: string;
}

interface WebhookItem {
  id: string;
  url: string;
  events: string[];
  secret: string;
  created: string;
}

const getGlobalSmtpStatusLabel = (provider: string) => {
  switch (provider) {
    case 'AZURE':
      return '[Inactive - Routed via Azure Communication Services]';
    case 'MOCK':
      return '[Inactive - Simulated via Development Sandbox]';
    default:
      return '';
  }
};

const isGlobalSmtpDisabled = (provider: string) => {
  return provider === 'AZURE' || provider === 'MOCK';
};

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<'profile' | 'security' | 'notifications' | 'integrations'>('profile');
  const [toastMessage, setToastMessage] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const timezoneOptions = useTimezones();

  const triggerToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage('');
    }, 4000);
  };

  // --- PROFILE STATES ---
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [orgName, setOrgName] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');

  const profileInitials = `${firstName.trim().charAt(0) || 'J'}${lastName.trim().charAt(0) || 'D'}`.toUpperCase();

  // --- SECURITY STATES ---
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);

  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([
    { id: 'key-1', name: 'Production API Main Relay', key: 'arc_pk_live_d817f2g9h3k8l9m0n1p2q3r4s5t6', role: 'Admin (Full Access)', created: '2026-05-10', lastUsed: '3 hours ago' }
  ]);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyRole, setNewKeyRole] = useState('Admin (Full Access)');
  const [showAddKeyForm, setShowAddKeyForm] = useState(false);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);

  // --- NOTIFICATIONS STATES ---
  const [notifDeliverability, setNotifDeliverability] = useState(true);
  const [notifReplies, setNotifReplies] = useState(true);
  const [notifWeeklyDigest, setNotifWeeklyDigest] = useState(false);
  const [notifDailyWarmup, setNotifDailyWarmup] = useState(true);
  const [notifSpamTraps, setNotifSpamTraps] = useState(true);

  // --- API INTEGRATIONS STATES ---
  const [activeProvider, setActiveProvider] = useState('MOCK');
  const [azureConnected, setAzureConnected] = useState(true);
  const [azureConnString, setAzureConnString] = useState('');
  const [azureSenderDomain, setAzureSenderDomain] = useState('');

  const [webhooks, setWebhooks] = useState<WebhookItem[]>([
    { id: 'wh-1', url: 'https://api.crm-client.com/webhooks/arcreach', events: ['lead.replied', 'email.bounced'], secret: 'whsec_e9a182c38d4f7281', created: '2026-05-20' }
  ]);
  const [newWebhookUrl, setNewWebhookUrl] = useState('');
  const [newWhEvents, setNewWhEvents] = useState<string[]>(['lead.replied']);
  const [showWebhookForm, setShowWebhookForm] = useState(false);

  // SMTP Settings State
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpLogs, setSmtpLogs] = useState<string[]>([]);
  // IMAP Settings State
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('');
  const [imapUser, setImapUser] = useState('');
  const [imapPass, setImapPass] = useState('');
  const [smtpLoading, setSmtpLoading] = useState(false);

  // Service-Level Rate Limits State
  const [rateLimitMinute, setRateLimitMinute] = useState('');
  const [rateLimitHour, setRateLimitHour] = useState('');
  const [rateLimitLoading, setRateLimitLoading] = useState(false);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        
        // Populate profile
        const fullName = data.user.name || '';
        const parts = fullName.split(' ');
        setFirstName(parts[0] || '');
        setLastName(parts.slice(1).join(' ') || '');
        setEmail(data.user.email || '');
        setOrgName(data.user.organization || '');
        setTimezone(data.user.timezone || 'America/New_York');

        // Populate SMTP & Global Limits
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
          setRateLimitMinute(data.settings.rateLimitMinute !== null && data.settings.rateLimitMinute !== undefined ? String(data.settings.rateLimitMinute) : '60');
          setRateLimitHour(data.settings.rateLimitHour !== null && data.settings.rateLimitHour !== undefined ? String(data.settings.rateLimitHour) : '1000');
        }
      }
    } catch (e) {
      console.error('Failed to load settings:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${firstName} ${lastName}`.trim(),
          organization: orgName,
          timezone: timezone
        })
      });
      if (res.ok) {
        triggerToast('Profile information saved successfully.');
        window.location.reload(); // Refresh sidebar session name
      } else {
        triggerToast('Failed to save profile.');
      }
    } catch (err) {
      console.error(err);
      triggerToast('Error saving profile.');
    }
  };

  const handleTestSmtpConnection = async () => {
    setSmtpLoading(true);
    setSmtpLogs([]);
    
    try {
      const testRes = await fetch('/api/settings/test-smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ smtpHost, smtpPort, smtpUser, smtpPass })
      });
      
      const testData = await testRes.json();
      setSmtpLogs(testData.logs || []);

      if (testData.success) {
        // Save the SMTP credentials to the database as they are validated!
        const saveRes = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            smtpHost, 
            smtpPort, 
            smtpUser, 
            smtpPass,
            imapHost,
            imapPort,
            imapUser,
            imapPass
          })
        });
        if (saveRes.ok) {
          triggerToast('Outbound SMTP configuration validated and saved!');
        }
      } else {
        triggerToast('SMTP validation failed.');
      }
    } catch (error) {
      triggerToast('Error validating SMTP connection.');
      console.error(error);
    } finally {
      setSmtpLoading(false);
    }
  };

  const handleSaveSmtpImap = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          smtpHost,
          smtpPort,
          smtpUser,
          smtpPass,
          imapHost,
          imapPort,
          imapUser,
          imapPass
        })
      });
      if (res.ok) {
        triggerToast('SMTP and IMAP configurations saved successfully.');
      } else {
        triggerToast('Failed to save SMTP/IMAP settings.');
      }
    } catch (err) {
      console.error(err);
      triggerToast('Error saving SMTP/IMAP settings.');
    }
  };

  const handleSaveRateLimits = async (e: React.FormEvent) => {
    e.preventDefault();
    setRateLimitLoading(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rateLimitMinute: rateLimitMinute ? Number(rateLimitMinute) : null,
          rateLimitHour: rateLimitHour ? Number(rateLimitHour) : null
        })
      });
      if (res.ok) {
        triggerToast('Service-level rate limits saved successfully.');
      } else {
        triggerToast('Failed to save rate limits.');
      }
    } catch (err) {
      console.error(err);
      triggerToast('Error saving rate limits.');
    } finally {
      setRateLimitLoading(false);
    }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPassword || !newPassword) {
      triggerToast('Please fill out all password fields.');
      return;
    }
    if (newPassword !== confirmPassword) {
      triggerToast('New passwords do not match.');
      return;
    }
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword,
          newPassword
        })
      });
      if (res.ok) {
        triggerToast('Password updated successfully.');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        const errData = await res.json();
        triggerToast(errData.error || 'Failed to update password.');
      }
    } catch (err) {
      console.error(err);
      triggerToast('Error updating password.');
    }
  };

  const handleProviderChange = async (newProvider: string) => {
    setActiveProvider(newProvider);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeProvider: newProvider })
      });
      if (res.ok) {
        triggerToast(`Active delivery provider updated to ${newProvider}`);
      } else {
        triggerToast('Failed to update active delivery provider.');
      }
    } catch (e) {
      console.error(e);
      triggerToast('Error updating active delivery provider.');
    }
  };

  const handleSaveAzureConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          azureConnString,
          azureSenderDomain
        })
      });
      if (res.ok) {
        triggerToast('Azure Communication Services configuration saved successfully.');
      } else {
        triggerToast('Failed to save Azure settings.');
      }
    } catch (err) {
      console.error(err);
      triggerToast('Error saving Azure settings.');
    }
  };

  const handleRandomizeAvatar = () => {
    const randomFirstNames = ['Evelyn', 'Marcus', 'Sienna', 'Damian', 'Clara', 'Julian'];
    const randomLastNames = ['Vance', 'Sterling', 'Gale', 'Manning', 'Kemp', 'Brooks'];
    const randF = randomFirstNames[Math.floor(Math.random() * randomFirstNames.length)];
    const randL = randomLastNames[Math.floor(Math.random() * randomLastNames.length)];
    setFirstName(randF);
    setLastName(randL);
    triggerToast(`Identity updated. Remember to Save Profiles!`);
  };

  const handleGenerateApiKey = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName.trim()) return;
    const randomChars = Array.from({ length: 28 }, () => Math.random().toString(36)[2]).join('');
    const generatedKeyStr = `arc_${newKeyRole.includes('Admin') ? 'pk_live_' : 'sk_auth_'}${randomChars}`;
    const newKey: ApiKeyItem = {
      id: `key-${Date.now()}`,
      name: newKeyName.trim(),
      key: generatedKeyStr,
      role: newKeyRole,
      created: new Date().toISOString().split('T')[0],
      lastUsed: 'Never'
    };
    setApiKeys([newKey, ...apiKeys]);
    setNewKeyName('');
    setShowAddKeyForm(false);
    triggerToast('New API access credential key generated.');
  };

  const handleRevokeKey = (id: string) => {
    setApiKeys(apiKeys.filter(k => k.id !== id));
    triggerToast('Access token credential key has been revoked.');
  };

  const handleCopyKeyToClipboard = (keyStr: string, id: string) => {
    navigator.clipboard.writeText(keyStr);
    setCopiedKeyId(id);
    setTimeout(() => setCopiedKeyId(null), 2000);
    triggerToast('Token copied to clipboard.');
  };

  const handleAddWebhook = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWebhookUrl.trim()) return;
    const randomSecret = 'whsec_' + Array.from({ length: 16 }, () => Math.random().toString(16)[2]).join('');
    const newWh: WebhookItem = {
      id: `wh-${Date.now()}`,
      url: newWebhookUrl.trim(),
      events: [...newWhEvents],
      secret: randomSecret,
      created: new Date().toISOString().split('T')[0]
    };
    setWebhooks([...webhooks, newWh]);
    setNewWebhookUrl('');
    setShowWebhookForm(false);
    triggerToast('Webhook listener registered successfully.');
  };

  const handleRemoveWebhook = (id: string) => {
    setWebhooks(webhooks.filter(w => w.id !== id));
    triggerToast('Webhook endpoint registration deleted.');
  };

  const toggleEventSelection = (evtName: string) => {
    if (newWhEvents.includes(evtName)) {
      setNewWhEvents(newWhEvents.filter(e => e !== evtName));
    } else {
      setNewWhEvents([...newWhEvents, evtName]);
    }
  };

  if (loading) {
    return (
      <div className="py-40 text-center text-slate-450 dark:text-slate-500 text-xs space-y-3">
        <div className="w-6 h-6 border-2 border-slate-305 dark:border-slate-700 border-t-blue-500 animate-spin rounded-full mx-auto" />
        <p className="font-medium tracking-wide">Syncing setting components nodes...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-4xl mx-auto pb-16">
      
      {/* Toast */}
      {toastMessage && (
        <div className="fixed bottom-8 right-8 bg-[#0c0d14] border border-slate-800 text-white px-4 py-3 rounded-lg shadow-2xl flex items-center gap-2.5 z-50 animate-in slide-in-from-bottom-5 text-xs font-medium">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></div>
          <span>{toastMessage}</span>
          <button onClick={() => setToastMessage('')} className="ml-2 text-slate-400 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <header className="pb-4 border-b border-slate-200 dark:border-slate-800">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white mb-0.5">Settings Preferences</h1>
        <p className="text-slate-505 dark:text-slate-400 text-xs font-medium">Manage authenticated SMTP servers, API records, and team roles.</p>
      </header>

      <div className="flex flex-col md:flex-row gap-6">
        {/* Navigation Sidebar */}
        <div className="w-full md:w-56 shrink-0">
          <nav className="flex md:flex-col gap-1 overflow-x-auto pb-2 md:pb-0">
            {[
              { id: 'profile', name: 'My Profile', icon: User },
              { id: 'security', name: 'Security & Keys', icon: Shield },
              { id: 'notifications', name: 'Notifications', icon: Bell },
              { id: 'integrations', name: 'API Integrations', icon: Key },
            ].map(tab => (
              <button 
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap cursor-pointer ${
                  activeTab === tab.id
                    ? 'bg-blue-50 dark:bg-blue-600/10 text-blue-700 dark:text-blue-400 border border-blue-150 dark:border-blue-500/10 shadow-2xs'
                    : 'text-slate-555 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/[0.01] hover:text-slate-900 dark:hover:text-white border border-transparent'
                }`}
              >
                <tab.icon className="w-4 h-4" />
                {tab.name}
              </button>
            ))}
          </nav>
        </div>

        {/* Content Screen */}
        <div className="flex-1 space-y-6">

          {/* ================= PROFILE TAB ================= */}
          {activeTab === 'profile' && (
            <div className="space-y-6 animate-in fade-in duration-300">
              <form onSubmit={handleSaveProfile} className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 shadow-xs">
                <h2 className="text-xs font-bold uppercase tracking-widest text-[#64748b] dark:text-slate-400 mb-4 pb-2 border-b border-slate-100 dark:border-[#1b1c26]">Profile Information</h2>
                
                <div className="flex items-center gap-5 mb-6">
                  <div className="w-14 h-14 rounded-lg bg-blue-50 dark:bg-blue-955/40 border border-blue-100 dark:border-blue-505/15 flex items-center justify-center text-lg font-bold text-blue-705 dark:text-blue-400 shadow-2xs font-mono">
                    {profileInitials}
                  </div>
                  <div>
                    <button 
                      type="button"
                      onClick={handleRandomizeAvatar}
                      className="px-3 py-1.5 bg-white dark:bg-[#12141d] hover:bg-slate-50 dark:hover:bg-white/[0.01] border border-slate-202 dark:border-[#1f2130] text-slate-700 dark:text-gray-305 text-xs font-bold rounded-lg transition-all shadow-2xs mb-1 cursor-pointer"
                    >
                      Randomize Identity
                    </button>
                    <p className="text-[10px] text-slate-400 dark:text-slate-505 font-medium">Generates visual initials dynamically in frontend workspace.</p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-555 dark:text-slate-400 font-bold uppercase tracking-widest">First Name</label>
                      <input 
                        type="text" 
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-202 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 placeholder:text-slate-400 shadow-2xs"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-555 dark:text-slate-400 font-bold uppercase tracking-widest">Last Name</label>
                      <input 
                        type="text" 
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-202 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 placeholder:text-slate-400 shadow-2xs"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-555 dark:text-slate-400 font-bold uppercase tracking-widest">Organization</label>
                      <input 
                        type="text" 
                        value={orgName}
                        onChange={(e) => setOrgName(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-202 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 placeholder:text-slate-400 shadow-2xs"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-555 dark:text-slate-400 font-bold uppercase tracking-widest">Local Timezone Option</label>
                      <select 
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-202 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 cursor-pointer"
                      >
                        {timezoneOptions.map(option => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="space-y-1.5 border-t border-slate-100 dark:border-slate-850 pt-4">
                    <label className="text-[10px] text-slate-555 dark:text-slate-400 font-bold uppercase tracking-widest">Registered E-Mail</label>
                    <input 
                      type="email" 
                      value={email}
                      className="w-full bg-slate-100/60 dark:bg-slate-900/50 border border-slate-202 dark:border-[#1b1c26] text-slate-400 dark:text-slate-400 text-xs rounded-lg px-3 py-2 cursor-not-allowed outline-none"
                      disabled
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2.5 mt-6 pt-4 border-t border-slate-100 dark:border-slate-850">
                   <button 
                     type="button"
                     onClick={() => loadSettings()}
                     className="px-4 py-2 bg-white dark:bg-[#12141d] hover:bg-slate-50 dark:hover:bg-white/[0.01] border border-slate-202 dark:border-[#1f2130] text-slate-700 dark:text-gray-300 font-bold rounded-lg transition-all text-xs shadow-2xs cursor-pointer"
                   >
                     Reset Fields
                   </button>
                   <button 
                     type="submit"
                     className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition-all text-xs flex items-center gap-1.5 shadow-md"
                   >
                     <Save className="w-3.5 h-3.5" />
                     Save Profiles
                   </button>
                </div>
              </form>
            </div>
          )}

          {/* ================= SECURITY & KEYS TAB ================= */}
          {activeTab === 'security' && (
            <div className="space-y-6 animate-in fade-in duration-300">
              <form onSubmit={handleUpdatePassword} className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 shadow-xs">
                <h3 className="text-xs font-bold uppercase tracking-widest text-[#64748b] dark:text-slate-400 mb-4 pb-2 border-b border-slate-100 dark:border-[#1b1c26]">Change Secure Password</h3>
                
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-555 dark:text-slate-400 font-bold uppercase tracking-widest">Current Active Password</label>
                    <div className="relative">
                      <input 
                        type={showPass ? "text" : "password"}
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        placeholder="•••••••••••••••••"
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-202 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 pr-10 outline-none focus:ring-2 focus:ring-blue-500/35 shadow-2xs font-mono"
                      />
                      <button 
                        type="button"
                        onClick={() => setShowPass(!showPass)}
                        className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-605 dark:hover:text-slate-300 cursor-pointer"
                      >
                        {showPass ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-555 dark:text-slate-400 font-bold uppercase tracking-widest">New Secure Password</label>
                      <input 
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="Min. 8 characters"
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-202 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 shadow-2xs font-mono"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-555 dark:text-slate-400 font-bold uppercase tracking-widest">Confirm New Password</label>
                      <input 
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Retype password"
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-202 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 shadow-2xs font-mono"
                      />
                    </div>
                  </div>
                </div>

                <div className="flex justify-end mt-5 pt-4 border-t border-slate-100 dark:border-[#1b1c26]">
                  <button 
                    type="submit"
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition-all text-xs flex items-center gap-1.5 shadow-md cursor-pointer"
                  >
                    <Lock className="w-3.5 h-3.5" />
                    Apply Password Security
                  </button>
                </div>
              </form>

              {/* 2FA Card */}
              <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 shadow-xs">
                <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-[#1b1c26] mb-4">
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-[#64748b] dark:text-slate-400">Two-Factor Authenticator (2FA)</h3>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 font-medium">Enforce authentication codes on user sessions.</p>
                  </div>
                  <button 
                    type="button"
                    onClick={() => {
                      setTwoFactorEnabled(!twoFactorEnabled);
                      triggerToast(`2FA verification status ${!twoFactorEnabled ? 'enforced' : 'deactivated'}.`);
                    }}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${twoFactorEnabled ? 'bg-blue-600' : 'bg-slate-200 dark:bg-slate-800'}`}
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${twoFactorEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>
              </div>

              {/* API Access Keys */}
              <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 shadow-xs">
                <div className="flex justify-between items-center pb-3 border-b border-slate-100 dark:border-[#1b1c26] mb-4">
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-[#64748b] dark:text-slate-400">API Outbound Access Keys</h3>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 font-medium">Manage credentials for Zapier webhooks and external queries.</p>
                  </div>
                  <button 
                    onClick={() => setShowAddKeyForm(!showAddKeyForm)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 hover:bg-slate-100 dark:bg-[#12141d] dark:hover:bg-[#1b1d28] border border-slate-202 dark:border-[#1f2130] rounded-lg text-xs font-semibold text-slate-800 dark:text-white transition-all shadow-2xs cursor-pointer"
                  >
                    {showAddKeyForm ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                    {showAddKeyForm ? 'Cancel' : 'Generate API Key'}
                  </button>
                </div>

                {showAddKeyForm && (
                  <form onSubmit={handleGenerateApiKey} className="mb-6 p-4 bg-slate-50 dark:bg-[#12141d] border border-slate-202 dark:border-[#1b1c26] rounded-xl space-y-4 animate-in slide-in-from-top-4 duration-350">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-[10px] text-slate-555 dark:text-slate-400 font-bold uppercase tracking-widest">Key Custom Name</label>
                        <input 
                          type="text" 
                          required 
                          placeholder="e.g. Zapier webhook key"
                          value={newKeyName}
                          onChange={(e) => setNewKeyName(e.target.value)}
                          className="w-full bg-white dark:bg-slate-950 border border-slate-202 dark:border-slate-800 text-slate-850 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 shadow-2xs"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] text-slate-555 dark:text-slate-400 font-bold uppercase tracking-widest">Access Scope</label>
                        <select 
                          value={newKeyRole}
                          onChange={(e) => setNewKeyRole(e.target.value)}
                          className="w-full bg-white dark:bg-slate-955 border border-slate-202 dark:border-slate-800 text-slate-850 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 cursor-pointer"
                        >
                          <option>Admin (Full Access)</option>
                          <option>Read-Only Access</option>
                        </select>
                      </div>
                    </div>
                    <div className="flex justify-end gap-2.5">
                      <button 
                        type="button" 
                        onClick={() => { setShowAddKeyForm(false); setNewKeyName(''); }}
                        className="px-3.5 py-1.8 text-xs font-semibold text-slate-500 hover:text-slate-855 dark:text-slate-400 dark:hover:text-white cursor-pointer"
                      >
                        Abandon
                      </button>
                      <button 
                        type="submit" 
                        className="px-4 py-1.8 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg text-xs transition-all shadow-xs cursor-pointer"
                      >
                        Confirm Generation
                      </button>
                    </div>
                  </form>
                )}

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-slate-100 dark:border-slate-850">
                        <th className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest text-left pb-2">Label Name</th>
                        <th className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest text-left pb-2">Scope Value</th>
                        <th className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest text-left pb-2">Masked Token Key</th>
                        <th className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest text-center pb-2">Operations</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-850">
                      {apiKeys.map(k => (
                        <tr key={k.id} className="group">
                          <td className="py-3 text-xs font-bold text-slate-800 dark:text-slate-200">{k.name}</td>
                          <td className="py-3 text-[11px] font-semibold text-slate-500 dark:text-slate-405">
                            <span className="bg-slate-50 dark:bg-slate-900 border border-slate-150 dark:border-slate-800/40 px-2 py-0.5 rounded text-[10px]">
                              {k.role}
                            </span>
                          </td>
                          <td className="py-3 text-xs font-mono text-slate-400 dark:text-slate-500">
                            {k.key.substring(0, 14)}••••••••••
                          </td>
                          <td className="py-3 text-center">
                            <div className="flex items-center justify-center gap-1.5">
                              <button 
                                onClick={() => handleCopyKeyToClipboard(k.key, k.id)}
                                className="p-1 px-2 border border-slate-202 dark:border-slate-800 bg-white hover:bg-slate-50 dark:bg-[#12141d] dark:hover:bg-slate-800 rounded flex items-center gap-1 text-[11px] font-bold text-slate-650 dark:text-slate-350 transition-all shadow-2xs cursor-pointer"
                              >
                                {copiedKeyId === k.id ? <Check className="w-3 h-3 text-emerald-505" /> : <Copy className="w-3 h-3" />}
                                {copiedKeyId === k.id ? 'Copied!' : 'Copy'}
                              </button>
                              <button 
                                onClick={() => handleRevokeKey(k.id)}
                                className="p-1 text-slate-400 hover:text-rose-600 dark:hover:text-rose-455 rounded transition-all cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ================= NOTIFICATIONS TAB ================= */}
          {activeTab === 'notifications' && (
            <div className="space-y-6 animate-in fade-in duration-300">
              <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 shadow-xs">
                <h3 className="text-xs font-bold uppercase tracking-widest text-[#64748b] dark:text-slate-400 mb-0.5">Notifications Settings</h3>
                <p className="text-[11px] text-slate-400 dark:text-slate-505 mb-6 font-medium">Select which outreach milestones send dynamic alerts to your email.</p>
                
                <div className="divide-y divide-slate-100 dark:divide-slate-850 space-y-4">
                  {[
                    { id: 'notifDeliverability', label: 'Outbound Deliverability Drop Alarm', desc: 'Warn when sender reputation scores decline below 95%.', state: notifDeliverability, setState: setNotifDeliverability },
                    { id: 'notifReplies', label: 'Prospect Inbound Response Alerts', desc: 'Notify immediately when leads reply to your sequences.', state: notifReplies, setState: setNotifReplies },
                    { id: 'notifWeeklyDigest', label: 'Weekly Performance Summary', desc: 'Compile stats digests on sequence open rates every Monday.', state: notifWeeklyDigest, setState: setNotifWeeklyDigest },
                    { id: 'notifDailyWarmup', label: 'Autopilot Warmup Progress Logs', desc: 'Notify regarding daily emails moved to Primary folders.', state: notifDailyWarmup, setState: setNotifDailyWarmup },
                  ].map(item => (
                    <div key={item.id} className="flex items-center justify-between py-2">
                      <div>
                        <h4 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider">{item.label}</h4>
                        <p className="text-[11px] text-slate-500 dark:text-slate-405 mt-0.5">{item.desc}</p>
                      </div>
                      <button 
                        type="button"
                        onClick={() => item.setState(!item.state)}
                        className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${item.state ? 'bg-blue-600' : 'bg-slate-200 dark:bg-slate-800'}`}
                      >
                        <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${item.state ? 'translate-x-5' : 'translate-x-0'}`} />
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex justify-end pt-5 border-t border-slate-100 dark:border-slate-850 mt-5">
                  <button 
                    onClick={() => triggerToast('Notification settings successfully updated.')}
                    type="button"
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition-all text-xs flex items-center gap-1.5 shadow-md cursor-pointer"
                  >
                    <Save className="w-3.5 h-3.5" />
                    Save Preferences
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ================= API INTEGRATIONS TAB ================= */}
          {activeTab === 'integrations' && (
            <div className="space-y-6 animate-in fade-in duration-300">
              
              {/* Outbound Mail Delivery Service */}
              <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 shadow-xs space-y-4">
                <div className="pb-3 border-b border-slate-100 dark:border-slate-850">
                  <h3 className="text-xs font-bold uppercase tracking-widest text-slate-855 dark:text-slate-200 mb-0.5 font-sans">Outbound Mail Delivery Service</h3>
                  <p className="text-[11px] text-slate-400 dark:text-slate-500 font-medium">Select your active outbound sending channel provider and authenticate connection pipelines.</p>
                </div>

                <div className="space-y-1.5 max-w-md">
                  <label className="text-[10px] text-slate-555 dark:text-slate-400 font-bold uppercase tracking-widest">Active Email Delivery Service</label>
                  <select 
                    value={activeProvider}
                    onChange={(e) => handleProviderChange(e.target.value)}
                    className="w-full bg-slate-100/60 dark:bg-slate-900/50 border border-slate-202 dark:border-[#1f2130] text-slate-400 dark:text-slate-400 text-xs rounded-lg px-3 py-2 cursor-not-allowed outline-none font-medium"
                    disabled
                  >
                    <option value="AZURE">Azure Communication Services</option>
                  </select>
                </div>

                {/* Conditionally render settings based on provider */}
                {activeProvider === 'MOCK' && (
                  <div className="p-4 bg-slate-50 dark:bg-[#12141d] border border-slate-202 dark:border-[#1f2130] rounded-xl text-xs text-slate-500 dark:text-slate-400 flex items-start gap-2.5">
                    <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold text-slate-750 dark:text-slate-350 mb-0.5">Development Sandbox Mode Active</p>
                      <p className="text-[11px]">Emails generated by outreach sequences are simulated and printed directly to the terminal console logs, preventing dispatches to real mailboxes during development.</p>
                    </div>
                  </div>
                )}

                {activeProvider === 'AZURE' && (
                  <form onSubmit={handleSaveAzureConfig} className="p-4 bg-slate-50 dark:bg-[#12141d] border border-slate-202 dark:border-[#1f2130] rounded-xl space-y-4 animate-in slide-in-from-top-2 duration-250">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-[10px] text-slate-555 dark:text-slate-405 font-bold uppercase tracking-widest">Azure Connection String</label>
                        <input 
                          type="password" 
                          required
                          value={azureConnString}
                          onChange={(e) => setAzureConnString(e.target.value)}
                          placeholder="endpoint=https://...;accesskey=..."
                          className="w-full bg-white dark:bg-slate-950 border border-slate-202 dark:border-slate-800 text-slate-850 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] text-slate-555 dark:text-slate-405 font-bold uppercase tracking-widest">Verified Sender Domain</label>
                        <input 
                          type="text" 
                          required
                          value={azureSenderDomain}
                          onChange={(e) => setAzureSenderDomain(e.target.value)}
                          placeholder="outbound.yourdomain.com"
                          className="w-full bg-white dark:bg-slate-955 border border-slate-202 dark:border-slate-800 text-slate-850 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35"
                        />
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <button 
                        type="submit" 
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg text-xs transition-colors shadow-2xs cursor-pointer flex items-center gap-1.5"
                      >
                        <Save className="w-3.5 h-3.5" />
                        Save Azure Configuration
                      </button>
                    </div>
                  </form>
                )}

                {(activeProvider === 'SMTP' || activeProvider === 'GOOGLE' || activeProvider === 'MICROSOFT' || activeProvider === 'AZURE' || activeProvider === 'MOCK') && (
                  <form onSubmit={handleSaveSmtpImap} className="p-4 bg-slate-50 dark:bg-[#12141d] border border-slate-202 dark:border-[#1f2130] rounded-xl space-y-6 animate-in slide-in-from-top-2 duration-250">
                    
                    {/* SMTP Outbound Section */}
                    <div className="space-y-4">
                      <h4 className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider pb-1 border-b border-slate-200/60 dark:border-slate-800/40">
                        Outbound Mail Delivery [SMTP] {getGlobalSmtpStatusLabel(activeProvider)}
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div className="space-y-1.5">
                          <label className="text-[10px] text-slate-555 dark:text-slate-400 font-bold uppercase tracking-widest">SMTP Host Server</label>
                          <input 
                            type="text" 
                            disabled={isGlobalSmtpDisabled(activeProvider)}
                            value={smtpHost}
                            onChange={(e) => setSmtpHost(e.target.value)}
                            placeholder={
                              activeProvider === 'GOOGLE' ? 'smtp.gmail.com' :
                              activeProvider === 'MICROSOFT' ? 'smtp.office365.com' :
                              'e.g. smtp.mailgun.org'
                            }
                            className="w-full bg-white dark:bg-slate-950 border border-slate-202 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35 disabled:opacity-50"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] text-slate-555 dark:text-slate-405 font-bold uppercase tracking-widest">Port Connection</label>
                          <input 
                            type="text" 
                            disabled={isGlobalSmtpDisabled(activeProvider)}
                            value={smtpPort}
                            onChange={(e) => setSmtpPort(e.target.value)}
                            placeholder="587"
                            className="w-full bg-white dark:bg-slate-950 border border-slate-202 dark:border-[#1f2130] text-slate-805 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35 disabled:opacity-50"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] text-slate-555 dark:text-slate-405 font-bold uppercase tracking-widest">Identity Username</label>
                          <input 
                            type="text" 
                            disabled={isGlobalSmtpDisabled(activeProvider)}
                            value={smtpUser}
                            onChange={(e) => setSmtpUser(e.target.value)}
                            placeholder="e.g. user@yourdomain.com"
                            className="w-full bg-white dark:bg-slate-955 border border-slate-202 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35 disabled:opacity-50"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <label className="text-[10px] text-slate-555 dark:text-slate-405 font-bold uppercase tracking-widest">Outbound SMTP Password Key</label>
                          <input 
                            type="password" 
                            disabled={isGlobalSmtpDisabled(activeProvider)}
                            value={smtpPass}
                            onChange={(e) => setSmtpPass(e.target.value)}
                            placeholder="SMTP Connection Password Key"
                            className="w-full bg-white dark:bg-slate-955 border border-slate-202 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35 disabled:opacity-50"
                          />
                        </div>
                        <div className="flex items-end pb-0.5">
                          <button 
                            type="button" 
                            disabled={smtpLoading || isGlobalSmtpDisabled(activeProvider)}
                            onClick={handleTestSmtpConnection}
                            className="w-full flex items-center justify-center gap-2 bg-blue-605/10 hover:bg-blue-600/10 text-blue-600 dark:text-blue-400 font-bold text-xs py-2 rounded-lg transition-colors border border-blue-200 dark:border-blue-500/30 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <RefreshCw className={`w-3.5 h-3.5 ${smtpLoading ? 'animate-spin' : ''}`} />
                            {smtpLoading ? 'Communicating Server...' : 'Test SMTP Authentication Connection'}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* IMAP Inbound Section */}
                    <div className="space-y-4 pt-2">
                      <h4 className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider pb-1 border-b border-slate-200/60 dark:border-slate-800/40">
                        Inbound Reply Sync [IMAP] {getGlobalSmtpStatusLabel(activeProvider)}
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div className="space-y-1.5">
                          <label className="text-[10px] text-slate-555 dark:text-slate-400 font-bold uppercase tracking-widest">IMAP Host Server</label>
                          <input 
                            type="text" 
                            disabled={isGlobalSmtpDisabled(activeProvider)}
                            value={imapHost}
                            onChange={(e) => setImapHost(e.target.value)}
                            placeholder={
                              activeProvider === 'GOOGLE' ? 'imap.gmail.com' :
                              activeProvider === 'MICROSOFT' ? 'outlook.office365.com' :
                              'e.g. imap.mailgun.org'
                            }
                            className="w-full bg-white dark:bg-slate-950 border border-slate-202 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35 disabled:opacity-50"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] text-slate-555 dark:text-slate-405 font-bold uppercase tracking-widest">Port Connection</label>
                          <input 
                            type="text" 
                            disabled={isGlobalSmtpDisabled(activeProvider)}
                            value={imapPort}
                            onChange={(e) => setImapPort(e.target.value)}
                            placeholder="993"
                            className="w-full bg-white dark:bg-slate-950 border border-slate-202 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35 disabled:opacity-50"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] text-slate-555 dark:text-slate-405 font-bold uppercase tracking-widest">IMAP Username</label>
                          <input 
                            type="text" 
                            disabled={isGlobalSmtpDisabled(activeProvider)}
                            value={imapUser}
                            onChange={(e) => setImapUser(e.target.value)}
                            placeholder="e.g. user@yourdomain.com"
                            className="w-full bg-white dark:bg-slate-955 border border-slate-202 dark:border-[#1f2130] text-slate-805 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35 disabled:opacity-50"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <label className="text-[10px] text-slate-555 dark:text-slate-405 font-bold uppercase tracking-widest">Inbound IMAP Password Key</label>
                          <input 
                            type="password" 
                            disabled={isGlobalSmtpDisabled(activeProvider)}
                            value={imapPass}
                            onChange={(e) => setImapPass(e.target.value)}
                            placeholder="IMAP Connection Password Key"
                            className="w-full bg-white dark:bg-slate-955 border border-slate-202 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35 disabled:opacity-50"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex justify-end pt-2 border-t border-slate-150 dark:border-slate-850">
                      <button 
                        type="submit" 
                        disabled={isGlobalSmtpDisabled(activeProvider)}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white font-semibold rounded-lg text-xs transition-colors shadow-2xs cursor-pointer flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Save className="w-3.5 h-3.5" />
                        Save SMTP & IMAP Configuration
                      </button>
                    </div>

                    {(smtpLogs.length > 0 || smtpLoading) && (
                      <div className="p-3.5 bg-slate-950 rounded-lg text-[11px] font-mono whitespace-pre-wrap text-[#cbd5e1] leading-relaxed border border-slate-850 max-h-52 overflow-y-auto w-full">
                        <div className="text-slate-500 pb-1.5 border-b border-slate-900 mb-1.5 flex justify-between items-center text-[9px] tracking-wider uppercase font-bold">
                          <span>SMTP Dispatch Diagnostic Console</span>
                          {smtpLoading && <span className="animate-pulse text-blue-400">CONNECTING...</span>}
                        </div>
                        {smtpLogs.map((logStr, idx) => (
                          <div key={idx} className={logStr.startsWith('✓') ? "text-emerald-400 font-bold" : ""}>
                            {logStr}
                          </div>
                        ))}
                      </div>
                    )}
                  </form>
                )}
              </div>

              {/* Outbound Event Webhooks */}
              <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 shadow-xs">
                <div className="flex justify-between items-center pb-3 border-b border-slate-100 dark:border-[#1b1c26] mb-4">
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-slate-800 dark:text-slate-205">Outbound Event Webhooks</h3>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">Stream lead replies and clicks to CRM endpoint destinations.</p>
                  </div>
                  <button 
                    onClick={() => setShowWebhookForm(!showWebhookForm)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 hover:bg-slate-100 dark:bg-[#12141d] dark:hover:bg-[#1b1d28] border border-slate-202 dark:border-[#1f2130] rounded-lg text-xs font-semibold text-slate-808 dark:text-white transition-all shadow-2xs cursor-pointer"
                  >
                    {showWebhookForm ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                    {showWebhookForm ? 'Close' : 'Add Webhook'}
                  </button>
                </div>

                {showWebhookForm && (
                  <form onSubmit={handleAddWebhook} className="mb-6 p-4 bg-slate-50 dark:bg-[#12141d] border border-slate-202 dark:border-[#1b1c26] rounded-xl space-y-4 animate-in slide-in-from-top-2 duration-250">
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-450 dark:text-slate-500 font-bold uppercase tracking-widest">Webhook Endpoint URL</label>
                      <input 
                        type="text" 
                        required 
                        placeholder="https://your-crm.com/api/v1/ingest"
                        value={newWebhookUrl}
                        onChange={(e) => setNewWebhookUrl(e.target.value)}
                        className="w-full bg-white dark:bg-slate-955 border border-slate-202 dark:border-slate-800 text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 shadow-2xs"
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] text-slate-450 dark:text-slate-500 font-bold uppercase tracking-widest block">Events to stream</label>
                      <div className="flex flex-wrap gap-2.5">
                        {['lead.replied', 'email.bounced', 'email.opened', 'lead.unsubscribed'].map(evt => (
                          <button
                            key={evt}
                            type="button"
                            onClick={() => toggleEventSelection(evt)}
                            className={`px-3 py-1.5 rounded-lg border text-[11px] font-semibold transition-all cursor-pointer ${
                              newWhEvents.includes(evt)
                                ? 'bg-blue-50 dark:bg-blue-600/10 border-blue-200 dark:border-blue-500/20 text-blue-700 dark:text-blue-400'
                                : 'bg-white dark:bg-slate-900 border-slate-202 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                            }`}
                          >
                            {evt}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex justify-end gap-2.5 pt-2 border-t border-slate-150 dark:border-slate-850">
                      <button 
                        type="button" 
                        onClick={() => { setShowWebhookForm(false); setNewWebhookUrl(''); }}
                        className="px-3.5 py-1.8 text-xs font-semibold text-slate-550 hover:text-slate-800 dark:text-slate-405 dark:hover:text-white cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button 
                        type="submit" 
                        className="px-4 py-1.8 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg text-xs transition-colors shadow-xs cursor-pointer"
                      >
                        Register Webhook
                      </button>
                    </div>
                  </form>
                )}

                <div className="space-y-3">
                  {webhooks.map(wh => (
                    <div key={wh.id} className="p-4 border border-slate-202 dark:border-slate-850 dark:bg-[#12141d]/40 rounded-xl relative hover:border-slate-300 dark:hover:border-slate-800 transition-all">
                      <button 
                        onClick={() => handleRemoveWebhook(wh.id)}
                        className="absolute right-3.5 top-3.5 p-1 text-slate-400 hover:text-rose-600 dark:hover:text-rose-500 rounded transition-all cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      <div className="space-y-1.5 pr-8">
                        <div className="flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                          <span className="text-xs font-bold text-slate-800 dark:text-slate-250 break-all font-mono">{wh.url}</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {wh.events.map(ev => (
                            <span key={ev} className="bg-slate-50 dark:bg-slate-900 border border-slate-150 dark:border-slate-850 text-slate-600 dark:text-slate-400 text-[9px] font-semibold px-2 py-0.5 rounded font-mono">
                              {ev}
                            </span>
                          ))}
                        </div>
                        <div className="text-[10px] text-slate-400 dark:text-slate-505 font-mono">
                          Signing Secret: <span className="bg-slate-100 dark:bg-slate-900 px-1 py-0.5 rounded">{wh.secret}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Service-Level Rate Limits */}
              <div className="bg-white dark:bg-[#0e1017] border border-slate-202 dark:border-[#1b1c26] rounded-xl p-5 shadow-xs">
                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-855 dark:text-slate-200 mb-0.5">Service-Level Outbound Rate Limits</h3>
                <p className="text-[11px] text-slate-400 dark:text-slate-505 mb-4 font-medium">Configure global limits for sending frequencies across all campaigns and active senders.</p>

                <form onSubmit={handleSaveRateLimits} className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-555 dark:text-slate-405 font-bold uppercase tracking-widest">Requests Per Minute (RPM)</label>
                      <input 
                        type="number" 
                        value={rateLimitMinute}
                        onChange={(e) => setRateLimitMinute(e.target.value)}
                        placeholder="60"
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-202 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-555 dark:text-slate-405 font-bold uppercase tracking-widest">Requests Per Hour (RPH)</label>
                      <input 
                        type="number" 
                        value={rateLimitHour}
                        onChange={(e) => setRateLimitHour(e.target.value)}
                        placeholder="1000"
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-202 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35"
                      />
                    </div>
                  </div>

                  <div className="flex justify-end pt-4 border-t border-slate-100 dark:border-slate-850 mt-4">
                    <button 
                      type="submit" 
                      disabled={rateLimitLoading}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition-all text-xs flex items-center gap-1.5 shadow-md cursor-pointer"
                    >
                      <Save className="w-3.5 h-3.5" />
                      {rateLimitLoading ? 'Saving Limits...' : 'Save Limits'}
                    </button>
                  </div>
                </form>
              </div>

            </div>
          )}

        </div>
      </div>
    </div>
  );
}

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

// Define initial states
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

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<'profile' | 'security' | 'notifications' | 'integrations'>('profile');
  const [toastMessage, setToastMessage] = useState<string>('');

  const triggerToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage('');
    }, 4000);
  };

  // --- TAB 1: PROFILE STATES ---
  const [firstName, setFirstName] = useState('John');
  const [lastName, setLastName] = useState('Doe');
  const [orgName, setOrgName] = useState('ArcReach Solutions Ltd');
  const [timezone, setTimezone] = useState('America/New_York');

  // Computed initials for Avatar
  const profileInitials = `${firstName.trim().charAt(0) || 'J'}${lastName.trim().charAt(0) || 'D'}`.toUpperCase();

  const handleSaveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    if (typeof window !== 'undefined') {
      localStorage.setItem('arcreach_firstName', firstName);
      localStorage.setItem('arcreach_lastName', lastName);
      localStorage.setItem('arcreach_orgName', orgName);
      localStorage.setItem('arcreach_timezone', timezone);
    }
    triggerToast('Profile information saved successfully.');
  };

  const handleRandomizeAvatar = () => {
    const randomFirstNames = ['Evelyn', 'Marcus', 'Sienna', 'Damian', 'Clara', 'Julian'];
    const randomLastNames = ['Vance', 'Sterling', 'Gale', 'Manning', 'Kemp', 'Brooks'];
    const randF = randomFirstNames[Math.floor(Math.random() * randomFirstNames.length)];
    const randL = randomLastNames[Math.floor(Math.random() * randomLastNames.length)];
    setFirstName(randF);
    setLastName(randL);
    if (typeof window !== 'undefined') {
      localStorage.setItem('arcreach_firstName', randF);
      localStorage.setItem('arcreach_lastName', randL);
    }
    triggerToast(`Avatar randomized to ${randF} ${randL}!`);
  };

  // --- TAB 2: SECURITY STATES ---
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);

  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([
    { id: 'key-1', name: 'Production API Main Relay', key: process.env.NEXT_PUBLIC_RELAY_API_KEY || 'arc_pk_live_placeholder_key_value_12345', role: 'Admin (Full Access)', created: '2026-05-10', lastUsed: '3 hours ago' },
    { id: 'key-2', name: 'Webhook Event Dispatch Sandbox', key: process.env.NEXT_PUBLIC_SANDBOX_API_KEY || 'arc_sk_test_placeholder_key_value_12345', role: 'Read-Only Access', created: '2026-06-01', lastUsed: 'Just now' }
  ]);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyRole, setNewKeyRole] = useState('Admin (Full Access)');
  const [showAddKeyForm, setShowAddKeyForm] = useState(false);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);

  const handleSavePassword = (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError('');
    
    if (!currentPassword) {
      setPasswordError('Please provide your current password to continue.');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters long.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Confirm Password does not match your newly entered password.');
      return;
    }

    if (typeof window !== 'undefined') {
      localStorage.setItem('arcreach_saved_password', newPassword);
    }
    triggerToast('Security password has been changed securely.');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
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

    const updatedKeys = [newKey, ...apiKeys];
    setApiKeys(updatedKeys);
    if (typeof window !== 'undefined') {
      localStorage.setItem('arcreach_apiKeys', JSON.stringify(updatedKeys));
    }
    setNewKeyName('');
    setShowAddKeyForm(false);
    triggerToast('New API access credential key generated.');
  };

  const handleRevokeKey = (id: string) => {
    const updatedKeys = apiKeys.filter(k => k.id !== id);
    setApiKeys(updatedKeys);
    if (typeof window !== 'undefined') {
      localStorage.setItem('arcreach_apiKeys', JSON.stringify(updatedKeys));
    }
    triggerToast('Access token credential key has been revoked.');
  };

  const handleCopyKeyToClipboard = (keyStr: string, id: string) => {
    navigator.clipboard.writeText(keyStr);
    setCopiedKeyId(id);
    setTimeout(() => setCopiedKeyId(null), 2000);
    triggerToast('Token copied to clipboard.');
  };

  // --- TAB 3: NOTIFICATIONS STATES ---
  const [notifDeliverability, setNotifDeliverability] = useState(true);
  const [notifReplies, setNotifReplies] = useState(true);
  const [notifWeeklyDigest, setNotifWeeklyDigest] = useState(false);
  const [notifDailyWarmup, setNotifDailyWarmup] = useState(true);
  const [notifSpamTraps, setNotifSpamTraps] = useState(true);

  const handleSaveNotifications = () => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('arcreach_notifDeliverability', String(notifDeliverability));
      localStorage.setItem('arcreach_notifReplies', String(notifReplies));
      localStorage.setItem('arcreach_notifWeeklyDigest', String(notifWeeklyDigest));
      localStorage.setItem('arcreach_notifDailyWarmup', String(notifDailyWarmup));
      localStorage.setItem('arcreach_notifSpamTraps', String(notifSpamTraps));
    }
    triggerToast('Notification delivery preferences updated.');
  };

  // --- TAB 4: API INTEGRATIONS STATES ---
  // Azure settings
  const [azureConnected, setAzureConnected] = useState(true);
  const [azureConnString, setAzureConnString] = useState('endpoint=https://arcreach-relay.communication.azure.com/;accesskey=****m928s19==');
  const [azureSenderDomain, setAzureSenderDomain] = useState('outbound.arcreach-platform.com');
  const [showAzureConfig, setShowAzureConfig] = useState(false);

  const handleSaveAzureConfig = (e: React.FormEvent) => {
    e.preventDefault();
    if (typeof window !== 'undefined') {
      localStorage.setItem('arcreach_azureConnString', azureConnString);
      localStorage.setItem('arcreach_azureSenderDomain', azureSenderDomain);
      localStorage.setItem('arcreach_azureConnected', String(azureConnected));
    }
    triggerToast('Azure Communication Services integration updated.');
    setShowAzureConfig(false);
  };

  // Webhooks state
  const [webhooks, setWebhooks] = useState<WebhookItem[]>([
    { id: 'wh-1', url: 'https://api.crm-client.com/webhooks/arcreach', events: ['lead.replied', 'email.bounced'], secret: process.env.NEXT_PUBLIC_CRM_WEBHOOK_SECRET || 'whsec_placeholder_secret_key_12345', created: '2026-05-20' }
  ]);
  const [newWebhookUrl, setNewWebhookUrl] = useState('');
  const [newWhEvents, setNewWhEvents] = useState<string[]>(['lead.replied']);
  const [showWebhookForm, setShowWebhookForm] = useState(false);

  const handleAddWebhook = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWebhookUrl.trim()) return;
    if (!newWebhookUrl.startsWith('http://') && !newWebhookUrl.startsWith('https://')) {
      triggerToast('Webhook endpoint absolute URL must start with http:// or https://');
      return;
    }

    const randomSecret = 'whsec_' + Array.from({ length: 16 }, () => Math.random().toString(16)[2]).join('');
    const newWh: WebhookItem = {
      id: `wh-${Date.now()}`,
      url: newWebhookUrl.trim(),
      events: [...newWhEvents],
      secret: randomSecret,
      created: new Date().toISOString().split('T')[0]
    };

    const updatedWebhooks = [...webhooks, newWh];
    setWebhooks(updatedWebhooks);
    if (typeof window !== 'undefined') {
      localStorage.setItem('arcreach_webhooks', JSON.stringify(updatedWebhooks));
    }
    setNewWebhookUrl('');
    setShowWebhookForm(false);
    triggerToast('Webhook listener registered successfully.');
  };

  const handleRemoveWebhook = (id: string) => {
    const updatedWebhooks = webhooks.filter(w => w.id !== id);
    setWebhooks(updatedWebhooks);
    if (typeof window !== 'undefined') {
      localStorage.setItem('arcreach_webhooks', JSON.stringify(updatedWebhooks));
    }
    triggerToast('Webhook endpoint registration deleted.');
  };

  const toggleEventSelection = (evtName: string) => {
    if (newWhEvents.includes(evtName)) {
      setNewWhEvents(newWhEvents.filter(e => e !== evtName));
    } else {
      setNewWhEvents([...newWhEvents, evtName]);
    }
  };

  // SMTP Testing Simulator State
  const [smtpHost, setSmtpHost] = useState('smtp.mailgun.org');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUser, setSmtpUser] = useState('postmaster@sandbox.arcreach.com');
  const [smtpPass, setSmtpPass] = useState('•••••••••••••••••••••••••••••');
  const [smtpLogs, setSmtpLogs] = useState<string[]>([]);
  const [smtpLoading, setSmtpLoading] = useState(false);

  const handleTestSmtpConnection = () => {
    setSmtpLoading(true);
    setSmtpLogs([]);

    if (typeof window !== 'undefined') {
      localStorage.setItem('arcreach_smtpHost', smtpHost);
      localStorage.setItem('arcreach_smtpPort', smtpPort);
      localStorage.setItem('arcreach_smtpUser', smtpUser);
      localStorage.setItem('arcreach_smtpPass', smtpPass);
    }
    
    const logs = [
      `[SMTP] Resolving MX server domain of mail relay host ${smtpHost}...`,
      `[SMTP] Connected to remote server on port ${smtpPort} successfully.`,
      `[SMTP] Sending EHLO protocol handshake to relay.`,
      `[SMTP] STARTTLS negotiated successfully. Connection is encrypted.`,
      `[SMTP] Sending AUTH PLAIN transaction for user ${smtpUser}...`,
      `[SMTP] Checking recipient delivery routes response.`,
      `✓ Connection testing successfully completed! Ready for deliverability.`
    ];

    let currentLogIndex = 0;
    const interval = setInterval(() => {
      if (currentLogIndex < logs.length) {
        setSmtpLogs(prev => [...prev, logs[currentLogIndex]]);
        currentLogIndex++;
      } else {
        clearInterval(interval);
        setSmtpLoading(false);
        triggerToast('Outbound custom SMTP configuration connection validated!');
      }
    }, 450);
  };

  // --- PERSISTENCE: LOAD STATES ON MOUNT ---
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedFirstName = localStorage.getItem('arcreach_firstName');
      const savedLastName = localStorage.getItem('arcreach_lastName');
      const savedOrgName = localStorage.getItem('arcreach_orgName');
      const savedTimezone = localStorage.getItem('arcreach_timezone');
      const savedTwoFA = localStorage.getItem('arcreach_twoFactorEnabled');
      const savedApiKeys = localStorage.getItem('arcreach_apiKeys');
      const savedNotifDeliverability = localStorage.getItem('arcreach_notifDeliverability');
      const savedNotifReplies = localStorage.getItem('arcreach_notifReplies');
      const savedNotifWeeklyDigest = localStorage.getItem('arcreach_notifWeeklyDigest');
      const savedNotifDailyWarmup = localStorage.getItem('arcreach_notifDailyWarmup');
      const savedNotifSpamTraps = localStorage.getItem('arcreach_notifSpamTraps');
      const savedAzureConnected = localStorage.getItem('arcreach_azureConnected');
      const savedAzureConnString = localStorage.getItem('arcreach_azureConnString');
      const savedAzureSenderDomain = localStorage.getItem('arcreach_azureSenderDomain');
      const savedWebhooks = localStorage.getItem('arcreach_webhooks');
      const savedSmtpHost = localStorage.getItem('arcreach_smtpHost');
      const savedSmtpPort = localStorage.getItem('arcreach_smtpPort');
      const savedSmtpUser = localStorage.getItem('arcreach_smtpUser');
      const savedSmtpPass = localStorage.getItem('arcreach_smtpPass');

      // Schedule asynchronously to prevent synchronous render warnings
      setTimeout(() => {
        if (savedFirstName) setFirstName(savedFirstName);
        if (savedLastName) setLastName(savedLastName);
        if (savedOrgName) setOrgName(savedOrgName);
        if (savedTimezone) setTimezone(savedTimezone);
        if (savedTwoFA !== null) setTwoFactorEnabled(savedTwoFA === 'true');
        if (savedApiKeys) {
          try {
            setApiKeys(JSON.parse(savedApiKeys));
          } catch (e) {
            console.error(e);
          }
        }
        if (savedNotifDeliverability !== null) setNotifDeliverability(savedNotifDeliverability === 'true');
        if (savedNotifReplies !== null) setNotifReplies(savedNotifReplies === 'true');
        if (savedNotifWeeklyDigest !== null) setNotifWeeklyDigest(savedNotifWeeklyDigest === 'true');
        if (savedNotifDailyWarmup !== null) setNotifDailyWarmup(savedNotifDailyWarmup === 'true');
        if (savedNotifSpamTraps !== null) setNotifSpamTraps(savedNotifSpamTraps === 'true');
        if (savedAzureConnected !== null) setAzureConnected(savedAzureConnected === 'true');
        if (savedAzureConnString) setAzureConnString(savedAzureConnString);
        if (savedAzureSenderDomain) setAzureSenderDomain(savedAzureSenderDomain);
        if (savedWebhooks) {
          try {
            setWebhooks(JSON.parse(savedWebhooks));
          } catch (e) {
            console.error(e);
          }
        }
        if (savedSmtpHost) setSmtpHost(savedSmtpHost);
        if (savedSmtpPort) setSmtpPort(savedSmtpPort);
        if (savedSmtpUser) setSmtpUser(savedSmtpUser);
        if (savedSmtpPass) setSmtpPass(savedSmtpPass);
      }, 0);
    }
  }, []);

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-4xl mx-auto pb-16">
      
      {/* Dynamic Toast Message */}
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
        <p className="text-slate-500 dark:text-slate-400 text-xs font-medium">Manage authenticated SMTP servers, API records, and team roles.</p>
      </header>

      <div className="flex flex-col md:flex-row gap-6">
        {/* Settings Navigation Sidebar */}
        <div className="w-full md:w-56 shrink-0">
          <nav className="flex md:flex-col gap-1 overflow-x-auto pb-2 md:pb-0">
            <button 
              onClick={() => setActiveTab('profile')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
                activeTab === 'profile'
                  ? 'bg-blue-50 dark:bg-blue-600/10 text-blue-700 dark:text-blue-400 border border-blue-150 dark:border-blue-500/10 shadow-2xs'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/[0.01] hover:text-slate-900 dark:hover:text-white border border-transparent'
              }`}
            >
              <User className="w-4 h-4" />
              My Profile
            </button>
            <button 
              onClick={() => setActiveTab('security')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
                activeTab === 'security'
                  ? 'bg-blue-50 dark:bg-blue-600/10 text-blue-700 dark:text-blue-400 border border-blue-150 dark:border-blue-500/10 shadow-2xs'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/[0.01] hover:text-slate-900 dark:hover:text-white border border-transparent'
              }`}
            >
              <Shield className="w-4 h-4" />
              Security & Keys
            </button>
            <button 
              onClick={() => setActiveTab('notifications')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
                activeTab === 'notifications'
                  ? 'bg-blue-50 dark:bg-blue-600/10 text-blue-700 dark:text-blue-400 border border-blue-150 dark:border-blue-500/10 shadow-2xs'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/[0.01] hover:text-slate-900 dark:hover:text-white border border-transparent'
              }`}
            >
              <Bell className="w-4 h-4" />
              Notifications
            </button>
            <button 
              onClick={() => setActiveTab('integrations')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
                activeTab === 'integrations'
                  ? 'bg-blue-50 dark:bg-blue-600/10 text-blue-700 dark:text-blue-400 border border-blue-150 dark:border-blue-500/10 shadow-2xs'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/[0.01] hover:text-slate-900 dark:hover:text-white border border-transparent'
              }`}
            >
              <Key className="w-4 h-4" />
              API Integrations
            </button>
          </nav>
        </div>

        {/* Settings Content Screen */}
        <div className="flex-1 space-y-6">

          {/* ================= MY PROFILE TAB ================= */}
          {activeTab === 'profile' && (
            <div className="space-y-6 animate-in fade-in duration-300">
              <form onSubmit={handleSaveProfile} className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 shadow-xs">
                <h2 className="text-xs font-bold uppercase tracking-widest text-[#64748b] dark:text-slate-400 mb-4 pb-2 border-b border-slate-100 dark:border-[#1b1c26]">Profile Information</h2>
                
                <div className="flex items-center gap-5 mb-6">
                  <div className="w-14 h-14 rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-505/15 flex items-center justify-center text-lg font-bold text-blue-700 dark:text-blue-400 shadow-2xs font-mono">
                    {profileInitials}
                  </div>
                  <div>
                    <button 
                      type="button"
                      onClick={handleRandomizeAvatar}
                      className="px-3 py-1.5 bg-white dark:bg-[#12141d] hover:bg-slate-50 dark:hover:bg-white/[0.01] border border-slate-200 dark:border-[#1f2130] text-slate-700 dark:text-gray-300 text-xs font-bold rounded-lg transition-all shadow-2xs mb-1"
                    >
                      Randomize Profile Identity
                    </button>
                    <p className="text-[10px] text-slate-400 dark:text-slate-500 font-medium">Auto-generates visual initials and avatar layout dynamically.</p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">First Name</label>
                      <input 
                        type="text" 
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 placeholder:text-slate-400 shadow-2xs"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Last Name</label>
                      <input 
                        type="text" 
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 placeholder:text-slate-400 shadow-2xs"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Company Organization</label>
                      <input 
                        type="text" 
                        value={orgName}
                        onChange={(e) => setOrgName(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 placeholder:text-slate-400 shadow-2xs"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Local Timezone Option</label>
                      <select 
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 cursor-pointer"
                      >
                        <option value="America/New_York">UTC-5 East Coast (New York)</option>
                        <option value="America/Los_Angeles">UTC-8 West Coast (Los Angeles)</option>
                        <option value="Europe/London">UTC+0 Western Europe (London)</option>
                        <option value="Asia/Tokyo">UTC+9 East Asia (Tokyo)</option>
                        <option value="Australia/Sydney">UTC+10 East Australia (Sydney)</option>
                      </select>
                    </div>
                  </div>

                  <div className="space-y-1.5 border-t border-slate-100 dark:border-slate-850 pt-4">
                    <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Registered E-Mail Account Identifier</label>
                    <input 
                      type="email" 
                      defaultValue="john.doe@example.com"
                      className="w-full bg-slate-100/60 dark:bg-gray-950/20 border border-slate-200 dark:border-[#1b1c26] text-slate-400 dark:text-slate-500 text-xs rounded-lg px-3 py-2 cursor-not-allowed outline-none"
                      disabled
                    />
                    <p className="text-[10px] text-slate-400 dark:text-slate-500 font-medium font-mono">Contact admin support to transfer your billing and ownership profiles.</p>
                  </div>
                </div>

                <div className="flex justify-end gap-2.5 mt-6 pt-4 border-t border-slate-100 dark:border-slate-850">
                   <button 
                     type="button"
                     onClick={() => { setFirstName('John'); setLastName('Doe'); setOrgName('ArcReach Solutions Ltd'); }}
                     className="px-4 py-2 bg-white dark:bg-[#12141d] hover:bg-slate-50 dark:hover:bg-white/[0.01] border border-slate-200 dark:border-[#1f2130] text-slate-700 dark:text-gray-300 font-bold rounded-lg transition-all text-xs shadow-2xs"
                   >
                     Reset Fields
                   </button>
                   <button 
                     type="submit"
                     className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition-all text-xs flex items-center gap-1.5 shadow-md hover:shadow-blue-500/10"
                   >
                     <Save className="w-3.5 h-3.5" />
                     Save Profiles
                   </button>
                </div>
              </form>

              {/* Status Section Card */}
              <div className="bg-slate-50 dark:bg-[#0c0d14] border border-slate-200 dark:border-slate-805 rounded-xl p-4 flex items-center gap-4">
                 <div className="w-10 h-10 bg-blue-500/10 dark:bg-blue-400/10 text-blue-600 dark:text-blue-400 rounded-lg flex items-center justify-center shrink-0">
                    <UserCheck className="w-5 h-5" />
                 </div>
                 <div>
                    <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wide">Role Authority Check</h4>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Your email account is configured as a global team super admin. You possess complete configurations and inbound relay management.</p>
                 </div>
              </div>
            </div>
          )}

          {/* ================= SECURITY & KEYS TAB ================= */}
          {activeTab === 'security' && (
            <div className="space-y-6 animate-in fade-in duration-300">
              
              {/* Reset Password Form */}
              <form onSubmit={handleSavePassword} className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 shadow-xs">
                <h3 className="text-xs font-bold uppercase tracking-widest text-[#64748b] dark:text-slate-400 mb-4 pb-2 border-b border-slate-100 dark:border-[#1b1c26]">Change Secure Password</h3>
                
                {passwordError && (
                  <div className="mb-4 p-3 bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 rounded-lg text-xs flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{passwordError}</span>
                  </div>
                )}

                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Current Active Password</label>
                    <div className="relative">
                      <input 
                        type={showPass ? "text" : "password"}
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        placeholder="•••••••••••••••••"
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 pr-10 outline-none focus:ring-2 focus:ring-blue-500/35 shadow-2xs font-mono"
                      />
                      <button 
                        type="button"
                        onClick={() => setShowPass(!showPass)}
                        className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                      >
                        {showPass ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">New Secure Password</label>
                      <input 
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="Min. 8 characters"
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 shadow-2xs font-mono"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Confirm New Password</label>
                      <input 
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Retype password"
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 shadow-2xs font-mono"
                      />
                    </div>
                  </div>
                </div>

                <div className="flex justify-end mt-5 pt-4 border-t border-slate-100 dark:border-[#1b1c26]">
                  <button 
                    type="submit"
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition-all text-xs flex items-center gap-1.5 shadow-md"
                  >
                    <Lock className="w-3.5 h-3.5" />
                    Apply Password Security
                  </button>
                </div>
              </form>

              {/* Two Factor Authentication Card */}
              <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 shadow-xs">
                <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-[#1b1c26] mb-4">
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-[#64748b] dark:text-slate-400">Two-Factor Authenticator (2FA)</h3>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">Enforce verification dynamic logs code on auth session.</p>
                  </div>
                  <button 
                    type="button"
                    onClick={() => {
                      setTwoFactorEnabled(!twoFactorEnabled);
                      triggerToast(`2FA verification status ${!twoFactorEnabled ? 'enforced' : 'deactivated'}.`);
                    }}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${twoFactorEnabled ? 'bg-blue-600' : 'bg-slate-200 dark:bg-slate-800'}`}
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${twoFactorEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>

                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 text-xs">
                  <div className="p-2.5 bg-blue-50 dark:bg-blue-950/20 text-blue-700 dark:text-blue-400 rounded-lg font-mono text-[10px] border border-blue-100 dark:border-blue-500/10 shadow-2xs font-medium uppercase tracking-wide">
                    {twoFactorEnabled ? "STATUS: SECURE 2FA ENFORCED" : "STATUS: PASSWORD AUTH ONLY"}
                  </div>
                  <p className="text-slate-400 dark:text-slate-500 font-medium">
                    {twoFactorEnabled 
                      ? "Your mobile authentication app is synced. Backup emergency codes are available offline."
                      : "We recommend enabling an authenticator app (Google Authenticator or Duo Security) to lock down access paths."}
                  </p>
                </div>
              </div>

              {/* API Access Keys & Tokens */}
              <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 shadow-xs">
                <div className="flex justify-between items-center pb-3 border-b border-slate-100 dark:border-[#1b1c26] mb-4">
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-[#64748b] dark:text-slate-400">API Outbound Access Keys</h3>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">Manage access tokens configured in automated curl requests.</p>
                  </div>
                  <button 
                    onClick={() => setShowAddKeyForm(!showAddKeyForm)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 hover:bg-slate-100 dark:bg-[#12141d] dark:hover:bg-[#1b1d28] border border-slate-200 dark:border-[#1f2130] rounded-lg text-xs font-semibold text-slate-800 dark:text-white transition-all shadow-2xs"
                  >
                    {showAddKeyForm ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                    {showAddKeyForm ? 'Cancel' : 'Generate API Key'}
                  </button>
                </div>

                {showAddKeyForm && (
                  <form onSubmit={handleGenerateApiKey} className="mb-6 p-4 bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1b1c26] rounded-xl space-y-4 animate-in slide-in-from-top-4 duration-350">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Key Custom Name label</label>
                        <input 
                          type="text" 
                          required 
                          placeholder="e.g. Zapier webhook integration key"
                          value={newKeyName}
                          onChange={(e) => setNewKeyName(e.target.value)}
                          className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-850 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 shadow-2xs"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Access Role Scope</label>
                        <select 
                          value={newKeyRole}
                          onChange={(e) => setNewKeyRole(e.target.value)}
                          className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-850 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 cursor-pointer"
                        >
                          <option>Admin (Full Access)</option>
                          <option>Read-Only Access</option>
                          <option>Outbound Senders Dispatcher Scope</option>
                        </select>
                      </div>
                    </div>
                    <div className="flex justify-end gap-2.5">
                      <button 
                        type="button" 
                        onClick={() => { setShowAddKeyForm(false); setNewKeyName(''); }}
                        className="px-3.5 py-1.8 text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white"
                      >
                        Abandon
                      </button>
                      <button 
                        type="submit" 
                        className="px-4 py-1.8 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg text-xs transition-all shadow-xs"
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
                      {apiKeys.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="text-center py-6 text-xs text-slate-400">
                            No secret API tokens generated yet.
                          </td>
                        </tr>
                      ) : (
                        apiKeys.map(k => (
                          <tr key={k.id} className="group">
                            <td className="py-3 text-xs font-bold text-slate-800 dark:text-slate-200">{k.name}</td>
                            <td className="py-3 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
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
                                  className="p-1 px-2 border border-slate-200 dark:border-slate-800 bg-white hover:bg-slate-50 dark:bg-[#12141d] dark:hover:bg-slate-800 rounded flex items-center gap-1 text-[11px] font-bold text-slate-600 dark:text-slate-350 transition-all shadow-2xs"
                                  title="Copy token secret key to clipboard"
                                >
                                  {copiedKeyId === k.id ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                                  {copiedKeyId === k.id ? 'Copied!' : 'Copy'}
                                </button>
                                <button 
                                  onClick={() => handleRevokeKey(k.id)}
                                  className="p-1 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 rounded transition-all"
                                  title="Revoke and delete this credential"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
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
                <h3 className="text-xs font-bold uppercase tracking-widest text-[#64748b] dark:text-slate-400 mb-0.5">Email Outbound & Dispatch Notifications</h3>
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mb-6 font-medium">Define which system events sync triggered alerts to your admin inbox.</p>
                
                <div className="divide-y divide-slate-100 dark:divide-slate-850 space-y-4">
                  
                  {/* Item 1 */}
                  <div className="flex items-center justify-between py-1 pt-1">
                    <div>
                      <h4 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider">Deliverability Drops (Reputation Warn Alert)</h4>
                      <p className="text-[11px] text-slate-400 dark:text-slate-400 mt-0.5">E-mail when any sender domain domain health index falls below 95%.</p>
                    </div>
                    <button 
                      type="button"
                      onClick={() => setNotifDeliverability(!notifDeliverability)}
                      className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${notifDeliverability ? 'bg-blue-600' : 'bg-slate-200 dark:bg-slate-800'}`}
                    >
                      <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${notifDeliverability ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                  </div>

                  {/* Item 2 */}
                  <div className="flex items-center justify-between py-3">
                    <div>
                      <h4 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider">Customer Replies (Unibox Inbox Notifications)</h4>
                      <p className="text-[11px] text-slate-400 dark:text-slate-400 mt-0.5">Alert immediately when cold prospects express feedback or answer campaigns.</p>
                    </div>
                    <button 
                      type="button"
                      onClick={() => setNotifReplies(!notifReplies)}
                      className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${notifReplies ? 'bg-blue-600' : 'bg-slate-200 dark:bg-slate-800'}`}
                    >
                      <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${notifReplies ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                  </div>

                  {/* Item 3 */}
                  <div className="flex items-center justify-between py-3">
                    <div>
                      <h4 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider">Weekly Analytic Performance Digest</h4>
                      <p className="text-[11px] text-slate-400 dark:text-slate-400 mt-0.5">Compile every Monday open-rates, sequences conversion funnel charts.</p>
                    </div>
                    <button 
                      type="button"
                      onClick={() => setNotifWeeklyDigest(!notifWeeklyDigest)}
                      className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${notifWeeklyDigest ? 'bg-blue-600' : 'bg-slate-200 dark:bg-slate-800'}`}
                    >
                      <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${notifWeeklyDigest ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                  </div>

                  {/* Item 4 */}
                  <div className="flex items-center justify-between py-3">
                    <div>
                      <h4 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider">Daily Warmup Deliverability Updates</h4>
                      <p className="text-[11px] text-slate-400 dark:text-slate-400 mt-0.5">Confirm email warmup accounts saved count status reports daily.</p>
                    </div>
                    <button 
                      type="button"
                      onClick={() => setNotifDailyWarmup(!notifDailyWarmup)}
                      className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${notifDailyWarmup ? 'bg-blue-600' : 'bg-slate-200 dark:bg-slate-800'}`}
                    >
                      <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${notifDailyWarmup ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                  </div>

                  {/* Item 5 */}
                  <div className="flex items-center justify-between py-3">
                    <div>
                      <h4 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider">Critical Spam blacklisted warn trigger</h4>
                      <p className="text-[11px] text-slate-400 dark:text-slate-400 mt-0.5">Major alarms when dynamic testing reveals IP blocks on spam relays.</p>
                    </div>
                    <button 
                      type="button"
                      onClick={() => setNotifSpamTraps(!notifSpamTraps)}
                      className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${notifSpamTraps ? 'bg-blue-600' : 'bg-slate-200 dark:bg-slate-800'}`}
                    >
                      <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${notifSpamTraps ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                  </div>

                </div>

                <div className="flex justify-end pt-5 border-t border-slate-100 dark:border-slate-850 mt-5">
                  <button 
                    onClick={handleSaveNotifications}
                    type="button"
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition-all text-xs flex items-center gap-1.5 shadow-md"
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
              
              {/* Azure Services Integration */}
              <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 shadow-xs">
                <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-[#1b1c26] mb-4">
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-slate-800 dark:text-slate-200">Azure Communication Services</h3>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 font-medium">Outbound email dispatch core sequence pipeline engine.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded font-mono border ${
                      azureConnected 
                        ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-150 dark:border-emerald-500/20' 
                        : 'bg-slate-100 dark:bg-slate-900 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-800'
                    }`}>
                      {azureConnected ? 'CONNECTED' : 'INACTIVE'}
                    </span>
                    <button 
                      onClick={() => {
                        setAzureConnected(!azureConnected);
                        triggerToast(`Azure delivery endpoint ${!azureConnected ? 'connected' : 'disconnected'}.`);
                      }}
                      className="px-2.5 py-1 text-[11px] font-bold text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 border border-transparent"
                    >
                      {azureConnected ? 'Disconnect' : 'Connect'}
                    </button>
                  </div>
                </div>

                {azureConnected && (
                  <div className="space-y-4">
                    <div className="p-3 bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-805 rounded-lg flex items-start gap-2.5">
                      <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                      <div className="text-[11px] text-slate-600 dark:text-slate-400">
                        The delivery engine is active and successfully processing templates on target queues. Over half of outbound mail was routed via endpoint: <strong className="text-slate-800 dark:text-white font-mono">{azureSenderDomain}</strong>.
                      </div>
                    </div>

                    <button 
                      onClick={() => setShowAzureConfig(!showAzureConfig)}
                      className="text-xs font-semibold text-slate-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 flex items-center gap-1 transition-colors"
                    >
                      {showAzureConfig ? 'Hide Credentials' : 'Click to update Azure Dispatcher Secrets'}
                      <ChevronRight className={`w-3.5 h-3.5 transform transition-transform ${showAzureConfig ? 'rotate-90' : ''}`} />
                    </button>

                    {showAzureConfig && (
                      <form onSubmit={handleSaveAzureConfig} className="p-4 bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1a1c26] rounded-xl space-y-4 animate-in slide-in-from-top-2 duration-250">
                        <div className="space-y-1.5">
                          <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Azure Connection String token</label>
                          <input 
                            type="text" 
                            required 
                            value={azureConnString}
                            onChange={(e) => setAzureConnString(e.target.value)}
                            className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35 shadow-2xs"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Verified Outbound Domain Handle</label>
                          <input 
                            type="text" 
                            required 
                            value={azureSenderDomain}
                            onChange={(e) => setAzureSenderDomain(e.target.value)}
                            className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35 shadow-2xs"
                          />
                        </div>
                        <div className="flex justify-end gap-2.5">
                          <button 
                            type="button" 
                            onClick={() => setShowAzureConfig(false)}
                            className="px-3.5 py-1.8 text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white"
                          >
                            Abandon
                          </button>
                          <button 
                            type="submit" 
                            className="px-4 py-1.8 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg text-xs transition-all shadow-xs"
                          >
                            Update Integration
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                )}
              </div>

              {/* Webhooks Manager */}
              <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 shadow-xs">
                <div className="flex justify-between items-center pb-3 border-b border-slate-100 dark:border-[#1b1c26] mb-4">
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-slate-800 dark:text-slate-200">Outbound Event Webhooks</h3>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">Stream lead engagement updates, replies & bounces to external URL targets.</p>
                  </div>
                  <button 
                    onClick={() => setShowWebhookForm(!showWebhookForm)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 hover:bg-slate-100 dark:bg-[#12141d] dark:hover:bg-[#1b1d28] border border-slate-200 dark:border-[#1f2130] rounded-lg text-xs font-semibold text-slate-800 dark:text-white transition-all shadow-2xs"
                  >
                    {showWebhookForm ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                    {showWebhookForm ? 'Close' : 'Add Webhook'}
                  </button>
                </div>

                {showWebhookForm && (
                  <form onSubmit={handleAddWebhook} className="mb-6 p-4 bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1b1c26] rounded-xl space-y-4 animate-in slide-in-from-top-2 duration-250">
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Webhook Endpoint URL</label>
                      <input 
                        type="text" 
                        required 
                        placeholder="https://your-crm.com/api/v1/arcreach-ingest"
                        value={newWebhookUrl}
                        onChange={(e) => setNewWebhookUrl(e.target.value)}
                        className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/35 shadow-2xs"
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest block">Involved Outbound Events to Dispatch</label>
                      <div className="flex flex-wrap gap-2.5">
                        {['lead.replied', 'email.bounced', 'email.opened', 'lead.unsubscribed'].map(evt => (
                          <button
                            key={evt}
                            type="button"
                            onClick={() => toggleEventSelection(evt)}
                            className={`px-3 py-1.5 rounded-lg border text-[11px] font-semibold transition-all ${
                              newWhEvents.includes(evt)
                                ? 'bg-blue-50 dark:bg-blue-600/10 border-blue-200 dark:border-blue-500/20 text-blue-700 dark:text-blue-400'
                                : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
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
                        className="px-3.5 py-1.8 text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white"
                      >
                        Cancel
                      </button>
                      <button 
                        type="submit" 
                        className="px-4 py-1.8 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg text-xs transition-colors shadow-xs"
                      >
                        Register Webhook
                      </button>
                    </div>
                  </form>
                )}

                <div className="space-y-3">
                  {webhooks.length === 0 ? (
                    <div className="text-center py-6 text-xs text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded-lg">
                      No webhook listeners registered.
                    </div>
                  ) : (
                    webhooks.map(wh => (
                      <div key={wh.id} className="p-4 border border-slate-200 dark:border-slate-850 dark:bg-[#12141d]/40 rounded-xl relative hover:border-slate-300 dark:hover:border-slate-800 transition-all">
                        <button 
                          onClick={() => handleRemoveWebhook(wh.id)}
                          className="absolute right-3.5 top-3.5 p-1 text-slate-400 hover:text-rose-600 dark:hover:text-rose-500 rounded transition-all"
                          title="Remove Webhook listener"
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

                          <div className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                            Signing Secret: <span className="bg-slate-100 dark:bg-slate-900 px-1 py-0.5 rounded">{wh.secret}</span>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Custom SMTP Outbound Relayer Check */}
              <div className="bg-white dark:bg-[#0e1017] border border-slate-200 dark:border-[#1b1c26] rounded-xl p-5 shadow-xs">
                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-800 dark:text-slate-200 mb-0.5">Alternative Outbound SMTP Relay</h3>
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mb-4 font-medium">Bypass Azure and dispatch lead sequencers via your own transactional server credentials.</p>

                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">SMTP Host Server hostname</label>
                      <input 
                        type="text" 
                        value={smtpHost}
                        onChange={(e) => setSmtpHost(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Port Connection</label>
                      <input 
                        type="text" 
                        value={smtpPort}
                        onChange={(e) => setSmtpPort(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Outbound Identity Username</label>
                      <input 
                        type="text" 
                        value={smtpUser}
                        onChange={(e) => setSmtpUser(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">Outbound Password Key</label>
                      <input 
                        type="password" 
                        value={smtpPass}
                        onChange={(e) => setSmtpPass(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-[#12141d] border border-slate-200 dark:border-[#1f2130] text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none font-mono focus:ring-2 focus:ring-blue-500/35"
                      />
                    </div>
                    <div className="flex items-end pb-0.5">
                      <button 
                        type="button" 
                        disabled={smtpLoading}
                        onClick={handleTestSmtpConnection}
                        className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-650 text-white font-semibold text-xs py-2 rounded-lg transition-colors shadow-2xs font-sans cursor-pointer"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${smtpLoading ? 'animate-spin' : ''}`} />
                        {smtpLoading ? 'Communicating Server...' : 'Test SMTP Authentication Connection'}
                      </button>
                    </div>
                  </div>

                  {/* Simulator logs terminal */}
                  {(smtpLogs.length > 0 || smtpLoading) && (
                    <div className="p-3.5 bg-slate-950 rounded-lg text-[11px] font-mono whitespace-pre-wrap text-[#cbd5e1] leading-relaxed border border-slate-850 max-h-52 overflow-y-auto">
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

                </div>
              </div>

            </div>
          )}

        </div>
      </div>
    </div>
  );
}

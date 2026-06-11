/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import { 
  ArrowLeft, 
  Save, 
  Send, 
  Settings, 
  Users, 
  AlignLeft, 
  Clock, 
  ToggleLeft, 
  Plus, 
  Trash2, 
  SplitSquareHorizontal,
  Mail,
  User,
  CheckCircle2,
  MousePointerClick,
  Reply,
  SendHorizontal,
  PlayCircle,
  Sparkles,
  ChevronDown,
  Play,
  Loader2
} from 'lucide-react';
import Link from 'next/link';
import { use, useState, useEffect } from 'react';
import { useTimezones } from '@/hooks/use-timezones';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { motion, AnimatePresence } from 'motion/react';

export default function CampaignDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const campaignId = resolvedParams.id;
  const timezoneOptions = useTimezones();

  const [campaign, setCampaign] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('Sequence');
  const [templates, setTemplates] = useState<any[]>([]);
  const [previewSteps, setPreviewSteps] = useState<Record<string, boolean>>({});

  const toggleStepPreview = (stepIdOrIndex: string | number) => {
    setPreviewSteps(prev => ({
      ...prev,
      [stepIdOrIndex]: !prev[stepIdOrIndex]
    }));
  };

  const resolveTemplateText = (text: string) => {
    if (!text) return '';
    let result = text;
    result = result.replace(/\{\{firstName\}\}/g, 'Emily');
    result = result.replace(/\{\{company\}\}/g, 'Stark Industries');
    result = result.replace(/\{\{\s*\$json\.name\s*\|\|\s*'[^']*'\s*\}\}/g, 'Emily');
    result = result.replace(/\{\{\s*\$json\.name\s*\}\}/g, 'Emily');

    const spintaxRegex = /\{([^{}]+)\}/g;
    result = result.replace(spintaxRegex, (match, options) => {
      const choices = options.split('|');
      return choices[0] || '';
    });

    return result;
  };

  const isHtml = (text: string) => {
    if (!text) return false;
    const clean = text.trim().toLowerCase();
    return clean.startsWith('<!doctype html') || clean.startsWith('<html') || clean.startsWith('<body') || clean.includes('<div') || clean.includes('<table');
  };

  // Input states
  const [campaignName, setCampaignName] = useState('');
  const [status, setStatus] = useState('Draft');
  const [audienceCohort, setAudienceCohort] = useState('Valid');
  const [runningCampaign, setRunningCampaign] = useState(false);
  const [timezone, setTimezone] = useState('America/New_York');
  const [stopOnReply, setStopOnReply] = useState(true);
  const [trackOpens, setTrackOpens] = useState(true);
  const [trackClicks, setTrackClicks] = useState(true);
  const [steps, setSteps] = useState<any[]>([]);

  // Schedule days & time window
  const [selectedDays, setSelectedDays] = useState<string[]>(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('17:00');

  // Toast state
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const loadTemplates = async () => {
    try {
      const res = await fetch('/api/templates');
      if (res.ok) {
        const data = await res.json();
        setTemplates(data);
      }
    } catch (err) {
      console.error('Failed to load templates:', err);
    }
  };

  const applyTemplate = (templateId: string) => {
    if (!templateId) return;
    const selected = templates.find(t => t.id === templateId);
    if (!selected) return;

    let parsedSteps: any[] = [];
    if (selected.steps) {
      try {
        parsedSteps = typeof selected.steps === 'string' ? JSON.parse(selected.steps) : selected.steps;
      } catch (e) {
        console.error('Error parsing template steps:', e);
      }
    }

    if (parsedSteps && parsedSteps.length > 0) {
      const newSteps = parsedSteps.map((step, idx) => ({
        id: `temp-${Date.now()}-${idx}`,
        waitDays: idx === 0 ? 0 : (step.waitDays || 3),
        subject: step.subject || '',
        body: step.body || '',
        isABTest: false
      }));
      setSteps(newSteps);
    } else {
      setSteps([
        {
          id: `temp-${Date.now()}`,
          waitDays: 0,
          subject: selected.subject || '',
          body: selected.body || '',
          isABTest: false
        }
      ]);
    }
    showToast(`Applied template: ${selected.name}`);
  };

  const loadCampaign = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/campaigns/${campaignId}`);
      if (res.ok) {
        const data = await res.json();
        setCampaign(data);
        
        // Populate inputs
        setCampaignName(data.name || '');
        setStatus(data.status || 'Draft');
        setTimezone(data.timezone || 'UTC');
        setAudienceCohort(data.audienceCohort || 'Valid');
        setStopOnReply(data.stopOnReply !== false);
        setTrackOpens(data.trackOpens !== false);
        setTrackClicks(data.trackClicks !== false);
        setSteps(data.steps || []);

        // Populate schedule fields if JSON structure exists
        if (data.sendSchedule) {
          try {
            const sched = typeof data.sendSchedule === 'string' ? JSON.parse(data.sendSchedule) : data.sendSchedule;
            if (sched.days) setSelectedDays(sched.days);
            if (sched.window) {
              if (sched.window.start) setStartTime(sched.window.start);
              if (sched.window.end) setEndTime(sched.window.end);
            }
          } catch (e) {
            console.error('Error parsing campaign schedule:', e);
          }
        }
      } else {
        showToast('Failed to load campaign details.', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Error loading campaign.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCampaign();
    loadTemplates();
  }, [campaignId]);

  const addStep = () => {
    setSteps([...steps, { id: `temp-${Date.now()}`, waitDays: 3, subject: '', body: '', isABTest: false }]);
  };

  const removeStep = (indexToRemove: number) => {
    if (steps.length > 1) {
      setSteps(steps.filter((_, idx) => idx !== indexToRemove));
    }
  };

  const updateStepField = (index: number, field: string, value: any) => {
    setSteps(prev => prev.map((s, idx) => idx === index ? { ...s, [field]: value } : s));
  };

  const insertVariable = (variable: string, index: number) => {
    const currentBody = steps[index]?.body || '';
    updateStepField(index, 'body', currentBody + variable);
  };

  const handleSaveCampaign = async (overrideStatus?: string) => {
    try {
      setSaving(true);
      const targetStatus = overrideStatus || status;

      const scheduleJson = {
        days: selectedDays,
        window: {
          start: startTime,
          end: endTime
        }
      };

      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: campaignName,
          status: targetStatus,
          timezone,
          sendSchedule: scheduleJson,
          stopOnReply,
          trackOpens,
          trackClicks,
          audienceCohort,
          steps
        })
      });

      if (res.ok) {
        showToast('Outbound sequence configuration successfully saved!');
        if (overrideStatus) setStatus(overrideStatus);
        await loadCampaign(); // Reload stats and steps
      } else {
        showToast('Failed to update campaign configuration.', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Error occurred saving sequence configuration.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleRunCampaign = async () => {
    try {
      setRunningCampaign(true);
      const res = await fetch(`/api/campaigns/${campaignId}/run`, {
        method: 'POST'
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(`Campaign processed! Sent ${data.dispatchedCount} emails.`);
        await loadCampaign(); // Refresh metrics
      } else {
        showToast(data.error || 'Failed to process campaign cycle.', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Error occurred while executing campaign.', 'error');
    } finally {
      setRunningCampaign(false);
    }
  };

  const toggleDaySelection = (day: string) => {
    if (selectedDays.includes(day)) {
      setSelectedDays(selectedDays.filter(d => d !== day));
    } else {
      setSelectedDays([...selectedDays, day]);
    }
  };

  // Mock graph data matching telemetry performance trend
  const mockChartData = [
    { name: 'Day 1', opens: Math.round((campaign?.telemetry?.opens || 0) * 0.15), clicks: Math.round((campaign?.telemetry?.clicks || 0) * 0.1) },
    { name: 'Day 2', opens: Math.round((campaign?.telemetry?.opens || 0) * 0.35), clicks: Math.round((campaign?.telemetry?.clicks || 0) * 0.25) },
    { name: 'Day 3', opens: Math.round((campaign?.telemetry?.opens || 0) * 0.55), clicks: Math.round((campaign?.telemetry?.clicks || 0) * 0.45) },
    { name: 'Day 4', opens: Math.round((campaign?.telemetry?.opens || 0) * 0.75), clicks: Math.round((campaign?.telemetry?.clicks || 0) * 0.65) },
    { name: 'Day 5', opens: Math.round((campaign?.telemetry?.opens || 0) * 0.85), clicks: Math.round((campaign?.telemetry?.clicks || 0) * 0.8) },
    { name: 'Day 6', opens: Math.round((campaign?.telemetry?.opens || 0) * 0.95), clicks: Math.round((campaign?.telemetry?.clicks || 0) * 0.9) },
    { name: 'Day 7', opens: campaign?.telemetry?.opens || 0, clicks: campaign?.telemetry?.clicks || 0 },
  ];

  if (loading) {
    return (
      <div className="py-40 text-center text-slate-450 dark:text-slate-500 text-xs space-y-3">
        <div className="w-6 h-6 border-2 border-slate-305 dark:border-slate-700 border-t-blue-500 animate-spin rounded-full mx-auto" />
        <p className="font-medium tracking-wide">Syncing sequence builder configuration...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-5xl mx-auto pb-16">
      
      {/* Toast Alert */}
      <AnimatePresence>
        {toast && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={`fixed top-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-xl border backdrop-blur-md shadow-2xl min-w-[280px] ${
              toast.type === 'success' 
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-450' 
                : 'bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-455'
            }`}
          >
            <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
            <p className="text-xs font-semibold leading-normal">{toast.message}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="flex justify-between items-start pb-4 border-b border-slate-205 dark:border-slate-800">
        <div className="flex gap-4">
          <Link href="/campaigns" className="p-2 h-fit bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800 rounded-lg transition-colors border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-white shadow-xs">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">{campaignName || 'Sequence Setup'}</h1>
              <div className="relative inline-block">
                <select 
                  value={status}
                  onChange={(e) => handleSaveCampaign(e.target.value)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-[10px] uppercase font-bold border cursor-pointer outline-none ${
                    status === 'Active' 
                      ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-150 dark:border-emerald-900/30'
                      : status === 'Paused'
                      ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-705 dark:text-amber-400 border-amber-150 dark:border-amber-900/30'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                  }`}
                >
                  <option value="Draft">Draft</option>
                  <option value="Active">Active</option>
                  <option value="Paused">Paused</option>
                </select>
              </div>
            </div>
            <p className="text-slate-505 dark:text-slate-400 text-xs mt-1">Sender Mailbox: {campaign?.senderAccount?.emailAddress || 'N/A'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {status === 'Active' && (
            <button 
              onClick={handleRunCampaign}
              disabled={runningCampaign}
              className="px-3.5 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-amber-600/50 text-white font-semibold rounded-lg text-xs flex items-center gap-1.5 cursor-pointer shadow-sm transition-colors"
            >
              {runningCampaign ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              {runningCampaign ? 'Running...' : 'Run Campaign'}
            </button>
          )}
          <button 
            onClick={() => handleSaveCampaign()}
            disabled={saving}
            className="px-3.5 py-2 bg-white hover:bg-slate-50 dark:bg-slate-955 dark:hover:bg-slate-800 border border-slate-202 dark:border-slate-800 text-slate-705 dark:text-slate-300 font-semibold rounded-lg text-xs flex items-center gap-1.5 cursor-pointer shadow-xs"
          >
            <Save className="w-3.5 h-3.5 text-slate-400" />
            {saving ? 'Saving...' : 'Save Draft'}
          </button>
          <button 
            onClick={() => handleSaveCampaign('Active')}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg text-xs flex items-center gap-1.5 cursor-pointer shadow-sm transition-colors"
          >
            <Send className="w-3.5 h-3.5" />
            Publish Sequence
          </button>
        </div>
      </header>

      {/* Telemetry Metrics Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { title: 'Total Dispatched', value: campaign?.telemetry?.sent.toLocaleString() || '0', icon: SendHorizontal, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-955/25', border: 'border-blue-100 dark:border-blue-500/10', pct: null },
          { title: 'Email Opens', value: campaign?.telemetry?.opens.toLocaleString() || '0', icon: Mail, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-955/25', border: 'border-blue-105 dark:border-blue-500/10', pct: `${campaign?.telemetry?.openRate || 0}% open rate` },
          { title: 'Goal Clicks', value: campaign?.telemetry?.clicks.toLocaleString() || '0', icon: MousePointerClick, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-955/25', border: 'border-blue-105 dark:border-blue-500/10', pct: `${campaign?.telemetry?.clickRate || 0}% clickthrough` },
          { title: 'CRM Replies', value: campaign?.telemetry?.replies.toLocaleString() || '0', icon: Reply, color: 'text-emerald-700 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-955/25', border: 'border-emerald-100 dark:border-emerald-500/10', pct: `${campaign?.telemetry?.replyRate || 0}% reply rate` },
        ].map((stat, i) => (
          <div key={i} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
            <div className="flex justify-between items-start mb-2">
              <p className="text-[10px] text-slate-550 dark:text-slate-400 font-bold uppercase tracking-widest">{stat.title}</p>
              <div className={`w-8 h-8 rounded ${stat.bg} border ${stat.border} flex items-center justify-center ${stat.color}`}>
                <stat.icon className="w-4 h-4" />
              </div>
            </div>
            <h3 className="text-xl font-bold text-slate-900 dark:text-white">{stat.value}</h3>
            {stat.pct && (
              <p className="text-[10px] text-slate-400 dark:text-slate-505 font-bold mt-1.5 font-mono">{stat.pct}</p>
            )}
          </div>
        ))}
      </div>

      {/* Tabs Menu Bar */}
      <div className="flex gap-1 p-1 bg-white dark:bg-slate-900 border border-slate-202 dark:border-slate-800 rounded-xl w-fit shadow-xs">
        {['Sequence', 'Audience', 'Schedule', 'Options'].map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-1.5 rounded-lg text-[10px] font-bold transition-all uppercase tracking-widest cursor-pointer ${
              activeTab === tab 
                ? 'bg-blue-600 text-white shadow-xs' 
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Main Designer Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="col-span-2 space-y-6">
          
          {activeTab === 'Sequence' && (
             <div className="space-y-6">
                {/* Title Card */}
                <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-405 mb-3 flex items-center gap-2">
                    <Settings className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    Campaign Title
                  </h2>
                  <input 
                    type="text" 
                    placeholder="e.g. Q4 Inactive Leads Engagement"
                    value={campaignName}
                    onChange={(e) => setCampaignName(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-202 dark:border-slate-805 text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2.5 outline-none focus:ring-2 focus:ring-blue-500/40 placeholder:text-slate-400 dark:placeholder:text-slate-500 shadow-xs"
                  />
                </section>

                <div className="flex justify-between items-center pb-1 border-b border-slate-200 dark:border-slate-800">
                  <div className="flex items-center gap-2">
                    <AlignLeft className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">Steps Setup</h2>
                  </div>
                  {templates.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Use Template:</span>
                      <select
                        onChange={(e) => {
                          applyTemplate(e.target.value);
                          e.target.value = "";
                        }}
                        defaultValue=""
                        className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 text-xs rounded-lg px-2 py-1 outline-none font-medium"
                      >
                        <option value="" disabled>-- Select Template --</option>
                        {templates.map(t => (
                          <option key={t.id} value={t.id}>{t.name} ({t.category})</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {/* Automation Steps Stack */}
                {steps.map((step, index) => (
                  <section key={step.id || index} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 relative transition-all shadow-xs">
                    {index > 0 && (
                      <div className="absolute -top-6 left-9 h-6 w-[1.5px] bg-slate-200 dark:bg-slate-800"></div>
                    )}
                    
                    <div className="flex justify-between items-center mb-4">
                      <div className="flex items-center gap-3">
                        <div className="w-7 h-7 rounded bg-blue-50 dark:bg-blue-955/40 text-blue-600 dark:text-blue-400 font-bold flex items-center justify-center text-xs border border-blue-100 dark:border-blue-550/15 font-mono">
                          {index + 1}
                        </div>
                        {index > 0 ? (
                          <div className="flex items-center gap-2 text-xs font-semibold text-slate-705 dark:text-slate-350">
                            Wait for
                            <input 
                              type="number" 
                              value={step.waitDays} 
                              onChange={(e) => updateStepField(index, 'waitDays', parseInt(e.target.value) || 0)}
                              className="w-14 bg-slate-50 dark:bg-slate-950 py-1 px-2 border border-slate-202 dark:border-slate-800 rounded text-center text-xs font-mono outline-none text-slate-800 dark:text-white focus:border-blue-500" 
                            />
                            days
                          </div>
                        ) : (
                          <span className="text-xs font-semibold uppercase tracking-widest text-slate-550 dark:text-slate-400">Initial Dispatch</span>
                        )}
                      </div>
                      
                      <div className="flex gap-2">
                        <button 
                          type="button"
                          onClick={() => toggleStepPreview(step.id || index)}
                          className={`px-2.5 py-1.5 border rounded text-[10px] font-bold transition-colors flex items-center gap-1 cursor-pointer ${
                            previewSteps[step.id || index] !== false
                              ? 'bg-blue-50 dark:bg-blue-600/10 border-blue-200 dark:border-blue-500/20 text-blue-600 dark:text-blue-400' 
                              : 'bg-slate-50 dark:bg-slate-955 dark:hover:bg-slate-805 border-slate-202 dark:border-slate-800 text-slate-700 dark:text-slate-300'
                          }`}
                        >
                          {previewSteps[step.id || index] !== false ? 'Edit Mode' : 'Preview Mode'}
                        </button>
                        <button 
                          type="button"
                          onClick={() => updateStepField(index, 'isABTest', !step.isABTest)}
                          className={`px-2.5 py-1.5 border rounded text-[10px] font-bold transition-colors flex items-center gap-1 cursor-pointer ${
                            step.isABTest 
                              ? 'bg-blue-50 dark:bg-blue-600/10 border-blue-200 dark:border-blue-500/20 text-blue-600 dark:text-blue-400' 
                              : 'bg-slate-50 dark:bg-slate-955 dark:hover:bg-slate-805 border-slate-202 dark:border-slate-800 text-slate-700 dark:text-slate-300'
                          }`}
                        >
                          <SplitSquareHorizontal className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                          A/B TEST Variant
                        </button>
                        {steps.length > 1 && (
                          <button 
                            type="button"
                            onClick={() => removeStep(index)} 
                            className="p-1.5 bg-slate-50 border border-slate-202 hover:bg-rose-500/10 hover:text-rose-600 dark:bg-slate-950 dark:border-slate-800 dark:hover:bg-rose-500/10 dark:hover:text-rose-455 rounded text-slate-400 dark:text-slate-500 transition-colors cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {previewSteps[step.id || index] !== false ? (
                      /* Live Preview Representation */
                      <div className="space-y-4 animate-in fade-in">
                        <div className="bg-blue-50/50 dark:bg-blue-950/10 border border-blue-100 dark:border-blue-500/10 p-3 rounded-lg flex items-start gap-2.5">
                          <div>
                            <p className="text-[10px] text-blue-750 dark:text-blue-400 font-extrabold uppercase tracking-wider">Dynamic Resolve Preview</p>
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Showing output resolved for contact: <strong className="text-slate-900 dark:text-white">Emily</strong> at <strong className="text-slate-900 dark:text-white">Stark Industries</strong>.</p>
                          </div>
                        </div>

                        <div className="space-y-3 font-sans bg-slate-50 dark:bg-[#12141d] border border-slate-100 dark:border-[#1f2130] p-4 rounded-lg">
                          <div className="border-b border-slate-200 dark:border-[#1b1c26] pb-2">
                            <span className="text-[9px] text-slate-400 dark:text-slate-500 uppercase tracking-widest font-bold font-mono">Subject Outcome:</span>
                            <p className="text-xs font-semibold text-slate-900 dark:text-white mt-1">{resolveTemplateText(step.subject || '')}</p>
                          </div>
                          <div>
                            <span className="text-[9px] text-slate-400 dark:text-slate-500 uppercase tracking-widest font-bold font-mono mb-1.5 block">Message Outcome:</span>
                            {isHtml(resolveTemplateText(step.body || '')) ? (
                              <iframe 
                                srcDoc={resolveTemplateText(step.body || '')}
                                title="Email Preview"
                                className="w-full h-[500px] border border-slate-200 dark:border-slate-800 rounded-lg bg-white"
                                sandbox="allow-same-origin"
                              />
                            ) : (
                              <p className="text-xs text-slate-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed font-sans">{resolveTemplateText(step.body || '')}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      /* Main Editor Inputs */
                      <div className="space-y-3">
                        <input 
                          type="text" 
                          placeholder="Subject Line"
                          value={step.subject}
                          onChange={(e) => updateStepField(index, 'subject', e.target.value)}
                          className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-202 dark:border-slate-805 text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/40 placeholder:text-slate-400 dark:placeholder:text-slate-500 shadow-xs"
                        />
                        
                        <div className="border border-slate-202 dark:border-slate-800 rounded-lg overflow-hidden bg-slate-50 dark:bg-slate-950 flex flex-col">
                          <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-3 py-1.5 flex items-center justify-between text-[11px]">
                            <div className="flex items-center gap-1.5 font-mono">
                              <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-bold tracking-widest mr-1">Variables:</span>
                              <button type="button" onClick={() => insertVariable('{{firstName}}', index)} className="text-[9px] text-blue-650 dark:text-blue-400 bg-blue-50 dark:bg-blue-955/40 px-1.5 py-0.5 rounded cursor-pointer uppercase font-bold border border-blue-100 dark:border-blue-550/10">{'{{firstName}}'}</button>
                              <button type="button" onClick={() => insertVariable('{{company}}', index)} className="text-[9px] text-blue-650 dark:text-blue-400 bg-blue-50 dark:bg-blue-955/40 px-1.5 py-0.5 rounded cursor-pointer uppercase font-bold border border-blue-100 dark:border-blue-550/10">{'{{company}}'}</button>
                              <button type="button" onClick={() => insertVariable('{Hi|Hello}', index)} className="text-[9px] text-blue-650 dark:text-blue-400 bg-blue-50 dark:bg-blue-955/40 px-1.5 py-0.5 rounded cursor-pointer uppercase font-bold border border-blue-100 dark:border-blue-550/10">{'{{spintax}}'}</button>
                            </div>
                          </div>
                          <textarea 
                            className="w-full h-36 p-3 outline-none bg-transparent text-slate-800 dark:text-white text-xs placeholder:text-slate-400 dark:placeholder:text-slate-500 resize-none font-mono leading-relaxed"
                            placeholder="Write your custom copy stream here..."
                            value={step.body}
                            onChange={(e) => updateStepField(index, 'body', e.target.value)}
                          ></textarea>
                        </div>
                      </div>
                    )}
                  </section>
                ))}

                <button 
                  type="button"
                  onClick={addStep}
                  className="w-full py-3.5 bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-850 border border-slate-202 border-dashed rounded-lg text-xs font-bold uppercase text-slate-550 dark:text-slate-405 transition-colors flex items-center justify-center gap-1.5 cursor-pointer dark:border-slate-800"
                >
                  <Plus className="w-4 h-4" />
                  Add Journey Step
                </button>
             </div>
          )}

          {activeTab === 'Schedule' && (
             <div className="space-y-6 animate-in fade-in duration-200">
                <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-550 dark:text-slate-400 mb-5 flex items-center gap-2 border-b border-slate-200 dark:border-slate-805 pb-2">
                    <Clock className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    Target Cadence Window
                  </h2>
                  
                  <div className="space-y-5">
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-550 dark:text-slate-400 font-bold uppercase tracking-widest">Outbox Timezone</label>
                      <select 
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-202 dark:border-slate-800 text-slate-700 dark:text-slate-300 text-xs rounded-lg px-3 py-2 outline-none font-medium cursor-pointer"
                      >
                        {timezoneOptions.map(option => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] text-slate-550 dark:text-slate-400 font-bold uppercase tracking-widest">Permitted Active Days</label>
                      <div className="flex gap-1.5">
                         {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => (
                            <label key={day} className="flex-1 cursor-pointer">
                               <input 
                                 type="checkbox" 
                                 checked={selectedDays.includes(day)}
                                 onChange={() => toggleDaySelection(day)}
                                 className="peer sr-only" 
                               />
                               <div className="py-2 text-center rounded border border-slate-202 dark:border-slate-800 bg-slate-50 dark:bg-slate-955 text-[10px] font-bold text-slate-550 dark:text-slate-400 peer-checked:bg-blue-50 dark:peer-checked:bg-blue-955/40 peer-checked:border-blue-200 dark:peer-checked:border-blue-550/20 peer-checked:text-blue-600 dark:peer-checked:text-blue-400 transition-all uppercase tracking-wider">
                                  {day}
                               </div>
                            </label>
                         ))}
                      </div>
                    </div>

                    <div className="space-y-4">
                      <label className="text-[10px] text-slate-555 dark:text-slate-400 font-bold uppercase tracking-widest">Cadence Delivery Window (Local Senders Clock)</label>
                      <div className="flex items-center gap-3">
                         <input 
                           type="time" 
                           value={startTime}
                           onChange={(e) => setStartTime(e.target.value)}
                           className="flex-1 bg-slate-50 dark:bg-slate-950 border border-slate-202 dark:border-slate-800 rounded-lg px-3 py-2 text-slate-800 dark:text-white text-xs outline-none font-mono" 
                         />
                         <span className="text-slate-400 dark:text-slate-550 text-xs">to</span>
                         <input 
                           type="time" 
                           value={endTime}
                           onChange={(e) => setEndTime(e.target.value)}
                           className="flex-1 bg-slate-50 dark:bg-slate-950 border border-slate-202 dark:border-slate-800 rounded-lg px-3 py-2 text-slate-800 dark:text-white text-xs outline-none font-mono" 
                         />
                      </div>
                    </div>
                  </div>
                </section>
             </div>
          )}

          {activeTab === 'Options' && (
             <div className="space-y-6 animate-in fade-in duration-200">
                <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-555 dark:text-slate-405 mb-4 flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-2">
                    <ToggleLeft className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    Delivery Autopilot Flags
                  </h2>
                  
                  <div className="space-y-3">
                    <label className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-202 dark:border-slate-800 rounded-lg cursor-pointer hover:bg-slate-100/50 dark:hover:bg-slate-850/30 transition-colors">
                       <div>
                          <div className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-widest">Pause Sequence on Reply (Stop on Reply)</div>
                          <div className="text-[11px] text-slate-505 dark:text-slate-400 mt-1">Stop further emails once a customer expresses interest.</div>
                       </div>
                       <input 
                         type="checkbox" 
                         checked={stopOnReply}
                         onChange={(e) => setStopOnReply(e.target.checked)}
                         className="toggle-checkbox sr-only peer" 
                       />
                       <div className="w-10 h-6 bg-slate-200 dark:bg-slate-850 rounded-full peer peer-checked:bg-blue-650 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all relative border border-slate-300 dark:border-slate-750"></div>
                    </label>

                    <label className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-202 dark:border-slate-800 rounded-lg cursor-pointer hover:bg-slate-100/50 dark:hover:bg-slate-850/30 transition-colors">
                       <div>
                          <div className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-widest">Track Read Opens status</div>
                          <div className="text-[11px] text-slate-505 dark:text-slate-400 mt-1">Embed standard safe tracking pixel mechanisms.</div>
                       </div>
                       <input 
                         type="checkbox" 
                         checked={trackOpens}
                         onChange={(e) => setTrackOpens(e.target.checked)}
                         className="toggle-checkbox sr-only peer" 
                       />
                       <div className="w-10 h-6 bg-slate-200 dark:bg-slate-850 rounded-full peer peer-checked:bg-blue-655 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all relative border border-slate-300 dark:border-slate-750"></div>
                    </label>

                    <label className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-202 dark:border-slate-800 rounded-lg cursor-pointer hover:bg-slate-100/50 dark:hover:bg-slate-850/30 transition-colors">
                       <div>
                          <div className="text-xs font-bold text-slate-805 dark:text-white uppercase tracking-widest">Track Hyperlink Engagements</div>
                          <div className="text-[11px] text-slate-505 dark:text-slate-400 mt-1">Wrap static body content links using custom domains.</div>
                       </div>
                       <input 
                         type="checkbox" 
                         checked={trackClicks}
                         onChange={(e) => setTrackClicks(e.target.checked)}
                         className="toggle-checkbox sr-only peer" 
                       />
                       <div className="w-10 h-6 bg-slate-200 dark:bg-slate-850 rounded-full peer peer-checked:bg-blue-650 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all relative border border-slate-300 dark:border-slate-750"></div>
                    </label>
                  </div>
                </section>
             </div>
          )}

          {activeTab === 'Audience' && (
             <div className="space-y-6 animate-in fade-in duration-200">
               <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
                 <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-5 flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-2">
                   <Users className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                   Audience Selection
                 </h2>
                 <div className="space-y-4">
                   <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-550 dark:text-slate-400 font-bold uppercase tracking-widest">Target CRM List Folder</label>
                      <select 
                        value={audienceCohort}
                        onChange={(e) => setAudienceCohort(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-slate-955 border border-slate-202 dark:border-slate-800 text-slate-705 dark:text-slate-300 text-xs rounded-lg px-3 py-2 outline-none cursor-pointer"
                      >
                        <option value="Valid">All Active Valid Leads ({campaign?.telemetry?.validLeadsCount || 0})</option>
                        <option value="Unverified">All Unverified Leads ({campaign?.telemetry?.unverifiedLeadsCount || 0})</option>
                        <option value="HighIntent">Segment: High Intent (0)</option>
                      </select>
                    </div>
                   <div className="p-4 bg-blue-50 dark:bg-blue-955/20 border border-blue-105 dark:border-blue-550/15 rounded-lg">
                     <p className="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-widest">Selected Prospects Estimate</p>
                     <p className="text-2xl font-bold text-slate-905 dark:text-white mt-1">{campaign?.telemetry?.enrollments || 0}</p>
                     <p className="text-xs text-blue-500 dark:text-blue-300 font-medium mt-1">Active enrollments in sequence execution queue</p>
                   </div>
                 </div>
               </section>
             </div>
          )}

        </div>

        {/* Info Sidebar Summary info */}
        <div className="space-y-6">
           <div className="p-4 bg-blue-50/50 dark:bg-blue-955/10 border border-blue-100 dark:border-blue-500/10 rounded-xl shadow-xs">
              <h3 className="text-[10px] font-extrabold text-blue-600 dark:text-blue-400 uppercase tracking-widest mb-3.5">Campaign Outline</h3>
              <ul className="space-y-2.5 text-xs text-slate-650 dark:text-slate-300">
                 <li className="flex justify-between border-b border-slate-100 dark:border-slate-800/60 pb-1.5">
                    <span>Total Emails</span> <span className="font-bold text-slate-900 dark:text-white">{steps.length} Steps</span>
                 </li>
                 <li className="flex justify-between border-b border-slate-100 dark:border-slate-800/60 pb-1.5">
                    <span>Duration delay</span> <span className="font-bold text-slate-900 dark:text-white">{steps.reduce((acc, step) => acc + (step.waitDays || 0), 0)} Days</span>
                 </li>
                 <li className="flex justify-between">
                    <span>Active Cohort</span> <span className="font-bold text-blue-600 dark:text-blue-400 font-mono">{campaign?.telemetry?.enrollments || 0} leads</span>
                 </li>
              </ul>
           </div>

           {/* Telemetry Chart details */}
           <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col shadow-xs">
             <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-550 dark:text-slate-400 mb-6">Funnel Over Time</h2>
             <div className="h-[200px] w-full">
               <ResponsiveContainer width="100%" height="100%">
                 <AreaChart data={mockChartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                   <defs>
                     <linearGradient id="colorO" x1="0" y1="0" x2="0" y2="1">
                       <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.2}/>
                       <stop offset="95%" stopColor="#4f46e5" stopOpacity={0}/>
                     </linearGradient>
                     <linearGradient id="colorC" x1="0" y1="0" x2="0" y2="1">
                       <stop offset="5%" stopColor="#818cf8" stopOpacity={0.15}/>
                       <stop offset="95%" stopColor="#818cf8" stopOpacity={0}/>
                     </linearGradient>
                   </defs>
                   <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" className="text-slate-202 dark:text-slate-800/80" />
                   <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10 }} dy={10} />
                   <YAxis axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10 }} />
                   <Tooltip 
                     contentStyle={{ 
                       backgroundColor: 'var(--card-bg, #ffffff)', 
                       borderRadius: '12px', 
                       border: '1px solid var(--border-card, #e2e8f0)', 
                       color: 'var(--text-white, #0f172a)', 
                       fontSize: '11px' 
                     }} 
                   />
                   <Area type="monotone" dataKey="opens" stroke="#4f46e5" strokeWidth={2} fillOpacity={1} fill="url(#colorO)" />
                   <Area type="monotone" dataKey="clicks" stroke="#818cf8" strokeWidth={2} fillOpacity={1} fill="url(#colorC)" />
                 </AreaChart>
               </ResponsiveContainer>
             </div>
           </div>
        </div>
      </div>
    </div>
  );
}

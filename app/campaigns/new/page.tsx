/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import { ArrowLeft, Save, Send, Settings, Users, AlignLeft, Clock, ToggleLeft, Plus, Trash2, SplitSquareHorizontal, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { useTimezones } from '@/hooks/use-timezones';
import VariableToolbar from '@/components/VariableToolbar';

export default function NewCampaignPage() {
  const timezoneOptions = useTimezones();
  const [activeTab, setActiveTab] = useState('Sequence');
  const [templates, setTemplates] = useState<any[]>([]);
  const [steps, setSteps] = useState([
    { id: 1, waitDays: 0, subject: '', body: '', isABTest: false }
  ]);
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
    result = result.replace(/\{\{name\}\}/g, 'Emily Carter');
    result = result.replace(/\{\{jobTitle\}\}/g, 'VP of Marketing');
    result = result.replace(/\{\{email\}\}/g, 'emily@starkindustries.com');
    result = result.replace(/\{\{\s*\$json\.name\s*\|\|\s*'[^']*'\s*\}\}/g, 'Emily');
    result = result.replace(/\{\{\s*\$json\.name\s*\}\}/g, 'Emily');

    // Replace custom unsubscribe placeholders for live preview
    result = result.replace(/\[\[\s*unsubscribe_url\s*\]\]/gi, '#unsubscribe');
    result = result.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, '#unsubscribe');

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

  useEffect(() => {
    loadTemplates();
  }, []);

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
        id: Date.now() + idx,
        waitDays: idx === 0 ? 0 : (step.waitDays || 3),
        subject: step.subject || '',
        body: step.body || '',
        isABTest: false
      }));
      setSteps(newSteps);
    } else {
      setSteps([
        {
          id: Date.now(),
          waitDays: 0,
          subject: selected.subject || '',
          body: selected.body || '',
          isABTest: false
        }
      ]);
    }
  };

  const addStep = () => {
    setSteps([...steps, { id: Date.now(), waitDays: 3, subject: '', body: '', isABTest: false }]);
  };

  const removeStep = (id: number) => {
    if (steps.length > 1) {
      setSteps(steps.filter(s => s.id !== id));
    }
  };

  const insertVariable = (variable: string, stepId: number) => {
     const updatedSteps = steps.map(s => {
        if (s.id === stepId) {
            return { ...s, body: s.body + variable };
        }
        return s;
     });
     setSteps(updatedSteps);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-5xl mx-auto pb-10">
      {/* Back & Action Header */}
      <header className="flex justify-between items-center pb-4 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-4">
          <Link href="/campaigns" className="p-2 bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800 rounded-lg transition-colors border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-white shadow-xs">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white mb-0.5">Create Outbound Sequence</h1>
            <p className="text-slate-500 dark:text-slate-400 text-xs">Set up your steps, delays, track clicks, and define target lists.</p>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <button className="px-3.5 py-2 bg-white hover:bg-slate-50 dark:bg-slate-950 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 font-semibold rounded-lg text-xs flex items-center gap-1.5 cursor-pointer shadow-xs">
            <Save className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
            Save Draft
          </button>
          <button className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg text-xs flex items-center gap-1.5 cursor-pointer shadow-xs transition-colors">
            <Send className="w-3.5 h-3.5" />
            Publish Sequence
          </button>
        </div>
      </header>

      {/* Tabs Menu Bar */}
      <div className="flex gap-1 p-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl w-fit shadow-xs">
        {['Sequence', 'Audience', 'Schedule', 'Options'].map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-1.5 rounded-lg text-[10px] font-bold transition-all uppercase tracking-widest ${
              activeTab === tab 
                ? 'bg-blue-600 text-white shadow-xs' 
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

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
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-805 text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2.5 outline-none focus:ring-2 focus:ring-blue-500/40 placeholder:text-slate-400 dark:placeholder:text-slate-500 shadow-xs"
                  />
                </section>

                <div className="flex justify-between items-center pb-1 border-b border-slate-200 dark:border-slate-800">
                  <div className="flex items-center gap-2">
                    <AlignLeft className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">Steps Setup</h2>
                  </div>
                  {templates.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-slate-400 dark:text-slate-505 uppercase tracking-wider">Use Template:</span>
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
                  <section key={step.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 relative transition-all shadow-xs">
                    {index > 0 && (
                      <div className="absolute -top-6 left-9 h-6 w-[1.5px] bg-slate-200 dark:bg-slate-800"></div>
                    )}
                    
                    <div className="flex justify-between items-center mb-4">
                      <div className="flex items-center gap-3">
                        <div className="w-7 h-7 rounded bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 font-bold flex items-center justify-center text-xs border border-blue-100 dark:border-blue-550/15 font-mono">
                          {index + 1}
                        </div>
                        {index > 0 ? (
                          <div className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-350">
                            Wait for
                            <input 
                              type="number" 
                              defaultValue={step.waitDays} 
                              className="w-14 bg-slate-50 dark:bg-slate-950 py-1 px-2 border border-slate-200 dark:border-slate-800 rounded text-center text-xs font-mono outline-none text-slate-800 dark:text-white focus:border-blue-500" 
                            />
                            days
                          </div>
                        ) : (
                          <span className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">Initial Dispatch</span>
                        )}
                      </div>
                      
                      <div className="flex gap-2">
                        <button 
                          type="button"
                          onClick={() => toggleStepPreview(step.id || index)}
                          className={`px-2.5 py-1.5 border rounded text-[10px] font-bold transition-colors flex items-center gap-1 cursor-pointer ${
                            previewSteps[step.id || index] !== false
                              ? 'bg-blue-50 dark:bg-blue-600/10 border-blue-200 dark:border-blue-500/20 text-blue-600 dark:text-blue-400' 
                              : 'bg-slate-50 dark:bg-slate-905 dark:hover:bg-slate-800 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300'
                          }`}
                        >
                          {previewSteps[step.id || index] !== false ? 'Edit Mode' : 'Preview Mode'}
                        </button>
                        <button className="px-2.5 py-1.5 bg-slate-50 hover:bg-slate-100 dark:bg-slate-950 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 rounded text-[10px] font-bold text-slate-700 dark:text-slate-300 transition-colors flex items-center gap-1">
                          <SplitSquareHorizontal className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                          A/B TEST Variant
                        </button>
                        {steps.length > 1 && (
                          <button 
                            onClick={() => removeStep(step.id)} 
                            className="p-1.5 bg-slate-50 border border-slate-200 hover:bg-rose-500/10 hover:text-rose-600 dark:bg-slate-950 dark:border-slate-800 dark:hover:bg-rose-500/10 dark:hover:text-rose-455 rounded text-slate-400 dark:text-slate-500 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {previewSteps[step.id || index] !== false ? (
                      /* Live Preview Representation */
                      <div className="space-y-4 animate-in fade-in">
                        <div className="bg-blue-50/50 dark:bg-blue-955/10 border border-blue-100 dark:border-blue-500/10 p-3 rounded-lg flex items-start gap-2.5">
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
                          value={step.subject || ''}
                          onChange={(e) => {
                            const updatedSteps = steps.map(s => s.id === step.id ? { ...s, subject: e.target.value } : s);
                            setSteps(updatedSteps);
                          }}
                          className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-805 text-slate-800 dark:text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/40 placeholder:text-slate-400 dark:placeholder:text-slate-500 shadow-xs"
                        />
                        
                        <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-slate-50 dark:bg-slate-950 flex flex-col">
                          <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-3 py-1.5 flex items-center text-[11px]">
                            <VariableToolbar
                              onInsert={(v) => insertVariable(v, step.id)}
                              onInsertSubject={(v) => {
                                const updatedSteps = steps.map(s => s.id === step.id ? { ...s, subject: (s.subject || '') + ' ' + v } : s);
                                setSteps(updatedSteps);
                              }}
                            />
                          </div>
                          <textarea 
                            className="w-full h-36 p-3 outline-none bg-transparent text-slate-800 dark:text-white text-xs placeholder:text-slate-400 dark:placeholder:text-slate-500 resize-none font-mono leading-relaxed"
                            placeholder="Write your custom copy stream here..."
                            value={step.body}
                            onChange={(e) => {
                               const updatedSteps = steps.map(s => s.id === step.id ? { ...s, body: e.target.value } : s);
                               setSteps(updatedSteps);
                            }}
                          ></textarea>
                        </div>
                      </div>
                    )}
                  </section>
                ))}

                <button 
                  onClick={addStep}
                  className="w-full py-3.5 bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-850 border border-slate-202 border-dashed rounded-lg text-xs font-bold uppercase text-slate-500 dark:text-slate-400 transition-colors flex items-center justify-center gap-1.5 cursor-pointer dark:border-slate-800"
                >
                  <Plus className="w-4 h-4" />
                  Add Journey Step
                </button>
             </div>
          )}

          {activeTab === 'Schedule' && (
             <div className="space-y-6 animate-in fade-in duration-200">
                <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-5 flex items-center gap-2 border-b border-slate-200 dark:border-slate-805 pb-2">
                    <Clock className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    Target Cadence Window
                  </h2>
                  
                  <div className="space-y-5">
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest">Outbox Timezone</label>
                      <select className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 text-xs rounded-lg px-3 py-2 outline-none font-medium">
                        {timezoneOptions.map(option => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest">Permitted Active Days</label>
                      <div className="flex gap-1.5">
                         {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => (
                            <label key={day} className="flex-1 cursor-pointer">
                               <input type="checkbox" defaultChecked={day !== 'Sat' && day !== 'Sun'} className="peer sr-only" />
                               <div className="py-2 text-center rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-[10px] font-bold text-slate-500 dark:text-slate-400 peer-checked:bg-blue-50 dark:peer-checked:bg-blue-950/40 peer-checked:border-blue-200 dark:peer-checked:border-blue-550/20 peer-checked:text-blue-600 dark:peer-checked:text-blue-400 transition-all uppercase tracking-wider">
                                  {day}
                               </div>
                            </label>
                         ))}
                      </div>
                    </div>

                    <div className="space-y-4">
                      <label className="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest">Cadence Delivery Window (Local Senders Clock)</label>
                      <div className="flex items-center gap-3">
                         <input type="time" defaultValue="09:00" className="flex-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-slate-800 dark:text-white text-xs outline-none font-mono" />
                         <span className="text-slate-400 dark:text-slate-500 text-xs">to</span>
                         <input type="time" defaultValue="17:00" className="flex-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-slate-800 dark:text-white text-xs outline-none font-mono" />
                      </div>
                    </div>
                  </div>
                </section>
             </div>
          )}

          {activeTab === 'Options' && (
             <div className="space-y-6 animate-in fade-in duration-200">
                <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-405 mb-4 flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-2">
                    <ToggleLeft className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    Delivery Autopilot Flags
                  </h2>
                  
                  <div className="space-y-3">
                    <label className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg cursor-pointer hover:bg-slate-100/50 dark:hover:bg-slate-850/30 transition-colors">
                       <div>
                          <div className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-widest">Pause Sequence on Reply (Stop on Reply)</div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">Stop further emails once a customer expresses interest.</div>
                       </div>
                       <input type="checkbox" defaultChecked className="toggle-checkbox sr-only peer" />
                       <div className="w-10 h-6 bg-slate-200 dark:bg-slate-850 rounded-full peer peer-checked:bg-blue-600 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all relative border border-slate-300 dark:border-slate-750"></div>
                    </label>

                    <label className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg cursor-pointer hover:bg-slate-100/50 dark:hover:bg-slate-850/30 transition-colors">
                       <div>
                          <div className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-widest">Track Read Opens status</div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">Embed standard safe tracking pixel mechanisms.</div>
                       </div>
                       <input type="checkbox" defaultChecked className="toggle-checkbox sr-only peer" />
                       <div className="w-10 h-6 bg-slate-200 dark:bg-slate-850 rounded-full peer peer-checked:bg-blue-600 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all relative border border-slate-300 dark:border-slate-750"></div>
                    </label>

                    <label className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg cursor-pointer hover:bg-slate-100/50 dark:hover:bg-slate-850/30 transition-colors">
                       <div>
                          <div className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-widest">Track Hyperlink Engagements</div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">Wrap static body content links using custom domains.</div>
                       </div>
                       <input type="checkbox" defaultChecked className="toggle-checkbox sr-only peer" />
                       <div className="w-10 h-6 bg-slate-200 dark:bg-slate-850 rounded-full peer peer-checked:bg-blue-600 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all relative border border-slate-300 dark:border-slate-750"></div>
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
                     <label className="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest">Target CRM List Folder</label>
                     <select className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 text-xs rounded-lg px-3 py-2 outline-none">
                       <option>All Active Valid Leads (1,240)</option>
                       <option>All Unverified Leads (0)</option>
                       <option>Segment: High Intent (420)</option>
                       <option>Segment: Churned (150)</option>
                     </select>
                   </div>
                   <div className="p-4 bg-blue-50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-550/15 rounded-lg">
                     <p className="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-widest">Selected Prospects Estimate</p>
                     <p className="text-2xl font-bold text-slate-900 dark:text-white mt-1">1,240</p>
                     <p className="text-xs text-blue-500 dark:text-blue-300 font-medium mt-1">Pending bulk queue transfers</p>
                   </div>
                 </div>
               </section>
             </div>
          )}

        </div>

        {/* Info Sidebar Summary info */}
        <div className="space-y-6">
           <div className="p-4 bg-blue-50/50 dark:bg-blue-950/10 border border-blue-100 dark:border-blue-500/10 rounded-xl shadow-xs">
              <h3 className="text-[10px] font-extrabold text-blue-600 dark:text-blue-400 uppercase tracking-widest mb-3.5">Campaign Outline</h3>
              <ul className="space-y-2.5 text-xs text-slate-650 dark:text-slate-300">
                 <li className="flex justify-between border-b border-slate-100 dark:border-slate-800/60 pb-1.5">
                    <span>Total Emails</span> <span className="font-bold text-slate-900 dark:text-white">{steps.length} Steps</span>
                 </li>
                 <li className="flex justify-between border-b border-slate-100 dark:border-slate-800/60 pb-1.5">
                    <span>Duration delay</span> <span className="font-bold text-slate-900 dark:text-white">{steps.reduce((acc, step) => acc + (step.waitDays || 0), 0)} Days</span>
                 </li>
                 <li className="flex justify-between">
                    <span>Target Cohort</span> <span className="font-bold text-blue-600 dark:text-blue-400 font-mono">1,240 leads</span>
                 </li>
              </ul>
           </div>
        </div>
      </div>
    </div>
  );
}

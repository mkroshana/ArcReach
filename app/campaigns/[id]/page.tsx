'use client';

import { ArrowLeft, Edit, Mail, MousePointerClick, Reply, SendHorizontal, PlayCircle } from 'lucide-react';
import Link from 'next/link';
import { use } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const mockData = [
  { name: 'Day 1', opens: 1400, clicks: 200 },
  { name: 'Day 2', opens: 3000, clicks: 800 },
  { name: 'Day 3', opens: 5000, clicks: 1500 },
  { name: 'Day 4', opens: 8800, clicks: 2200 },
  { name: 'Day 5', opens: 11000, clicks: 3100 },
  { name: 'Day 6', opens: 13900, clicks: 3800 },
  { name: 'Day 7', opens: 18000, clicks: 4500 },
];

export default function CampaignDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  
  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-6xl mx-auto pb-10">
      <header className="flex justify-between items-start pb-4 border-b border-slate-205 dark:border-slate-800">
        <div className="flex gap-4">
          <Link href="/campaigns" className="p-2 h-fit bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800 rounded-lg transition-colors border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-white shadow-xs">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">Campaign Record #{resolvedParams.id}</h1>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-[10px] uppercase font-bold border bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-150 dark:border-emerald-900/30">
                <PlayCircle className="w-3.5 h-3.5" />
                Active status
              </span>
            </div>
            <p className="text-slate-500 dark:text-slate-400 text-xs mt-1">Sent to 45,000 leads • Started 2 days ago</p>
          </div>
        </div>
        <div>
          <button className="px-3.5 py-2 bg-white dark:bg-slate-950 hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 font-semibold rounded-lg text-xs flex items-center gap-1.5 transition-colors cursor-pointer shadow-xs">
            <Edit className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
            Modify Sequence
          </button>
        </div>
      </header>

      {/* Telemetry metrics row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { title: 'Total Dispatched', value: '45,000', icon: SendHorizontal, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950/25', border: 'border-blue-100 dark:border-blue-500/10', pct: null },
          { title: 'Email Opens', value: '18,000', icon: Mail, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950/25', border: 'border-blue-105 dark:border-blue-500/10', pct: '40% open rate' },
          { title: 'Goal Clicks', value: '4,500', icon: MousePointerClick, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950/25', border: 'border-blue-105 dark:border-blue-500/10', pct: '10% clickthrough' },
          { title: 'CRM Replies', value: '1,200', icon: Reply, color: 'text-emerald-700 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950/25', border: 'border-emerald-100 dark:border-emerald-500/10', pct: '2.6% reply rate' },
        ].map((stat, i) => (
          <div key={i} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
            <div className="flex justify-between items-start mb-2">
              <p className="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest">{stat.title}</p>
              <div className={`w-8 h-8 rounded ${stat.bg} border ${stat.border} flex items-center justify-center ${stat.color}`}>
                <stat.icon className="w-4 h-4" />
              </div>
            </div>
            <h3 className="text-xl font-bold text-slate-900 dark:text-white">{stat.value}</h3>
            {stat.pct && (
              <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold mt-1.5 font-mono">{stat.pct}</p>
            )}
          </div>
        ))}
      </div>

      {/* Graph telemetry workspace */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col shadow-xs">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-6">Telemetry & Sequence Funnel Over Time</h2>
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={mockData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
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
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" className="text-slate-200 dark:text-slate-800/80" />
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
  );
}

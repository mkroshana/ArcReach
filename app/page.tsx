'use client';

import Link from 'next/link';
import { 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer 
} from 'recharts';
import { Mail, MousePointerClick, Reply, SendHorizontal, TrendingUp } from 'lucide-react';

const mockData = [
  { name: '01 May', sent: 4000, opens: 2400, clicks: 1200 },
  { name: '02 May', sent: 3000, opens: 1398, clicks: 800 },
  { name: '03 May', sent: 2000, opens: 9800, clicks: 2000 },
  { name: '04 May', sent: 2780, opens: 3908, clicks: 1500 },
  { name: '05 May', sent: 1890, opens: 4800, clicks: 1800 },
  { name: '06 May', sent: 2390, opens: 3800, clicks: 1700 },
  { name: '07 May', sent: 3490, opens: 4300, clicks: 2100 },
];

function StatCard({ title, value, change, icon: Icon, accentColor, accentBg }: any) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs hover:border-blue-100 dark:hover:border-slate-700 transition-all duration-250">
      <div className="flex justify-between items-start">
        <div>
          <p className="text-[10px] text-slate-500 dark:text-slate-400 font-extrabold uppercase tracking-widest">{title}</p>
          <h3 className="text-2xl font-bold mt-1 text-slate-900 dark:text-white tracking-tight">{value}</h3>
          
          <div className="flex items-center gap-1.5 mt-2.5">
            <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-900/30 px-2 py-0.5 rounded">
              {change}
            </span>
            <span className="text-[10px] text-slate-400 dark:text-slate-500 font-medium">vs last week</span>
          </div>
        </div>
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center border border-slate-100 dark:border-slate-800/40 ${accentBg} ${accentColor}`}>
          <Icon className="w-4.5 h-4.5" />
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* Premium Dashboard Header */}
      <header className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800 transition-colors duration-200">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white mb-0.5">Campaign Analytics</h1>
          <p className="text-slate-500 dark:text-slate-400 text-xs">A unified command overview of your outbound deliverability and automated sequences.</p>
        </div>
        <div className="flex items-center gap-3">
          <Link 
            href="/campaigns/new" 
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-colors shadow-xs"
          >
            + Create Campaign
          </Link>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-850 rounded-lg shadow-xs">
            <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
            <span className="text-[11px] text-slate-600 dark:text-slate-300 font-bold font-mono">LIVE OUTBOX</span>
          </div>
        </div>
      </header>

      {/* Structured Stats Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard 
          title="Total Outbound Sent" 
          value="124,592" 
          change="+12.5%" 
          icon={SendHorizontal} 
          accentColor="text-blue-600 dark:text-blue-400" 
          accentBg="bg-blue-50 dark:bg-blue-950/20"
        />
        <StatCard 
          title="Average Open Rate" 
          value="40.3%" 
          change="+5.2%" 
          icon={Mail} 
          accentColor="text-teal-600 dark:text-teal-400" 
          accentBg="bg-teal-50 dark:bg-teal-950/20"
        />
        <StatCard 
          title="Dynamic Click Rate" 
          value="12.8%" 
          change="+2.4%" 
          icon={MousePointerClick} 
          accentColor="text-amber-600 dark:text-amber-400" 
          accentBg="bg-amber-50 dark:bg-amber-950/20"
        />
        <StatCard 
          title="Sequences Replies" 
          value="3,245" 
          change="+18.1%" 
          icon={Reply} 
          accentColor="text-rose-600 dark:text-rose-400" 
          accentBg="bg-rose-50 dark:bg-rose-950/20"
        />
      </div>

      {/* Graph Section */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col shadow-xs transition-colors duration-200">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-200 uppercase tracking-widest">Engagement Trends</h2>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">Track key deliverability status metrics in real-time.</p>
          </div>
          <select className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-805 text-slate-700 dark:text-slate-300 text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/40 appearance-none font-medium pr-8 relative cursor-pointer shadow-xs">
            <option>Last 7 Days</option>
            <option>Last 30 Days</option>
            <option>This Year</option>
          </select>
        </div>
        
        <div className="h-[350px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={mockData}
              margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
            >
              <defs>
                <linearGradient id="colorSent" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15}/>
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                </linearGradient>
                <linearGradient id="colorOpens" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#2dd4bf" stopOpacity={0.15}/>
                  <stop offset="95%" stopColor="#2dd4bf" stopOpacity={0}/>
                </linearGradient>
                <linearGradient id="colorClicks" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.15}/>
                  <stop offset="95%" stopColor="#f43f5e" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" className="text-slate-200 dark:text-slate-800/80" />
              <XAxis 
                dataKey="name" 
                axisLine={false} 
                tickLine={false} 
                tick={{ fill: '#64748b', fontSize: 11 }} 
                dy={10}
              />
              <YAxis 
                axisLine={false} 
                tickLine={false} 
                tick={{ fill: '#64748b', fontSize: 11 }} 
              />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: 'var(--card-bg, #ffffff)', 
                  borderRadius: '12px',
                  border: '1px solid var(--border-card, #e2e8f0)',
                  boxShadow: '0 10px 15px -3px rgba(0,0,0,0.05)',
                  color: 'var(--text-white, #0f172a)'
                }} 
                itemStyle={{ fontSize: 11 }}
              />
              <Area type="monotone" dataKey="sent" stroke="#3b82f6" strokeWidth={2.5} fillOpacity={1} fill="url(#colorSent)" name="Sent Outbound" />
              <Area type="monotone" dataKey="opens" stroke="#2dd4bf" strokeWidth={2.5} fillOpacity={1} fill="url(#colorOpens)" name="Unique Opens" />
              <Area type="monotone" dataKey="clicks" stroke="#f43f5e" strokeWidth={2.5} fillOpacity={1} fill="url(#colorClicks)" name="Total Clicks" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

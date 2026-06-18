/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  Legend
} from 'recharts';
import { Mail, MousePointerClick, Reply, SendHorizontal, RefreshCw, XCircle, AlertTriangle, UserMinus } from 'lucide-react';

function StatCard({ title, value, change, icon: Icon, accentColor, accentBg }: any) {
  const numericChange = Number(change) || 0;
  const isPositive = numericChange > 0;
  const isNegative = numericChange < 0;
  const changeText = isPositive ? `+${numericChange}%` : `${numericChange}%`;
  
  let badgeStyle = "text-slate-500 bg-slate-50 dark:bg-slate-950/30 border border-slate-100 dark:border-slate-900/30";
  if (isPositive) {
    badgeStyle = "text-emerald-700 dark:text-emerald-450 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-900/30";
  } else if (isNegative) {
    badgeStyle = "text-rose-700 dark:text-rose-450 bg-rose-50 dark:bg-rose-950/30 border border-rose-100 dark:border-rose-900/30";
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs hover:border-blue-100 dark:hover:border-slate-700 transition-all duration-250">
      <div className="flex justify-between items-start">
        <div>
          <p className="text-[10px] text-slate-500 dark:text-slate-405 font-extrabold uppercase tracking-widest">{title}</p>
          <h3 className="text-2xl font-bold mt-1 text-slate-900 dark:text-white tracking-tight">{value}</h3>
          
          <div className="flex items-center gap-1.5 mt-2.5">
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${badgeStyle}`}>
              {changeText}
            </span>
            <span className="text-[10px] text-slate-400 dark:text-slate-500 font-medium">vs last period</span>
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
  const [range, setRange] = useState('7');
  const [stats, setStats] = useState<any>({
    totalSent: 0,
    totalReplies: 0,
    averageOpenRate: 0,
    averageClickRate: 0,
    failed: 0,
    bounced: 0,
    unsubscribed: 0,
    deltas: {
      sent: 0,
      openRate: 0,
      clickRate: 0,
      replies: 0
    }
  });
  const [trends, setTrends] = useState<any[]>([]);
  const [funnel, setFunnel] = useState<any[]>([]);
  const [sentiment, setSentiment] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [systemStatus, setSystemStatus] = useState<any>(null);

  const fetchStats = async (selectedRange = range) => {
    try {
      setLoading(true);
      const [statsRes, statusRes] = await Promise.all([
        fetch(`/api/dashboard-stats?range=${selectedRange}`),
        fetch('/api/system-status')
      ]);

      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data.stats);
        setTrends(data.trends);
        setFunnel(data.funnel || []);
        setSentiment(data.sentiment || []);
      }
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        setSystemStatus(statusData);
      }
    } catch (error) {
      console.error('Failed to load stats:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleRangeChange = (newRange: string) => {
    setRange(newRange);
    fetchStats(newRange);
  };

  useEffect(() => {
    fetchStats();

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchStats();
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [range]);

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
            href="/campaigns" 
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-colors shadow-xs"
          >
            + Create Campaign
          </Link>
          <button 
            onClick={fetchStats}
            className="p-2 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-850 rounded-lg shadow-xs"
            title="Refresh statistics"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-205 dark:border-slate-850 rounded-lg shadow-xs">
            <span className={`w-2 h-2 rounded-full ${
              systemStatus?.deliveryStatus === 'OPERATIONAL' 
                ? 'bg-emerald-500' 
                : systemStatus?.deliveryStatus === 'STANDBY' 
                  ? 'bg-amber-500' 
                  : 'bg-slate-400'
            }`}></span>
            <span className="text-[11px] text-slate-650 dark:text-slate-300 font-bold font-mono">
              {systemStatus?.deliveryStatus === 'OPERATIONAL' ? 'LIVE OUTBOX' : 'OUTBOX INACTIVE'}
            </span>
          </div>
        </div>
      </header>

      {/* Configuration Status Alerts / Setup Wizard */}
      {systemStatus && (
        (systemStatus.accountsCount === 0 || systemStatus.leadsCount === 0 || systemStatus.activeCampaignsCount === 0) && (
          <div className="bg-amber-500/5 dark:bg-amber-500/5 border border-amber-500/20 dark:border-amber-500/20 rounded-xl p-5 shadow-xs space-y-3 animate-in fade-in duration-300">
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-450">
              <span className="font-bold text-xs uppercase tracking-wider">Required Setup Steps</span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed font-semibold">
              To start sending outreach sequences, you need to configure your delivery network, import CRM contacts, and activate a campaign.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
              {systemStatus.accountsCount === 0 ? (
                <div className="bg-white dark:bg-slate-900 border border-amber-500/30 rounded-lg p-3.5 flex flex-col justify-between hover:border-amber-500 transition-colors shadow-2xs">
                  <div>
                    <h4 className="text-[11px] font-bold text-slate-800 dark:text-white uppercase tracking-wider mb-1">1. Connect Mailbox</h4>
                    <p className="text-[10px] text-slate-500 dark:text-slate-450">No mailboxes connected. Outbound paused.</p>
                  </div>
                  <Link href="/accounts" className="text-[11px] font-bold text-amber-600 dark:text-amber-400 mt-3 flex items-center gap-1 hover:underline">
                    Connect Senders &rarr;
                  </Link>
                </div>
              ) : (
                <div className="bg-emerald-500/5 dark:bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-3.5 flex flex-col justify-between shadow-2xs">
                  <div>
                    <h4 className="text-[11px] font-bold text-emerald-700 dark:text-emerald-450 uppercase tracking-wider mb-1 flex items-center gap-1">
                      <span>✓ Connected</span>
                    </h4>
                    <p className="text-[10px] text-slate-550 dark:text-slate-450">{systemStatus.accountsCount} active mailbox(es) online.</p>
                  </div>
                  <Link href="/accounts" className="text-[10px] font-medium text-slate-500 dark:text-slate-400 mt-3 hover:underline">
                    Manage Accounts
                  </Link>
                </div>
              )}

              {systemStatus.leadsCount === 0 ? (
                <div className="bg-white dark:bg-slate-900 border border-amber-500/30 rounded-lg p-3.5 flex flex-col justify-between hover:border-amber-500 transition-colors shadow-2xs">
                  <div>
                    <h4 className="text-[11px] font-bold text-slate-800 dark:text-white uppercase tracking-wider mb-1">2. Import Leads</h4>
                    <p className="text-[10px] text-slate-500 dark:text-slate-450">No CRM leads. Outbox has no targets.</p>
                  </div>
                  <Link href="/leads" className="text-[11px] font-bold text-amber-600 dark:text-amber-400 mt-3 flex items-center gap-1 hover:underline">
                    Upload Leads &rarr;
                  </Link>
                </div>
              ) : (
                <div className="bg-emerald-500/5 dark:bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-3.5 flex flex-col justify-between shadow-2xs">
                  <div>
                    <h4 className="text-[11px] font-bold text-emerald-700 dark:text-emerald-450 uppercase tracking-wider mb-1 flex items-center gap-1">
                      <span>✓ Leads Ready</span>
                    </h4>
                    <p className="text-[10px] text-slate-550 dark:text-slate-450">{systemStatus.leadsCount} CRM contact(s) imported.</p>
                  </div>
                  <Link href="/leads" className="text-[10px] font-medium text-slate-500 dark:text-slate-400 mt-3 hover:underline">
                    Manage Leads
                  </Link>
                </div>
              )}

              {systemStatus.activeCampaignsCount === 0 ? (
                <div className="bg-white dark:bg-slate-900 border border-amber-500/30 rounded-lg p-3.5 flex flex-col justify-between hover:border-amber-500 transition-colors shadow-2xs">
                  <div>
                    <h4 className="text-[11px] font-bold text-slate-800 dark:text-white uppercase tracking-wider mb-1">3. Start Campaign</h4>
                    <p className="text-[10px] text-slate-500 dark:text-slate-450">All campaigns are idle.</p>
                  </div>
                  <Link href="/campaigns" className="text-[11px] font-bold text-amber-600 dark:text-amber-400 mt-3 flex items-center gap-1 hover:underline">
                    Manage Campaigns &rarr;
                  </Link>
                </div>
              ) : (
                <div className="bg-emerald-500/5 dark:bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-3.5 flex flex-col justify-between shadow-2xs">
                  <div>
                    <h4 className="text-[11px] font-bold text-emerald-700 dark:text-emerald-450 uppercase tracking-wider mb-1 flex items-center gap-1">
                      <span>✓ Active Campaign</span>
                    </h4>
                    <p className="text-[10px] text-slate-550 dark:text-slate-450">{systemStatus.activeCampaignsCount} campaign(s) actively sending.</p>
                  </div>
                  <Link href="/campaigns" className="text-[10px] font-medium text-slate-500 dark:text-slate-400 mt-3 hover:underline">
                    Manage Campaigns
                  </Link>
                </div>
              )}
            </div>
          </div>
        )
      )}

      {loading ? (
        <div className="py-20 text-center text-slate-400 dark:text-slate-500 text-xs mt-6 space-y-3">
          <div className="w-6 h-6 border-2 border-slate-300 dark:border-slate-700 border-t-blue-500 animate-spin rounded-full mx-auto" />
          <p className="font-medium tracking-wide">Retrieving outbound logs aggregates...</p>
        </div>
      ) : (
               {/* Structured Stats Section */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard 
              title="Total Outbound Sent" 
              value={stats.totalSent.toLocaleString()} 
              change={stats.deltas?.sent} 
              icon={SendHorizontal} 
              accentColor="text-blue-600 dark:text-blue-400" 
              accentBg="bg-blue-50 dark:bg-blue-950/20"
            />
            <StatCard 
              title="Average Open Rate" 
              value={`${stats.averageOpenRate}%`} 
              change={stats.deltas?.openRate} 
              icon={Mail} 
              accentColor="text-teal-600 dark:text-teal-400" 
              accentBg="bg-teal-50 dark:bg-teal-950/20"
            />
            <StatCard 
              title="Dynamic Click Rate" 
              value={`${stats.averageClickRate}%`} 
              change={stats.deltas?.clickRate} 
              icon={MousePointerClick} 
              accentColor="text-amber-600 dark:text-amber-400" 
              accentBg="bg-amber-50 dark:bg-amber-950/20"
            />
            <StatCard
              title="Sequences Replies"
              value={stats.totalReplies.toLocaleString()}
              change={stats.deltas?.replies}
              icon={Reply}
              accentColor="text-rose-600 dark:text-rose-400"
              accentBg="bg-rose-50 dark:bg-rose-950/20"
            />
          </div>

          {/* Deliverability Health Section */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { title: 'Failed Sends', value: (stats.failed ?? 0).toLocaleString(), icon: XCircle, color: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-950/25', border: 'border-rose-100 dark:border-rose-500/10', sub: 'Delivery errors at send time' },
              { title: 'Bounced', value: (stats.bounced ?? 0).toLocaleString(), icon: AlertTriangle, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950/25', border: 'border-amber-100 dark:border-amber-500/10', sub: 'Hard bounces (delivery webhook)' },
              { title: 'Unsubscribed', value: (stats.unsubscribed ?? 0).toLocaleString(), icon: UserMinus, color: 'text-slate-600 dark:text-slate-300', bg: 'bg-slate-100 dark:bg-slate-800/40', border: 'border-slate-200 dark:border-slate-700/40', sub: 'Opted out of mailings' },
            ].map((stat, i) => (
              <div key={i} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
                <div className="flex justify-between items-start mb-2">
                  <p className="text-[10px] text-slate-550 dark:text-slate-405 font-extrabold uppercase tracking-widest">{stat.title}</p>
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center border border-slate-100 dark:border-slate-800/40 ${stat.bg} ${stat.border} ${stat.color}`}>
                    <stat.icon className="w-4.5 h-4.5" />
                  </div>
                </div>
                <h3 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight">{stat.value}</h3>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 font-medium mt-2">{stat.sub}</p>
              </div>
            ))}
          </div>

          {/* Graph Section */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col shadow-xs transition-colors duration-200">
            <div className="flex justify-between items-center mb-6">
              <div>
                <h2 className="text-sm font-bold text-slate-805 dark:text-slate-200 uppercase tracking-widest">Engagement Trends</h2>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">Track key deliverability status metrics in real-time.</p>
              </div>
              <select 
                value={range}
                onChange={(e) => handleRangeChange(e.target.value)}
                className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-850 text-slate-705 dark:text-slate-300 text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/40 appearance-none font-medium pr-8 relative cursor-pointer shadow-xs"
              >
                <option value="7">Last 7 Days</option>
                <option value="30">Last 30 Days</option>
                <option value="90">Last 90 Days</option>
              </select>
            </div>
            
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={trends}
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

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Funnel Card */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col shadow-xs transition-colors duration-200">
              <h2 className="text-sm font-bold text-slate-805 dark:text-slate-200 uppercase tracking-widest mb-1">Conversion Funnel</h2>
              <p className="text-xs text-slate-400 dark:text-slate-505 mb-6">Pipeline performance from outbound dispatch to booked meeting.</p>
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    layout="vertical"
                    data={funnel}
                    margin={{ top: 10, right: 10, left: 20, bottom: 10 }}
                  >
                    <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10 }} />
                    <YAxis type="category" dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--card-bg, #ffffff)',
                        borderRadius: '12px',
                        border: '1px solid var(--border-card, #e2e8f0)',
                        color: 'var(--text-white, #0f172a)'
                      }}
                      itemStyle={{ fontSize: 11 }}
                    />
                    <Bar dataKey="value" fill="#3b82f6" radius={[0, 4, 4, 0]} barSize={24} name="Leads" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Sentiment Breakdown Card */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col shadow-xs transition-colors duration-200">
              <h2 className="text-sm font-bold text-slate-805 dark:text-slate-200 uppercase tracking-widest mb-1">Prospect Sentiment</h2>
              <p className="text-xs text-slate-400 dark:text-slate-505 mb-6">Distribution of global lead outcomes and responses.</p>
              <div className="h-[300px] w-full flex items-center justify-center relative">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={sentiment.filter(s => s.value > 0)}
                      cx="50%"
                      cy="50%"
                      innerRadius={65}
                      outerRadius={95}
                      paddingAngle={3}
                      dataKey="value"
                      nameKey="name"
                    >
                      {sentiment.filter(s => s.value > 0).map((entry, index) => {
                        const colors: Record<string, string> = {
                          'Neutral': '#94a3b8',
                          'Interested': '#10b981',
                          'Not Interested': '#f43f5e',
                          'Meeting Booked': '#6366f1',
                          'Out of Office': '#f59e0b',
                          'Bounced': '#8b5cf6',
                          'Unsubscribed': '#475569'
                        };
                        return <Cell key={`cell-${index}`} fill={colors[entry.name] || '#3b82f6'} />;
                      })}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--card-bg, #ffffff)',
                        borderRadius: '12px',
                        border: '1px solid var(--border-card, #e2e8f0)',
                        color: 'var(--text-white, #0f172a)'
                      }}
                      itemStyle={{ fontSize: 11 }}
                    />
                    <Legend 
                      verticalAlign="bottom" 
                      height={36} 
                      iconType="circle" 
                      iconSize={8}
                      wrapperStyle={{ fontSize: 10 }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                {sentiment.every(s => s.value === 0) && (
                  <div className="absolute inset-0 flex items-center justify-center text-slate-400 dark:text-slate-500 text-xs">
                    No leads enrolled in active campaigns.
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Send,
  Users,
  Inbox,
  Settings,
  Mail,
  FileText,
  Sun,
  Moon,
  ShieldCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTheme } from '@/components/ThemeProvider';

const defaultNavItems = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Campaigns', href: '/campaigns', icon: Send },
  { name: 'Leads', href: '/leads', icon: Users },
  { name: 'Unibox', href: '/unibox', icon: Inbox },
  { name: 'Accounts', href: '/accounts', icon: Mail },
  { name: 'Templates', href: '/templates', icon: FileText },
];

export function Sidebar() {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [session, setSessionState] = useState<any>(null);
  const [systemStatus, setSystemStatus] = useState<any>(null);

  useEffect(() => {
    setMounted(true);
    fetch('/api/session')
      .then(res => res.json())
      .then(data => setSessionState(data))
      .catch(() => {});

    fetch('/api/system-status')
      .then(res => res.json())
      .then(data => setSystemStatus(data))
      .catch(() => {});
  }, []);

  const handleToggleSessionRole = async () => {
    const nextAction = session?.role === 'ADMIN' ? 'set_user' : 'set_admin';
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: nextAction }),
      });
      const data = await res.json();
      if (data.success) {
        setSessionState(data.session);
        window.location.reload();
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Compile active navigation items based on current session role
  const navItems = [...defaultNavItems];
  if (session?.role === 'ADMIN') {
    navItems.push({ name: 'Users Admin', href: '/admin/users', icon: ShieldCheck });
  }

  return (
    <aside className="w-64 h-screen fixed top-0 left-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 z-50 flex flex-col pt-8 pb-4 px-4 shadow-sm transition-colors duration-200">
      {/* Brand Header */}
      <div className="flex items-center gap-3 px-3 mb-6">
        <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center shadow-md">
          <Mail className="text-white w-4.5 h-4.5" />
        </div>
        <span className="text-lg font-bold tracking-tight text-slate-900 dark:text-white uppercase tracking-wider">ArcReach</span>
      </div>

      {/* Session Swapping Widget */}
      <div className="mb-5 mx-1 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/25 shadow-2xs">
        <div className="flex items-center justify-between text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1.5">
          <span>Active Session</span>
          <span className={cn(
            "px-1.5 py-0.5 rounded text-[8px] font-mono tracking-normal",
            session?.role === 'ADMIN' 
              ? "bg-rose-500/10 text-rose-600 dark:text-rose-450 border border-rose-500/15" 
              : "bg-blue-500/10 text-blue-600 dark:text-blue-450 border border-blue-500/15"
          )}>
            {session?.role || 'LDR'}
          </span>
        </div>
        <div className="text-xs font-bold text-slate-800 dark:text-white truncate">
          {session?.name || 'Syncing Account...'}
        </div>
        <div className="text-[10px] text-slate-500 dark:text-slate-450 truncate mt-0.5 mb-2.5">
          {session?.email || 'Connecting...'}
        </div>
        <button
          onClick={handleToggleSessionRole}
          className="w-full py-1.5 rounded-lg text-[9px] font-bold text-center border cursor-pointer border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-350 hover:bg-slate-100 dark:hover:bg-slate-800/40 transition-colors uppercase tracking-wider"
        >
          Toggle to {session?.role === 'ADMIN' ? 'Standard User' : 'Admin'}
        </button>
      </div>

      {/* Navigation Stack */}
      <nav className="flex-1 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== '/' && pathname?.startsWith(item.href));
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors text-sm font-medium border border-transparent',
                isActive
                  ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border-blue-100 dark:border-blue-500/10 font-semibold'
                  : 'text-slate-600 dark:text-slate-450 hover:bg-slate-100 dark:hover:bg-slate-800/40 hover:text-slate-900 dark:hover:text-white'
              )}
            >
              <item.icon className={cn('w-4 h-4 transition-colors', isActive ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400 group-hover:text-slate-600 dark:text-slate-500')} />
              <span>{item.name}</span>
            </Link>
          );
        })}
      </nav>

      {/* Footer / Account / API Settings */}
      <div className="mt-auto pt-4 space-y-2 border-t border-slate-100 dark:border-slate-800/50">
        {/* Theme Toggle Button */}
        <button
          onClick={toggleTheme}
          className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors text-sm font-medium text-slate-500 dark:text-slate-455 hover:bg-slate-100 dark:hover:bg-slate-800/40 hover:text-slate-900 dark:hover:text-white cursor-pointer border border-transparent"
        >
          <div className="flex items-center gap-3">
            {!mounted ? (
              <>
                <div className="w-4 h-4 rounded-full bg-slate-200 dark:bg-slate-850 animate-pulse" />
                <span className="w-16 h-4 bg-slate-100 dark:bg-slate-800 rounded animate-pulse" />
              </>
            ) : theme === 'dark' ? (
              <>
                <Sun className="w-4 h-4 text-amber-500" />
                <span>Light Mode</span>
              </>
            ) : (
              <>
                <Moon className="w-4 h-4 text-blue-600" />
                <span>Dark Mode</span>
              </>
            )}
          </div>
          <span className="text-[10px] font-mono bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 px-1.5 py-0.5 rounded-md uppercase tracking-wider font-bold">
            {mounted ? theme : '...'}
          </span>
        </button>

        <Link
          href="/settings"
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors text-sm font-medium text-slate-500 dark:text-slate-455 hover:bg-slate-100 dark:hover:bg-slate-800/40 hover:text-slate-900 dark:hover:text-white border border-transparent"
        >
          <Settings className="w-4 h-4 text-slate-400 dark:text-slate-500" />
          Settings
        </Link>
        
        {/* Systems Status Plate */}
        <div className="bg-slate-50 dark:bg-slate-950/40 border border-slate-100 dark:border-slate-850 rounded-xl p-3 shadow-xs">
          <p className="text-[9px] uppercase tracking-wider text-slate-400 dark:text-slate-500 font-bold mb-1.5">Azure Delivery Network</p>
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-700 dark:text-slate-350 font-medium">ArcReach API</span>
            <div className="flex items-center gap-1.5">
              <span className={cn(
                "w-1.5 h-1.5 rounded-full",
                systemStatus?.deliveryStatus === 'OPERATIONAL' && "bg-emerald-500",
                systemStatus?.deliveryStatus === 'STANDBY' && "bg-amber-500",
                (systemStatus?.deliveryStatus === 'INACTIVE' || !systemStatus?.deliveryStatus) && "bg-slate-400 dark:bg-slate-600"
              )}></span>
              <span className={cn(
                "text-[10px] font-bold font-mono uppercase",
                systemStatus?.deliveryStatus === 'OPERATIONAL' && "text-emerald-600 dark:text-emerald-400",
                systemStatus?.deliveryStatus === 'STANDBY' && "text-amber-600 dark:text-amber-400",
                (systemStatus?.deliveryStatus === 'INACTIVE' || !systemStatus?.deliveryStatus) && "text-slate-550 dark:text-slate-400"
              )}>
                {systemStatus?.deliveryStatus || 'LOADING...'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

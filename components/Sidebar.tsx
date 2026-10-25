'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Send,
  Users,
  Inbox,
  Mail,
  FileText,
  Settings,
  ShieldCheck,
  ChevronDown,
  Activity,
  Database,
  Cloud,
  AlertTriangle,
  Radio,
} from 'lucide-react';
import { Drawer, Tooltip } from '@mui/material';
import { autoResumeNote } from '@/lib/campaignPause';
import { workerStatusText } from '@/lib/systemStatus';
import { viewerTimeZone, zoneLabel, zonedClock, zonedDate } from '@/lib/campaignTiming';
import { useNow } from '@/hooks/use-now';
import { useIsMobile } from '@/hooks/use-mobile';
import type { UserSession } from '@/lib/session';

export interface SidebarProps {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  session?: UserSession | null;
  systemStatus?: any | null;
}

const defaultNavItems = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Campaigns', href: '/campaigns', icon: Send, badgeKey: 'campaigns' },
  { name: 'Leads', href: '/leads', icon: Users, badgeKey: 'leads' },
  { name: 'Unibox', href: '/unibox', icon: Inbox, badgeKey: 'unibox' },
  { name: 'Accounts', href: '/accounts', icon: Mail, badgeKey: 'accounts' },
  { name: 'Templates', href: '/templates', icon: FileText },
];

const STATUS_OK = '#10b981';
const STATUS_WARN = '#f59e0b';
const STATUS_BAD = '#f43f5e';
const STATUS_IDLE = '#94a3b8';

const AZURE_STATUS: Record<string, { color: string; text: string }> = {
  CONFIGURED: { color: STATUS_OK, text: 'Configured' },
  UNCONFIGURED: { color: STATUS_WARN, text: 'Not Configured' },
  DISABLED: { color: STATUS_WARN, text: 'Disabled' },
};

const WORKER_STATUS: Record<string, { color: string; text: string }> = {
  RUNNING: { color: STATUS_OK, text: 'Running' },
  STALLED: { color: STATUS_WARN, text: 'Stalled' },
  FAILING: { color: STATUS_BAD, text: 'Failing' },
  NOT_RUNNING: { color: STATUS_BAD, text: 'Not Running' },
};

/**
 * CurrentTime: displays viewer's own clock, date, and timezone.
 */
function CurrentTime() {
  const now = useNow();
  const zone = now ? viewerTimeZone() : '';
  const row = (
    <div className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-[#161822] border border-[#EBF0F5] dark:border-[#1E222D] text-xs">
      <span className="text-[10px] font-bold font-mono tracking-wider text-slate-400 uppercase">Your Time</span>
      <div className="flex items-baseline gap-1.5 font-mono">
        <span className="font-bold text-slate-700 dark:text-slate-200">{now ? zonedClock(now, zone) : '--:--:--'}</span>
        <span className="text-[10px] text-slate-400 truncate max-w-[80px]">{now ? zonedDate(now, zone) : ''}</span>
      </div>
    </div>
  );
  return now ? (
    <Tooltip title={`${zone} · ${zoneLabel(now, zone)}`} placement="right">
      {row}
    </Tooltip>
  ) : (
    row
  );
}

export function Sidebar({ mobileOpen = false, onMobileClose, session: propSession, systemStatus: propSystemStatus }: SidebarProps) {
  const pathname = usePathname();
  const isMobile = useIsMobile();

  // Internal fallback state if props not passed directly
  const [internalSession, setInternalSession] = useState<UserSession | null>(null);
  const [internalSystemStatus, setInternalSystemStatus] = useState<any>(null);
  const [engineCardExpanded, setEngineCardExpanded] = useState(false);

  useEffect(() => {
    if (propSession !== undefined) return;
    fetch('/api/session')
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/login';
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (data) setInternalSession(data);
      })
      .catch(() => {});
  }, [propSession]);

  useEffect(() => {
    if (propSystemStatus !== undefined) return;
    const loadStatus = () => {
      fetch('/api/system-status')
        .then((res) => (res.status === 401 ? null : res.json()))
        .then((data) => {
          if (data) setInternalSystemStatus(data);
        })
        .catch(() => {});
    };
    loadStatus();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') loadStatus();
    }, 60000);
    return () => clearInterval(interval);
  }, [propSystemStatus]);

  const session = propSession !== undefined ? propSession : internalSession;
  const systemStatus = propSystemStatus !== undefined ? propSystemStatus : internalSystemStatus;

  const navItems = [...defaultNavItems];
  if (session?.role === 'ADMIN') {
    navItems.push({ name: 'Users Admin', href: '/admin/users', icon: ShieldCheck, badgeKey: undefined });
  }

  // System status metrics & signals
  const dbOk = systemStatus?.database === 'OPERATIONAL';
  const dbColor = dbOk ? STATUS_OK : systemStatus ? STATUS_BAD : STATUS_IDLE;
  const dbText = systemStatus ? (dbOk ? 'Online' : 'Offline') : 'Loading';

  const unknown = { color: STATUS_IDLE, text: systemStatus ? 'Unknown' : 'Loading' };
  const azure = AZURE_STATUS[systemStatus?.azureStatus] ?? unknown;
  const azureDetail =
    systemStatus?.azureStatus === 'CONFIGURED'
      ? 'The connection string decrypts and a verified sender domain is saved. Azure accepts or refuses the access key only when an email is sent.'
      : systemStatus?.sendingProblem;

  const worker = WORKER_STATUS[systemStatus?.workerStatus] ?? unknown;
  const workerDetail = WORKER_STATUS[systemStatus?.workerStatus]
    ? workerStatusText(systemStatus.workerStatus, systemStatus.workerHeartbeat)
    : null;

  const isAllOperational = dbOk && azure.color === STATUS_OK && worker.color === STATUS_OK;
  const isAttentionNeeded = !isAllOperational && (azure.color === STATUS_WARN || worker.color === STATUS_WARN);
  const healthStatusText = isAllOperational
    ? 'All Systems Operational'
    : isAttentionNeeded
    ? 'Attention Needed'
    : 'Service Degraded';
  const healthDotClass = isAllOperational
    ? 'bg-emerald-400'
    : isAttentionNeeded
    ? 'bg-amber-400'
    : 'bg-rose-400';

  // Setup paused campaigns
  const setupPaused: Array<{
    id: string;
    name: string;
    status: string;
    pauseReason: string | null;
    pausedUntil: string | null;
    hasSendingSchedule: boolean;
  }> = systemStatus?.setupPausedCampaigns ?? [];
  const setupPausedMore = (systemStatus?.setupPausedCount ?? 0) - setupPaused.length;

  // Badge count calculation helper
  const getBadgeCount = (badgeKey?: string) => {
    if (!systemStatus || !badgeKey) return null;
    if (badgeKey === 'campaigns' && typeof systemStatus.activeCampaignsCount === 'number') {
      return systemStatus.activeCampaignsCount > 0 ? `${systemStatus.activeCampaignsCount}` : null;
    }
    if (badgeKey === 'leads' && typeof systemStatus.leadsCount === 'number') {
      return systemStatus.leadsCount > 0 ? systemStatus.leadsCount.toLocaleString() : null;
    }
    if (badgeKey === 'accounts' && typeof systemStatus.accountsCount === 'number') {
      return systemStatus.accountsCount > 0 ? `${systemStatus.accountsCount}` : null;
    }
    return null;
  };

  const handleLinkClick = () => {
    if (isMobile && onMobileClose) {
      onMobileClose();
    }
  };

  const sidebarContent = (
    <div className="flex flex-col h-full select-none">
      {/* Brand Header */}
      <div className="flex items-center gap-3 px-3 py-4 mb-4">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-600 to-blue-700 flex items-center justify-center text-white shadow-md shadow-blue-500/20">
          <Mail size={20} strokeWidth={2.4} />
        </div>
        <div className="flex flex-col">
          <span className="font-extrabold text-base tracking-[0.08em] text-slate-900 dark:text-white leading-tight">
            ARCREACH
          </span>
          <span className="text-[10px] font-bold font-mono tracking-wider text-blue-600 dark:text-blue-400 uppercase">
            Cold Email Engine
          </span>
        </div>
      </div>

      {/* Main Navigation Items with Generous Spacing */}
      <nav className="flex-1 overflow-y-auto space-y-1.5 pr-1 scrollbar-thin">
        {navItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== '/' && pathname?.startsWith(item.href));
          const Icon = item.icon;
          const badge = getBadgeCount(item.badgeKey);

          return (
            <Link
              key={item.name}
              href={item.href}
              onClick={handleLinkClick}
              className={`relative flex items-center gap-3.5 px-4 py-3 rounded-xl text-sm font-medium transition-all group ${
                isActive
                  ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 font-semibold shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100/70 dark:hover:bg-slate-800/50'
              }`}
            >
              {/* Vertical Active Indicator Bar on Left Edge */}
              {isActive && (
                <span
                  className="w-1.5 h-6 bg-blue-600 dark:bg-blue-500 rounded-r-full absolute left-0 top-1/2 -translate-y-1/2"
                  aria-hidden="true"
                />
              )}

              <Icon
                size={19}
                className={`transition-colors shrink-0 ${
                  isActive
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-slate-400 dark:text-slate-500 group-hover:text-slate-700 dark:group-hover:text-slate-300'
                }`}
              />

              <span className="truncate">{item.name}</span>

              {/* Count Badge Pill */}
              {badge && (
                <span
                  className={`ml-auto text-[11px] font-mono font-bold px-2 py-0.5 rounded-full transition-colors ${
                    isActive
                      ? 'bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 group-hover:bg-slate-200/70 dark:group-hover:bg-slate-700'
                  }`}
                >
                  {badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Footer / Status Area */}
      <div className="pt-3 mt-auto space-y-3 border-t border-[#EBF0F5] dark:border-[#1E222D]">
        {/* Settings Link */}
        <Link
          href="/settings"
          onClick={handleLinkClick}
          className={`relative flex items-center gap-3.5 px-4 py-2.5 rounded-xl text-sm font-medium transition-all group ${
            pathname === '/settings'
              ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 font-semibold shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100/70 dark:hover:bg-slate-800/50'
          }`}
        >
          {pathname === '/settings' && (
            <span
              className="w-1.5 h-6 bg-blue-600 dark:bg-blue-500 rounded-r-full absolute left-0 top-1/2 -translate-y-1/2"
              aria-hidden="true"
            />
          )}
          <Settings
            size={18}
            className={`transition-colors shrink-0 ${
              pathname === '/settings'
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-slate-400 dark:text-slate-500 group-hover:text-slate-700 dark:group-hover:text-slate-300'
            }`}
          />
          <span className="truncate">Settings</span>
        </Link>

        {/* Viewer Local Clock */}
        <CurrentTime />

        {/* Bottom ArcReach Engine Status Card */}
        <div className="bg-gradient-to-br from-blue-600 via-blue-600 to-blue-700 dark:from-blue-700 dark:via-blue-800 dark:to-blue-900 text-white p-3.5 rounded-2xl shadow-lg shadow-blue-500/20 border border-blue-400/20 relative overflow-hidden transition-all duration-200">
          {/* Subtle flare in background */}
          <div className="absolute -right-4 -bottom-4 w-24 h-24 bg-white/10 rounded-full blur-xl pointer-events-none" />

          {/* Card Header & Accordion Trigger */}
          <div className="flex items-center justify-between gap-2 relative z-10">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-6 h-6 rounded-lg bg-white/15 flex items-center justify-center shrink-0">
                <Radio size={13} className="text-white" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-extrabold tracking-wider text-white/90 uppercase">
                    ArcReach Engine
                  </span>
                  <span className="relative flex h-2 w-2">
                    <span
                      className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${healthDotClass}`}
                    />
                    <span className={`relative inline-flex rounded-full h-2 w-2 ${healthDotClass}`} />
                  </span>
                </div>
                <p className="text-[11px] text-blue-100/80 font-medium truncate">{healthStatusText}</p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setEngineCardExpanded((prev) => !prev)}
              aria-expanded={engineCardExpanded}
              aria-label="Toggle ArcReach Engine status details"
              className="p-1 rounded-lg text-white/80 hover:text-white hover:bg-white/15 transition-colors shrink-0"
            >
              <ChevronDown
                size={16}
                className={`transition-transform duration-200 ${engineCardExpanded ? 'rotate-180' : ''}`}
              />
            </button>
          </div>

          {/* Expandable Accordion Details */}
          {engineCardExpanded && (
            <div className="mt-3 pt-2.5 border-t border-white/20 space-y-2 text-xs relative z-10 animate-in fade-in duration-150">
              {/* Database Row */}
              <div className="flex items-center justify-between text-white/90">
                <span className="text-white/70 flex items-center gap-1.5 text-[11px]">
                  <Database size={12} /> Database
                </span>
                <span className="font-mono text-[10px] font-bold uppercase tracking-wider flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: dbColor }} />
                  {dbText}
                </span>
              </div>

              {/* Azure ACS Row */}
              <Tooltip title={azureDetail ?? ''} placement="right">
                <div className="flex items-center justify-between text-white/90 cursor-help">
                  <span className="text-white/70 flex items-center gap-1.5 text-[11px]">
                    <Cloud size={12} /> Azure ACS
                  </span>
                  <span className="font-mono text-[10px] font-bold uppercase tracking-wider flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: azure.color }} />
                    {azure.text}
                  </span>
                </div>
              </Tooltip>

              {/* Send Worker Row */}
              <Tooltip title={workerDetail ?? ''} placement="right">
                <div className="flex items-center justify-between text-white/90 cursor-help">
                  <span className="text-white/70 flex items-center gap-1.5 text-[11px]">
                    <Activity size={12} /> Send Worker
                  </span>
                  <span className="font-mono text-[10px] font-bold uppercase tracking-wider flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: worker.color }} />
                    {worker.text}
                  </span>
                </div>
              </Tooltip>

              {/* Setup Paused Campaigns Warning Block */}
              {setupPaused.length > 0 && (
                <div className="mt-2 pt-2 border-t border-white/15">
                  <div className="flex items-center gap-1 text-[11px] font-bold text-amber-200 mb-1">
                    <AlertTriangle size={12} />
                    <span>Paused by Setup ({systemStatus.setupPausedCount})</span>
                  </div>
                  <div className="space-y-1">
                    {setupPaused.map((c) => (
                      <Tooltip key={c.id} title={autoResumeNote(c) ?? ''} placement="right">
                        <Link
                          href={`/campaigns/${c.id}`}
                          onClick={handleLinkClick}
                          className="block text-[11px] text-white/90 hover:text-white underline truncate"
                        >
                          {c.name}
                        </Link>
                      </Tooltip>
                    ))}
                    {setupPausedMore > 0 && (
                      <Link
                        href="/campaigns"
                        onClick={handleLinkClick}
                        className="block text-[10px] text-blue-200 hover:underline"
                      >
                        +{setupPausedMore} more campaigns
                      </Link>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile Drawer (rendered only on small screens) */}
      <Drawer
        open={mobileOpen}
        onClose={onMobileClose}
        slotProps={{
          root: { keepMounted: true },
          paper: {
            id: 'app-navigation',
            'aria-label': 'Navigation',
            sx: {
              width: 272,
              bgcolor: 'background.paper',
              backgroundImage: 'none',
              px: 2,
              py: 2.5,
              borderRight: 1,
              borderColor: 'divider',
            },
          },
        }}
      >
        {sidebarContent}
      </Drawer>

      {/* Desktop Fixed Aside Sidebar */}
      <aside
        id="app-navigation-desktop"
        aria-label="Navigation"
        className="hidden md:flex flex-col fixed top-0 left-0 bottom-0 w-64 bg-white dark:bg-[#11131A] border-r border-[#EBF0F5] dark:border-[#1E222D] z-30 px-3.5 py-4 transition-colors duration-200"
      >
        {sidebarContent}
      </aside>
    </>
  );
}

export default Sidebar;

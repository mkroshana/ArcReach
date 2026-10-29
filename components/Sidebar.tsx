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
  Clock,
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
import { Badge } from '@/components/ui/Badge';

export interface SidebarProps {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  session?: UserSession | null;
  systemStatus?: any | null;
}

type NavItem = { name: string; href: string; icon: typeof LayoutDashboard; badgeKey?: string };

// Two groups split by a hairline, as Shopeers does: day-to-day outreach, then what it is built from.
const outreachNavItems: NavItem[] = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Campaigns', href: '/campaigns', icon: Send, badgeKey: 'campaigns' },
  { name: 'Leads', href: '/leads', icon: Users, badgeKey: 'leads' },
  { name: 'Unibox', href: '/unibox', icon: Inbox, badgeKey: 'unibox' },
];

const setupNavItems: NavItem[] = [
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
    <div aria-label="Your time" className="flex h-9 items-center gap-3 px-3 text-[13px] text-text-sub">
      <Clock size={17} className="shrink-0 text-slate-400 dark:text-slate-500" />
      <span className="font-medium text-text-main">{now ? zonedClock(now, zone) : '--:--:--'}</span>
      <span className="ml-auto truncate text-xs text-text-muted">{now ? zonedDate(now, zone) : ''}</span>
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

  const setupItems = [...setupNavItems];
  if (session?.role === 'ADMIN') {
    setupItems.push({ name: 'Users Admin', href: '/admin/users', icon: ShieldCheck });
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

  // A plain function rather than a component, so the links are not remounted on every render.
  const renderNavLink = (item: NavItem) => {
    const isActive = item.href === '/' ? pathname === '/' : pathname === item.href || pathname?.startsWith(`${item.href}/`);
    const Icon = item.icon;
    const badge = getBadgeCount(item.badgeKey);
    return (
      <Link
        key={item.name}
        href={item.href}
        onClick={handleLinkClick}
        aria-current={isActive ? 'page' : undefined}
        className={`group relative flex h-9 items-center gap-3 rounded-control px-3 text-[13px] font-medium transition-colors ${
          isActive
            ? 'bg-primary-subtle text-primary'
            : 'text-text-sub hover:bg-slate-50 hover:text-text-main dark:hover:bg-white/5'
        }`}
      >
        {/* Active marker on the sidebar's own left edge */}
        {isActive && (
          <span aria-hidden="true" className="absolute top-1/2 -left-3 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
        )}
        <Icon
          size={17}
          className={`shrink-0 transition-colors ${
            isActive ? 'text-primary' : 'text-slate-400 group-hover:text-slate-600 dark:text-slate-500 dark:group-hover:text-slate-300'
          }`}
        />
        <span className="truncate">{item.name}</span>
        {badge && (
          <Badge tone="green" className="ml-auto">
            {badge}
          </Badge>
        )}
      </Link>
    );
  };

  const sidebarContent = (
    <div className="flex flex-col h-full select-none">
      {/* Brand row: the same 64px as the top bar beside it, so the two read as one header line */}
      <div className="flex h-16 shrink-0 items-center px-3">
        <Link href="/" className="flex items-center gap-2.5 rounded-control">
          <div className="flex size-7 items-center justify-center rounded-control bg-primary text-on-primary">
            <Mail size={15} strokeWidth={2.4} />
          </div>
          <span className="text-[15px] font-semibold tracking-tight text-text-main">ArcReach</span>
        </Link>
      </div>

      <nav aria-label="Main" className="flex-1 overflow-y-auto pt-2 scrollbar-thin">
        <div className="space-y-0.5">{outreachNavItems.map(renderNavLink)}</div>
        <div className="mx-3 my-3 h-px bg-card-border" />
        <div className="space-y-0.5">{setupItems.map(renderNavLink)}</div>
      </nav>

      <div className="mt-auto space-y-0.5 pt-3">
        {renderNavLink({ name: 'Settings', href: '/settings', icon: Settings })}

        {/* Viewer Local Clock */}
        <CurrentTime />

        {/* Engine status, in the shape of Shopeers' upgrade card */}
        <div className="relative mt-3 overflow-hidden rounded-card bg-gradient-to-br from-blue-600 to-blue-800 p-4 text-on-primary">
          <div className="flex size-8 items-center justify-center rounded-control bg-on-primary/15">
            <ShieldCheck size={17} strokeWidth={2.2} />
          </div>

          <div className="mt-3 text-sm font-semibold leading-snug">ArcReach Engine</div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-on-primary/80">
            <span className={`size-1.5 shrink-0 rounded-full ${healthDotClass}`} />
            {healthStatusText}
          </div>

          <button
            type="button"
            onClick={() => setEngineCardExpanded((prev) => !prev)}
            aria-expanded={engineCardExpanded}
            className="mt-3 flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded-control bg-on-primary/15 text-xs font-medium text-on-primary transition-colors hover:bg-on-primary/25"
          >
            System Diagnostics
            <ChevronDown
              size={14}
              className={`transition-transform duration-200 ${engineCardExpanded ? 'rotate-180' : ''}`}
            />
          </button>

          {/* Expandable Accordion Details */}
          {engineCardExpanded && (
            <div className="mt-3 space-y-2 border-t border-on-primary/20 pt-2.5 text-xs">
              {/* Database Row */}
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[11px] text-on-primary/80">
                  <Database size={12} /> Database
                </span>
                <span className="flex items-center gap-1 text-[11px] font-medium">
                  <span className="size-1.5 rounded-full" style={{ backgroundColor: dbColor }} />
                  {dbText}
                </span>
              </div>

              {/* Azure ACS Row */}
              <Tooltip title={azureDetail ?? ''} placement="right">
                <div className="flex cursor-help items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11px] text-on-primary/80">
                    <Cloud size={12} /> Azure ACS
                  </span>
                  <span className="flex items-center gap-1 text-[11px] font-medium">
                    <span className="size-1.5 rounded-full" style={{ backgroundColor: azure.color }} />
                    {azure.text}
                  </span>
                </div>
              </Tooltip>

              {/* Send Worker Row */}
              <Tooltip title={workerDetail ?? ''} placement="right">
                <div className="flex cursor-help items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11px] text-on-primary/80">
                    <Activity size={12} /> Send Worker
                  </span>
                  <span className="flex items-center gap-1 text-[11px] font-medium">
                    <span className="size-1.5 rounded-full" style={{ backgroundColor: worker.color }} />
                    {worker.text}
                  </span>
                </div>
              </Tooltip>

              {/* Setup Paused Campaigns Warning Block */}
              {setupPaused.length > 0 && (
                <div className="mt-2 border-t border-on-primary/15 pt-2">
                  <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-amber-200">
                    <AlertTriangle size={12} />
                    <span>Paused by Setup ({systemStatus.setupPausedCount})</span>
                  </div>
                  <div className="space-y-1">
                    {setupPaused.map((c) => (
                      <Tooltip key={c.id} title={autoResumeNote(c) ?? ''} placement="right">
                        <Link
                          href={`/campaigns/${c.id}`}
                          onClick={handleLinkClick}
                          className="block truncate text-[11px] text-on-primary hover:underline"
                        >
                          {c.name}
                        </Link>
                      </Tooltip>
                    ))}
                    {setupPausedMore > 0 && (
                      <Link
                        href="/campaigns"
                        onClick={handleLinkClick}
                        className="block text-[11px] text-on-primary/80 hover:underline"
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
              width: 256,
              bgcolor: 'background.paper',
              backgroundImage: 'none',
              px: 1.5,
              pb: 1.5,
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
        className="hidden md:flex flex-col fixed top-0 left-0 bottom-0 w-64 bg-card border-r border-card-border z-30 px-3 pb-3 transition-colors duration-200"
      >
        {sidebarContent}
      </aside>
    </>
  );
}

export default Sidebar;

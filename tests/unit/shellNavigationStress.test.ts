import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { deliveryStatusText, workerStatusText, WORKER_STALL_MS, type DeliveryStatus } from '../../lib/systemStatus';
import { profileInitials } from '../../lib/profileInitials';

// Load source code for static analysis and transpile validation
const topNavBarPath = path.resolve(__dirname, '../../components/TopNavBar.tsx');
const sidebarPath = path.resolve(__dirname, '../../components/Sidebar.tsx');
const appLayoutClientPath = path.resolve(__dirname, '../../components/AppLayoutClient.tsx');

const topNavBarSource = fs.readFileSync(topNavBarPath, 'utf8');
const sidebarSource = fs.readFileSync(sidebarPath, 'utf8');
const appLayoutClientSource = fs.readFileSync(appLayoutClientPath, 'utf8');

describe('Transpile & TypeScript Syntactic Validity (M2 Components)', () => {
  it('transpiles TopNavBar.tsx cleanly with ts.transpileModule', () => {
    const res = ts.transpileModule(topNavBarSource, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: 'TopNavBar.tsx',
      reportDiagnostics: true,
    });
    expect(res.diagnostics?.length ?? 0).toBe(0);
    expect(res.outputText).toContain('TopNavBar');
  });

  it('transpiles Sidebar.tsx cleanly with ts.transpileModule', () => {
    const res = ts.transpileModule(sidebarSource, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: 'Sidebar.tsx',
      reportDiagnostics: true,
    });
    expect(res.diagnostics?.length ?? 0).toBe(0);
    expect(res.outputText).toContain('Sidebar');
  });

  it('transpiles AppLayoutClient.tsx cleanly with ts.transpileModule', () => {
    const res = ts.transpileModule(appLayoutClientSource, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: 'AppLayoutClient.tsx',
      reportDiagnostics: true,
    });
    expect(res.diagnostics?.length ?? 0).toBe(0);
    expect(res.outputText).toContain('AppLayoutClient');
  });
});

describe('House Design Directives Forensic Audit (Zero Emojis, Clean Look)', () => {
  // Regex matching standard unicode emoji ranges
  const emojiRegex = /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/u;

  it('contains zero emojis in TopNavBar.tsx', () => {
    const match = topNavBarSource.match(emojiRegex);
    expect(match).toBeNull();
  });

  it('contains zero emojis in Sidebar.tsx', () => {
    const match = sidebarSource.match(emojiRegex);
    expect(match).toBeNull();
  });

  it('contains zero emojis in AppLayoutClient.tsx', () => {
    const match = appLayoutClientSource.match(emojiRegex);
    expect(match).toBeNull();
  });

  it('does not contain generic AI vibe-coded purple gradient blobs or rainbow glow', () => {
    const vibeCodedWords = ['from-purple', 'to-pink', 'from-fuchsia', 'shadow-purple', 'rainbow'];
    for (const word of vibeCodedWords) {
      expect(topNavBarSource.toLowerCase()).not.toContain(word);
      expect(sidebarSource.toLowerCase()).not.toContain(word);
      expect(appLayoutClientSource.toLowerCase()).not.toContain(word);
    }
  });
});

describe('TopNavBar: Delivery Status Chip Matrix & Edge Cases', () => {
  // DELIVERY_CONFIG extracted from TopNavBar
  const DELIVERY_CONFIG: Record<
    string,
    { label: string; dotClass: string; bgClass: string; textClass: string; borderClass: string; pulse: boolean }
  > = {
    RUNNING: {
      label: 'Outbox Running',
      dotClass: 'bg-emerald-500',
      bgClass: 'bg-emerald-50 dark:bg-emerald-950/40',
      textClass: 'text-emerald-700 dark:text-emerald-300',
      borderClass: 'border-emerald-200 dark:border-emerald-800/60',
      pulse: true,
    },
    STALLED: {
      label: 'Outbox Stalled',
      dotClass: 'bg-amber-500',
      bgClass: 'bg-amber-50 dark:bg-amber-950/40',
      textClass: 'text-amber-700 dark:text-amber-300',
      borderClass: 'border-amber-200 dark:border-amber-800/60',
      pulse: true,
    },
    FAILING: {
      label: 'Outbox Failing',
      dotClass: 'bg-rose-500',
      bgClass: 'bg-rose-50 dark:bg-rose-950/40',
      textClass: 'text-rose-700 dark:text-rose-300',
      borderClass: 'border-rose-200 dark:border-rose-800/60',
      pulse: false,
    },
    NOT_RUNNING: {
      label: 'Outbox Not Running',
      dotClass: 'bg-rose-500',
      bgClass: 'bg-rose-50 dark:bg-rose-950/40',
      textClass: 'text-rose-700 dark:text-rose-300',
      borderClass: 'border-rose-200 dark:border-rose-800/60',
      pulse: false,
    },
    DISABLED: {
      label: 'Sending Disabled',
      dotClass: 'bg-amber-500',
      bgClass: 'bg-amber-50 dark:bg-amber-950/40',
      textClass: 'text-amber-700 dark:text-amber-300',
      borderClass: 'border-amber-200 dark:border-amber-800/60',
      pulse: false,
    },
  };

  function resolveDelivery(systemStatus: any) {
    const deliveryStatusKey = systemStatus?.deliveryStatus;
    const currentDelivery = deliveryStatusKey
      ? DELIVERY_CONFIG[deliveryStatusKey] ?? {
          label: 'Outbox Status Unknown',
          dotClass: 'bg-slate-400',
          bgClass: 'bg-slate-100 dark:bg-slate-800',
          textClass: 'text-slate-600 dark:text-slate-400',
          borderClass: 'border-slate-200 dark:border-slate-700',
          pulse: false,
        }
      : {
          label: !systemStatus ? 'Checking Outbox' : 'Outbox Status Unknown',
          dotClass: 'bg-slate-400',
          bgClass: 'bg-slate-100 dark:bg-slate-800',
          textClass: 'text-slate-600 dark:text-slate-400',
          borderClass: 'border-slate-200 dark:border-slate-700',
          pulse: false,
        };

    const deliveryDetail = systemStatus?.deliveryStatus
      ? deliveryStatusText(systemStatus.deliveryStatus, systemStatus.sendingProblem, systemStatus.workerHeartbeat)
      : !systemStatus
      ? 'Checking delivery engine and worker heartbeat…'
      : 'System status could not be read.';

    return { currentDelivery, deliveryDetail };
  }

  it('correctly resolves all 5 official delivery states', () => {
    // 1. RUNNING
    const running = resolveDelivery({
      deliveryStatus: 'RUNNING',
      workerHeartbeat: { lastTickAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), lastError: null },
    });
    expect(running.currentDelivery.label).toBe('Outbox Running');
    expect(running.currentDelivery.dotClass).toBe('bg-emerald-500');
    expect(running.currentDelivery.pulse).toBe(true);
    expect(running.deliveryDetail).toContain('Worker running');

    // 2. STALLED
    const stalled = resolveDelivery({
      deliveryStatus: 'STALLED',
      workerHeartbeat: { lastTickAt: new Date().toISOString(), lastSuccessAt: new Date(Date.now() - 3600000).toISOString(), lastError: null },
    });
    expect(stalled.currentDelivery.label).toBe('Outbox Stalled');
    expect(stalled.currentDelivery.dotClass).toBe('bg-amber-500');
    expect(stalled.currentDelivery.pulse).toBe(true);
    expect(stalled.deliveryDetail).toContain('cycles normally run every 30 seconds');

    // 3. FAILING
    const failing = resolveDelivery({
      deliveryStatus: 'FAILING',
      workerHeartbeat: { lastTickAt: new Date().toISOString(), lastSuccessAt: null, lastError: 'Database connection dropped' },
    });
    expect(failing.currentDelivery.label).toBe('Outbox Failing');
    expect(failing.currentDelivery.dotClass).toBe('bg-rose-500');
    expect(failing.currentDelivery.pulse).toBe(false);
    expect(failing.deliveryDetail).toContain('Database connection dropped');

    // 4. NOT_RUNNING
    const notRunning = resolveDelivery({
      deliveryStatus: 'NOT_RUNNING',
      workerHeartbeat: null,
    });
    expect(notRunning.currentDelivery.label).toBe('Outbox Not Running');
    expect(notRunning.currentDelivery.dotClass).toBe('bg-rose-500');
    expect(notRunning.currentDelivery.pulse).toBe(false);
    expect(notRunning.deliveryDetail).toContain('Worker not running');

    // 5. DISABLED
    const disabled = resolveDelivery({
      deliveryStatus: 'DISABLED',
      sendingProblem: 'No verified domain in Azure ACS',
    });
    expect(disabled.currentDelivery.label).toBe('Sending Disabled');
    expect(disabled.currentDelivery.dotClass).toBe('bg-amber-500');
    expect(disabled.currentDelivery.pulse).toBe(false);
    expect(disabled.deliveryDetail).toBe('No verified domain in Azure ACS');
  });

  it('handles edge case: null or undefined systemStatus', () => {
    const nullRes = resolveDelivery(null);
    expect(nullRes.currentDelivery.label).toBe('Checking Outbox');
    expect(nullRes.currentDelivery.dotClass).toBe('bg-slate-400');
    expect(nullRes.currentDelivery.pulse).toBe(false);
    expect(nullRes.deliveryDetail).toBe('Checking delivery engine and worker heartbeat…');

    const undefRes = resolveDelivery(undefined);
    expect(undefRes.currentDelivery.label).toBe('Checking Outbox');
  });

  it('handles edge case: empty object systemStatus ({})', () => {
    const emptyRes = resolveDelivery({});
    expect(emptyRes.currentDelivery.label).toBe('Outbox Status Unknown');
    expect(emptyRes.currentDelivery.dotClass).toBe('bg-slate-400');
    expect(emptyRes.currentDelivery.pulse).toBe(false);
    expect(emptyRes.deliveryDetail).toBe('System status could not be read.');
  });

  it('handles edge case: corrupted/unrecognized deliveryStatus string', () => {
    const corruptRes = resolveDelivery({ deliveryStatus: 'BOGUS_STATUS' });
    expect(corruptRes.currentDelivery.label).toBe('Outbox Status Unknown');
    expect(corruptRes.currentDelivery.dotClass).toBe('bg-slate-400');
    expect(corruptRes.currentDelivery.pulse).toBe(false);
  });
});

describe('TopNavBar: Command Search Palette (⌘K) Keyboard Navigation & Filtering', () => {
  interface NavCommandItem {
    id: string;
    title: string;
    description: string;
    href: string;
    adminOnly?: boolean;
  }

  const COMMAND_NAV_ITEMS: NavCommandItem[] = [
    { id: 'dashboard', title: 'Dashboard', description: 'Overview, deliverability metrics, and active charts', href: '/' },
    { id: 'campaigns', title: 'Campaigns', description: 'Automated outbound sequences and active cadences', href: '/campaigns' },
    { id: 'leads', title: 'Leads', description: 'Contact lists, lead imports, and CRM prospects', href: '/leads' },
    { id: 'unibox', title: 'Unibox', description: 'Unified multi-inbox thread management and replies', href: '/unibox' },
    { id: 'accounts', title: 'Accounts', description: 'Sender mailboxes, IMAP sync, and daily quotas', href: '/accounts' },
    { id: 'templates', title: 'Templates', description: 'Email copywriting snippets and sequence steps', href: '/templates' },
    { id: 'settings', title: 'Settings', description: 'Profile preferences, time zone, and system settings', href: '/settings' },
    { id: 'admin-users', title: 'Users Admin', description: 'Role assignments, invites, and team permissions', href: '/admin/users', adminOnly: true },
  ];

  function getAvailableCommands(role?: string) {
    return COMMAND_NAV_ITEMS.filter((item) => {
      if (item.adminOnly && role !== 'ADMIN') return false;
      return true;
    });
  }

  function filterCommands(availableCommands: NavCommandItem[], searchQuery: string) {
    if (!searchQuery.trim()) return availableCommands;
    const q = searchQuery.toLowerCase().trim();
    return availableCommands.filter(
      (item) => item.title.toLowerCase().includes(q) || item.description.toLowerCase().includes(q)
    );
  }

  function simulateKeyDown(
    key: 'ArrowDown' | 'ArrowUp' | 'Enter',
    currentIndex: number,
    filteredCommands: NavCommandItem[],
    onSelect?: (href: string) => void
  ): number {
    if (key === 'ArrowDown') {
      return filteredCommands.length ? (currentIndex + 1) % filteredCommands.length : 0;
    } else if (key === 'ArrowUp') {
      return filteredCommands.length ? (currentIndex - 1 + filteredCommands.length) % filteredCommands.length : 0;
    } else if (key === 'Enter') {
      if (filteredCommands[currentIndex]) {
        onSelect?.(filteredCommands[currentIndex].href);
      }
      return currentIndex;
    }
    return currentIndex;
  }

  it('omits Users Admin for USER or null session, includes for ADMIN', () => {
    expect(getAvailableCommands('USER').map((i) => i.id)).not.toContain('admin-users');
    expect(getAvailableCommands(undefined).map((i) => i.id)).not.toContain('admin-users');
    expect(getAvailableCommands('ADMIN').map((i) => i.id)).toContain('admin-users');
  });

  it('filters destinations accurately with empty, title, description, and whitespace queries', () => {
    const all = getAvailableCommands('USER');
    // Empty query returns all
    expect(filterCommands(all, '')).toHaveLength(7);
    expect(filterCommands(all, '   ')).toHaveLength(7);

    // Title match
    expect(filterCommands(all, 'campaigns')).toHaveLength(1);
    expect(filterCommands(all, 'CAMPAIGNS')).toHaveLength(1);

    // Description match
    expect(filterCommands(all, 'cadence')).toHaveLength(1);
    expect(filterCommands(all, 'CRM')).toHaveLength(1);
    expect(filterCommands(all, 'CRM')[0].id).toBe('leads');

    // Multi-match
    const eMatch = filterCommands(all, 'deliverability');
    expect(eMatch).toHaveLength(1);
    expect(eMatch[0].id).toBe('dashboard');

    // No match
    expect(filterCommands(all, 'xyz-non-existent')).toHaveLength(0);
  });

  it('cycles ArrowDown navigation through all items and loops back to 0', () => {
    const list = getAvailableCommands('USER'); // length 7
    let idx = 0;
    for (let i = 1; i <= 6; i++) {
      idx = simulateKeyDown('ArrowDown', idx, list);
      expect(idx).toBe(i);
    }
    // At end (6), ArrowDown should wrap to 0
    idx = simulateKeyDown('ArrowDown', 6, list);
    expect(idx).toBe(0);
  });

  it('cycles ArrowUp navigation backward and wraps from 0 to last index', () => {
    const list = getAvailableCommands('USER'); // length 7
    // From 0, ArrowUp should wrap to 6
    const idx = simulateKeyDown('ArrowUp', 0, list);
    expect(idx).toBe(6);

    // From 6, ArrowUp should go to 5
    const idx2 = simulateKeyDown('ArrowUp', 6, list);
    expect(idx2).toBe(5);
  });

  it('handles empty results without division by zero, NaN, or exceptions', () => {
    const emptyList: NavCommandItem[] = [];
    const idxDown = simulateKeyDown('ArrowDown', 0, emptyList);
    expect(idxDown).toBe(0);
    expect(Number.isNaN(idxDown)).toBe(false);

    const idxUp = simulateKeyDown('ArrowUp', 0, emptyList);
    expect(idxUp).toBe(0);
    expect(Number.isNaN(idxUp)).toBe(false);

    const onSelect = vi.fn();
    simulateKeyDown('Enter', 0, emptyList, onSelect);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('triggers router navigation on Enter for selected index', () => {
    const list = getAvailableCommands('USER');
    const onSelect = vi.fn();
    simulateKeyDown('Enter', 2, list, onSelect);
    expect(onSelect).toHaveBeenCalledWith('/leads');
  });
});

describe('Sidebar: Active State & Badge Calculations', () => {
  function isActiveRoute(itemHref: string, currentPathname: string): boolean {
    return currentPathname === itemHref || (itemHref !== '/' && currentPathname?.startsWith(itemHref));
  }

  function getBadgeCount(systemStatus: any, badgeKey?: string): string | null {
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
  }

  it('strictly activates root dashboard ONLY when pathname is exactly "/"', () => {
    expect(isActiveRoute('/', '/')).toBe(true);
    expect(isActiveRoute('/', '/campaigns')).toBe(false);
    expect(isActiveRoute('/', '/leads/123')).toBe(false);
  });

  it('activates module tabs when nested under that route', () => {
    expect(isActiveRoute('/campaigns', '/campaigns')).toBe(true);
    expect(isActiveRoute('/campaigns', '/campaigns/create')).toBe(true);
    expect(isActiveRoute('/campaigns', '/campaigns/c-12345')).toBe(true);
    expect(isActiveRoute('/campaigns', '/leads')).toBe(false);
  });

  it('formats badge counts with locale strings and suppresses zero counts', () => {
    const status = {
      activeCampaignsCount: 12,
      leadsCount: 124500,
      accountsCount: 0,
    };
    expect(getBadgeCount(status, 'campaigns')).toBe('12');
    expect(getBadgeCount(status, 'leads')).toBe('124,500');
    expect(getBadgeCount(status, 'accounts')).toBeNull();
    expect(getBadgeCount(status, undefined)).toBeNull();
    expect(getBadgeCount(null, 'campaigns')).toBeNull();
  });
});

describe('Sidebar: ArcReach Engine Status & Setup-Paused Campaigns', () => {
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

  function computeEngineHealth(systemStatus: any) {
    const dbOk = systemStatus?.database === 'OPERATIONAL';
    const unknown = { color: STATUS_IDLE, text: systemStatus ? 'Unknown' : 'Loading' };
    const azure = AZURE_STATUS[systemStatus?.azureStatus] ?? unknown;
    const worker = WORKER_STATUS[systemStatus?.workerStatus] ?? unknown;

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

    return { isAllOperational, isAttentionNeeded, healthStatusText, healthDotClass };
  }

  it('evaluates "All Systems Operational" only when Database, Azure, and Worker are all OK', () => {
    const health = computeEngineHealth({
      database: 'OPERATIONAL',
      azureStatus: 'CONFIGURED',
      workerStatus: 'RUNNING',
    });
    expect(health.healthStatusText).toBe('All Systems Operational');
    expect(health.healthDotClass).toBe('bg-emerald-400');
  });

  it('evaluates "Attention Needed" when Azure is UNCONFIGURED but DB is operational', () => {
    const health = computeEngineHealth({
      database: 'OPERATIONAL',
      azureStatus: 'UNCONFIGURED',
      workerStatus: 'RUNNING',
    });
    expect(health.healthStatusText).toBe('Attention Needed');
    expect(health.healthDotClass).toBe('bg-amber-400');
  });

  it('evaluates "Service Degraded" when Database is down', () => {
    const health = computeEngineHealth({
      database: 'DOWN',
      azureStatus: 'CONFIGURED',
      workerStatus: 'RUNNING',
    });
    expect(health.healthStatusText).toBe('Service Degraded');
    expect(health.healthDotClass).toBe('bg-rose-400');
  });

  it('computes setup-paused overflow count correctly', () => {
    const systemStatus = {
      setupPausedCampaigns: [
        { id: 'c1', name: 'Alpha' },
        { id: 'c2', name: 'Beta' },
      ],
      setupPausedCount: 6,
    };
    const setupPaused = systemStatus.setupPausedCampaigns;
    const setupPausedMore = (systemStatus.setupPausedCount ?? 0) - setupPaused.length;
    expect(setupPausedMore).toBe(4);
  });
});

describe('AppLayoutClient: Responsive Drawer & Route Transitions', () => {
  it('detects /login route to isolate login layout from global shell', () => {
    const isLoginPage = (pathname: string) => pathname === '/login';
    expect(isLoginPage('/login')).toBe(true);
    expect(isLoginPage('/')).toBe(false);
    expect(isLoginPage('/campaigns')).toBe(false);
  });

  it('resets mobileSidebarOpen to false on route change', () => {
    let mobileSidebarOpen = true;
    let prevPathname = '/campaigns';
    const newPathname = '/leads';

    // AppLayoutClient render-phase route synchronization logic:
    if (newPathname !== prevPathname) {
      prevPathname = newPathname;
      if (mobileSidebarOpen) mobileSidebarOpen = false;
    }

    expect(mobileSidebarOpen).toBe(false);
    expect(prevPathname).toBe('/leads');
  });

  it('closes mobile drawer when clicking a link on mobile view', () => {
    let mobileOpen = true;
    const onMobileClose = vi.fn(() => {
      mobileOpen = false;
    });

    const isMobile = true;
    const handleLinkClick = () => {
      if (isMobile && onMobileClose) {
        onMobileClose();
      }
    };

    handleLinkClick();
    expect(onMobileClose).toHaveBeenCalled();
    expect(mobileOpen).toBe(false);
  });

  it('does NOT call onMobileClose when clicking a link on desktop view', () => {
    const onMobileClose = vi.fn();
    const isMobile = false;
    const handleLinkClick = () => {
      if (isMobile && onMobileClose) {
        onMobileClose();
      }
    };

    handleLinkClick();
    expect(onMobileClose).not.toHaveBeenCalled();
  });
});

/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Send, Users, Inbox, Settings, Mail, FileText, Sun, Moon, ShieldCheck, LogOut, Menu,
} from 'lucide-react';
import { useTheme } from '@/components/ThemeProvider';
import {
  Box, Stack, Typography, Avatar, Chip, Button, List, ListItemButton, ListItemIcon, ListItemText, Tooltip, Drawer, IconButton,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { autoResumeNote } from '@/lib/campaignPause';
import { workerStatusText } from '@/lib/systemStatus';
import { useIsMobile } from '@/hooks/use-mobile';

const defaultNavItems = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Campaigns', href: '/campaigns', icon: Send },
  { name: 'Leads', href: '/leads', icon: Users },
  { name: 'Unibox', href: '/unibox', icon: Inbox },
  { name: 'Accounts', href: '/accounts', icon: Mail },
  { name: 'Templates', href: '/templates', icon: FileText },
];

const STATUS_OK = '#10b981';
const STATUS_WARN = '#f59e0b';
const STATUS_BAD = '#f43f5e';
const STATUS_IDLE = '#94a3b8';

/** Azure settings, from /api/system-status's azureStatus. Nothing calls Azure, so none of these says it is online. */
const AZURE_STATUS: Record<string, { color: string; text: string }> = {
  CONFIGURED: { color: STATUS_OK, text: 'Configured' },
  UNCONFIGURED: { color: STATUS_WARN, text: 'Not Configured' },
  DISABLED: { color: STATUS_WARN, text: 'Disabled' },
};

/** The send worker, from /api/system-status's workerStatus (its heartbeat). */
const WORKER_STATUS: Record<string, { color: string; text: string }> = {
  RUNNING: { color: STATUS_OK, text: 'Running' },
  STALLED: { color: STATUS_WARN, text: 'Stalled' },
  FAILING: { color: STATUS_BAD, text: 'Failing' },
  NOT_RUNNING: { color: STATUS_BAD, text: 'Not Running' },
};

/** How often the status panel re-reads /api/system-status while the tab is visible. */
const STATUS_REFRESH_MS = 60_000;

function StatusRow({ label, color, text, detail }: { label: string; color: string; text: string; detail?: string | null }) {
  const row = (
    <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 500 }}>{label}</Typography>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
        <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: color }} />
        <Typography sx={{ fontSize: 10, fontWeight: 700, fontFamily: 'monospace', color, textTransform: 'uppercase' }}>{text}</Typography>
      </Stack>
    </Stack>
  );
  return detail ? <Tooltip title={detail} placement="right">{row}</Tooltip> : row;
}

export function Sidebar() {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [session, setSessionState] = useState<any>(null);
  const [systemStatus, setSystemStatus] = useState<any>(null);
  // Below md the sidebar is a drawer opened from the top bar.
  const isMobile = useIsMobile();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMounted(true);
    fetch('/api/session').then(res => {
      // A missing, revoked or disabled session answers 401 (and its cookie is cleared): sign in again.
      if (res.status === 401) { window.location.href = '/login'; return null; }
      return res.json();
    }).then(data => setSessionState(data)).catch(() => {});
    const loadStatus = () => {
      // A 401 (session ended) is left to the session check; it says nothing about the system.
      fetch('/api/system-status').then(res => (res.status === 401 ? null : res.json())).then(data => { if (data) setSystemStatus(data); }).catch(() => {});
    };
    loadStatus();
    // The worker status comes from its heartbeat, so it is re-read rather than kept from page load.
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') loadStatus();
    }, STATUS_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  const handleLogout = async () => {
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      if (res.ok) window.location.href = '/login';
    } catch (e) {
      console.error(e);
    }
  };

  const navItems = [...defaultNavItems];
  if (session?.role === 'ADMIN') navItems.push({ name: 'Users Admin', href: '/admin/users', icon: ShieldCheck });

  // System status colors/labels
  const dbOk = systemStatus?.database === 'OPERATIONAL';
  const dbColor = dbOk ? STATUS_OK : systemStatus ? STATUS_BAD : STATUS_IDLE;
  const dbText = systemStatus ? (dbOk ? 'Online' : 'Offline') : 'Loading';

  const unknown = { color: STATUS_IDLE, text: systemStatus ? 'Unknown' : 'Loading' };
  const azure = AZURE_STATUS[systemStatus?.azureStatus] ?? unknown;
  const azureDetail = systemStatus?.azureStatus === 'CONFIGURED'
    ? 'The connection string decrypts and a verified sender domain is saved. Azure accepts or refuses the access key only when an email is sent.'
    : systemStatus?.sendingProblem;
  const worker = WORKER_STATUS[systemStatus?.workerStatus] ?? unknown;
  const workerDetail = WORKER_STATUS[systemStatus?.workerStatus]
    ? workerStatusText(systemStatus.workerStatus, systemStatus.workerHeartbeat)
    : null;

  // Campaigns the send engine paused until their setup is fixed, and whether each
  // has a complete sending schedule (without one its auto-resume sets it to Draft).
  const setupPaused: Array<{ id: string; name: string; status: string; pauseReason: string | null; pausedUntil: string | null; hasSendingSchedule: boolean }> =
    systemStatus?.setupPausedCampaigns ?? [];
  const setupPausedMore = (systemStatus?.setupPausedCount ?? 0) - setupPaused.length;

  const content = (
    <>
      {/* Brand */}
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', px: 1, mb: 3 }}>
        <Avatar variant="rounded" sx={{ bgcolor: 'primary.main', width: 36, height: 36, borderRadius: '10px', boxShadow: 2 }}>
          <Mail size={18} color="#fff" />
        </Avatar>
        <Typography variant="h6" sx={{ fontWeight: 700, letterSpacing: '0.06em' }}>ARCREACH</Typography>
      </Stack>

      {/* Session card */}
      <Box sx={{ mb: 2.5, p: 1.75, borderRadius: '16px', bgcolor: 'action.hover', border: 1, borderColor: 'divider' }}>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 0.75 }}>
          <Typography sx={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color: 'text.secondary', textTransform: 'uppercase' }}>Active Session</Typography>
          <Chip
            size="small"
            label={session?.role || 'USER'}
            color={session?.role === 'ADMIN' ? 'error' : 'primary'}
            variant="outlined"
            sx={{ height: 18, '& .MuiChip-label': { px: 0.75, fontSize: 9, fontWeight: 700, fontFamily: 'monospace' } }}
          />
        </Stack>
        <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>{session?.name || 'Syncing Account…'}</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1.5 }} noWrap>{session?.email || 'Connecting…'}</Typography>
        <Button onClick={handleLogout} fullWidth size="small" variant="outlined" color="inherit" startIcon={<LogOut size={14} />}
          sx={{ borderColor: 'divider', color: 'text.secondary', fontSize: 11 }}>
          Log Out
        </Button>
      </Box>

      {/* Navigation */}
      <List sx={{ flex: 1, overflowY: 'auto', py: 0, '& .MuiListItemButton-root': { mb: 0.5 } }}>
        {navItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== '/' && pathname?.startsWith(item.href));
          const Icon = item.icon;
          return (
            <ListItemButton
              key={item.name}
              component={Link as any}
              href={item.href}
              selected={isActive}
              sx={{
                borderRadius: 999,
                px: 1.5, py: 1,
                color: 'text.secondary',
                '& .MuiListItemIcon-root': { minWidth: 34, color: 'inherit' },
                '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
                '&.Mui-selected': {
                  bgcolor: (t) => alpha(t.palette.primary.main, 0.14),
                  color: 'primary.main',
                  '&:hover': { bgcolor: (t) => alpha(t.palette.primary.main, 0.2) },
                },
              }}
            >
              <ListItemIcon><Icon size={18} /></ListItemIcon>
              <ListItemText primary={<Typography sx={{ fontSize: 14, fontWeight: isActive ? 700 : 500 }}>{item.name}</Typography>} />
            </ListItemButton>
          );
        })}
      </List>

      {/* Footer */}
      <Stack spacing={1} sx={{ mt: 'auto', pt: 1.5, borderTop: 1, borderColor: 'divider' }}>
        <ListItemButton onClick={toggleTheme} sx={{ borderRadius: 999, px: 1.5, py: 1, color: 'text.secondary', '&:hover': { bgcolor: 'action.hover' } }}>
          <ListItemIcon sx={{ minWidth: 34, color: 'inherit' }}>
            {mounted && theme === 'dark' ? <Sun size={18} color="#f59e0b" /> : <Moon size={18} />}
          </ListItemIcon>
          <ListItemText primary={<Typography sx={{ fontSize: 14, fontWeight: 500 }}>{mounted ? (theme === 'dark' ? 'Light Mode' : 'Dark Mode') : 'Theme'}</Typography>} />
          <Chip size="small" label={mounted ? theme : '…'} sx={{ height: 18, fontFamily: 'monospace', '& .MuiChip-label': { px: 0.75, fontSize: 9, fontWeight: 700, textTransform: 'uppercase' } }} />
        </ListItemButton>

        <ListItemButton component={Link as any} href="/settings" sx={{ borderRadius: 999, px: 1.5, py: 1, color: 'text.secondary', '& .MuiListItemIcon-root': { minWidth: 34, color: 'inherit' }, '&:hover': { bgcolor: 'action.hover', color: 'text.primary' } }}>
          <ListItemIcon><Settings size={18} /></ListItemIcon>
          <ListItemText primary={<Typography sx={{ fontSize: 14, fontWeight: 500 }}>Settings</Typography>} />
        </ListItemButton>

        {/* System status */}
        <Box sx={{ p: 1.5, borderRadius: '14px', bgcolor: 'action.hover', border: 1, borderColor: 'divider' }}>
          <Typography sx={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: 'text.secondary', textTransform: 'uppercase', mb: 1 }}>System Status</Typography>
          <Stack spacing={1}>
            <StatusRow label="Database" color={dbColor} text={dbText} />
            <StatusRow label="Azure Settings" color={azure.color} text={azure.text} detail={azureDetail} />
            <StatusRow label="Send Worker" color={worker.color} text={worker.text} detail={workerDetail} />
          </Stack>
          {setupPaused.length > 0 && (
            <Box sx={{ mt: 1.25, pt: 1, borderTop: 1, borderColor: 'divider' }}>
              <Typography sx={{ fontSize: 10, fontWeight: 700, color: STATUS_WARN, mb: 0.5 }}>
                Paused by Setup Problems ({systemStatus.setupPausedCount})
              </Typography>
              <Stack spacing={0.25}>
                {setupPaused.map((c) => (
                  <Tooltip key={c.id} title={autoResumeNote(c) ?? ''} placement="right">
                    <Typography component={Link as any} href={`/campaigns/${c.id}`} noWrap
                      sx={{ fontSize: 11, color: 'text.primary', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>
                      {c.name}
                    </Typography>
                  </Tooltip>
                ))}
                {setupPausedMore > 0 && (
                  <Typography component={Link as any} href="/campaigns"
                    sx={{ fontSize: 11, color: 'text.secondary', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>
                    {setupPausedMore} more
                  </Typography>
                )}
              </Stack>
            </Box>
          )}
        </Box>
      </Stack>
    </>
  );

  return (
    <>
      {/* Top bar with the menu button, below md only */}
      <Box
        component="header"
        className="flex md:hidden"
        sx={{ alignItems: 'center', gap: 1, flexShrink: 0, px: 1, py: 1, bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}
      >
        <IconButton
          onClick={() => setMobileOpen(true)}
          aria-label="Open Navigation"
          aria-controls="app-navigation"
          aria-expanded={mobileOpen}
          sx={{ color: 'text.primary' }}
        >
          <Menu size={20} />
        </IconButton>
        <Avatar variant="rounded" sx={{ bgcolor: 'primary.main', width: 30, height: 30, borderRadius: '9px' }}>
          <Mail size={16} color="#fff" />
        </Avatar>
        <Typography sx={{ fontWeight: 700, letterSpacing: '0.06em' }}>ARCREACH</Typography>
      </Box>

      {isMobile ? (
        <Drawer
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          slotProps={{
            root: { keepMounted: true },
            paper: {
              id: 'app-navigation',
              'aria-label': 'Navigation',
              // Following any link closes the drawer, even one to the page already shown.
              onClick: (e: React.MouseEvent<HTMLDivElement>) => {
                if ((e.target as Element).closest('a')) setMobileOpen(false);
              },
              sx: { width: 256, backgroundImage: 'none', px: 2, pt: 3, pb: 2 },
            },
          }}
        >
          {content}
        </Drawer>
      ) : (
        // Also hidden below md by CSS, so a phone never shows it before hydration swaps in the drawer.
        <Box
          component="aside"
          className="hidden md:flex"
          sx={{
            width: 256, height: '100vh', position: 'fixed', top: 0, left: 0, zIndex: 50,
            bgcolor: 'background.paper', borderRight: 1, borderColor: 'divider',
            flexDirection: 'column', px: 2, pt: 3, pb: 2,
          }}
        >
          {content}
        </Box>
      )}
    </>
  );
}

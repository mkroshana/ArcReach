/* eslint-disable react-hooks/set-state-in-effect */
'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Send, Users, Inbox, Settings, Mail, FileText, Sun, Moon, ShieldCheck, LogOut,
} from 'lucide-react';
import { useTheme } from '@/components/ThemeProvider';
import {
  Box, Stack, Typography, Avatar, Chip, Button, List, ListItemButton, ListItemIcon, ListItemText,
} from '@mui/material';
import { alpha } from '@mui/material/styles';

const defaultNavItems = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Campaigns', href: '/campaigns', icon: Send },
  { name: 'Leads', href: '/leads', icon: Users },
  { name: 'Unibox', href: '/unibox', icon: Inbox },
  { name: 'Accounts', href: '/accounts', icon: Mail },
  { name: 'Templates', href: '/templates', icon: FileText },
];

function StatusRow({ label, color, text }: { label: string; color: string; text: string }) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 500 }}>{label}</Typography>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
        <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: color }} />
        <Typography sx={{ fontSize: 10, fontWeight: 700, fontFamily: 'monospace', color, textTransform: 'uppercase' }}>{text}</Typography>
      </Stack>
    </Stack>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [session, setSessionState] = useState<any>(null);
  const [systemStatus, setSystemStatus] = useState<any>(null);

  useEffect(() => {
    setMounted(true);
    fetch('/api/session').then(res => res.json()).then(data => setSessionState(data)).catch(() => {});
    fetch('/api/system-status').then(res => res.json()).then(data => setSystemStatus(data)).catch(() => {});
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

  // System status colors/labels (preserves prior logic)
  const dbOk = systemStatus?.database === 'OPERATIONAL';
  const dbColor = dbOk ? '#10b981' : systemStatus ? '#f43f5e' : '#94a3b8';
  const dbText = systemStatus ? (dbOk ? 'Online' : 'Offline') : 'Loading';

  let azureColor = '#94a3b8';
  let azureText = 'Loading';
  if (systemStatus) {
    if (systemStatus.activeProvider === 'AZURE') {
      if (systemStatus.azureStatus === 'OPERATIONAL') { azureColor = '#10b981'; azureText = 'Online'; }
      else if (systemStatus.azureStatus === 'UNCONFIGURED') { azureColor = '#f59e0b'; azureText = 'Not Setup'; }
      else { azureColor = '#f43f5e'; azureText = 'Offline'; }
    } else { azureColor = '#f59e0b'; azureText = 'Disabled'; }
  }

  return (
    <Box
      component="aside"
      sx={{
        width: 256, height: '100vh', position: 'fixed', top: 0, left: 0, zIndex: 50,
        bgcolor: 'background.paper', borderRight: 1, borderColor: 'divider',
        display: 'flex', flexDirection: 'column', px: 2, pt: 3, pb: 2,
      }}
    >
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
            <StatusRow label="Azure API" color={azureColor} text={azureText} />
          </Stack>
        </Box>
      </Stack>
    </Box>
  );
}
